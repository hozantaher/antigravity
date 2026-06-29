// Sprint 2.2 (mail-client init 2026-05-12) — operator reply with attachments.
//
// POST /api/replies/:id/reply
//   Content-Type: multipart/form-data
//   Fields:
//     body  — plain text reply (required, max 50k chars)
//     files — 0-3 file attachments (max 10 MB each, image/* or pdf/doc/docx/xlsx)
//
// Side effects:
//   1. INSERT manual_reply_outbox (body, reply_inbox_id) → outbox_id
//   2. For each file: INSERT message_attachments(direction='outbound', BYTEA blob)
//      + link via manual_reply_outbox_attachments (outbox_id, attachment_id, position)
//   3. UPDATE reply_inbox SET handled = TRUE, handled_at = now()
//
// The orchestrator worker `runOutboundReplyCron` (server.js, runs every 90s)
// picks up rows where sent_at IS NULL, builds MIME with attachments via
// multipart/mixed, dispatches via anti-trace-relay /v1/submit, and stamps
// envelope_id + sent_at on success.
//
// Threading: outbox cron reads send_event.message_id for the In-Reply-To
// header so the reply lands in the same thread on the recipient's side
// (Seznam, Gmail, etc. all honour RFC 5322 §3.6.5).
//
// Memory:
//   feedback_no_pii_in_commands — slog keys avoid recipient address.
//   feedback_extreme_testing    — covered by tests/contract/bff-reply-multipart.contract.test.js.
//   feedback_search_before_implement — multipart parsing is delegated to the
//   app-global express-fileupload middleware (server.js), NOT a route-local
//   parser. A second parser here used to fight express-fileupload over the
//   single-consumption request stream: express-fileupload drained the body
//   first, this route's Busboy then saw EOF and threw "Unexpected end of form"
//   (→ HTTP 400 on EVERY send). The route now reads the already-parsed
//   req.body / req.files (same idiom as crm.js /api/crm/clients/import).

import { createHash } from 'node:crypto'

// Whitelist mirrors AttachmentStrip's safe inline image set + common
// document types operators actually attach. SVG excluded (XSS).
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
])

const MAX_FILES = 3
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB per attachment
const MAX_BODY_CHARS = 50_000

/**
 * Pull { body, files } out of a request already parsed by the app-global
 * express-fileupload middleware (server.js). Text fields land on `req.body`;
 * file parts sent under field name `files` land on `req.files.files` as a
 * single UploadedFile (1 file) or an array of them (N files).
 *
 * We re-validate count, MIME, and per-file size here — express-fileupload only
 * enforces the global 10 MB ceiling, not this route's whitelist or send-cap.
 * Throws Error (→ HTTP 400) on any violation so the caller's catch maps it.
 *
 * @param {import('express').Request} req
 * @returns {{ body: string, files: Array<{ filename: string, contentType: string, buffer: Buffer }> }}
 */
function extractMultipart(req) {
  // Cap stored length (silent truncation, matching prior behaviour) + trim.
  const body = String(req.body?.body ?? '').slice(0, MAX_BODY_CHARS).trim()

  const raw = req.files?.files
  const uploads = Array.isArray(raw) ? raw : raw ? [raw] : []
  if (uploads.length > MAX_FILES) {
    throw new Error(`too many files: ${uploads.length} > ${MAX_FILES}`)
  }

  const files = uploads.map((f) => {
    const contentType = (f?.mimetype || 'application/octet-stream').toLowerCase()
    if (!ALLOWED_MIME.has(contentType)) {
      throw new Error(`unsupported content_type: ${contentType}`)
    }
    // express-fileupload sets truncated=true if the global fileSize limit was
    // hit; with abortOnLimit it usually 413s before we run — defensive here.
    if (f.truncated) {
      throw new Error(`file ${f.name || 'attachment'} exceeds ${MAX_FILE_BYTES} bytes`)
    }
    const buffer = f.data
    if (!Buffer.isBuffer(buffer)) {
      // server.js pins useTempFiles:false so .data is the in-memory Buffer.
      // If that ever flips, fail loud rather than persist an empty blob.
      throw new Error('attachment buffer unavailable (useTempFiles must stay false)')
    }
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(`file ${f.name || 'attachment'} exceeds ${MAX_FILE_BYTES} bytes`)
    }
    return {
      filename: (f.name || 'attachment').slice(0, 255),
      contentType,
      buffer,
    }
  })

  return { body, files }
}

/**
 * Mount POST /api/replies/:id/reply on the Express app.
 *
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: any, safeError: any }} deps
 */
export function mountReplyMultipartRoutes(app, { pool, capture500, safeError }) {
  app.post('/api/replies/:id/reply', async (req, res) => {
    const rawId = Number(req.params.id)
    if (!Number.isFinite(rawId)) {
      return res.status(400).json({ error: 'invalid reply id' })
    }
    const ct = (req.headers['content-type'] || '').toLowerCase()
    if (!ct.startsWith('multipart/form-data')) {
      return res.status(415).json({ error: 'expected multipart/form-data' })
    }

    let parsed
    try {
      parsed = extractMultipart(req)
    } catch (e) {
      return res.status(400).json({ error: e?.message || 'invalid multipart' })
    }
    const text = parsed.body
    if (!text) {
      return res.status(400).json({ error: 'body required' })
    }

    const client = await pool.connect()
    let replyInboxId
    try {
      // Sprint 1.4 fix — open the transaction BEFORE any writes. The orphan
      // promotion below (INSERT reply_inbox + UPDATE unmatched_inbound SET
      // reviewed=TRUE) used to run BEFORE `BEGIN`, so they auto-committed; a
      // later failure + ROLLBACK then left the orphan consumed (reviewed=TRUE,
      // hidden from the UI) with NO manual_reply_outbox row — the operator's
      // reply was silently never sent. With BEGIN first the promotion rolls
      // back atomically with the outbox INSERT (mirrors replyForward.js). Each
      // early-exit branch must therefore ROLLBACK the open tx before returning.
      await client.query('BEGIN')

      if (rawId < 0) {
        // Sprint 1.4 — negative ID = unmatched_inbound row. Promote it
        // to reply_inbox so the existing outbound pipeline (which keys
        // off reply_inbox_id via FK) can pick it up. The promotion
        // copies from_email / subject / received_at; send_event_id +
        // campaign_id + contact_id stay NULL (no matching outbound).
        const unmatchedId = -rawId
        const { rows: ur } = await client.query(
          `SELECT from_address, subject, received_at, reviewed
             FROM unmatched_inbound WHERE id = $1`,
          [unmatchedId],
        )
        if (!ur.length) {
          await client.query('ROLLBACK')
          return res.status(404).json({ error: 'unmatched reply not found' })
        }
        // Idempotency — a reviewed orphan was already promoted/handled; promoting
        // it again would mint a second reply_inbox stub + outbox row → duplicate
        // send. `reviewed` is already SELECTed above; refuse the re-submit.
        if (ur[0].reviewed === true) {
          await client.query('ROLLBACK')
          return res.status(409).json({ error: 'orphan already handled' })
        }
        // INSERT reply_inbox stub. mailbox_id NULL (we don't know which
        // mailbox received the orphan). classification stays NULL → UI
        // shows 'unknown'.
        const u = ur[0]
        // Record source_unmatched_id (migration 145) so the promoted reply can
        // serve the orphan's photos (which stay in unmatched_inbound_attachments
        // keyed by the original unmatched_id).
        const { rows: insRows } = await client.query(
          `INSERT INTO reply_inbox (from_email, subject, received_at, handled, source_unmatched_id)
           VALUES ($1, $2, $3, FALSE, $4)
           RETURNING id`,
          [u.from_address, u.subject, u.received_at, unmatchedId],
        )
        replyInboxId = Number(insRows[0].id)
        // Mark the unmatched_inbound row as reviewed so it doesn't
        // show twice in the UI.
        await client.query(
          `UPDATE unmatched_inbound SET reviewed = TRUE, reviewed_at = now() WHERE id = $1`,
          [unmatchedId],
        )
      } else {
        replyInboxId = rawId
        const { rows: ri } = await client.query(
          `SELECT id, handled FROM reply_inbox WHERE id = $1`,
          [replyInboxId],
        )
        if (!ri.length) {
          await client.query('ROLLBACK')
          return res.status(404).json({ error: 'reply not found' })
        }
        // Idempotency — `handled` was SELECTed but never checked, so an operator
        // double-click / retry queued a SECOND manual_reply_outbox row and the
        // recipient received two replies. If it's already handled, refuse.
        if (ri[0].handled === true) {
          await client.query('ROLLBACK')
          return res.status(409).json({ error: 'reply already handled' })
        }
      }

      // 1) Outbox row — runOutboundReplyCron picks this up and sends.
      const { rows: outbox } = await client.query(
        `INSERT INTO manual_reply_outbox (body, reply_inbox_id)
         VALUES ($1, $2)
         RETURNING id`,
        [text, replyInboxId],
      )
      const outboxId = Number(outbox[0].id)

      // 2) Attachments — store BYTEA inline in manual_reply_outbox_attachments.
      // Migration 101 changed schema so outbound files no longer
      // require a parent outreach_messages row (which only exists
      // post-send). The outbound worker pulls these rows at send time
      // and assembles the MIME message.
      const attachmentIds = []
      for (let i = 0; i < parsed.files.length; i++) {
        const f = parsed.files[i]
        const sha = createHash('sha256').update(f.buffer).digest('hex')
        const { rows: att } = await client.query(
          `INSERT INTO manual_reply_outbox_attachments
            (outbox_id, position, filename, content_type, size_bytes, data, sha256, is_inline)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [outboxId, i, f.filename, f.contentType, f.buffer.length, f.buffer, sha, f.contentType.startsWith('image/')],
        )
        attachmentIds.push(Number(att[0].id))
      }

      // 3) Mark the inbound row as handled (operator decision made).
      await client.query(
        `UPDATE reply_inbox SET handled = TRUE, handled_at = now() WHERE id = $1`,
        [replyInboxId],
      )

      await client.query('COMMIT')
      res.json({
        ok: true,
        outbox_id: outboxId,
        attachments: attachmentIds,
        note: 'queued — operator will see send confirmation within ~2 min',
      })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
}
