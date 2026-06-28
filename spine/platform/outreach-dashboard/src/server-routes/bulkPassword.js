// POST /api/mailboxes/bulk-set-password — bulk-update mailbox passwords.
// ─────────────────────────────────────────────────────────────────────────────
// The Mailboxes drawer + edit modal flow takes 5 clicks per mailbox to set
// a password. With 24 mailboxes that's 120 clicks. This endpoint accepts
// a flat list `[{ id|email, password }]` and updates all in one round-trip.
//
// HARD RULE — `feedback_mailbox_passwords_via_db`: this endpoint is the
// authorised UI alternative to direct SQL UPDATE. NEVER write a path that
// reads passwords from env vars or a config file.
//
// Validation:
//   - each row must have either id (int) or email (string) + password (string)
//   - password must NOT match the placeholder detector (8+ chars, no banned
//     prefix, no repeated trigrams)
//   - rows that fail validation are reported in `errors[]` with reason; the
//     remaining rows still apply (operator sees per-row outcome)
//
// Response shape mirrors the existing import-csv endpoint so the UI layer
// can reuse the same toast / error rendering.

import { isPlaceholderPassword } from '../lib/passwordValidator.js'

// Per-IP rate limit for the bulk-password endpoint.
// 5 calls per IP per minute — stops brute-force and accidental loops.
// Intentionally not using the global createRateLimitMiddleware because
// that middleware is mounted application-wide and handles generic burst;
// this endpoint needs a much tighter window on its own.
const _bulkPwdStore = new Map()
const BULK_PWD_MAX = 5
const BULK_PWD_WINDOW_MS = 60_000

function bulkPasswordRateLimit(req, res, next) {
  if (process.env.BFF_RATE_LIMIT_DISABLED === '1') return next()
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const now = Date.now()
  let entry = _bulkPwdStore.get(ip)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + BULK_PWD_WINDOW_MS }
    _bulkPwdStore.set(ip, entry)
  }
  entry.count++
  if (entry.count > BULK_PWD_MAX) {
    return res.status(429).json({ error: 'příliš mnoho požadavků — zkuste za minutu' })
  }
  return next()
}

/**
 * Mount the bulk-password endpoint on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: Function, safeError: Function }} deps
 */
export function mountBulkPasswordRoute(app, { pool, capture500, safeError }) {
  app.post('/api/mailboxes/bulk-set-password', bulkPasswordRateLimit, async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'rows[] required' })
    }
    if (rows.length > 100) {
      return res.status(400).json({ error: 'rows[] capped at 100 per request' })
    }
    const results = []
    for (const r of rows) {
      const ident = r?.id != null ? { kind: 'id', value: r.id } : (r?.email ? { kind: 'email', value: r.email } : null)
      const pwd = typeof r?.password === 'string' ? r.password : ''
      if (!ident) {
        results.push({ ok: false, error: 'řádek musí mít id nebo email' })
        continue
      }
      if (isPlaceholderPassword(pwd)) {
        results.push({
          ok: false,
          identifier: ident.value,
          error: 'heslo nesplňuje politiku (8+ znaků, ne placeholder)',
        })
        continue
      }
      let client
      try {
        client = await pool.connect()
        await client.query('BEGIN')
        const sql = ident.kind === 'id'
          ? 'UPDATE outreach_mailboxes SET password = $1, updated_at = now() WHERE id = $2 RETURNING id, from_address AS email'
          : 'UPDATE outreach_mailboxes SET password = $1, updated_at = now() WHERE from_address = $2 RETURNING id, from_address AS email'
        const { rows: out } = await client.query(sql, [pwd, ident.value])
        if (out.length === 0) {
          await client.query('ROLLBACK')
          results.push({ ok: false, identifier: ident.value, error: 'schránka nenalezena' })
        } else {
          await client.query(
            `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
             VALUES ('mailbox_bulk_password_update', 'dashboard', 'outreach_mailbox', $1, $2::jsonb)`,
            [String(out[0].id), JSON.stringify({ field: 'password', rotated_at: new Date().toISOString() })]
          )
          await client.query('COMMIT')
          results.push({ ok: true, identifier: ident.value, id: out[0].id, email: out[0].email })
        }
      } catch (e) {
        if (client) { try { await client.query('ROLLBACK') } catch {} }
        results.push({ ok: false, identifier: ident.value, error: e.message || 'UPDATE selhal' })
      } finally {
        if (client) client.release()
      }
    }
    const updated = results.filter(r => r.ok).length
    const errors = results.filter(r => !r.ok)
    res.json({
      ok: errors.length === 0,
      updated,
      total: results.length,
      errors,
      results,
    })
  })
}
