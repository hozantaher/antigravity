// mailboxBlacklistAlerts.js — Sprint M4 (issue #1272).
//
// GET /api/mailboxes/blacklist-alerts?window=24h|7d|30d|all
//
// Aggregates mailbox_alerts where type='blacklist_hit' so the operator
// has a single place to see "which mailbox got blacklisted on which
// zone (Spamhaus / Barracuda / SORBS / etc.) and when". The cron
// `runBlacklistCheckCron` (server.js daily 02:00) already inserts
// rows; we just provide a read-only aggregation surface.
//
// POST /api/mailboxes/blacklist-alerts/:id/resolve  (X-Confirm-Send)
// Marks the alert resolved + writes operator_audit_log.
//
// The blacklist message format is the cron's choice — currently
// "Blacklist hit: <zone1>, <zone2>, ..." (per server.js:5495).

const WINDOWS = {
  '24h': "INTERVAL '24 hours'",
  '7d':  "INTERVAL '7 days'",
  '30d': "INTERVAL '30 days'",
  'all': null,
}

export function mountMailboxBlacklistAlertsRoutes(app, { pool, capture500, safeError }) {
  // List + group active blacklist alerts.
  app.get('/api/mailboxes/blacklist-alerts', async (req, res) => {
    try {
      const window = String(req.query.window || '7d')
      if (!(window in WINDOWS)) {
        return res.status(400).json({
          error: 'invalid window',
          allowed: Object.keys(WINDOWS),
        })
      }
      const interval = WINDOWS[window]
      const timeFilter = interval ? `AND a.created_at >= NOW() - ${interval}` : ''

      // Per-alert listing — joined with mailbox to surface from_address.
      const { rows: alerts } = await pool.query(`
        SELECT
          a.id,
          a.mailbox_id,
          m.from_address,
          a.severity,
          a.message,
          a.created_at,
          a.resolved_at
        FROM mailbox_alerts a
        LEFT JOIN outreach_mailboxes m ON m.id = a.mailbox_id
        WHERE a.type = 'blacklist_hit'
          ${timeFilter}
        ORDER BY (a.resolved_at IS NULL) DESC, a.created_at DESC
        LIMIT 200
      `)

      // Per-mailbox aggregation — counts of active vs resolved.
      const { rows: mailboxRollup } = await pool.query(`
        SELECT
          m.id                                                        AS mailbox_id,
          m.from_address,
          m.status                                                    AS mailbox_status,
          COUNT(a.id)                                                 AS total,
          COUNT(a.id) FILTER (WHERE a.resolved_at IS NULL)            AS active,
          COUNT(a.id) FILTER (WHERE a.resolved_at IS NOT NULL)        AS resolved,
          MAX(a.created_at)                                           AS most_recent_at
        FROM outreach_mailboxes m
        LEFT JOIN mailbox_alerts a
          ON a.mailbox_id = m.id
         AND a.type = 'blacklist_hit'
         ${timeFilter ? timeFilter.replace(/a\.created_at/g, 'a.created_at') : ''}
        WHERE m.environment = 'production'
        GROUP BY m.id, m.from_address, m.status
        HAVING COUNT(a.id) > 0
        ORDER BY active DESC, total DESC
      `)

      // Fleet totals — dedicated uncapped COUNT over the SAME filter as the
      // `alerts` listing (which is LIMIT 200). Deriving fleet counts from the
      // capped array undercounts total/active/resolved after a >200-row incident.
      const { rows: [fleetCounts] } = await pool.query(`
        SELECT
          COUNT(*)                                          AS total,
          COUNT(*) FILTER (WHERE a.resolved_at IS NULL)     AS active,
          COUNT(*) FILTER (WHERE a.resolved_at IS NOT NULL) AS resolved
        FROM mailbox_alerts a
        WHERE a.type = 'blacklist_hit'
          ${timeFilter}
      `)

      // Zone extraction — pull "Blacklist hit: X, Y" tokens out of
      // the message field so the UI can render zone-level breakdown.
      // Tolerant of formatting drift.
      const zoneCounts = {}
      for (const a of alerts) {
        const m = String(a.message || '').match(/Blacklist hit:\s*(.+)$/i)
        if (m) {
          for (const zone of m[1].split(',').map(z => z.trim()).filter(Boolean)) {
            zoneCounts[zone] = (zoneCounts[zone] || 0) + 1
          }
        }
      }
      const topZones = Object.entries(zoneCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([zone, count]) => ({ zone, count }))

      res.json({
        window,
        ran_at: new Date().toISOString(),
        fleet: {
          total: Number(fleetCounts?.total || 0),
          active: Number(fleetCounts?.active || 0),
          resolved: Number(fleetCounts?.resolved || 0),
        },
        top_zones: topZones,
        mailboxes: mailboxRollup.map(r => ({
          mailbox_id: Number(r.mailbox_id),
          from_address: r.from_address,
          mailbox_status: r.mailbox_status,
          total: Number(r.total),
          active: Number(r.active),
          resolved: Number(r.resolved),
          most_recent_at: r.most_recent_at,
        })),
        alerts: alerts.map(a => ({
          id: Number(a.id),
          mailbox_id: Number(a.mailbox_id),
          from_address: a.from_address,
          severity: a.severity,
          message: a.message,
          created_at: a.created_at,
          resolved_at: a.resolved_at,
        })),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  // Resolve a blacklist alert. Per feedback_audit_log_on_mutations T0,
  // operator_audit_log INSERT in the same transaction.
  app.post('/api/mailboxes/blacklist-alerts/:id/resolve', async (req, res) => {
    if (req.get('x-confirm-send') !== 'yes') {
      return res.status(428).json({ error: 'requires X-Confirm-Send: yes header' })
    }
    const alertId = Number(req.params.id)
    if (!Number.isFinite(alertId) || alertId <= 0) {
      return res.status(400).json({ error: 'invalid alert id' })
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [updated] } = await client.query(
        `UPDATE mailbox_alerts
            SET resolved_at = now()
          WHERE id = $1
            AND type = 'blacklist_hit'
            AND resolved_at IS NULL
          RETURNING id, mailbox_id, message, created_at`,
        [alertId],
      )
      if (!updated) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(404).json({ error: 'alert not found or already resolved' })
      }
      // Audit log — feedback_audit_log_on_mutations T0.
      const operator =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'unknown'
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('blacklist_alert_resolve', $1, 'mailbox_alert', $2, $3::jsonb)`,
        [operator, String(alertId), JSON.stringify({
          mailbox_id: updated.mailbox_id,
          original_message: updated.message,
          original_created_at: updated.created_at,
        })],
      )
      await client.query('COMMIT')
      client.release()
      res.json({ ok: true, alert_id: alertId, resolved_at: new Date().toISOString() })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      client.release()
      capture500(res, e, safeError)
    }
  })
}
