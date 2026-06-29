// mailboxDeliveryTimeStats.js — Sprint M3 (issue #1272).
//
// GET /api/mailboxes/delivery-time-stats?window=24h|7d|30d
//
// Returns delivery-time distribution per mailbox over the window.
// "Delivery time" here = sent_at - created_at on send_events:
//   - created_at: when the runner queued the envelope
//   - sent_at:    when the relay confirmed successful submission
//
// We don't have a true "recipient accepted" timestamp — that would
// require provider FBL or DSN parsing. The queued→submitted gap is
// the right proxy for greylisting / deferral signals: when Seznam
// greylists, the relay backs off and sent_at slides 5-15 minutes
// later. Sustained drift in the histogram = reputation degrading.
//
// Buckets (chosen to highlight greylisting which typically defers
// for 60-300s, plus the longer tail when receivers escalate):
//   - <30s        — happy path, no deferral
//   - 30-60s      — minor queueing
//   - 1-2min      — first-tier deferral
//   - 2-5min      — provider holding off
//   - 5-15min     — sustained deferral
//   - 15-60min    — reputation concern
//   - >1h         — likely stuck / will retry
//
// Industry rule of thumb: >5% of sends should NOT spend more than
// 5 min between queue and submit. We surface that as the alert flag
// so the operator spots a single mailbox getting deferred before
// the fleet rate degrades.

const WINDOWS = {
  '24h': "INTERVAL '24 hours'",
  '7d':  "INTERVAL '7 days'",
  '30d': "INTERVAL '30 days'",
}

// % of sends taking >5min that we treat as the alert threshold.
const ALERT_LONG_TAIL_PCT = 5.0
// "Long tail" boundary — anything above this counts as a long
// delivery toward the alert percentage.
const LONG_TAIL_SECONDS = 300

export function mountMailboxDeliveryTimeStatsRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/mailboxes/delivery-time-stats', async (req, res) => {
    try {
      const window = String(req.query.window || '7d')
      const interval = WINDOWS[window]
      if (!interval) {
        return res.status(400).json({
          error: 'invalid window',
          allowed: Object.keys(WINDOWS),
        })
      }

      // Per-mailbox histogram + long-tail count. EXTRACT EPOCH for
      // delta math; FILTER counters give us the bucket totals in one
      // pass. Status='sent' only — bounced rows have a delivery_time
      // but it represents "time to reject", not relevant here.
      const { rows } = await pool.query(`
        SELECT
          m.id                                                       AS mailbox_id,
          m.from_address                                              AS from_address,
          m.status                                                    AS status,
          m.lifecycle_phase                                           AS lifecycle_phase,
          COALESCE(h.total, 0)                                        AS total,
          COALESCE(h.b_under_30s, 0)                                  AS b_under_30s,
          COALESCE(h.b_30_60s, 0)                                     AS b_30_60s,
          COALESCE(h.b_1_2min, 0)                                     AS b_1_2min,
          COALESCE(h.b_2_5min, 0)                                     AS b_2_5min,
          COALESCE(h.b_5_15min, 0)                                    AS b_5_15min,
          COALESCE(h.b_15_60min, 0)                                   AS b_15_60min,
          COALESCE(h.b_over_60min, 0)                                 AS b_over_60min,
          COALESCE(h.long_tail, 0)                                    AS long_tail_count,
          CASE
            WHEN COALESCE(h.total, 0) = 0 THEN 0
            ELSE ROUND((h.long_tail::numeric / h.total) * 100, 2)
          END                                                         AS long_tail_pct,
          COALESCE(h.p50_seconds, 0)                                  AS p50_seconds,
          COALESCE(h.p95_seconds, 0)                                  AS p95_seconds
        FROM outreach_mailboxes m
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE delta <  30)                       AS b_under_30s,
            COUNT(*) FILTER (WHERE delta >= 30   AND delta <  60)     AS b_30_60s,
            COUNT(*) FILTER (WHERE delta >= 60   AND delta <  120)    AS b_1_2min,
            COUNT(*) FILTER (WHERE delta >= 120  AND delta <  300)    AS b_2_5min,
            COUNT(*) FILTER (WHERE delta >= 300  AND delta <  900)    AS b_5_15min,
            COUNT(*) FILTER (WHERE delta >= 900  AND delta <  3600)   AS b_15_60min,
            COUNT(*) FILTER (WHERE delta >= 3600)                     AS b_over_60min,
            COUNT(*) FILTER (WHERE delta >= ${LONG_TAIL_SECONDS})     AS long_tail,
            COALESCE(PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY delta), 0)::int AS p50_seconds,
            COALESCE(PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY delta), 0)::int AS p95_seconds
          FROM (
            SELECT EXTRACT(EPOCH FROM (sent_at - created_at))::numeric AS delta
            FROM send_events
            WHERE mailbox_used = m.from_address
              AND status = 'sent'
              AND sent_at IS NOT NULL
              AND sent_at >= NOW() - ${interval}
              AND sent_at > created_at -- defensive: drop rows with malformed timestamps
          ) deltas
        ) h ON TRUE
        WHERE m.environment = 'production'
        ORDER BY long_tail_pct DESC, p95_seconds DESC, total DESC NULLS LAST
      `)

      // Fleet rollup — same buckets summed.
      const { rows: fleetRows } = await pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE delta >= ${LONG_TAIL_SECONDS})       AS long_tail,
          COALESCE(PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY delta), 0)::int AS p50_seconds,
          COALESCE(PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY delta), 0)::int AS p95_seconds
        FROM (
          SELECT EXTRACT(EPOCH FROM (sent_at - created_at))::numeric AS delta
          FROM send_events
          WHERE status = 'sent'
            AND sent_at IS NOT NULL
            AND sent_at >= NOW() - ${interval}
            AND sent_at > created_at
        ) deltas
      `)
      const fleetTotal = Number(fleetRows[0]?.total || 0)
      const fleetLongTail = Number(fleetRows[0]?.long_tail || 0)
      const fleetLongTailPct = fleetTotal === 0
        ? 0
        : Math.round((fleetLongTail / fleetTotal) * 100 * 100) / 100

      const mailboxes = rows.map(r => ({
        mailbox_id: Number(r.mailbox_id),
        from_address: r.from_address,
        status: r.status,
        lifecycle_phase: r.lifecycle_phase,
        total: Number(r.total),
        buckets: {
          under_30s:    Number(r.b_under_30s),
          '30_60s':     Number(r.b_30_60s),
          '1_2min':     Number(r.b_1_2min),
          '2_5min':     Number(r.b_2_5min),
          '5_15min':    Number(r.b_5_15min),
          '15_60min':   Number(r.b_15_60min),
          over_60min:   Number(r.b_over_60min),
        },
        long_tail_count: Number(r.long_tail_count),
        long_tail_pct: Number(r.long_tail_pct),
        p50_seconds: Number(r.p50_seconds),
        p95_seconds: Number(r.p95_seconds),
        alert_threshold_breached: Number(r.long_tail_pct) >= ALERT_LONG_TAIL_PCT,
      }))

      res.json({
        window,
        ran_at: new Date().toISOString(),
        threshold_pct: ALERT_LONG_TAIL_PCT,
        long_tail_seconds: LONG_TAIL_SECONDS,
        fleet: {
          total: fleetTotal,
          long_tail_count: fleetLongTail,
          long_tail_pct: fleetLongTailPct,
          p50_seconds: Number(fleetRows[0]?.p50_seconds || 0),
          p95_seconds: Number(fleetRows[0]?.p95_seconds || 0),
        },
        mailboxes,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
