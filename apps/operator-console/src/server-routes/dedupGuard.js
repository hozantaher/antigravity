// Dedup Guard operator panel — per-axis blocking statistics, segment funnel,
// recent skip events. Read-only summary surface for campaign contact lifecycle.
// ────────────────────────────────────────────────────────────────────────────────
// Sprint F1 (2026-05-05): new monitoring surface combining 8 dedup axes.
// Sprint F1.1 (hardening, 2026-05-05): time-window filter, limit=0 fix,
//   "why blocked?" lookup endpoint, threshold config support.
//
// Endpoints:
//   GET /api/dedup-guard/stats?window=all|24h|7d|30d — per-axis blocking counts
//   GET /api/dedup-guard/segment-funnel?id=N         — segment eligibility waterfall
//   GET /api/dedup-guard/recent-skips?limit=N        — last N skip events (PII-free)
//   GET /api/dedup-guard/contact-block-reason?id=N   — why was this contact blocked?

// ── Allowed time-window values for the stats endpoint ─────────────────────────
const VALID_WINDOWS = new Set(['all', '24h', '7d', '30d'])

/**
 * Map a window string to a SQL interval string, or null for "no filter".
 *
 * @param {string} window
 * @returns {string | null}
 */
function windowToInterval(window) {
  if (window === '24h') return '1 day'
  if (window === '7d') return '7 days'
  if (window === '30d') return '30 days'
  return null // 'all' — no filter
}

/**
 * Mount the dedup guard routes on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
import { clampInt } from '../lib/clampInt.js'

export function mountDedupGuardRoutes(app, deps) {
  const { pool, capture500, safeError } = deps

  // GET /api/dedup-guard/stats?window=all|24h|7d|30d
  // Aggregate counts per dedup axis. Optional time-window filter (default=all).
  // Fix #3 (hardening 2026-05-05): stats were cumulative without time-window;
  //   now supports ?window= query param so operator can scope to recent period.
  app.get('/api/dedup-guard/stats', async (req, res) => {
    try {
      const windowParam = req.query.window || 'all'
      if (!VALID_WINDOWS.has(windowParam)) {
        return res.status(400).json({ error: `window must be one of: ${[...VALID_WINDOWS].join(', ')}` })
      }
      const interval = windowToInterval(windowParam)

      // Build optional time-filter SQL fragment
      const timeFilter = interval ? `AND cc.created_at >= NOW() - INTERVAL '${interval}'` : ''

      // F1.1 — Each axis = count of campaign_contacts in skipped state
      // with the corresponding reason in details.skip_reason.
      const result = await pool.query(`
        SELECT
          COALESCE((
            SELECT COUNT(*) FROM campaign_contacts cc
            WHERE cc.status = 'skipped'
              AND cc.details->>'skip_reason' LIKE 'dnt%'
              ${timeFilter}
          ), 0) as dnt,
          COALESCE((
            SELECT COUNT(*) FROM campaign_contacts cc
            WHERE cc.status = 'skipped'
              AND cc.details->>'skip_reason' LIKE 'lifetime_exhausted%'
              ${timeFilter}
          ), 0) as lifetime_exhausted,
          COALESCE((
            SELECT COUNT(*) FROM campaign_contacts cc
            WHERE cc.status = 'skipped'
              AND cc.details->>'skip_reason' LIKE 'cross_campaign_cooldown%'
              ${timeFilter}
          ), 0) as cross_campaign_cooldown,
          COALESCE((
            SELECT COUNT(*) FROM campaign_contacts cc
            WHERE cc.status = 'skipped'
              AND cc.details->>'skip_reason' LIKE 'per_domain_cooldown%'
              ${timeFilter}
          ), 0) as per_domain_cooldown,
          COALESCE((
            SELECT COUNT(*) FROM campaign_contacts cc
            WHERE cc.status = 'skipped'
              AND cc.details->>'skip_reason' LIKE 'bounce_cluster%'
              ${timeFilter}
          ), 0) as bounce_cluster,
          COALESCE((
            SELECT COUNT(*) FROM campaign_contacts cc
            WHERE cc.status = 'skipped'
              AND cc.details->>'skip_reason' LIKE 'region_rate_limit%'
              ${timeFilter}
          ), 0) as region_rate_limit,
          COALESCE((
            SELECT COUNT(*) FROM campaign_contacts cc
            WHERE cc.status = 'skipped'
              AND cc.details->>'skip_reason' LIKE 'engagement_decay%'
              ${timeFilter}
          ), 0) as engagement_decay,
          COALESCE((
            SELECT COUNT(*) FROM campaign_contacts cc
            WHERE cc.status = 'skipped'
              AND cc.details->>'skip_reason' LIKE 'crm_active_client%'
              ${timeFilter}
          ), 0) as crm_active_client
      `)

      const row = result.rows[0] || {}
      const axes = {
        dnt: Number(row.dnt) || 0,
        lifetime_exhausted: Number(row.lifetime_exhausted) || 0,
        cross_campaign_cooldown: Number(row.cross_campaign_cooldown) || 0,
        per_domain_cooldown: Number(row.per_domain_cooldown) || 0,
        bounce_cluster: Number(row.bounce_cluster) || 0,
        region_rate_limit: Number(row.region_rate_limit) || 0,
        engagement_decay: Number(row.engagement_decay) || 0,
        crm_active_client: Number(row.crm_active_client) || 0,
      }
      return res.json({
        axes,
        total_skipped: Object.values(axes).reduce((a, b) => a + b, 0),
        window: windowParam,
      })
    } catch (e) {
      capture500(res, e, safeError)
      return res.status(500).json({ error: safeError(e) })
    }
  })

  // GET /api/dedup-guard/segment-funnel?id=<segmentId>
  // Returns the funnel: total → minus each filter → eligible.
  app.get('/api/dedup-guard/segment-funnel', async (req, res) => {
    try {
      const { id } = req.query
      if (!id || isNaN(Number(id))) {
        return res.status(400).json({ error: 'segment id required' })
      }

      const segmentId = Number(id)

      const result = await pool.query(`
        -- contacts don't carry segment_id; segment membership lives in
        -- segment_memberships (company-level) and joins to contacts via ico.
        -- contacts.is_deleted column does not exist — fall back to status
        -- filter (status NOT IN deleted-like values).
        WITH seg_contacts AS (
          SELECT c.id, c.email
          FROM contacts c
          JOIN companies co ON co.ico = c.ico
          JOIN segment_memberships sm ON sm.company_id = co.id
          WHERE sm.segment_id = $1
            AND (c.status IS NULL OR c.status NOT IN ('deleted','removed'))
        ),
        -- True waterfall: each stage carries forward only the survivors of all
        -- prior axes (the previous shape counted each axis independently against
        -- the full set, so 'eligible' excluded CRM only — DNT/lifetime/cooldown
        -- suppressions were never subtracted from the eligible total).
        after_dnt AS (
          SELECT c.id, c.email FROM seg_contacts c
          WHERE NOT EXISTS (
            SELECT 1 FROM suppression_list sl
            WHERE sl.contact_id = c.id AND sl.suppression_type = 'dnt'
          )
          AND NOT EXISTS (
            SELECT 1 FROM outreach_suppressions os
            WHERE os.email = c.email
              AND os.reason = 'dnt'
          )
        ),
        after_lifetime AS (
          SELECT c.id, c.email FROM after_dnt c
          WHERE NOT EXISTS (
            SELECT 1 FROM suppression_list sl
            WHERE sl.contact_id = c.id AND sl.suppression_type = 'lifetime_exhausted'
          )
        ),
        after_cooldown AS (
          SELECT c.id, c.email FROM after_lifetime c
          WHERE NOT EXISTS (
            SELECT 1 FROM suppression_list sl
            WHERE sl.contact_id = c.id
              AND sl.suppression_type IN ('cross_campaign_cooldown', 'per_domain_cooldown')
          )
        ),
        after_crm AS (
          SELECT c.id, c.email FROM after_cooldown c
          WHERE NOT EXISTS (
            SELECT 1 FROM suppression_list sl
            WHERE sl.contact_id = c.id AND sl.suppression_type = 'crm_active_client'
          )
        )
        SELECT
          (SELECT COUNT(*) FROM seg_contacts)   as total,
          (SELECT COUNT(*) FROM after_dnt)      as after_dnt,
          (SELECT COUNT(*) FROM after_lifetime) as after_lifetime,
          (SELECT COUNT(*) FROM after_cooldown) as after_cooldown,
          (SELECT COUNT(*) FROM after_crm)      as after_crm
      `, [segmentId])

      const funnel = result.rows[0] || {}
      return res.json({
        segment_id: segmentId,
        total: Number(funnel.total) || 0,
        after_dnt_filter: Number(funnel.after_dnt) || 0,
        after_lifetime_filter: Number(funnel.after_lifetime) || 0,
        after_cooldown_filters: Number(funnel.after_cooldown) || 0,
        after_crm_filters: Number(funnel.after_crm) || 0,
        eligible: Number(funnel.after_crm) || 0,
      })
    } catch (e) {
      capture500(res, e, safeError)
      return res.status(500).json({ error: safeError(e) })
    }
  })

  // GET /api/dedup-guard/recent-skips?limit=N
  // Returns the last N skip events with contact ID, campaign ID, and reason.
  // NO email addresses (PII constraint per feedback_no_pii_in_commands).
  //
  // Fix #1 (hardening 2026-05-05): limit=0 quirk — parseInt('0') is falsy → || 100
  // now correctly documented + clamped. limit=0 is explicitly treated as default (100).
  app.get('/api/dedup-guard/recent-skips', async (req, res) => {
    try {
      // Fix: parseInt('0') is falsy in JS, so limit=0 → || 100 → 100.
      // This is intentional: callers should pass explicit positive values.
      // Clamped to [1, 500] after the default fallback.
      const rawLimit = parseInt(req.query.limit, 10)
      const limit = clampInt(rawLimit || 100, 1, 500)

      const result = await pool.query(`
        SELECT
          cc.id as contact_skip_id,
          cc.campaign_id,
          cc.contact_id,
          cc.status,
          cc.details->>'skip_reason' as skip_reason,
          cc.created_at as skipped_at
        FROM campaign_contacts cc
        WHERE cc.status = 'skipped'
        ORDER BY cc.created_at DESC
        LIMIT $1
      `, [limit])

      const rows = result.rows || []
      return res.json({
        limit,
        count: rows.length,
        skips: rows.map(r => ({
          id: r.contact_skip_id,
          campaign_id: r.campaign_id,
          contact_id: r.contact_id,
          reason: r.skip_reason || 'unknown',
          skipped_at: r.skipped_at,
        })),
      })
    } catch (e) {
      capture500(res, e, safeError)
      return res.status(500).json({ error: safeError(e) })
    }
  })

  // GET /api/dedup-guard/contact-block-reason?id=<contactId>
  // New feature (hardening 2026-05-05): "Why was this contact blocked?" lookup.
  // Returns the most recent skip records for a contact across all campaigns.
  // PII-safe: no email returned.
  app.get('/api/dedup-guard/contact-block-reason', async (req, res) => {
    try {
      const rawId = req.query.id
      if (!rawId) {
        return res.status(400).json({ error: 'contact id required' })
      }
      const contactId = parseInt(rawId, 10)
      if (!Number.isFinite(contactId) || contactId <= 0) {
        return res.status(400).json({ error: 'contact id must be a positive integer' })
      }

      const result = await pool.query(`
        SELECT
          cc.campaign_id,
          cc.details->>'skip_reason' as skip_reason,
          cc.created_at as skipped_at,
          c.company_name,
          c.email_domain AS domain
        FROM campaign_contacts cc
        JOIN contacts c ON c.id = cc.contact_id
        WHERE cc.contact_id = $1
          AND cc.status = 'skipped'
        ORDER BY cc.created_at DESC
        LIMIT 20
      `, [contactId])

      const rows = result.rows || []

      // Derive suppression_list entries to show all active blocks
      const slResult = await pool.query(`
        SELECT suppression_type, expires_at, created_at
        FROM suppression_list
        WHERE contact_id = $1
        ORDER BY created_at DESC
        LIMIT 20
      `, [contactId])

      return res.json({
        contact_id: contactId,
        company_name: rows[0]?.company_name || null,
        domain: rows[0]?.domain || null,
        skip_history: rows.map(r => ({
          campaign_id: r.campaign_id,
          reason: r.skip_reason || 'unknown',
          skipped_at: r.skipped_at,
        })),
        active_suppressions: (slResult.rows || []).map(r => ({
          type: r.suppression_type,
          expires_at: r.expires_at,
          created_at: r.created_at,
        })),
      })
    } catch (e) {
      capture500(res, e, safeError)
      return res.status(500).json({ error: safeError(e) })
    }
  })
}
