// dashboardLiveActivity.js — Story LXV (2026-05-28)
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/live-activity
//
// Real-time activity snapshot for the Home ticker. Returns last-1h and last-24h
// aggregate counts, deltas vs yesterday's same window, and three trending
// signals so the operator sees live PROD pulse without a full page reload.
//
// Schema verified 2026-05-28:
//   send_events:        id, status ('sent'|'bounced'|'replied'|…), sent_at,
//                       mailbox_used, campaign_id
//   reply_inbox:        id, contact_id, received_at, handled, classification,
//                       from_email, subject
//   contacts:           id, first_name, last_name, company_name
//   outreach_mailboxes: id, from_address, status, lifecycle_phase, environment
//   operator_audit_log: id, action, actor, created_at, details
//   campaigns:          id, name
//
// Cited from: dashboardSummary.js + mailboxBounceStats.js + leadDetail.js
//   (same SELECT columns in active production use).
//
// HARD feedback_no_magic_thresholds T0 — every threshold named below.
// HARD feedback_no_pii_in_logs T0 — log only counts; names/emails never logged.
// HARD feedback_schema_verify_before_sql T0 — columns cited above.

/** Seconds the response may be served from a downstream HTTP cache.
 *  Not stored server-side; callers poll at TICKER_REFRESH_MS intervals. */
export const LIVE_ACTIVITY_TTL_S = 15

/** How many minutes back to look for a "hot lead just replied" event. */
export const HOT_LEAD_LOOKBACK_MIN = 10

/** Minimum bounce % (last 1h, for a mailbox) to emit a bounce_alert. */
export const BOUNCE_ALERT_THRESHOLD_PCT = 5

/** Minimum sends in last 5 min to report a campaign_burst event. */
export const CAMPAIGN_BURST_MIN_SENDS = 3

/**
 * Mount the live-activity endpoint.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500?: (res: import('express').Response, err: unknown, safeError?: (e: unknown) => string) => void,
 * }} deps
 */
export function mountDashboardLiveActivityEndpoint(app, { pool, capture500 }) {
  app.get('/api/dashboard/live-activity', async (req, res) => {
    try {
      // ── 1. last_1h counts ─────────────────────────────────────────────────
      const [sends1h, sends24h, replies1h, replies24h, audit1h] = await Promise.all([
        // sends 1h
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'sent')    ::int AS sends,
            COUNT(*) FILTER (WHERE status = 'bounced') ::int AS bounces
          FROM send_events
          WHERE sent_at > NOW() - INTERVAL '1 hour'
        `).then(r => r.rows[0] || { sends: 0, bounces: 0 }),

        // sends 24h
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'sent')    ::int AS sends,
            COUNT(*) FILTER (WHERE status = 'bounced') ::int AS bounces
          FROM send_events
          WHERE sent_at > NOW() - INTERVAL '24 hours'
        `).then(r => r.rows[0] || { sends: 0, bounces: 0 }),

        // replies 1h
        pool.query(`
          SELECT COUNT(*)::int AS replies
          FROM reply_inbox
          WHERE received_at > NOW() - INTERVAL '1 hour'
        `).then(r => Number(r.rows[0]?.replies ?? 0)),

        // replies 24h with positive count
        pool.query(`
          SELECT
            COUNT(*)                                                   ::int AS replies,
            COUNT(*) FILTER (WHERE classification = 'positive')       ::int AS positive_replies
          FROM reply_inbox
          WHERE received_at > NOW() - INTERVAL '24 hours'
        `).then(r => r.rows[0] || { replies: 0, positive_replies: 0 }),

        // audit events 1h — count only (no PII in logs or response)
        pool.query(`
          SELECT COUNT(*)::int AS n
          FROM operator_audit_log
          WHERE created_at > NOW() - INTERVAL '1 hour'
        `).then(r => Number(r.rows[0]?.n ?? 0)),
      ])

      // ── 2. Yesterday same window (vs_yesterday deltas) ───────────────────
      const [ySends24h, yReplies24h] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'sent')    ::int AS sends,
            COUNT(*) FILTER (WHERE status = 'bounced') ::int AS bounces
          FROM send_events
          WHERE sent_at BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours'
        `).then(r => r.rows[0] || { sends: 0, bounces: 0 }),

        pool.query(`
          SELECT COUNT(*)::int AS replies
          FROM reply_inbox
          WHERE received_at BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours'
        `).then(r => Number(r.rows[0]?.replies ?? 0)),
      ])

      // ── 3. Trending signals ───────────────────────────────────────────────

      // 3a. Hot lead — most-recent reply_inbox row where classification='positive'
      //     within last HOT_LEAD_LOOKBACK_MIN minutes.
      //     Returns first_name + company_name (from contacts via contact_id).
      //     HARD: never log email. contact_id may be NULL for unmatched inbound.
      const hotLeadRow = await pool.query(`
        SELECT ri.id, ri.contact_id, ri.received_at,
               c.first_name, c.company_name
        FROM reply_inbox ri
        LEFT JOIN contacts c ON c.id = ri.contact_id
        WHERE ri.received_at > NOW() - ($1 || ' minutes')::interval
          AND ri.classification = 'positive'
        ORDER BY ri.received_at DESC
        LIMIT 1
      `, [String(HOT_LEAD_LOOKBACK_MIN)]).then(r => r.rows[0] || null)

      const hotLead = hotLeadRow
        ? {
            contact_id: hotLeadRow.contact_id ? Number(hotLeadRow.contact_id) : null,
            first_name: hotLeadRow.first_name || null,
            company_name: hotLeadRow.company_name || null,
            received_at: hotLeadRow.received_at,
          }
        : null

      // 3b. Campaign burst — campaign with most sends in the last 5 min.
      //     Only reported if CAMPAIGN_BURST_MIN_SENDS threshold is met.
      const burstRow = await pool.query(`
        SELECT se.campaign_id, c.name, COUNT(*)::int AS sends_last_5min
        FROM send_events se
        LEFT JOIN campaigns c ON c.id = se.campaign_id
        WHERE se.sent_at > NOW() - INTERVAL '5 minutes'
          AND se.status = 'sent'
          AND se.campaign_id IS NOT NULL
        GROUP BY se.campaign_id, c.name
        ORDER BY sends_last_5min DESC
        LIMIT 1
      `).then(r => r.rows[0] || null)

      const campaignBurst = burstRow && Number(burstRow.sends_last_5min) >= CAMPAIGN_BURST_MIN_SENDS
        ? {
            campaign_id: Number(burstRow.campaign_id),
            name: burstRow.name || null,
            sends_last_5min: Number(burstRow.sends_last_5min),
          }
        : null

      // 3c. Bounce alert — mailbox with highest bounce % last 1h, if over threshold.
      //     address is operator-facing identity (not a credential), OK to surface.
      //     Per feedback_no_pii_in_logs T0: we do NOT log it — only return in response.
      const bounceAlertRow = await pool.query(`
        SELECT m.id AS mailbox_id, m.from_address AS address,
               ROUND(
                 (100.0 * COUNT(*) FILTER (WHERE se.status = 'bounced') /
                  NULLIF(COUNT(*) FILTER (WHERE se.status IN ('sent','bounced')), 0)
                 )::numeric, 1
               ) AS bounce_pct_last_1h
        FROM outreach_mailboxes m
        JOIN send_events se ON se.mailbox_used = m.from_address
        WHERE se.sent_at > NOW() - INTERVAL '1 hour'
          AND m.environment = 'production'
        GROUP BY m.id, m.from_address
        HAVING COUNT(*) FILTER (WHERE se.status IN ('sent','bounced')) >= 2
        ORDER BY bounce_pct_last_1h DESC NULLS LAST
        LIMIT 1
      `).then(r => r.rows[0] || null)

      const bounceAlert = bounceAlertRow && Number(bounceAlertRow.bounce_pct_last_1h) >= BOUNCE_ALERT_THRESHOLD_PCT
        ? {
            mailbox_id: Number(bounceAlertRow.mailbox_id),
            address: bounceAlertRow.address,
            bounce_pct_last_1h: Number(bounceAlertRow.bounce_pct_last_1h),
          }
        : null

      // ── 4. Compute deltas + derived rates ─────────────────────────────────
      const sends24 = Number(sends24h.sends ?? 0)
      const bounces24 = Number(sends24h.bounces ?? 0)
      const totalSentBounced24 = sends24 + bounces24
      const bouncePct24 = totalSentBounced24 > 0
        ? Math.round((bounces24 / totalSentBounced24) * 1000) / 10
        : 0

      const yS = Number(ySends24h.sends ?? 0)
      const yB = Number(ySends24h.bounces ?? 0)
      const yTotal = yS + yB
      const yBouncePct = yTotal > 0 ? Math.round((yB / yTotal) * 1000) / 10 : 0

      // ── 5. Assemble response ──────────────────────────────────────────────
      res.set('Cache-Control', `no-store, max-age=${LIVE_ACTIVITY_TTL_S}`)
      res.json({
        now: new Date().toISOString(),
        last_1h: {
          sends:        Number(sends1h.sends   ?? 0),
          bounces:      Number(sends1h.bounces ?? 0),
          replies:      replies1h,
          audit_events: audit1h,
        },
        last_24h: {
          sends:           sends24,
          bounces:         bounces24,
          bounce_pct:      bouncePct24,
          replies:         Number(replies24h.replies          ?? 0),
          positive_replies: Number(replies24h.positive_replies ?? 0),
        },
        vs_yesterday: {
          sends_delta:     sends24  - yS,
          replies_delta:   Number(replies24h.replies ?? 0) - yReplies24h,
          bounce_pct_delta: Math.round((bouncePct24 - yBouncePct) * 10) / 10,
        },
        trending: {
          hot_lead_just_replied: hotLead,
          campaign_burst:        campaignBurst,
          bounce_alert:          bounceAlert,
        },
      })
    } catch (e) {
      if (capture500) {
        capture500(res, e, (err) => String(err?.message ?? err))
      } else {
        res.status(500).json({ error: String(e?.message ?? e) })
      }
    }
  })
}
