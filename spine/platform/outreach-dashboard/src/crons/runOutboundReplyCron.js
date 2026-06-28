import { formatRFC5322Date } from '../lib/time-chaos.js'
import { getRelayBase } from '../lib/relayClient.js'

/**
 * runOutboundReplyCron — dispatch manual_reply_outbox rows via relay /v1/submit.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */
export async function runOutboundReplyCron(pool) {
  const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS) || 3
  // 1) Pull pending outbox rows with everything needed to build the reply.
  // Forward feature (migration 175) — kept bit-for-bit in sync with the Go
  // dispatcher (services/orchestrator/cmd/outreach/cron_outbound_reply.go):
  // recipient = COALESCE(forward_to, from_email); sending mailbox =
  // COALESCE(from_mailbox_id, reply_inbox.mailbox_id); scan m.id so mailbox_id
  // reflects the actual sender. If only ONE runner is updated, a forward row
  // picked up by the stale runner would ship to the original sender — a data
  // leak — so both MUST change together.
  const { rows: pending } = await pool.query(`
    SELECT o.id AS outbox_id, o.body, o.subject_override, o.attempts,
           o.reply_inbox_id,
           COALESCE(o.forward_to, r.from_email) AS recipient, r.subject AS original_subject,
           m.id AS mailbox_id, r.send_event_id,
           se.message_id AS in_reply_to,
           m.from_address AS mailbox_addr, m.smtp_host, m.smtp_port,
           m.smtp_username, m.password, m.imap_host, m.imap_port,
           m.preferred_country,
           o.forward_to, o.kind
      FROM manual_reply_outbox o
      JOIN reply_inbox r          ON r.id = o.reply_inbox_id
      LEFT JOIN send_events se    ON se.id = r.send_event_id
      JOIN outreach_mailboxes m   ON m.id = COALESCE(o.from_mailbox_id, r.mailbox_id)
     WHERE o.sent_at IS NULL
       AND o.attempts < $1
     ORDER BY o.id
     LIMIT 20
  `, [MAX_ATTEMPTS])

  if (pending.length === 0) return

  const relayBase = await getRelayBase(pool)
  const relayToken = process.env.ANTI_TRACE_RELAY_TOKEN || process.env.ANTI_TRACE_TOKEN || ''
  if (!relayBase || !relayToken) {
    console.warn('[outbox] relay not configured, skipping', pending.length, 'rows')
    return
  }

  for (const row of pending) {
    const subject = (row.subject_override || '').trim()
      || (row.original_subject ? (row.original_subject.match(/^Re:/i) ? row.original_subject : `Re: ${row.original_subject}`) : 'Re: ')

    // Sprint 2.2 — pull attachments stored inline on the outbox row.
    // Each attachment is sent to relay /v1/submit via the standard
    // attachments[] field (relay's submit handler already supports it
    // for outbound MIME assembly).
    const { rows: atts } = await pool.query(
      `SELECT filename, content_type, size_bytes, data, sha256, is_inline
         FROM manual_reply_outbox_attachments
        WHERE outbox_id = $1
        ORDER BY position`,
      [row.outbox_id]
    )
    const attachments = atts.map(a => ({
      filename:     a.filename,
      content_type: a.content_type,
      size_bytes:   Number(a.size_bytes),
      // Postgres BYTEA → Buffer; base64 over JSON for relay submit.
      data_b64:     Buffer.from(a.data).toString('base64'),
      sha256:       a.sha256,
      is_inline:    !!a.is_inline,
    }))

    const isForward = row.kind === 'forward'

    // Build wire headers. In-Reply-To + References keep the thread
    // glued in the recipient's mail client (Seznam, Gmail, Outlook
    // all honour RFC 5322 §3.6.5). A FORWARD goes to a third party who
    // never saw the original thread, so omit the threading headers.
    const headers = {
      Date: formatRFC5322Date(new Date(), 'Europe/Prague'),
    }
    if (!isForward && row.in_reply_to) {
      headers['In-Reply-To'] = `<${row.in_reply_to}>`
      headers['References'] = `<${row.in_reply_to}>`
    }

    try {
      const r = await fetch(`${relayBase.replace(/\/$/, '')}/v1/submit`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${relayToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          recipient:     row.recipient,
          subject,
          body:          row.body || '',
          from_address:  row.mailbox_addr,
          smtp_host:     row.smtp_host,
          smtp_port:     row.smtp_port,
          smtp_username: row.smtp_username || row.mailbox_addr,
          smtp_password: row.password,
          imap_host:     row.imap_host || '',
          imap_port:     row.imap_port || 0,
          headers,
          // attachments[] is passed-through to relay submit; the relay's
          // outbound SMTP layer assembles multipart/mixed with each file
          // as a separate part. Empty array (no attachments) is OK.
          attachments,
        }),
        signal: AbortSignal.timeout(45_000),
      })
      const respText = await r.text()
      const parsed = (() => { try { return JSON.parse(respText) } catch { return {} } })()
      if (!r.ok) {
        const errMsg = parsed?.error || `relay HTTP ${r.status}`
        await pool.query(
          `UPDATE manual_reply_outbox SET attempts = attempts + 1, error = $1, updated_at = now() WHERE id = $2`,
          [String(errMsg).slice(0, 500), row.outbox_id]
        )
        console.warn(`[outbox] reply ${row.outbox_id} relay rejected: ${errMsg}`)
        continue
      }
      const envelopeId = parsed.envelope_id || null
      await pool.query(`
        UPDATE manual_reply_outbox
           SET sent_at = now(), envelope_id = $1, error = NULL, updated_at = now()
         WHERE id = $2
      `, [envelopeId, row.outbox_id])
      // Persist as an outbound outreach_messages row so the thread view
      // shows operator's reply immediately. Resolve thread_id via
      // contact_id from reply_inbox → contacts. A FORWARD is not part of
      // the lead's conversation (it went to a third party), so skip it.
      if (!isForward) {
        try {
          await pool.query(`
            INSERT INTO outreach_messages (
              thread_id, direction, message_id, in_reply_to, body_text, subject, replied_at
            )
            SELECT t.id, 'outbound', $1, $2, $3, $4, now()
              FROM reply_inbox r
              LEFT JOIN outreach_threads t ON t.contact_id = r.contact_id
             WHERE r.id = $5
             LIMIT 1
          `, [envelopeId, row.in_reply_to || null, row.body || '', subject, row.reply_inbox_id])
        } catch (e) {
          console.warn(`[outbox] outreach_messages insert failed (non-fatal): ${e?.message}`)
        }
      }
      console.log(`[outbox] sent reply ${row.outbox_id} envelope=${envelopeId}`)
    } catch (e) {
      await pool.query(
        `UPDATE manual_reply_outbox SET attempts = attempts + 1, error = $1, updated_at = now() WHERE id = $2`,
        [String(e?.message || 'unknown').slice(0, 500), row.outbox_id]
      )
      console.warn(`[outbox] reply ${row.outbox_id} send failed: ${e?.message}`)
    }
  }
}
