// AV-F5-A — Prospects route surface (read-only Top-N).
// AV-F5-B (2026-05-20) — extended to back the /priprava/top-targets UI:
//   - Added query params: region (CSV), with_email (bool), page, size
//   - sector now accepts CSV (companies.sector_primary IN (...))
//   - Returns `page`, `size`, `total` for pagination
//   - Added /api/prospects/stats endpoint (4 score-tier buckets, 5s cache)
//
// Endpoints:
//   GET /api/prospects/top
//   GET /api/prospects/stats
//
// Query parameters for /api/prospects/top (all optional):
//   limit       integer  1-1000  (default 100)        — legacy: number of rows
//   page        integer  1-…     (default 1)          — 1-indexed pagination
//   size        integer  1-1000  (default 30)         — page window
//   min_score   number   0-100   (default 0)          — floor on prospect_score
//   sector      CSV string                            — match against companies.sector_primary IN (...)
//   region      CSV string                            — match against companies.region_normalized IN (...)
//   with_email  bool                                  — when 'true', require contacts.email IS NOT NULL/empty
//   since_days  integer  1-3650  (default no filter)  — only contacts.created_at within window
//
// `page`+`size` take precedence over `limit`. If `page` is set, the BFF returns
// rows for that page and ignores `limit`. If only `limit` is set (legacy
// callers), behaviour matches AV-F5-A exactly.
//
// Behaviour:
//   - Only contacts with crm_client_id IS NULL are returned (unsent prospects).
//   - Sorted by prospect_score DESC NULLS LAST then last_contacted ASC NULLS FIRST.
//   - JOINs companies for sector_primary / icp_tier / region_normalized / name.
//   - Returns { rows: [{ contact, company, prospect_score, factors }], total, page, size }
//
// Read-only — no audit log required.
//
// Schema citations (verified 2026-05-19, AV-F5-A + cross-checked 2026-05-20):
//   contacts.id, email, first_name, last_name, company_name, ico,
//     last_contacted, created_at, crm_client_id, email_status,
//     prospect_score, prospect_score_at, prospect_score_factors  (added in 125)
//   companies.id, name, ico, icp_tier, sector_primary, region_normalized,
//     category_path (region_normalized confirmed in server.js:1039 + :1082)

const DEFAULT_LIMIT       = 100
const MAX_LIMIT           = 1000
const DEFAULT_PAGE_SIZE   = 30
const MAX_PAGE_SIZE       = 1000
const DEFAULT_MIN_SCORE   = 0
const MAX_SINCE_DAYS      = 3650
const MAX_CSV_VALUES      = 32   // upper bound for sector / region CSV expansion

// AV-F5-B — score-tier boundaries for /api/prospects/stats buckets.
// Surfaced as named constants per feedback_no_magic_thresholds T0. Boundaries
// match the operator-facing copy in TopTargetsStatStrip ("Ideální" ≥ 85,
// "Vysoký" 70-84, "Střední" 50-69, "Nízký" < 50).
const SCORE_TIER_IDEAL_MIN   = 85
const SCORE_TIER_HIGH_MIN    = 70
const SCORE_TIER_MEDIUM_MIN  = 50

// 5s in-memory cache for /api/prospects/stats. Mirrors the 5s window used by
// /api/replies/stats so the badge feels live without hammering the DB.
const STATS_CACHE_TTL_MS = 5000

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

function toFloat(value, fallback) {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Parse a CSV-style query parameter into a trimmed, deduplicated array.
 * Returns null when the value is missing/empty so the caller can branch
 * on "filter not applied".
 *
 * @param {string|undefined} raw
 * @param {number} maxLen — per-value length guard (defensive against pathological URLs)
 * @returns {string[]|null}
 */
function parseCsv(raw, maxLen = 64) {
  if (typeof raw !== 'string') return null
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < maxLen)
  if (parts.length === 0) return null
  // Cap the number of CSV values to avoid pathological `IN (...)` lists.
  const dedup = Array.from(new Set(parts)).slice(0, MAX_CSV_VALUES)
  return dedup.length > 0 ? dedup : null
}

function parseBool(value) {
  if (typeof value !== 'string') return false
  const lower = value.trim().toLowerCase()
  return lower === 'true' || lower === '1' || lower === 'yes'
}

/**
 * Build the WHERE clause + params array for /api/prospects/top and
 * /api/prospects/stats. Returns { whereSql, params } so the caller can plug
 * additional positional params after the shared WHERE.
 */
function buildProspectFilter(req) {
  const minScore = Math.min(
    Math.max(toFloat(req.query.min_score, DEFAULT_MIN_SCORE), 0),
    100,
  )

  const sectors = parseCsv(req.query.sector)
  const regions = parseCsv(req.query.region)
  const withEmail = parseBool(req.query.with_email)

  const sinceDaysRaw = toInt(req.query.since_days, 0)
  const sinceDays = sinceDaysRaw > 0 && sinceDaysRaw <= MAX_SINCE_DAYS
    ? sinceDaysRaw
    : null

  const conds = [
    'c.crm_client_id IS NULL',
    'c.prospect_score IS NOT NULL',
  ]
  const params = []
  let p = 1
  conds.push(`c.prospect_score >= $${p++}`); params.push(minScore)

  if (sectors && sectors.length > 0) {
    const placeholders = sectors.map(() => `$${p++}`).join(', ')
    conds.push(`co.sector_primary IN (${placeholders})`)
    params.push(...sectors)
  }

  if (regions && regions.length > 0) {
    const placeholders = regions.map(() => `$${p++}`).join(', ')
    conds.push(`co.region_normalized IN (${placeholders})`)
    params.push(...regions)
  }

  if (withEmail) {
    conds.push(`c.email IS NOT NULL AND c.email <> ''`)
  }

  if (sinceDays) {
    conds.push(`c.created_at >= NOW() - ($${p++} || ' days')::interval`)
    params.push(String(sinceDays))
  }

  return {
    whereSql: conds.join(' AND '),
    params,
    nextParamIdx: p,
    filter: {
      min_score: minScore,
      sector: sectors,
      region: regions,
      with_email: withEmail,
      since_days: sinceDays,
    },
  }
}

/**
 * Mount the prospects route surface (Top-N read-only + stats) on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
import { clampInt } from '../lib/clampInt.js'

export function mountProspectsRoutes(app, { pool, capture500, safeError }) {
  // 5s cache for /api/prospects/stats — keyed by serialized filter so each
  // (sector, region, with_email) combination has its own bucket. Operator
  // typically switches filters a few times then settles, so the cache pays
  // for itself within the first 1-2 toggles.
  let statsCache = new Map()

  app.get('/api/prospects/top', async (req, res) => {
    try {
      const { whereSql, params, nextParamIdx, filter } = buildProspectFilter(req)
      let p = nextParamIdx

      // Pagination resolution. `page` + `size` take precedence over the
      // legacy `limit`. When only `limit` is supplied, behaviour matches
      // AV-F5-A exactly (offset always 0).
      const pageRaw = toInt(req.query.page, 0)
      const sizeRaw = toInt(req.query.size, 0)
      let page = 1
      let size = DEFAULT_LIMIT
      let offset = 0
      if (pageRaw > 0 || sizeRaw > 0) {
        page = pageRaw > 0 ? pageRaw : 1
        size = clampInt(sizeRaw > 0 ? sizeRaw : DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        offset = (page - 1) * size
      } else {
        const rawLimit = toInt(req.query.limit, DEFAULT_LIMIT)
        size = clampInt(rawLimit, 1, MAX_LIMIT)
      }

      // ── COUNT(*) over the same filter ────────────────────────────────
      const countSql =
        `SELECT COUNT(*)::int AS total
           FROM contacts c
           LEFT JOIN companies co ON co.ico = c.ico
          WHERE ${whereSql}`
      const { rows: countRows } = await pool.query(countSql, params)
      const total = countRows[0]?.total ?? 0

      // ── Page of rows ─────────────────────────────────────────────────
      const pageParams = params.slice()
      const limitIdx = p++
      pageParams.push(size)
      const offsetIdx = p++
      pageParams.push(offset)

      const pageSql =
        `SELECT c.id                       AS contact_id,
                c.email                    AS contact_email,
                c.first_name               AS contact_first_name,
                c.last_name                AS contact_last_name,
                c.company_name             AS contact_company_name,
                c.ico                      AS contact_ico,
                c.last_contacted           AS contact_last_contacted,
                c.created_at               AS contact_created_at,
                c.email_status             AS contact_email_status,
                c.prospect_score,
                c.prospect_score_at,
                c.prospect_score_factors,
                co.id                      AS company_id,
                co.name                    AS company_name,
                co.icp_tier                AS company_icp_tier,
                co.sector_primary          AS company_sector_primary,
                co.region_normalized       AS company_region_normalized,
                co.category_path           AS company_category_path
           FROM contacts c
           LEFT JOIN companies co ON co.ico = c.ico
          WHERE ${whereSql}
          ORDER BY c.prospect_score DESC NULLS LAST,
                   c.last_contacted ASC NULLS FIRST,
                   c.id ASC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}`
      const { rows } = await pool.query(pageSql, pageParams)

      const out = rows.map((r) => ({
        contact: {
          id: r.contact_id,
          email: r.contact_email,
          first_name: r.contact_first_name,
          last_name: r.contact_last_name,
          company_name: r.contact_company_name,
          ico: r.contact_ico,
          last_contacted: r.contact_last_contacted,
          created_at: r.contact_created_at,
          email_status: r.contact_email_status,
        },
        company: r.company_id != null ? {
          id: r.company_id,
          name: r.company_name,
          icp_tier: r.company_icp_tier,
          sector_primary: r.company_sector_primary,
          region_normalized: r.company_region_normalized,
          category_path: r.company_category_path,
        } : null,
        prospect_score: r.prospect_score != null ? Number(r.prospect_score) : null,
        prospect_score_at: r.prospect_score_at,
        factors: r.prospect_score_factors || null,
      }))

      res.json({
        rows: out,
        total,
        page,
        size,
        limit: size, // back-compat with AV-F5-A consumers
        filter,
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // AV-F5-B — /api/prospects/stats: 4-bucket score distribution for the
  // TopTargetsStatStrip. Honours the same sector / region / with_email
  // filter envelope as /api/prospects/top so the strip stays consistent
  // with the list view. 5s in-memory cache keyed by the filter signature.
  app.get('/api/prospects/stats', async (req, res) => {
    try {
      // Build a filter that ignores `min_score` (stats span all scored
      // contacts) but honours sector / region / with_email / since_days.
      // We rebuild the WHERE clause manually so we can drop the
      // min_score predicate without re-implementing the rest.
      const sectors = parseCsv(req.query.sector)
      const regions = parseCsv(req.query.region)
      const withEmail = parseBool(req.query.with_email)
      const sinceDaysRaw = toInt(req.query.since_days, 0)
      const sinceDays = sinceDaysRaw > 0 && sinceDaysRaw <= MAX_SINCE_DAYS
        ? sinceDaysRaw
        : null

      const cacheKey = JSON.stringify({
        sectors: sectors || [],
        regions: regions || [],
        withEmail,
        sinceDays,
      })
      const cached = statsCache.get(cacheKey)
      if (cached && (Date.now() - cached.at) < STATS_CACHE_TTL_MS) {
        return res.json(cached.body)
      }

      const conds = [
        'c.crm_client_id IS NULL',
        'c.prospect_score IS NOT NULL',
      ]
      const params = []
      let p = 1
      if (sectors && sectors.length > 0) {
        const placeholders = sectors.map(() => `$${p++}`).join(', ')
        conds.push(`co.sector_primary IN (${placeholders})`)
        params.push(...sectors)
      }
      if (regions && regions.length > 0) {
        const placeholders = regions.map(() => `$${p++}`).join(', ')
        conds.push(`co.region_normalized IN (${placeholders})`)
        params.push(...regions)
      }
      if (withEmail) {
        conds.push(`c.email IS NOT NULL AND c.email <> ''`)
      }
      if (sinceDays) {
        conds.push(`c.created_at >= NOW() - ($${p++} || ' days')::interval`)
        params.push(String(sinceDays))
      }
      const whereSql = conds.join(' AND ')

      // Single COUNT query with CASE buckets — cheaper than 4 round trips.
      const sql =
        `SELECT
           SUM(CASE WHEN c.prospect_score >= ${SCORE_TIER_IDEAL_MIN}                                    THEN 1 ELSE 0 END)::int AS idealni,
           SUM(CASE WHEN c.prospect_score >= ${SCORE_TIER_HIGH_MIN}    AND c.prospect_score < ${SCORE_TIER_IDEAL_MIN} THEN 1 ELSE 0 END)::int AS vysoky,
           SUM(CASE WHEN c.prospect_score >= ${SCORE_TIER_MEDIUM_MIN}  AND c.prospect_score < ${SCORE_TIER_HIGH_MIN}  THEN 1 ELSE 0 END)::int AS stredni,
           SUM(CASE WHEN c.prospect_score <  ${SCORE_TIER_MEDIUM_MIN}                                   THEN 1 ELSE 0 END)::int AS nizky
         FROM contacts c
         LEFT JOIN companies co ON co.ico = c.ico
         WHERE ${whereSql}`
      const { rows } = await pool.query(sql, params)
      const r = rows[0] || {}
      const body = {
        idealni: Number(r.idealni) || 0,
        vysoky:  Number(r.vysoky)  || 0,
        stredni: Number(r.stredni) || 0,
        nizky:   Number(r.nizky)   || 0,
        boundaries: {
          ideal_min:  SCORE_TIER_IDEAL_MIN,
          high_min:   SCORE_TIER_HIGH_MIN,
          medium_min: SCORE_TIER_MEDIUM_MIN,
        },
      }

      // Bounded cache — evict if it grows past 64 entries (operator only
      // ever toggles a handful of filter combinations per session).
      if (statsCache.size > 64) statsCache = new Map()
      statsCache.set(cacheKey, { at: Date.now(), body })
      res.json(body)
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}
