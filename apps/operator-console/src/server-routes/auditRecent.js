// AW8-3 — Recent operator_audit_log query for surfacing backend hardening events.
//
// GET /api/audit/recent?action=<name>&since_hours=<n>&limit=<n>
//
// Reads from `operator_audit_log` (canonical audit table — see services/common/audit/log.go)
// and returns up to `limit` (default 50, max 200) rows for `action`. Used by the
// dashboard to surface:
//
//   - watchdog reaper count badge on CampaignDetail (action=in_flight_reaped)
//     — Sprint AW7-3, PR #1196 emits one row per reaped campaign_contact.
//
//   - engine panic-recovery banner on CampaignDetail (action=engine.panic_recovered)
//     — Sprint AW7-4, PR #1197 emits one row per recovered panic. ActionEnginePanicRecovered
//     constant lives in services/common/audit/entry.go.
//
// Optional `entity_id` filter narrows by campaign_id (rows from in_flight_reaped
// store entity_type='campaign_contact' with entity_id=<contact_id>; reaper rows
// also include the parent campaign in `details.campaign_id`, but operator-side
// we filter post-read since filtering on JSON is a per-DB-flavor minefield).
//
// Response shape:
//   {
//     ok: true,
//     action: '<requested>',
//     since_hours: <n>,
//     count: <number>,
//     rows: [
//       { id, action, actor, entity_type, entity_id, details, created_at },
//       ...
//     ],
//     generated_at: <ISO8601>,
//   }
//
// On schema gap (operator_audit_log not present) returns 200 { ok: false, reason } —
// dashboard hides the badge/banner in that case (matches RelayBackpressureBadge
// pattern).
//
// Read-only — no audit log writes from this endpoint to avoid recursive noise.

const ALLOWED_ACTIONS = new Set([
  'in_flight_reaped',
  'engine.panic_recovered',
])

const DEFAULT_SINCE_HOURS = 24
const MAX_SINCE_HOURS     = 24 * 14  // 2 weeks
const DEFAULT_LIMIT       = 50
const MAX_LIMIT           = 200

/**
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500?: Function, safeError?: Function }} deps
 */
export function mountAuditRecentRoute(app, { pool, capture500, safeError } = {}) {
  app.get('/api/audit/recent', async (req, res) => {
    try {
      const action = String(req.query.action || '').trim()
      if (!action) {
        return res.status(400).json({ ok: false, error: 'action query parameter required' })
      }
      // Whitelist guard — prevents arbitrary scans of operator_audit_log via
      // a public endpoint. New consumers add to ALLOWED_ACTIONS explicitly.
      if (!ALLOWED_ACTIONS.has(action)) {
        return res.status(400).json({
          ok: false,
          error: 'action not in whitelist',
          allowed: [...ALLOWED_ACTIONS],
        })
      }

      const sinceHoursRaw = Number(req.query.since_hours ?? DEFAULT_SINCE_HOURS)
      const sinceHours = Number.isFinite(sinceHoursRaw)
        ? Math.max(1, Math.min(MAX_SINCE_HOURS, Math.floor(sinceHoursRaw)))
        : DEFAULT_SINCE_HOURS

      const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT)
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
        : DEFAULT_LIMIT

      const entityId = req.query.entity_id ? String(req.query.entity_id) : null

      // Build WHERE clause defensively — entity_id filter is optional.
      const params = [action]
      let where = `action = $1 AND created_at > now() - ($2 || ' hours')::interval`
      params.push(String(sinceHours))
      if (entityId) {
        params.push(entityId)
        where += ` AND entity_id = $${params.length}`
      }
      params.push(limit)

      const sql = `
        SELECT id, action, actor, entity_type, entity_id, details, created_at
        FROM operator_audit_log
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}
      `

      const { rows } = await pool.query(sql, params)
      return res.json({
        ok: true,
        action,
        since_hours: sinceHours,
        count: rows.length,
        rows,
        generated_at: new Date().toISOString(),
      })
    } catch (e) {
      // Schema gap (e.g. fresh DB without operator_audit_log) — return ok:false
      // so the dashboard hides the badge gracefully instead of bubbling a 500.
      if (e?.code === '42P01' || /relation .*operator_audit_log.* does not exist/i.test(e?.message || '')) {
        return res.json({
          ok: false,
          reason: 'operator_audit_log table not present',
          rows: [],
          count: 0,
          generated_at: new Date().toISOString(),
        })
      }
      if (capture500) return capture500(res, e, safeError)
      console.error('[auditRecent] error:', e?.message || e)
      return res.status(500).json({ ok: false, error: e?.message || 'internal error' })
    }
  })
}
