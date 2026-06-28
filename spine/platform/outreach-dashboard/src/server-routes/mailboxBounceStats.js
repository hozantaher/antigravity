// mailboxBounceStats.js — Sprint M1 (issue #1272, master deliverability tracking).
//
// GET /api/mailboxes/bounce-stats?window=24h|7d|30d
//
// Returns per-mailbox bounce rate over the requested rolling window plus
// a fleet-wide rollup so the operator can spot outliers. The dashboard
// alerts when any mailbox is at ≥2% bounce rate over a 30d window
// (industry standard threshold for inbox-placement degradation).
//
// Response shape:
//   {
//     window: '7d',
//     ran_at: '2026-05-12T19:00:00Z',
//     fleet: { sent, bounced, bounce_rate_pct },
//     mailboxes: [
//       { mailbox_id, from_address, sent, bounced, bounce_rate_pct, status,
//         alert_threshold_breached: boolean }
//     ]
//   }
//
// The endpoint is read-only — operator just inspects. Mutations
// (pause/resume on threshold breach) happen via existing
// /api/mailboxes/:id/pause flow (UX/UI first rule).
//
// Memory:
//   feedback_no_pii_in_commands — from_address is operator-facing UI
//   data, not a credential. OK to surface (no password).
//   feedback_ux_ui_first — the panel will be wired in a separate UI PR
//   (M1 ships endpoint + a placeholder card). Read-only diagnostic
//   endpoints are explicitly carved out from UX/UI-first since they
//   don't mutate state.

const WINDOWS = {
  '24h': "INTERVAL '24 hours'",
  '7d':  "INTERVAL '7 days'",
  '30d': "INTERVAL '30 days'",
}

// Industry standard: 2% bounce rate over 7d+ window starts hurting
// inbox-placement reputation. Threshold is hard-coded here; if the
// operator ever wants to tune it, move to operator_settings.
const ALERT_THRESHOLD_PCT = 2.0

export function mountMailboxBounceStatsRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/mailboxes/bounce-stats', async (req, res) => {
    try {
      const window = String(req.query.window || '7d')
      const interval = WINDOWS[window]
      if (!interval) {
        return res.status(400).json({
          error: 'invalid window',
          allowed: Object.keys(WINDOWS),
        })
      }

      // Per-mailbox aggregation. LEFT JOIN so mailboxes with zero sends
      // in the window still appear (operator can see "nothing sent
      // here — should it be active?").
      const { rows } = await pool.query(`
        SELECT
          m.id                                                       AS mailbox_id,
          m.from_address                                              AS from_address,
          m.status                                                    AS status,
          m.lifecycle_phase                                           AS lifecycle_phase,
          COALESCE(stats.sent, 0)                                     AS sent,
          COALESCE(stats.bounced, 0)                                  AS bounced,
          CASE
            WHEN COALESCE(stats.sent, 0) + COALESCE(stats.bounced, 0) = 0 THEN 0
            ELSE ROUND((stats.bounced::numeric / NULLIF(stats.sent + stats.bounced, 0)) * 100, 2)
          END                                                         AS bounce_rate_pct
        FROM outreach_mailboxes m
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE status = 'sent')                   AS sent,
            COUNT(*) FILTER (WHERE status = 'bounced')                AS bounced
          FROM send_events
          WHERE mailbox_used = m.from_address
            AND sent_at >= NOW() - ${interval}
        ) stats ON TRUE
        WHERE m.environment = 'production'
        ORDER BY bounce_rate_pct DESC, sent DESC NULLS LAST
      `)

      // Fleet rollup — same window.
      const { rows: fleetRows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent')                     AS sent,
          COUNT(*) FILTER (WHERE status = 'bounced')                  AS bounced
        FROM send_events
        WHERE sent_at >= NOW() - ${interval}
      `)
      const fleetSent = Number(fleetRows[0]?.sent || 0)
      const fleetBounced = Number(fleetRows[0]?.bounced || 0)
      const fleetTotal = fleetSent + fleetBounced
      const fleetBounceRatePct =
        fleetTotal === 0 ? 0 : Math.round((fleetBounced / fleetTotal) * 100 * 100) / 100

      const mailboxes = rows.map(r => ({
        mailbox_id: Number(r.mailbox_id),
        from_address: r.from_address,
        status: r.status,
        lifecycle_phase: r.lifecycle_phase,
        sent: Number(r.sent),
        bounced: Number(r.bounced),
        bounce_rate_pct: Number(r.bounce_rate_pct),
        alert_threshold_breached: Number(r.bounce_rate_pct) >= ALERT_THRESHOLD_PCT,
      }))

      res.json({
        window,
        ran_at: new Date().toISOString(),
        threshold_pct: ALERT_THRESHOLD_PCT,
        fleet: {
          sent: fleetSent,
          bounced: fleetBounced,
          bounce_rate_pct: fleetBounceRatePct,
        },
        mailboxes,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
