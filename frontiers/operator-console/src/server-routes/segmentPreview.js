// segmentPreview.js — GET /api/segments/preview  (Sprint K1, #1289)
//
// Returns aggregate counts for a segment filter WITHOUT any PII:
//   total_matching:        int  — contacts matching filters
//   skipped_dedup:         int  — sample of N checked against dedup axes
//   domain_coverage:       { unique_domains, max_per_domain, top_domains[10] }
//   breakdown_by_email_status: { valid, invalid, risky, null }
//
// HARD RULE feedback_no_pii_in_commands: no email addresses in response.
// HARD RULE feedback_no_magic_thresholds: all thresholds as named constants.

// Number of contacts sampled from the matching set for dedup estimation.
// Must be in operator_settings if operators need to tune it; named constant
// per feedback_no_magic_thresholds.
const DEDUP_SAMPLE_SIZE = 200

// Maximum number of top domains returned in domain_coverage.
const TOP_DOMAINS_LIMIT = 10

// Allowed filter field names — mirrors server.js SEGMENT_ALLOWED allowlist.
const SEGMENT_ALLOWED = new Set([
  'sector_primary', 'sector_tags', 'icp_tier', 'icp_score',
  'region_normalized', 'email_status', 'exclusion_status',
  'engagement_cluster', 'velikost_firmy', 'nace_primary',
])

const SEGMENT_FIELD_SQL = {
  nace_primary: 'nace_codes[1]',
}
const fieldSql = name => SEGMENT_FIELD_SQL[name] || name

/**
 * Build a parameterized WHERE fragment from a filter query tree.
 * Params are indexed from $1 (standalone COUNT queries).
 *
 * @param {object} node
 * @param {unknown[]} params
 * @returns {string}
 */
function buildPreviewWhere(node, params) {
  const op = (node?.op || '').toUpperCase()
  if (op === 'AND' || op === 'OR') {
    if (!node.conditions?.length) return 'TRUE'
    const parts = node.conditions.map(c => `(${buildPreviewWhere(c, params)})`)
    return parts.join(op === 'AND' ? ' AND ' : ' OR ')
  }
  if (!SEGMENT_ALLOWED.has(node?.field)) return 'TRUE'
  const col = fieldSql(node.field)
  if (op === 'IN') {
    const vals = [].concat(node.value).filter(Boolean)
    if (!vals.length) return 'FALSE'
    params.push(`{${vals.join(',')}}`)
    return `${col} = ANY($${params.length}::text[])`
  }
  if (op === 'EQ')          { params.push(node.value); return `${col} = $${params.length}` }
  if (op === 'GTE')         { params.push(node.value); return `${col} >= $${params.length}` }
  if (op === 'LTE')         { params.push(node.value); return `${col} <= $${params.length}` }
  if (op === 'STARTS_WITH') { params.push(`${node.value}%`); return `${col} LIKE $${params.length}` }
  if (op === 'IS_NULL')     { return `${col} IS NULL` }
  return 'TRUE'
}

/**
 * Mount the segment preview route on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountSegmentPreviewRoutes(app, { pool, capture500, safeError }) {
  // GET /api/segments/preview
  // Query params:
  //   email_status  — comma-separated list: valid,invalid,risky,null
  //   sectors       — comma-separated NACE prefix codes
  //   regions       — comma-separated region_normalized values (CZ kraje)
  //   dedup         — "on" to estimate dedup skips (sample of DEDUP_SAMPLE_SIZE)
  app.get('/api/segments/preview', async (req, res) => {
    try {
      const emailStatusRaw = req.query.email_status
      const sectorsRaw     = req.query.sectors
      const regionsRaw     = req.query.regions
      const dedupApply     = req.query.dedup === 'on'

      // ── Build filter conditions ───────────────────────────────────────────────
      const params = []
      const whereParts = ["exclusion_status = 'pass'"]

      if (emailStatusRaw) {
        const statuses = emailStatusRaw.split(',').map(s => s.trim()).filter(Boolean)
        if (statuses.length) {
          // 'null' maps to IS NULL in SQL
          const nonNull = statuses.filter(s => s !== 'null')
          const includeNull = statuses.includes('null')
          const subparts = []
          if (nonNull.length) {
            params.push(`{${nonNull.join(',')}}`)
            subparts.push(`email_status = ANY($${params.length}::text[])`)
          }
          if (includeNull) {
            subparts.push('email_status IS NULL')
          }
          if (subparts.length) {
            whereParts.push(`(${subparts.join(' OR ')})`)
          }
        }
      }

      if (sectorsRaw) {
        const sectors = sectorsRaw.split(',').map(s => s.trim()).filter(Boolean)
        if (sectors.length) {
          // Match nace_primary starts-with any of the provided codes
          const sectorParts = sectors.map(code => {
            params.push(`${code}%`)
            return `nace_codes[1] LIKE $${params.length}`
          })
          whereParts.push(`(${sectorParts.join(' OR ')})`)
        }
      }

      if (regionsRaw) {
        const regions = regionsRaw.split(',').map(r => r.trim()).filter(Boolean)
        if (regions.length) {
          params.push(`{${regions.join(',')}}`)
          whereParts.push(`region_normalized = ANY($${params.length}::text[])`)
        }
      }

      const where = whereParts.join(' AND ')

      // K1 perf (#1319): the four sections each full-scan companies
      // (exclusion_status='pass' matches ~99.7% → seq scan, no index helps).
      // Run sequentially that was ~4–5s and starved the pool under the browser's
      // concurrent page loads (>25s). Two fixes: (1) fold the total COUNT into
      // the breakdown query — it already groups the same scan, so the standalone
      // COUNT was a redundant full scan; (2) issue the independent queries in
      // parallel so wall-time is the slowest one, not their sum.

      // ── A. Total + breakdown by email_status (one companies scan) ─────────────
      const breakdownPromise = pool.query(
        `SELECT
           COUNT(*)                                          AS total,
           COUNT(*) FILTER (WHERE email_status = 'valid')   AS valid,
           COUNT(*) FILTER (WHERE email_status = 'invalid') AS invalid,
           COUNT(*) FILTER (WHERE email_status = 'risky')   AS risky,
           COUNT(*) FILTER (WHERE email_status IS NULL)      AS "null"
         FROM companies WHERE ${where}`,
        [...params],
      )

      // ── B. Domain coverage (companies ⨝ contacts; PII-safe — domains only) ────
      const domainPromise = pool.query(
        `WITH matched_companies AS (
           SELECT ico FROM companies WHERE ${where}
         ),
         domains AS (
           SELECT
             split_part(c.email, '@', 2) AS domain
           FROM contacts c
           JOIN matched_companies mc ON mc.ico = c.ico
           WHERE c.email IS NOT NULL
             AND c.email LIKE '%@%'
         ),
         agg AS (
           SELECT
             domain,
             COUNT(*) AS cnt
           FROM domains
           WHERE domain <> ''
           GROUP BY domain
         )
         SELECT
           (SELECT COUNT(*) FROM agg) AS unique_domains,
           (SELECT MAX(cnt) FROM agg) AS max_per_domain,
           (
             SELECT json_agg(sub ORDER BY sub.count DESC)
             FROM (
               SELECT domain, cnt::int AS count FROM agg ORDER BY cnt DESC LIMIT ${TOP_DOMAINS_LIMIT}
             ) sub
           ) AS top_domains
         `,
        [...params],
      )

      // ── C. Dedup estimation (optional) — sample query in parallel ─────────────
      // Samples DEDUP_SAMPLE_SIZE contacts from the matching set; counts how many
      // are suppressed via either suppression table. The query ALSO returns the
      // full matching CONTACT population (`population`) and the actual sampled
      // contact count (`sampled`) so the skip-rate scales against the same
      // contact unit it was drawn from. Estimate, not exact.
      const dedupPromise = dedupApply
        ? pool.query(
            `WITH eligible AS (
               SELECT c.id AS contact_id, c.email
               FROM contacts c
               JOIN companies co ON co.ico = c.ico
               WHERE ${where.replace(/companies/g, 'co')}
             ),
             matched AS (
               SELECT contact_id, email FROM eligible LIMIT $${params.length + 1}
             )
             SELECT
               (SELECT COUNT(*) FROM eligible)::int AS population,
               COUNT(*)::int                        AS sampled,
               COUNT(*) FILTER (WHERE (
                 EXISTS (
                   SELECT 1 FROM suppression_list sl
                   WHERE sl.contact_id = m.contact_id
                     AND sl.suppression_type IN ('dnt','lifetime_exhausted','cross_campaign_cooldown','per_domain_cooldown','crm_active_client')
                 )
                 OR EXISTS (
                   SELECT 1 FROM outreach_suppressions os
                   WHERE os.email = m.email
                 )
               ))::int                              AS skipped
             FROM matched m`,
            [...params, DEDUP_SAMPLE_SIZE],
          )
        : Promise.resolve(null)

      const [breakdownRes, domainRes, dedupRes] = await Promise.all([
        breakdownPromise, domainPromise, dedupPromise,
      ])

      const brow = breakdownRes.rows[0] || {}
      const total_matching = Number(brow.total ?? 0)
      const breakdown_by_email_status = {
        valid:   Number(brow.valid   ?? 0),
        invalid: Number(brow.invalid ?? 0),
        risky:   Number(brow.risky   ?? 0),
        null:    Number(brow.null    ?? 0),
      }

      const drow = domainRes.rows[0] || {}
      const domain_coverage = {
        unique_domains: Number(drow.unique_domains ?? 0),
        max_per_domain: Number(drow.max_per_domain ?? 0),
        top_domains:    drow.top_domains ?? [],
      }

      // Scale the SAMPLED CONTACT skip-rate up to the full matching CONTACT
      // population. Denominator + population both come from the contact-level
      // dedup query — not the company-level `total_matching`, which over-scaled
      // the estimate (contacts-per-company ≠ 1, so it could exceed total_matching).
      let skipped_dedup = null
      if (dedupApply && dedupRes) {
        const ddrow = dedupRes.rows[0] || {}
        const sampledSkipped    = Number(ddrow.skipped ?? 0)
        const sampleSize        = Number(ddrow.sampled ?? 0)
        const contactPopulation = Number(ddrow.population ?? 0)
        skipped_dedup = sampleSize > 0
          ? Math.round((sampledSkipped / sampleSize) * contactPopulation)
          : 0
      }

      return res.json({
        total_matching,
        skipped_dedup,
        domain_coverage,
        breakdown_by_email_status,
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}
