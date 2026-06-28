// mailboxReputationHistory.js — Sprint M6 (issue #1272).
//
// GET /api/mailboxes/reputation-history?days=30
//
// Historical reputation scores per mailbox — sparkline data for the
// last N days. Reuses M5 weighting formula for consistency. Response:
// { mailboxes: [{ id, email, history: [{ date, score }] }] }
//
// Thresholds and weights are the same as M5. Query validates 1-90 days
// (default 30).

const WEIGHTS = { bounce: 0.40, spam: 0.30, delivery: 0.15, auth: 0.15 }

const T_BOUNCE_PCT     = 2.0
const T_SPAM_PCT       = 0.1
const T_DELIVERY_PCT   = 5.0
const T_AUTH_LOCKS     = 3

function subScore(value, threshold) {
  if (!Number.isFinite(value) || value <= 0) return 100
  const decay = (value / threshold) * 50
  return Math.max(0, Math.round(100 - decay))
}

function computeScore(sent, bounced, complaints, longTail, authLocks) {
  const bouncePct = sent + bounced === 0 ? 0 : (bounced / (sent + bounced)) * 100
  const spamPct = sent === 0 ? 0 : (complaints / sent) * 100
  const deliveryPct = sent === 0 ? 0 : (longTail / sent) * 100

  const subBounce   = subScore(bouncePct, T_BOUNCE_PCT)
  const subSpam     = subScore(spamPct, T_SPAM_PCT)
  const subDelivery = subScore(deliveryPct, T_DELIVERY_PCT)
  const subAuth     = subScore(authLocks, T_AUTH_LOCKS)

  return Math.round(
    subBounce   * WEIGHTS.bounce   +
    subSpam     * WEIGHTS.spam     +
    subDelivery * WEIGHTS.delivery +
    subAuth     * WEIGHTS.auth,
  )
}

export function mountMailboxReputationHistoryRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/mailboxes/reputation-history', async (req, res) => {
    try {
      const daysParam = Number(req.query.days || 30)
      const days = Math.max(1, Math.min(90, daysParam))

      if (!Number.isFinite(daysParam) || daysParam < 1 || daysParam > 90) {
        return res.status(400).json({
          error: 'invalid days param',
          allowed: 'integer 1-90',
        })
      }

      // Per mailbox + per calendar day: compute bounce/spam/delivery/auth
      // signals from send_events and reply_inbox windowed by day.
      const { rows } = await pool.query(`
        WITH mailbox_list AS (
          SELECT id, from_address
          FROM outreach_mailboxes
          WHERE environment = 'production'
        ),
        day_series AS (
          SELECT CAST(d AS DATE) AS day
          FROM GENERATE_SERIES(
            NOW()::DATE - ($1::INT - 1) * INTERVAL '1 day',
            NOW()::DATE,
            INTERVAL '1 day'
          ) AS d
        ),
        send_by_day AS (
          SELECT
            m.id AS mailbox_id,
            CAST(se.sent_at::DATE AS DATE) AS day,
            COUNT(*) FILTER (WHERE se.status = 'sent')     AS sent,
            COUNT(*) FILTER (WHERE se.status = 'bounced')  AS bounced,
            COUNT(*) FILTER (
              WHERE se.status = 'sent'
                AND se.sent_at IS NOT NULL
                AND se.sent_at > se.created_at
                AND EXTRACT(EPOCH FROM (se.sent_at - se.created_at)) >= 300
            )                                              AS long_tail
          FROM mailbox_list m
          LEFT JOIN send_events se
            ON se.mailbox_used = m.from_address
            AND se.sent_at >= NOW()::DATE - ($1::INT - 1) * INTERVAL '1 day'
          GROUP BY m.id, CAST(se.sent_at::DATE AS DATE)
        ),
        spam_by_day AS (
          SELECT
            m.id AS mailbox_id,
            CAST(ri.received_at::DATE AS DATE) AS day,
            COUNT(*) AS complaints
          FROM mailbox_list m
          LEFT JOIN reply_inbox ri
            ON ri.mailbox_id = m.id
            AND ri.classification IN ('negative', 'unsubscribe')
            AND ri.received_at >= NOW()::DATE - ($1::INT - 1) * INTERVAL '1 day'
          GROUP BY m.id, CAST(ri.received_at::DATE AS DATE)
        ),
        auth_by_day AS (
          SELECT
            m.id AS mailbox_id,
            CAST(ma.created_at::DATE AS DATE) AS day,
            COUNT(*) AS auth_locks
          FROM mailbox_list m
          LEFT JOIN mailbox_alerts ma
            ON ma.mailbox_id = m.id
            AND ma.type = 'auth_locked'
            AND ma.created_at >= NOW()::DATE - ($1::INT - 1) * INTERVAL '1 day'
          GROUP BY m.id, CAST(ma.created_at::DATE AS DATE)
        )
        SELECT
          m.id                              AS mailbox_id,
          m.from_address                    AS from_address,
          ds.day,
          COALESCE(sb.sent, 0)              AS sent,
          COALESCE(sb.bounced, 0)           AS bounced,
          COALESCE(sb.long_tail, 0)         AS long_tail,
          COALESCE(sp.complaints, 0)        AS complaints,
          COALESCE(ab.auth_locks, 0)        AS auth_locks
        FROM mailbox_list m
        CROSS JOIN day_series ds
        LEFT JOIN send_by_day sb
          ON sb.mailbox_id = m.id AND sb.day = ds.day
        LEFT JOIN spam_by_day sp
          ON sp.mailbox_id = m.id AND sp.day = ds.day
        LEFT JOIN auth_by_day ab
          ON ab.mailbox_id = m.id AND ab.day = ds.day
        ORDER BY m.from_address, ds.day
      `, [days])

      const historyByMailbox = {}
      for (const row of rows) {
        const key = `${row.mailbox_id}|${row.from_address}`
        if (!historyByMailbox[key]) {
          historyByMailbox[key] = {
            mailbox_id: Number(row.mailbox_id),
            from_address: row.from_address,
            history: [],
          }
        }

        const score = computeScore(
          Number(row.sent),
          Number(row.bounced),
          Number(row.complaints),
          Number(row.long_tail),
          Number(row.auth_locks),
        )

        historyByMailbox[key].history.push({
          date: row.day.toISOString().split('T')[0],
          score,
        })
      }

      const mailboxes = Object.values(historyByMailbox)

      res.json({
        days,
        ran_at: new Date().toISOString(),
        weights: WEIGHTS,
        thresholds: {
          bounce_pct: T_BOUNCE_PCT,
          spam_pct: T_SPAM_PCT,
          delivery_long_tail_pct: T_DELIVERY_PCT,
          auth_locks: T_AUTH_LOCKS,
        },
        mailboxes,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
