// mailboxReputationScore.js — Sprint M5 (issue #1272).
//
// GET /api/mailboxes/reputation-score?window=7d|30d
//
// Composite reputation score per mailbox: weighted sum of the four
// signals already surfaced by M1-M4 panels. Single number 0-100 the
// operator can sort by; greater = healthier.
//
// Weighting (Sprint M5 spec):
//   - Bounce rate     40% — strongest deliverability signal; 0% = 100pts
//   - Spam complaint  30% — drives provider reputation; 0% = 100pts
//   - Delivery time   15% — long_tail_pct over 5min bucket; 0% = 100pts
//   - Auth failures   15% — IMAP/SMTP credential events from mailbox
//                            alerts type='auth_locked'; 0 = 100pts
//
// Each signal converts to a 0-100 sub-score via linear-decay against
// its own alert threshold:
//   sub_score = max(0, 100 - (signal_value / threshold) * 50)
// At threshold the sub-score is 50 (yellow); at 2× threshold = 0.
// This keeps green/yellow/red bands intuitive on a single axis.
//
// Final reputation score is the weighted sum. Alert flag fires below
// 70 (matches the AP1 mailbox_score loop threshold so the existing
// scoring cron and this panel agree on "degraded").

const WINDOWS = { '7d': "INTERVAL '7 days'", '30d': "INTERVAL '30 days'" }

const WEIGHTS = { bounce: 0.40, spam: 0.30, delivery: 0.15, auth: 0.15 }

// Thresholds map to M1-M4 panel alerts. Same numbers, single source.
const T_BOUNCE_PCT     = 2.0   // M1
const T_SPAM_PCT       = 0.1   // M2
const T_DELIVERY_PCT   = 5.0   // M3 long-tail %
const T_AUTH_LOCKS     = 3     // # of auth_locked alerts in window

const ALERT_THRESHOLD_SCORE = 70

function subScore(value, threshold) {
  if (!Number.isFinite(value) || value <= 0) return 100
  const decay = (value / threshold) * 50
  return Math.max(0, Math.round(100 - decay))
}

export function mountMailboxReputationScoreRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/mailboxes/reputation-score', async (req, res) => {
    try {
      const window = String(req.query.window || '7d')
      const interval = WINDOWS[window]
      if (!interval) {
        return res.status(400).json({
          error: 'invalid window',
          allowed: Object.keys(WINDOWS),
        })
      }

      // Pull all four signals per mailbox in one query. The percentile
      // is overkill for reputation scoring so we just join bounce/spam/
      // delivery counts + auth alerts and compute in JS.
      const { rows } = await pool.query(`
        WITH send_window AS (
          SELECT
            mailbox_used,
            COUNT(*) FILTER (WHERE status = 'sent')     AS sent,
            COUNT(*) FILTER (WHERE status = 'bounced')  AS bounced,
            COUNT(*) FILTER (
              WHERE status = 'sent'
                AND sent_at IS NOT NULL
                AND sent_at > created_at
                AND EXTRACT(EPOCH FROM (sent_at - created_at)) >= 300
            )                                            AS long_tail
          FROM send_events
          WHERE sent_at >= NOW() - ${interval}
          GROUP BY mailbox_used
        ),
        spam_window AS (
          SELECT
            mailbox_id,
            COUNT(*) AS complaints
          FROM reply_inbox
          WHERE classification IN ('negative', 'unsubscribe')
            AND received_at >= NOW() - ${interval}
          GROUP BY mailbox_id
        ),
        auth_window AS (
          SELECT
            mailbox_id,
            COUNT(*) AS auth_locks
          FROM mailbox_alerts
          WHERE type = 'auth_locked'
            AND created_at >= NOW() - ${interval}
          GROUP BY mailbox_id
        )
        SELECT
          m.id                                                       AS mailbox_id,
          m.from_address                                              AS from_address,
          m.status                                                    AS status,
          m.lifecycle_phase                                           AS lifecycle_phase,
          COALESCE(s.sent, 0)                                         AS sent,
          COALESCE(s.bounced, 0)                                      AS bounced,
          COALESCE(s.long_tail, 0)                                    AS long_tail,
          COALESCE(spam.complaints, 0)                                AS complaints,
          COALESCE(auth.auth_locks, 0)                                AS auth_locks
        FROM outreach_mailboxes m
        LEFT JOIN send_window s    ON s.mailbox_used = m.from_address
        LEFT JOIN spam_window spam ON spam.mailbox_id = m.id
        LEFT JOIN auth_window auth ON auth.mailbox_id = m.id
        WHERE m.environment = 'production'
      `)

      const mailboxes = rows.map(r => {
        const sent = Number(r.sent)
        const bounced = Number(r.bounced)
        const longTail = Number(r.long_tail)
        const complaints = Number(r.complaints)
        const authLocks = Number(r.auth_locks)

        const bouncePct = sent + bounced === 0 ? 0 : (bounced / (sent + bounced)) * 100
        const spamPct = sent === 0 ? 0 : (complaints / sent) * 100
        const deliveryPct = sent === 0 ? 0 : (longTail / sent) * 100

        const subBounce   = subScore(bouncePct, T_BOUNCE_PCT)
        const subSpam     = subScore(spamPct, T_SPAM_PCT)
        const subDelivery = subScore(deliveryPct, T_DELIVERY_PCT)
        const subAuth     = subScore(authLocks, T_AUTH_LOCKS)

        const score = Math.round(
          subBounce   * WEIGHTS.bounce   +
          subSpam     * WEIGHTS.spam     +
          subDelivery * WEIGHTS.delivery +
          subAuth     * WEIGHTS.auth,
        )

        return {
          mailbox_id: Number(r.mailbox_id),
          from_address: r.from_address,
          status: r.status,
          lifecycle_phase: r.lifecycle_phase,
          reputation_score: score,
          alert_threshold_breached: score < ALERT_THRESHOLD_SCORE,
          inputs: {
            sent,
            bounced,
            bounce_rate_pct: Math.round(bouncePct * 100) / 100,
            complaints,
            spam_rate_pct: Math.round(spamPct * 1000) / 1000,
            long_tail_count: longTail,
            delivery_long_tail_pct: Math.round(deliveryPct * 100) / 100,
            auth_locks: authLocks,
          },
          sub_scores: {
            bounce: subBounce,
            spam: subSpam,
            delivery: subDelivery,
            auth: subAuth,
          },
        }
      })

      // Sort lowest score (worst) first so operator sees problems on top.
      mailboxes.sort((a, b) => a.reputation_score - b.reputation_score)

      const fleetAvg =
        mailboxes.length === 0
          ? 100
          : Math.round(
              mailboxes.reduce((s, m) => s + m.reputation_score, 0) / mailboxes.length,
            )

      res.json({
        window,
        ran_at: new Date().toISOString(),
        threshold_score: ALERT_THRESHOLD_SCORE,
        weights: WEIGHTS,
        thresholds: {
          bounce_pct: T_BOUNCE_PCT,
          spam_pct: T_SPAM_PCT,
          delivery_long_tail_pct: T_DELIVERY_PCT,
          auth_locks: T_AUTH_LOCKS,
        },
        fleet: {
          mailbox_count: mailboxes.length,
          avg_score: fleetAvg,
          below_threshold: mailboxes.filter(m => m.alert_threshold_breached).length,
        },
        mailboxes,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
