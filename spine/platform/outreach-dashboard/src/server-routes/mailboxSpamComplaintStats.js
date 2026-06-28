// mailboxSpamComplaintStats.js — Sprint M2 (issue #1272).
//
// GET /api/mailboxes/spam-complaint-stats?window=24h|7d|30d
//
// "Spam complaint rate" in this codebase = inbound replies classified
// as 'negative' or 'unsubscribe', expressed as a fraction of sends
// from the same mailbox in the same window. We don't yet wire FBL
// (Feedback Loop) reports from receivers — they require domain
// ownership + ARF format ingestion. Operator-driven classification
// (and the keyword classifier) is the best proxy until then.
//
// Industry standard: >0.1% spam complaint rate from a mailbox is the
// point where receiving providers start downgrading inbox placement.
// Gmail's bulk-sender threshold is 0.3% but operators should react
// long before that.
//
// Response shape mirrors mailboxBounceStats for consistency — the UI
// pivots windows the same way and the alert flag uses the same name.

const WINDOWS = {
  '24h': "INTERVAL '24 hours'",
  '7d':  "INTERVAL '7 days'",
  '30d': "INTERVAL '30 days'",
}

// Treat negative + unsubscribe replies as spam complaints. Question /
// auto_reply / positive / unmatched are excluded (they are not signals
// that the recipient considered the mail abusive).
const COMPLAINT_CLASSIFICATIONS = ['negative', 'unsubscribe']

// Industry standard: 0.1% trips reputation; Gmail's 0.3% explicit cap
// is for bulk senders (5k+/day). We alert at 0.1% to give operator
// runway before any provider acts.
const ALERT_THRESHOLD_PCT = 0.1

export function mountMailboxSpamComplaintStatsRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/mailboxes/spam-complaint-stats', async (req, res) => {
    try {
      const window = String(req.query.window || '7d')
      const interval = WINDOWS[window]
      if (!interval) {
        return res.status(400).json({
          error: 'invalid window',
          allowed: Object.keys(WINDOWS),
        })
      }

      // Per-mailbox: sent count from send_events + complaint count from
      // reply_inbox where classification IN (negative,unsubscribe).
      // LEFT JOIN LATERAL so mailboxes with zero sends still appear.
      const { rows } = await pool.query(`
        SELECT
          m.id                                                       AS mailbox_id,
          m.from_address                                              AS from_address,
          m.status                                                    AS status,
          m.lifecycle_phase                                           AS lifecycle_phase,
          COALESCE(send_stats.sent, 0)                                AS sent,
          COALESCE(complaint_stats.complaints, 0)                     AS complaints,
          CASE
            WHEN COALESCE(send_stats.sent, 0) = 0 THEN 0
            ELSE ROUND(
              (complaint_stats.complaints::numeric / NULLIF(send_stats.sent, 0)) * 100,
              3
            )
          END                                                         AS complaint_rate_pct
        FROM outreach_mailboxes m
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE status = 'sent') AS sent
          FROM send_events
          WHERE mailbox_used = m.from_address
            AND sent_at >= NOW() - ${interval}
        ) send_stats ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS complaints
          FROM reply_inbox r
          WHERE r.mailbox_id = m.id
            AND r.classification = ANY($1::text[])
            AND r.received_at >= NOW() - ${interval}
        ) complaint_stats ON TRUE
        WHERE m.environment = 'production'
        ORDER BY complaint_rate_pct DESC, sent DESC NULLS LAST
      `, [COMPLAINT_CLASSIFICATIONS])

      // Fleet rollup — same window. Sent across all production mailboxes
      // + total complaints. Complaints are joined to mailboxes via
      // reply_inbox.mailbox_id (NULL = orphan, excluded from per-mailbox
      // attribution but kept out of the fleet rollup too — operator can
      // see orphans separately in /replies).
      const { rows: fleetRows } = await pool.query(`
        SELECT
          (SELECT COUNT(*)
             FROM send_events se
             JOIN outreach_mailboxes m ON m.from_address = se.mailbox_used
            WHERE se.status = 'sent'
              AND m.environment = 'production'
              AND se.sent_at >= NOW() - ${interval})             AS sent,
          (SELECT COUNT(*)
             FROM reply_inbox
            WHERE classification = ANY($1::text[])
              AND mailbox_id IS NOT NULL
              AND received_at >= NOW() - ${interval})            AS complaints
      `, [COMPLAINT_CLASSIFICATIONS])
      const fleetSent = Number(fleetRows[0]?.sent || 0)
      const fleetComplaints = Number(fleetRows[0]?.complaints || 0)
      const fleetComplaintRatePct =
        fleetSent === 0
          ? 0
          : Math.round((fleetComplaints / fleetSent) * 100 * 1000) / 1000

      const mailboxes = rows.map(r => ({
        mailbox_id: Number(r.mailbox_id),
        from_address: r.from_address,
        status: r.status,
        lifecycle_phase: r.lifecycle_phase,
        sent: Number(r.sent),
        complaints: Number(r.complaints),
        complaint_rate_pct: Number(r.complaint_rate_pct),
        alert_threshold_breached: Number(r.complaint_rate_pct) >= ALERT_THRESHOLD_PCT,
      }))

      res.json({
        window,
        ran_at: new Date().toISOString(),
        threshold_pct: ALERT_THRESHOLD_PCT,
        complaint_classifications: COMPLAINT_CLASSIFICATIONS,
        fleet: {
          sent: fleetSent,
          complaints: fleetComplaints,
          complaint_rate_pct: fleetComplaintRatePct,
        },
        mailboxes,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
