// funnelSummary.js — FUN-1.4
// GET /api/funnel/summary?days=N&campaign_id=X&template_name=T
//
// Returns the marketing funnel for the requested time window:
//   { sent, opened, replied, classified_engagement, lead_created, lead_won }
// Plus per-stage drop-off percentages.
// Optionally filtered by campaign_id or template_name.
//
// All thresholds as named constants (feedback_no_magic_thresholds T0).

// Named constants — no magic literals.
const DEFAULT_FUNNEL_DAYS = 14
const MAX_FUNNEL_DAYS = 90

/**
 * Mount the funnel summary route on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountFunnelSummaryRoute(app, { pool, capture500, safeError }) {
  app.get('/api/funnel/summary', async (req, res) => {
    try {
      const days = Math.min(
        Math.max(parseInt(req.query.days, 10) || DEFAULT_FUNNEL_DAYS, 1),
        MAX_FUNNEL_DAYS,
      )
      const campaignId = req.query.campaign_id ? Number(req.query.campaign_id) : null
      const templateName = req.query.template_name ? String(req.query.template_name) : null

      if (campaignId !== null && (!Number.isFinite(campaignId) || campaignId <= 0)) {
        return res.status(400).json({ error: 'campaign_id musí být kladné číslo.' })
      }

      // Build dynamic WHERE clauses.
      const conditions = [`occurred_at > now() - ($1 || ' days')::interval`]
      const params = [days]

      if (campaignId !== null) {
        params.push(campaignId)
        conditions.push(`campaign_id = $${params.length}`)
      }
      if (templateName !== null) {
        params.push(templateName)
        conditions.push(`template_name = $${params.length}`)
      }

      const where = conditions.join(' AND ')

      // Main funnel aggregation.
      const { rows: [agg] } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_type = 'sent')::int                   AS sent,
           COUNT(*) FILTER (WHERE event_type = 'opened')::int                 AS opened,
           COUNT(*) FILTER (WHERE event_type = 'replied')::int                AS replied,
           COUNT(*) FILTER (WHERE event_type = 'classified_engagement')::int  AS classified_engagement,
           COUNT(*) FILTER (WHERE event_type = 'lead_created')::int           AS lead_created,
           COUNT(*) FILTER (WHERE event_type = 'lead_won')::int               AS lead_won,
           COUNT(*) FILTER (WHERE event_type = 'lead_lost')::int              AS lead_lost,
           COUNT(*) FILTER (WHERE event_type = 'classified_negative')::int    AS classified_negative,
           COUNT(*) FILTER (WHERE event_type = 'classified_bounce')::int      AS classified_bounce,
           COUNT(*) FILTER (WHERE event_type = 'suppressed')::int             AS suppressed
         FROM funnel_events
         WHERE ${where}`,
        params,
      )

      // Per-template comparison (last 30d, top 10 by sent count).
      // Always includes template data regardless of filter — allows the UI
      // to render the comparison table independently.
      const templateDays = Math.min(30, MAX_FUNNEL_DAYS)
      const { rows: templateRows } = await pool.query(
        `SELECT
           COALESCE(template_name, '(geen sjabloon)') AS template_name,
           COUNT(*) FILTER (WHERE event_type = 'sent')::int                   AS sent,
           COUNT(*) FILTER (WHERE event_type = 'replied')::int                AS replied,
           COUNT(*) FILTER (WHERE event_type = 'classified_engagement')::int  AS engaged,
           COUNT(*) FILTER (WHERE event_type = 'lead_created')::int           AS leads
         FROM funnel_events
         WHERE occurred_at > now() - ($1 || ' days')::interval
         GROUP BY template_name
         ORDER BY sent DESC
         LIMIT 10`,
        [templateDays],
      )

      // Daily timeseries (last N days, defaulting to DEFAULT_FUNNEL_DAYS).
      const { rows: timelineRows } = await pool.query(
        `SELECT
           TO_CHAR(DATE_TRUNC('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           COUNT(*) FILTER (WHERE event_type = 'sent')::int                   AS sent,
           COUNT(*) FILTER (WHERE event_type = 'replied')::int                AS replied,
           COUNT(*) FILTER (WHERE event_type = 'lead_created')::int           AS lead_created
         FROM funnel_events
         WHERE occurred_at > now() - ($1 || ' days')::interval
         GROUP BY 1
         ORDER BY 1`,
        [days],
      )

      // Fill in missing days so the timeseries has no gaps.
      const timelineMap = Object.fromEntries(timelineRows.map(r => [r.day, r]))
      const timeline = []
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        const key = d.toISOString().slice(0, 10)
        timeline.push(timelineMap[key] ?? { day: key, sent: 0, replied: 0, lead_created: 0 })
      }

      // Compute drop-off percentages.
      const sent = agg.sent || 0
      const opened = agg.opened || 0
      const replied = agg.replied || 0
      const engaged = agg.classified_engagement || 0
      const leadCreated = agg.lead_created || 0
      const leadWon = agg.lead_won || 0

      const pct = (num, denom) =>
        denom > 0 ? Math.round((num / denom) * 1000) / 10 : null

      const funnel = {
        sent,
        opened,
        replied,
        classified_engagement: engaged,
        lead_created: leadCreated,
        lead_won: leadWon,
        classified_negative: agg.classified_negative || 0,
        classified_bounce: agg.classified_bounce || 0,
        suppressed: agg.suppressed || 0,
        lead_lost: agg.lead_lost || 0,
        dropoffs: {
          sent_to_opened:    pct(opened,      sent),
          sent_to_replied:   pct(replied,     sent),
          replied_to_engaged: pct(engaged,    replied),
          engaged_to_lead:   pct(leadCreated, engaged),
          lead_to_won:       pct(leadWon,     leadCreated),
        },
      }

      // Per-template reply_rate computed server-side.
      const templates = templateRows.map(r => ({
        template_name: r.template_name,
        sent: r.sent,
        replied: r.replied,
        engaged: r.engaged,
        leads: r.leads,
        reply_rate_pct: pct(r.replied, r.sent),
        engage_rate_pct: pct(r.engaged, r.sent),
      }))

      res.json({
        days,
        campaign_id: campaignId,
        template_name: templateName,
        funnel,
        templates,
        timeline,
        default_funnel_days: DEFAULT_FUNNEL_DAYS,
        ran_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
