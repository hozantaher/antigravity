// notifications.js — Sprint Y7.
//
// Operator-facing notification center. Aggregates alerts from multiple
// sources into a single feed so the operator can see "what needs my
// attention" without hunting through DB rows, Sentry, and BFF logs.
//
// Routes:
//   GET  /api/notifications              — aggregated feed (auto + mailbox_alerts)
//   POST /api/notifications/:id/resolve  — mark a mailbox_alerts row resolved
//                                          (X-Confirm-Send header required)
//
// Severity model (per spec):
//   - critical : auth_lock / bounce_hold mailbox / runner crash
//   - warning  : bounce rate approaching threshold, spam complaint,
//                IMAP poll failures, blacklist hit
//   - info     : warmup phase advanced, daily cap hit (normal)
//
// Auto-dismiss:
//   - info alerts older than 24h are filtered out from the feed
//   - warning/critical stay visible until operator clicks Resolved
//
// Sources aggregated:
//   1. mailbox_alerts table (canonical) — raw rows where resolved_at IS NULL
//   2. outreach_mailboxes status='auth_locked' or 'bounce_hold' (live state)
//   3. computed bounce_rate > threshold from operator_settings (live)
//
// Thresholds come from operator_settings (HARD RULE
// feedback_no_magic_thresholds T0). Defaults shipped as fallback so the
// feed works on a fresh DB; operator overrides via dashboard UI.

const DEFAULT_BOUNCE_RATE_WARN = 0.02       // 2% — feedback_no_magic_thresholds spec
const DEFAULT_BOUNCE_RATE_MIN_SAMPLE = 20   // sample floor to avoid tiny-N noise
const DEFAULT_INFO_TTL_HOURS = 24           // auto-dismiss info alerts after 24h

async function loadThreshold(pool, key, fallback) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM operator_settings WHERE key = $1`,
      [key],
    )
    if (rows.length === 0) return fallback
    const raw = rows[0].value
    const parsed = typeof raw === 'string' ? parseFloat(raw) : Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function severityRank(s) {
  if (s === 'critical') return 0
  if (s === 'warning') return 1
  if (s === 'info') return 2
  return 3
}

export function mountNotificationsRoutes(app, { pool, capture500, safeError }) {
  // GET /api/notifications — aggregated feed
  app.get('/api/notifications', async (_req, res) => {
    try {
      const bounceWarn = await loadThreshold(
        pool, 'bounce_rate_warn_threshold', DEFAULT_BOUNCE_RATE_WARN,
      )
      const bounceMinSample = await loadThreshold(
        pool, 'bounce_rate_min_sample', DEFAULT_BOUNCE_RATE_MIN_SAMPLE,
      )
      const infoTtlHours = await loadThreshold(
        pool, 'notification_info_ttl_hours', DEFAULT_INFO_TTL_HOURS,
      )

      // Source 1: raw mailbox_alerts rows that are still unresolved.
      // info alerts older than the TTL are dropped (auto-dismiss).
      const { rows: alertRows } = await pool.query(
        `SELECT
           a.id,
           a.mailbox_id,
           m.from_address,
           a.type,
           a.severity,
           a.message,
           a.created_at
         FROM mailbox_alerts a
         LEFT JOIN outreach_mailboxes m ON m.id = a.mailbox_id
         WHERE a.resolved_at IS NULL
           AND (
             a.severity != 'info'
             OR a.created_at >= NOW() - ($1::int || ' hours')::interval
           )
         ORDER BY a.created_at DESC
         LIMIT 200`,
        [infoTtlHours],
      )

      // Source 2: live mailbox state — auth_locked / bounce_hold.
      // These are computed (not stored in mailbox_alerts) so they appear
      // even when the cron hasn't logged a row yet.
      const { rows: lockRows } = await pool.query(
        `SELECT id, from_address, status, auth_locked_at, auth_locked_reason
         FROM outreach_mailboxes
         WHERE status IN ('auth_locked', 'bounce_hold')
         ORDER BY auth_locked_at DESC NULLS LAST`,
      )

      // Source 3: computed bounce rate > warn threshold.
      // Live read of send_events so the feed surfaces degradation as it
      // happens, not on cron tick. min_sample guards tiny-N false positives.
      const { rows: bounceRows } = await pool.query(
        `WITH stats AS (
           SELECT
             mailbox_used,
             count(*)                                                   AS total,
             count(*) FILTER (WHERE status IN ('bounced','failed'))     AS bounced
           FROM send_events
           WHERE sent_at > NOW() - INTERVAL '24 hours'
           GROUP BY mailbox_used
           HAVING count(*) >= $1
         )
         SELECT
           m.id,
           m.from_address,
           s.bounced,
           s.total,
           (s.bounced::float / NULLIF(s.total, 0))                      AS rate
         FROM stats s
         JOIN outreach_mailboxes m ON m.from_address = s.mailbox_used
         WHERE (s.bounced::float / NULLIF(s.total, 0)) > $2
         ORDER BY rate DESC
         LIMIT 50`,
        [bounceMinSample, bounceWarn],
      )

      const notifications = []

      for (const r of alertRows) {
        notifications.push({
          id: `alert-${r.id}`,
          alert_id: Number(r.id),
          source: 'mailbox_alerts',
          type: r.type || 'unknown',
          severity: r.severity || 'info',
          message: r.message || '',
          mailbox_id: r.mailbox_id != null ? Number(r.mailbox_id) : null,
          from_address: r.from_address || null,
          created_at: r.created_at,
          resolvable: true,
        })
      }

      for (const r of lockRows) {
        const status = r.status
        notifications.push({
          id: `lock-${r.id}`,
          source: 'mailbox_state',
          type: status === 'auth_locked' ? 'mailbox_auth_lock' : 'mailbox_bounce_hold',
          severity: 'critical',
          message:
            status === 'auth_locked'
              ? `Schránka uzamčena (auth): ${r.auth_locked_reason || 'důvod neznámý'}`
              : `Schránka pozastavena (bounce hold)`,
          mailbox_id: Number(r.id),
          from_address: r.from_address || null,
          created_at: r.auth_locked_at || new Date().toISOString(),
          resolvable: false,
        })
      }

      for (const r of bounceRows) {
        const pct = (Number(r.rate) * 100).toFixed(1)
        notifications.push({
          id: `bounce-${r.id}`,
          source: 'computed',
          type: 'bounce_rate_high',
          severity: 'warning',
          message: `Bounce rate ${pct}% (${r.bounced}/${r.total} v 24h) — překročen práh ${(bounceWarn * 100).toFixed(1)}%`,
          mailbox_id: Number(r.id),
          from_address: r.from_address || null,
          created_at: new Date().toISOString(),
          resolvable: false,
        })
      }

      // Sort: severity (critical → warning → info), then newest first.
      notifications.sort((a, b) => {
        const sd = severityRank(a.severity) - severityRank(b.severity)
        if (sd !== 0) return sd
        const ta = new Date(a.created_at).getTime() || 0
        const tb = new Date(b.created_at).getTime() || 0
        return tb - ta
      })

      const counts = {
        total: notifications.length,
        critical: notifications.filter(n => n.severity === 'critical').length,
        warning: notifications.filter(n => n.severity === 'warning').length,
        info: notifications.filter(n => n.severity === 'info').length,
      }

      res.json({
        ran_at: new Date().toISOString(),
        thresholds: {
          bounce_rate_warn: bounceWarn,
          bounce_rate_min_sample: bounceMinSample,
          info_ttl_hours: infoTtlHours,
        },
        counts,
        notifications,
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // POST /api/notifications/:id/resolve — mark mailbox_alerts row resolved.
  // Per feedback_audit_log_on_mutations T0, INSERT operator_audit_log
  // in the SAME transaction as the UPDATE.
  app.post('/api/notifications/:id/resolve', async (req, res) => {
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
            AND resolved_at IS NULL
          RETURNING id, mailbox_id, type, severity, message, created_at`,
        [alertId],
      )
      if (!updated) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(404).json({ error: 'alert not found or already resolved' })
      }
      const operator =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'unknown'
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('notification_resolve', $1, 'mailbox_alert', $2, $3::jsonb)`,
        [operator, String(alertId), JSON.stringify({
          mailbox_id: updated.mailbox_id,
          type: updated.type,
          severity: updated.severity,
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
