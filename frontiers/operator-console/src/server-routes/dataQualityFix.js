// dataQualityFix.js — one-click deterministic fixes for data-quality tasks.
//
// Makes the úkolovník actionable: some checks have a safe, deterministic fix
// the operator can trigger in place. The LLM is never involved — pure code
// writes the final state. Every mutation is audit-logged in the same tx
// (feedback_audit_log_on_mutations).
import { decodeMimeWords } from '../app/lib/replyMeta.js'

export function mountDataQualityFixRoute(app, { pool, capture500, safeError }) {
  // POST /api/data-quality/fix/reply-mime-subject
  // Decodes raw RFC-2047 MIME subjects (=?UTF-8?…?=) stored in reply_inbox and
  // writes back the readable text — so exports / / CRM forwards (anything not
  // decoding on display like does) show real subjects. Idempotent: a second
  // run fixes 0. decodeMimeWords is deterministic + fail-safe (returns input
  // unchanged on any decode error), so we only UPDATE when it actually changed.
  app.post('/api/data-quality/fix/reply-mime-subject', async (req, res) => {
    const client = await pool.connect()
    try {
      const { rows } = await client.query(
        `SELECT id, subject FROM reply_inbox WHERE subject LIKE '=?%?=%'`
      )
      await client.query('BEGIN')
      let fixed = 0
      for (const r of rows) {
        const decoded = decodeMimeWords(r.subject)
        if (decoded && decoded !== r.subject) {
          await client.query(`UPDATE reply_inbox SET subject = $1 WHERE id = $2`, [decoded, r.id])
          fixed++
        }
      }
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        ['reply_mime_subject_backfill', 'operator', 'reply_inbox', null,
         JSON.stringify({ scanned: rows.length, fixed })]
      )
      await client.query('COMMIT')
      res.json({ ok: true, scanned: rows.length, fixed })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
}
