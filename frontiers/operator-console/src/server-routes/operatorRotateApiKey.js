// AW8-3 — API key rotation observability + operator-acknowledged rotation log.
//
// Sprint AW5 audit (PR #1187) flagged that OUTREACH_API_KEY rotation was overdue.
// This module surfaces rotation state in the dashboard so the operator can:
//
//   1. See current key fingerprint (last 4 chars) + age (days since first
//      rotation row in operator_audit_log) so they know whether rotation is due.
//   2. Acknowledge a rotation by POSTing to /api/operator/rotate-api-key with
//      X-Confirm-Send: yes header. The endpoint writes an audit row and returns
//      a runbook pointer — it does NOT spawn shell / Railway CLI.
//
// The "no shell exec" constraint is intentional and preserves three guarantees:
//
//   a. Security: spawning Railway CLI from BFF is a token-storage problem that
//      we don't have a clean answer for in this codebase. Audit-log + manual
//      rotation matches the secret-rotation playbook
//      (docs/playbooks/secret-rotation.md) and respects HARD RULE
//      feedback_no_pii_in_commands (no inline secrets piped to subprocesses).
//
//   b. Sentry-only monitoring: the audit row is enough for the operator to
//      track rotations; HARD RULE feedback_no_extra_monitoring forbids adding
//      separate alert pipelines (PagerDuty, Slack, etc).
//
//   c. Reversibility: an audit-log row is cheap to delete; a half-completed
//      shell rotation is not.
//
// Endpoints
// ─────────
//
// GET /api/operator/api-key-status
//   Returns: { ok, fingerprint, age_days, last_rotated_at, rotation_count }
//   - fingerprint: last 4 chars of OUTREACH_API_KEY (or 'unset' if env not set)
//   - age_days: days since most recent api_key_rotated audit row (or null)
//   - rotation_count: total api_key_rotated audit rows ever
//
// POST /api/operator/rotate-api-key
//   Headers: X-Confirm-Send: yes  (required)
//   Body:    { reason?: string, runbook_acknowledged?: boolean }
//
//   Writes one operator_audit_log row (action='api_key_rotated', actor=<x-operator-id>).
//   Returns 200 { ok, audit_id, runbook_url, instructions:[…] } guiding the
//   operator through Railway env update + Go service redeploy.
//   Returns 412 if X-Confirm-Send is missing.

const RUNBOOK_URL = 'https://github.com/messing/hozan-taher/blob/main/docs/playbooks/secret-rotation.md'

// Rotation step instructions surfaced in the response so the dashboard modal
// can render them without re-fetching markdown. Keep aligned with the playbook
// (docs/playbooks/secret-rotation.md). Updates here MUST be mirrored there.
const ROTATION_INSTRUCTIONS = [
  'Generate new key:  openssl rand -hex 32',
  'Update Railway env on outreach-dashboard:  OUTREACH_API_KEY=<new>',
  'Update Railway env on outreach (Go service): OUTREACH_API_KEY=<new>',
  'Redeploy both services so the new key is loaded.',
  'All current dashboard sessions become invalid (BFF auth middleware).',
  'Verify with curl + new key against /api/health.',
]

/**
 * Fingerprint helper — returns last 4 chars (or 'unset').
 * @param {string|undefined|null} key
 */
function fingerprintKey(key) {
  if (!key || typeof key !== 'string' || key.length < 4) return 'unset'
  return `…${key.slice(-4)}`
}

/**
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500?: Function, safeError?: Function }} deps
 */
export function mountOperatorRotateApiKeyRoutes(app, { pool, capture500, safeError } = {}) {
  app.get('/api/operator/api-key-status', async (_req, res) => {
    try {
      const fingerprint = fingerprintKey(process.env.OUTREACH_API_KEY)

      let lastRotatedAt = null
      let rotationCount = 0
      try {
        const { rows: lastRows } = await pool.query(
          `
            SELECT created_at FROM operator_audit_log
             WHERE action = 'api_key_rotated'
          ORDER BY created_at DESC
             LIMIT 1
          `,
        )
        if (lastRows[0]) lastRotatedAt = lastRows[0].created_at

        const { rows: cntRows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM operator_audit_log WHERE action='api_key_rotated'`,
        )
        rotationCount = cntRows[0]?.n ?? 0
      } catch (e) {
        // Schema gap → treat as no-history (lastRotatedAt=null, count=0).
        if (e?.code !== '42P01') throw e
      }

      const ageDays = lastRotatedAt
        ? Math.floor((Date.now() - new Date(lastRotatedAt).getTime()) / 86_400_000)
        : null

      return res.json({
        ok: true,
        fingerprint,
        age_days: ageDays,
        last_rotated_at: lastRotatedAt,
        rotation_count: rotationCount,
        runbook_url: RUNBOOK_URL,
        generated_at: new Date().toISOString(),
      })
    } catch (e) {
      if (capture500) return capture500(res, e, safeError)
      console.error('[operatorRotateApiKey/status] error:', e?.message || e)
      return res.status(500).json({ ok: false, error: e?.message || 'internal error' })
    }
  })

  app.post('/api/operator/rotate-api-key', async (req, res) => {
    try {
      if (req.headers['x-confirm-send'] !== 'yes') {
        return res.status(412).json({
          ok: false,
          error: 'X-Confirm-Send: yes header required',
          hint: 'This endpoint records a rotation in the audit log. Acknowledge by adding X-Confirm-Send: yes.',
        })
      }

      const reason = (req.body?.reason && String(req.body.reason).slice(0, 200)) || 'operator-initiated rotation'
      const runbookAcknowledged = req.body?.runbook_acknowledged === true
      const actor = req.headers['x-operator-id'] || req.user?.email || req.user?.id || 'dashboard'

      let auditId = null
      try {
        const { rows } = await pool.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('api_key_rotated', $1, 'env_secret', 'OUTREACH_API_KEY', $2::jsonb)
           RETURNING id`,
          [
            String(actor),
            JSON.stringify({
              reason,
              runbook_acknowledged: runbookAcknowledged,
              fingerprint_before: fingerprintKey(process.env.OUTREACH_API_KEY),
              at: new Date().toISOString(),
            }),
          ],
        )
        auditId = rows[0]?.id ?? null
      } catch (e) {
        // Schema gap on operator_audit_log — surface it explicitly so the
        // operator knows the rotation wasn't recorded. Do not silently succeed.
        if (e?.code === '42P01') {
          return res.status(500).json({
            ok: false,
            error: 'operator_audit_log table missing — cannot record rotation',
            hint: 'Apply migrations before using this endpoint.',
          })
        }
        throw e
      }

      return res.json({
        ok: true,
        audit_id: auditId,
        runbook_url: RUNBOOK_URL,
        instructions: ROTATION_INSTRUCTIONS,
        warning: 'Recording the audit row does NOT rotate the key. Follow the instructions above to complete rotation.',
      })
    } catch (e) {
      if (capture500) return capture500(res, e, safeError)
      console.error('[operatorRotateApiKey/rotate] error:', e?.message || e)
      return res.status(500).json({ ok: false, error: e?.message || 'internal error' })
    }
  })
}

// Exported for unit testing.
export { fingerprintKey, ROTATION_INSTRUCTIONS, RUNBOOK_URL }
