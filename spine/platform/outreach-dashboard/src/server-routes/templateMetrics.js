// templateMetrics.js — Sprint L2 (issue #1287).
//
// GET /api/templates/metrics?window=7d|30d
//
// Per-template performance aggregation: how many sends, opens, replies,
// and spam complaints each template generates in the given window.
// Operator uses this to spot which templates drive replies vs. spam so
// they can retire or iterate.
//
// Response shape (per template):
//   sent_count          — COUNT(send_events WHERE step_template = name AND status = 'sent' AND sent_at >= window)
//   open_count          — COUNT(tracking_events WHERE event = 'open' joined to a send_event in window)
//   reply_count         — COUNT(reply_inbox joined to send_event in window WHERE classification != 'auto_reply')
//   spam_count          — COUNT(reply_inbox joined to send_event in window WHERE classification IN ('negative','unsubscribe'))
//   used_in_campaigns   — array of campaign_ids where sequence_config references this template name
//   open_rate_pct       — derived in JS: (open_count / sent_count) * 100
//   reply_rate_pct      — derived in JS: (reply_count / sent_count) * 100
//   spam_rate_pct       — derived in JS: (spam_count / sent_count) * 100
//   alert_threshold_breached — spam_rate_pct >= SPAM_ALERT_THRESHOLD_PCT
//
// SPAM_ALERT_THRESHOLD_PCT = 0.1 (matches M2 sprint threshold exactly;
// industry standard for provider-visible reputation impact).
// Named constant per HARD RULE feedback_no_magic_thresholds T0.

const WINDOWS = { '7d': "INTERVAL '7 days'", '30d': "INTERVAL '30 days'" }

// 0.1% matches the M2 mailbox-level spam complaint threshold.
// Same numeric value, same industry logic: >0.1% trips provider reputation.
const SPAM_ALERT_THRESHOLD_PCT = 0.1

// Spam-signal classifications (same set as M2 + M5).
const SPAM_CLASSIFICATIONS = ['negative', 'unsubscribe']

export function mountTemplateMetricsRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/templates/metrics', async (req, res) => {
    try {
      const window = String(req.query.window || '7d')
      const interval = WINDOWS[window]
      if (!interval) {
        return res.status(400).json({
          error: 'invalid window',
          allowed: Object.keys(WINDOWS),
        })
      }

      // ── Per-template send / open / reply / spam counts ───────────────────────
      //
      // send_events has `step` (int) + `campaign_id`. Template name is
      // derived from campaigns.sequence_config[step].template (JSONB).
      // We pivot counts for opens (tracking_events WHERE event_type='open')
      // and replies (reply_inbox joined via send_event_id) in a single pass
      // using conditional aggregates.
      //
      // NULL template rows are excluded — they represent non-template sends
      // (direct / fallback) that have no UI name to surface.
      const { rows: metricRows } = await pool.query(`
        SELECT
          c.sequence_config -> se.step ->> 'template'                       AS template_name,
          -- COUNT(DISTINCT se.id), not COUNT(*): the LEFT JOINs to
          -- tracking_events + reply_inbox fan each send_event into N rows,
          -- so a bare COUNT(*) inflated sent_count and understated every rate.
          COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'sent')           AS sent_count,
          COUNT(DISTINCT te.id) FILTER (WHERE te.event_type = 'open')       AS open_count,
          -- IS DISTINCT FROM, not !=: (NULL != 'auto_reply') is NULL (not
          -- true), so a bare != silently dropped every NULL-classified reply.
          COUNT(DISTINCT r.id)  FILTER (
            WHERE r.classification IS DISTINCT FROM 'auto_reply'
          )                                                                  AS reply_count,
          COUNT(DISTINCT r.id)  FILTER (
            WHERE r.classification = ANY($1::text[])
          )                                                                  AS spam_count
        FROM send_events se
        JOIN campaigns c
          ON c.id = se.campaign_id
        LEFT JOIN tracking_events te
          ON te.send_event_id = se.id
        LEFT JOIN reply_inbox r
          ON r.send_event_id = se.id
        WHERE se.sent_at >= NOW() - ${interval}
          AND c.sequence_config -> se.step ->> 'template' IS NOT NULL
        GROUP BY c.sequence_config -> se.step ->> 'template'
        ORDER BY c.sequence_config -> se.step ->> 'template'
      `, [SPAM_CLASSIFICATIONS])

      if (metricRows.length === 0) {
        // No sends in window — return empty result quickly without the
        // campaign scan (avoid pointless large JSONB query on no-data).
        return res.json({
          window,
          ran_at: new Date().toISOString(),
          spam_alert_threshold_pct: SPAM_ALERT_THRESHOLD_PCT,
          templates: [],
        })
      }

      // ── Campaign membership scan ───────────────────────────────────────────
      //
      // sequence_config is JSONB. We scan all campaigns whose config
      // references any of the active template names. The JSONB cast to
      // text + ILIKE approach is intentionally broad (cheaper than
      // recursive JSONB traversal) and safe for read-only diagnostics.
      // Precision is sufficient: a false-positive inclusion is harmless
      // (operator sees an extra campaign reference); false-negative is
      // also low-risk (template still has metric data).
      const templateNames = metricRows.map(r => r.template_name)
      const { rows: campaignRows } = await pool.query(`
        SELECT
          id          AS campaign_id,
          sequence_config::text AS config_text
        FROM campaigns
        WHERE status != 'archived'
          AND sequence_config IS NOT NULL
      `)

      // Build a map: templateName → Set<campaignId>
      const campaignMap = new Map()
      for (const name of templateNames) {
        campaignMap.set(name, new Set())
      }
      for (const row of campaignRows) {
        const cfgText = row.config_text || ''
        for (const name of templateNames) {
          if (cfgText.includes(name)) {
            campaignMap.get(name).add(Number(row.campaign_id))
          }
        }
      }

      // ── Assemble final response ───────────────────────────────────────────
      const templates = metricRows.map(r => {
        const sent   = Number(r.sent_count)  || 0
        const opens  = Number(r.open_count)  || 0
        const replies = Number(r.reply_count) || 0
        const spams  = Number(r.spam_count)  || 0

        const openRatePct  = sent === 0 ? 0 : Math.round((opens   / sent) * 10000) / 100
        const replyRatePct = sent === 0 ? 0 : Math.round((replies / sent) * 10000) / 100
        const spamRatePct  = sent === 0 ? 0 : Math.round((spams   / sent) * 10000) / 100

        return {
          template_name: r.template_name,
          sent_count: sent,
          open_count: opens,
          reply_count: replies,
          spam_count: spams,
          open_rate_pct: openRatePct,
          reply_rate_pct: replyRatePct,
          spam_rate_pct: spamRatePct,
          used_in_campaigns: [...(campaignMap.get(r.template_name) || [])],
          alert_threshold_breached: spamRatePct >= SPAM_ALERT_THRESHOLD_PCT,
        }
      })

      // Sort: reply_rate_pct DESC then sent_count DESC
      templates.sort((a, b) =>
        b.reply_rate_pct - a.reply_rate_pct || b.sent_count - a.sent_count,
      )

      res.json({
        window,
        ran_at: new Date().toISOString(),
        spam_alert_threshold_pct: SPAM_ALERT_THRESHOLD_PCT,
        templates,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
