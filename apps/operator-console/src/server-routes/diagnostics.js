// Diagnostics — segmentation & feature-lift analytics for the operator UI.
// ─────────────────────────────────────────────────────────────────────────────
// Sprint G4 (2026-05-03): extracted verbatim from server.js per ADR-008 D2
// module sequence (after #691 G3 threads + alongside categories extract).
// Behavior is byte-equivalent to the inline declarations: same SQL, same
// allowed-feature whitelist, same min_bucket clamp range [5..500],
// same default 30, same response envelopes, same Sentry capture path.
//
// These two routes power the Companies UI's "what predicts replies?"
// panel — they help the operator decide which segmentation dimensions
// actually carry signal (memory `feedback_operator_focus` T1 — primary
// axis = inbound triage / engagement).
//
//   GET /api/diagnostics/segmentation
//     For each candidate feature, returns mutual information with the
//     binary outcome `replied` (any reply over the company's lifetime,
//     gated on total_sent > 0). ?features=<csv> selects the subset
//     (default: all 5). ?min_bucket clamps the minimum bucket size used
//     by `rankFeaturesByMI` to drop low-N buckets. Returns 400 when the
//     feature list reduces to empty after the whitelist filter.
//
//   GET /api/diagnostics/feature-lift
//     For a single ?feature=<name>, returns one row per bucket with
//     rate / lift / Wilson CI from `featureLift`. Same min_bucket
//     clamp. Returns 400 on unknown feature.
//
// Allowed feature set (shared across both routes):
//   sector_primary, velikost_firmy, icp_tier, score_tier, region_normalized
//
// HARD RULE — `feedback_anti_trace_full_stack`: this handler does not
// dial SMTP/IMAP. It only reads from PG and runs in-process MI math.
// No relay/proxy concerns.

import { rankFeaturesByMI, featureLift } from '../lib/diagnostics.js'

const ALLOWED_FEATURES = new Set([
  'sector_primary',
  'velikost_firmy',
  'icp_tier',
  'score_tier',
  'region_normalized',
])

/**
 * Mount the Diagnostics route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountDiagnosticsRoutes(app, { pool, capture500, safeError }) {
  // Diagnostics — for each candidate feature, returns mutual information
  // with the binary outcome `replied` (any reply in last 90 days). Helps the
  // operator see which segmentation dimensions actually predict engagement.
  app.get('/api/diagnostics/segmentation', async (req, res) => {
    try {
      const minBucket = Math.max(5, Math.min(500, Number(req.query.min_bucket) || 30))
      const features = String(req.query.features || 'sector_primary,velikost_firmy,icp_tier,score_tier,region_normalized')
        .split(',').map(s => s.trim()).filter(Boolean)
      const safe = features.filter(f => ALLOWED_FEATURES.has(f))
      if (safe.length === 0) return res.status(400).json({ error: 'no valid features' })
      // outcome = at least one reply in last 90 days
      const cols = safe.join(', ')
      const { rows } = await pool.query(`
        SELECT ${cols},
               CASE WHEN total_replied > 0 THEN 1 ELSE 0 END AS outcome
          FROM companies
         WHERE total_sent > 0
      `)
      const ranked = rankFeaturesByMI(rows, safe, minBucket)
      res.json({ total_companies: rows.length, min_bucket: minBucket, features: ranked })
    } catch (e) { capture500(res, e, safeError) }
  })

  // Per-feature lift breakdown — returns one row per bucket with rate/lift/wilson.
  app.get('/api/diagnostics/feature-lift', async (req, res) => {
    try {
      const f = String(req.query.feature || '').trim()
      if (!ALLOWED_FEATURES.has(f)) return res.status(400).json({ error: 'invalid feature' })
      const minBucket = Math.max(5, Math.min(500, Number(req.query.min_bucket) || 30))
      const { rows } = await pool.query(`
        SELECT ${f} AS feature,
               CASE WHEN total_replied > 0 THEN 1 ELSE 0 END AS outcome
          FROM companies
         WHERE total_sent > 0
      `)
      const result = featureLift(rows, minBucket)
      res.json({ feature: f, min_bucket: minBucket, ...result })
    } catch (e) { capture500(res, e, safeError) }
  })
}
