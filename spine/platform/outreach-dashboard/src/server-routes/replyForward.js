// replyForward.js — operator "Přeposlat" (forward) for an inbound reply.
//
// POST /api/replies/:id/forward
//   Body (JSON or multipart/form-data — both work, express.json +
//   express-fileupload are mounted app-globally):
//     to               — REQUIRED. Third-party recipient email (the dealer).
//     note             — optional operator note prepended above the quote.
//     from_mailbox_id  — optional. Sending mailbox; defaults to the reply's
//                        receiving mailbox, else the first active mailbox.
//     include_original — optional ('false' to skip). Default: carry the
//                        original inbound attachments.
//
// This reuses the EXISTING safe send path — it does NOT open a new relay
// client. It enqueues a manual_reply_outbox row with kind='forward' +
// forward_to + from_mailbox_id (migration 175); the outbound-reply dispatcher
// (Go cron_outbound_reply.go / BFF runOutboundReplyCron.js) then COALESCEs the
// recipient + sending mailbox and ships it through anti-trace-relay /v1/submit.
// NEVER raw SMTP. NEVER a bypass.
//
// vs. the existing "Předat do CRM" (/forward-to-crm): that is a no-send handoff
// stub. THIS actually delivers the email to a chosen address.
//
// Memory:
//   feedback_audit_log_on_mutations — the enqueue writes operator_audit_log in
//     the same tx as the outbox INSERT.
//   feedback_no_pii_in_commands     — the audit details log recipient_domain,
//     not the full address; the full address lives durably in forward_to (also
//     the GDPR Art. 30 disclosure record).
//   feedback_no_magic_thresholds    — caps are named constants.
//   feedback_anti_trace_full_stack  — send goes through the relay, no bypass.

const MAX_NOTE_CHARS = 10_000
const MAX_QUOTE_CHARS = 50_000        // truncate huge originals so the forward stays sane
const MAX_EMAIL_CHARS = 254           // RFC 5321 max addr length
// Pragmatic address shape — the relay re-validates on submit.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isValidEmail = (s) => typeof s === 'string' && s.length <= MAX_EMAIL_CHARS && EMAIL_RE.test(s)

/** Czech-formatted date for the quoted header; ISO fallback if ICU is absent. */
function fmtDate(d) {
  if (!d) return '(neznámé datum)'
  try {
    return new Date(d).toLocaleString('cs-CZ', {
      timeZone: 'Europe/Prague', dateStyle: 'medium', timeStyle: 'short',
    })
  } catch {
    try { return new Date(d).toISOString() } catch { return String(d) }
  }
}

/** "Fwd: <subject>", without doubling an existing Fwd: prefix. */
function fwdSubject(orig) {
  const s = String(orig || '').trim()
  if (!s) return 'Fwd: '
  if (/^fwd:/i.test(s)) return s
  return `Fwd: ${s}`
}

/** Operator note + standard quoted-original block. */
function composeForwardBody(note, original) {
  const n = String(note || '').slice(0, MAX_NOTE_CHARS).trim()
  let quote = String(original.body_text || '')
  if (quote.length > MAX_QUOTE_CHARS) {
    quote = quote.slice(0, MAX_QUOTE_CHARS) + '\n\n[…zkráceno…]'
  }
  const header = [
    '---------- Přeposlaná zpráva ----------',
    `Od: ${original.from_email || '(neznámý odesílatel)'}`,
    `Datum: ${fmtDate(original.received_at)}`,
    `Předmět: ${original.subject || '(bez předmětu)'}`,
    '',
    quote,
  ].join('\n')
  return n ? `${n}\n\n${header}` : header
}

/**
 * Load the original inbound message. Positive id = reply_inbox row. Negative
 * id = unmatched_inbound orphan — promote it to a reply_inbox stub (mirrors
 * replyMultipart.js) so the outbox FK + dispatcher can key off reply_inbox_id,
 * using the orphan's body_preview as the quoted body.
 * Returns null when the source row is missing.
 */
async function loadOriginalForForward(client, rawId) {
  if (rawId < 0) {
    const unmatchedId = -rawId
    const { rows: ur } = await client.query(
      `SELECT from_address, subject, received_at, body_preview, reviewed
         FROM unmatched_inbound WHERE id = $1`,
      [unmatchedId],
    )
    if (!ur.length) return null
    const u = ur[0]
    const { rows: ins } = await client.query(
      `INSERT INTO reply_inbox (from_email, subject, received_at, handled, source_unmatched_id)
       VALUES ($1, $2, $3, FALSE, $4)
       RETURNING id`,
      [u.from_address, u.subject, u.received_at, unmatchedId],
    )
    await client.query(
      `UPDATE unmatched_inbound SET reviewed = TRUE, reviewed_at = now() WHERE id = $1`,
      [unmatchedId],
    )
    return {
      replyInboxId: Number(ins[0].id),
      from_email: u.from_address,
      subject: u.subject,
      received_at: u.received_at,
      body_text: u.body_preview || '',
      mailbox_id: null, // orphan has no receiving mailbox; resolver picks a default
      orphan: true,
    }
  }
  const { rows } = await client.query(
    `SELECT id, from_email, subject, received_at, body_text, mailbox_id
       FROM reply_inbox WHERE id = $1`,
    [rawId],
  )
  if (!rows.length) return null
  const r = rows[0]
  return {
    replyInboxId: Number(r.id),
    from_email: r.from_email,
    subject: r.subject,
    received_at: r.received_at,
    body_text: r.body_text || '',
    mailbox_id: r.mailbox_id,
    orphan: false,
  }
}

/**
 * Resolve the sending mailbox: explicit param → reply's receiving mailbox →
 * first active mailbox. Returns { id, from_address } or { error }. Storing a
 * concrete id in from_mailbox_id guarantees the dispatcher's JOIN resolves
 * (COALESCE(from_mailbox_id, reply_inbox.mailbox_id)).
 */
async function resolveSendingMailbox(client, fromMailboxIdParam, replyMailboxId) {
  if (Number.isInteger(fromMailboxIdParam) && fromMailboxIdParam > 0) {
    const { rows } = await client.query(
      `SELECT id, from_address FROM outreach_mailboxes WHERE id = $1`, [fromMailboxIdParam])
    if (!rows.length) return { error: 'unknown from_mailbox_id' }
    return { id: Number(rows[0].id), from_address: rows[0].from_address }
  }
  if (replyMailboxId) {
    const { rows } = await client.query(
      `SELECT id, from_address FROM outreach_mailboxes WHERE id = $1`, [replyMailboxId])
    if (rows.length) return { id: Number(rows[0].id), from_address: rows[0].from_address }
  }
  const { rows } = await client.query(
    `SELECT id, from_address FROM outreach_mailboxes WHERE status = 'active' ORDER BY id ASC LIMIT 1`)
  if (rows.length) return { id: Number(rows[0].id), from_address: rows[0].from_address }
  return { error: 'no active mailbox available to forward from' }
}

/**
 * Mount POST /api/replies/:id/forward.
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: any, safeError: any }} deps
 */
export function mountReplyForwardRoutes(app, { pool, capture500, safeError }) {
  app.post('/api/replies/:id/forward', async (req, res) => {
    const rawId = Number(req.params.id)
    if (!Number.isInteger(rawId) || rawId === 0) {
      return res.status(400).json({ error: 'invalid reply id' })
    }

    const to = String(req.body?.to ?? '').trim().toLowerCase()
    if (!to) return res.status(400).json({ error: 'recipient (to) required' })
    if (!isValidEmail(to)) return res.status(400).json({ error: 'invalid recipient email' })

    const note = String(req.body?.note ?? '')
    const includeOriginal = String(req.body?.include_original ?? 'true') !== 'false'
    const fromMailboxIdParam = req.body?.from_mailbox_id != null
      ? Number(req.body.from_mailbox_id) : null

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const original = await loadOriginalForForward(client, rawId)
      if (!original) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'reply not found' })
      }

      const mailbox = await resolveSendingMailbox(client, fromMailboxIdParam, original.mailbox_id)
      if (mailbox.error) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: mailbox.error })
      }
      // Anti-loop: never forward a message to the very mailbox that sends it.
      if (mailbox.from_address && to === String(mailbox.from_address).trim().toLowerCase()) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'cannot forward to the sending mailbox' })
      }

      const subjectOverride = fwdSubject(original.subject)
      const body = composeForwardBody(note, original)

      // 1) Outbox row — kind='forward', recipient override in forward_to,
      //    sending identity pinned in from_mailbox_id, "Fwd:" in subject_override.
      const { rows: outbox } = await client.query(
        `INSERT INTO manual_reply_outbox
           (body, reply_inbox_id, subject_override, forward_to, from_mailbox_id, kind)
         VALUES ($1, $2, $3, $4, $5, 'forward')
         RETURNING id`,
        [body, original.replyInboxId, subjectOverride, to, mailbox.id],
      )
      const outboxId = Number(outbox[0].id)

      // 2) Carry the original inbound attachments (matched replies only — orphan
      //    photos live in unmatched_inbound_attachments; copying those is a
      //    follow-up). Copy bytes from reply_inbox_attachments → outbox store.
      let attachmentCount = 0
      if (includeOriginal && !original.orphan) {
        const { rows: origAtts } = await client.query(
          `SELECT idx, filename, content_type, size_bytes, data, sha256, is_inline
             FROM reply_inbox_attachments WHERE reply_inbox_id = $1 ORDER BY idx`,
          [original.replyInboxId],
        )
        for (let i = 0; i < origAtts.length; i++) {
          const a = origAtts[i]
          await client.query(
            `INSERT INTO manual_reply_outbox_attachments
               (outbox_id, position, filename, content_type, size_bytes, data, sha256, is_inline)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [outboxId, i, a.filename, a.content_type, a.size_bytes, a.data, a.sha256, a.is_inline],
          )
          attachmentCount++
        }
      }

      // 3) Audit the disclosure in the same tx. PII-light: domain only.
      const actor = req.headers['x-operator'] || req.user?.email || 'operator'
      const recipientDomain = to.includes('@') ? to.slice(to.indexOf('@') + 1) : ''
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          'reply_forwarded',
          actor,
          'reply',
          String(original.replyInboxId),
          JSON.stringify({
            kind: 'forward',
            recipient_domain: recipientDomain,
            from_mailbox_id: mailbox.id,
            attachment_count: attachmentCount,
            has_note: note.trim().length > 0,
            at: new Date().toISOString(),
          }),
        ],
      )

      await client.query('COMMIT')
      res.json({
        ok: true,
        outbox_id: outboxId,
        attachments: attachmentCount,
        recipient_domain: recipientDomain,
        note: 'zařazeno do fronty — relay odešle do ~2 min',
      })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
}
