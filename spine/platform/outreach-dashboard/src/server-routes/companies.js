// Companies route surface — list, detail, score trends, email verify,
// scoring, EV/DQ/readiness, lookalike, facts ingest.
// ─────────────────────────────────────────────────────────────────────────────
// T3.7 (2026-05-01): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after #448 mountDsrRoutes, #452 mountPrivacyRoutes, #459
// mountHealthRoutes). Behavior is byte-equivalent to the inline declarations:
// same SQL, same response shape, same Sentry capture, same Express route
// ordering (score-trends MUST be registered before `:ico` so it isn't
// swallowed by the param-segment matcher).
//
// D2.2 (2026-05-03): 15 additional /api/companies/* routes extracted from
// server.js into this mounter. Helpers that are also called from non-companies
// code paths (dual-axis ranking, scoring/preview, contacts verify, mailbox
// greylist cron, full-check cron) STAY in server.js and are passed in via
// `deps` so call-sites elsewhere keep their existing live binding. Helpers
// only consumed by these 15 handlers (autocomplete generator, facets cache)
// move into this file.
//
// Routes covered (19 total):
//   GET   /api/companies                         — paginated list (existing)
//   GET   /api/companies/score-trends            — sparklines (existing)
//   GET   /api/companies/:ico                    — drawer detail (existing)
//   GET   /api/companies/stats                   — pg_class reltuples estimate
//   GET   /api/companies/regions                 — region autocomplete
//   GET   /api/companies/sectors                 — sector autocomplete
//   GET   /api/companies/facets                  — filter facet counts (cached 30s)
//   POST  /api/companies/:ico/verify-email       — single-IČO SMTP verify
//   POST  /api/companies/bulk-verify-email       — batch verify (max 50)
//   GET   /api/companies/:ico/verification-history — verification audit log
//   POST  /api/companies/:ico/recompute-score    — manual score recompute
//   GET   /api/companies/:ico/expected-value     — EV ranking score
//   GET   /api/companies/:ico/data-quality       — DQS standalone
//   GET   /api/companies/:ico/readiness          — engagement readiness
//   GET   /api/companies/:ico/lookalike          — lookalike-converter score
//   POST  /api/companies/:ico/facts              — manual fact ingestion
//   GET   /api/companies/:ico/facts              — fact history (200 latest)
//   GET   /api/companies/:ico/facts/current      — non-expired facts (MV)
//   PATCH /api/companies/:ico                    — operator exclusion toggle (issue #859)
//
// `COMPANY_SORT_COLS` and `buildCompaniesWhere` were only consumed by the
// list handler in server.js, so they move with it. Keeping them co-located
// preserves the "one source of truth for company filter semantics" intent.

const COMPANY_SORT_COLS = {
  score: 'best_targeting_score',
  composite: 'composite_score',
  name: 'name',
  city: 'address_locality',
  contacted: 'last_contacted',
  // B4 — sortable E-mail column. Sorts by email_status (so "valid" >
  // "risky" > "invalid" group together) when DIR is desc, then by
  // email lexicographically for stable ordering within a status.
  email: 'email_status',
}

// Builds the WHERE clause + parameter array for /api/companies and the CSV
// export so the two endpoints can never drift in which filters they honor.
// Returns { where, params, p } where `p` is the next available $N index.
function buildCompaniesWhere(req) {
  const { search, category, icp, size, uncontacted, email_status } = req.query
  const emailStatuses = [].concat(req.query['email_status[]'] ?? email_status ?? []).filter(Boolean)
  const categories = [].concat(req.query['categories[]'] ?? req.query.categories ?? []).filter(Boolean)
  const excludeCats = [].concat(req.query['exclude_categories[]'] ?? req.query.exclude_categories ?? []).filter(Boolean)
  const regions = [].concat(req.query['region[]'] ?? req.query.region ?? []).filter(Boolean)
  const sectors = [].concat(req.query['sector[]'] ?? req.query.sector ?? []).filter(Boolean)
  const engagements = [].concat(req.query['engagement[]'] ?? req.query.engagement ?? []).filter(Boolean)
  const scoreMin = req.query.scoreMin != null && req.query.scoreMin !== '' ? Number(req.query.scoreMin) : null
  const scoreMax = req.query.scoreMax != null && req.query.scoreMax !== '' ? Number(req.query.scoreMax) : null
  const emailConfidenceMin = req.query.emailConfidenceMin != null && req.query.emailConfidenceMin !== '' ? Number(req.query.emailConfidenceMin) : null
  const lastContactedSince = req.query.lastContactedSince && /^\d{4}-\d{2}-\d{2}/.test(req.query.lastContactedSince) ? req.query.lastContactedSince : null
  const lastContactedNever = req.query.lastContactedNever === '1'
  const hasWebsite = req.query.hasWebsite === '1' ? true
                   : req.query.hasWebsite === '0' ? false
                   : null
  const conds = ['datum_zaniku IS NULL','v_likvidaci=false','v_insolvenci=false']
  const params = []
  let p = 1
  if (search)      { conds.push(`(name ILIKE $${p++} OR ico ILIKE $${p++})`); params.push(`%${search}%`,`%${search}%`) }
  if (category)    { conds.push(`category_path LIKE $${p++}`); params.push(category + ' >%') }
  if (categories.length) {
    const likes = categories.map(c => `category_path LIKE $${p++}`).join(' OR ')
    conds.push(`(${likes})`)
    categories.forEach(c => params.push(c.endsWith('%') ? c : c + '%'))
  }
  if (excludeCats.length) {
    excludeCats.forEach(c => { conds.push(`category_path NOT LIKE $${p++}`); params.push(c.endsWith('%') ? c : c + '%') })
  }
  if (icp)         { conds.push(`icp_tier = ANY($${p++}::text[])`); params.push(`{${icp}}`) }
  if (size)        { conds.push(`velikost_firmy = ANY($${p++}::text[])`); params.push(`{${size}}`) }
  if (uncontacted === '1') conds.push('last_contacted IS NULL')
  if (emailStatuses.length) {
    conds.push(`email_status = ANY($${p++}::text[])`); params.push(`{${emailStatuses.join(',')}}`)
  }
  if (regions.length) {
    conds.push(`region_normalized = ANY($${p++}::text[])`); params.push(regions)
  }
  if (sectors.length) {
    conds.push(`sector_primary = ANY($${p++}::text[])`); params.push(sectors)
  }
  if (Number.isFinite(scoreMin)) {
    conds.push(`composite_score >= $${p++}`); params.push(Math.max(0, Math.min(100, scoreMin)))
  }
  if (Number.isFinite(scoreMax)) {
    conds.push(`composite_score <= $${p++}`); params.push(Math.max(0, Math.min(100, scoreMax)))
  }
  if (engagements.length) {
    conds.push(`engagement_cluster = ANY($${p++}::text[])`); params.push(engagements)
  }
  if (Number.isFinite(emailConfidenceMin)) {
    conds.push(`email_confidence >= $${p++}`); params.push(Math.max(0, Math.min(100, emailConfidenceMin)))
  }
  if (lastContactedSince) {
    conds.push(`last_contacted >= $${p++}`); params.push(lastContactedSince)
  }
  if (lastContactedNever) {
    conds.push(`last_contacted IS NULL`)
  }
  if (hasWebsite === true) {
    conds.push(`website IS NOT NULL AND website <> ''`)
  } else if (hasWebsite === false) {
    conds.push(`(website IS NULL OR website = '')`)
  }
  return { where: conds.join(' AND '), params, p }
}

// D2.2 — autocomplete handler factory + 30s facets cache. Both are consumed
// only by handlers in this file, so they live module-private rather than in
// `deps`. The cache is process-private (single instance per BFF).
const AUTOCOMPLETE_LIMIT = 20
function makeAutocompleteHandler(pool, capture500, safeError, column) {
  return async (req, res) => {
    try {
      const q = String(req.query.q ?? '').trim()
      const base = `datum_zaniku IS NULL AND ${column} IS NOT NULL AND ${column} <> ''`
      const params = []
      let where = base
      if (q) {
        // Use `lower(col) LIKE lower($1)` so Postgres can use the
        // idx_co_*_lower_prefix expression index (migration 044).
        where += ` AND lower(${column}) LIKE lower($1)`
        params.push(`${q}%`)
      }
      const { rows } = await pool.query(
        `SELECT ${column} AS value, COUNT(*)::int AS n
           FROM companies WHERE ${where}
          GROUP BY ${column}
          ORDER BY n DESC, value ASC
          LIMIT ${AUTOCOMPLETE_LIMIT}`,
        params,
      )
      res.json({ rows })
    } catch (e) { capture500(res, e, safeError) }
  }
}

const FACETS_TTL_MS = 30_000
let _facetsCache = null  // { value, expiresAt }
const MAX_BULK_VERIFY = 50

/**
 * Mount the Companies route surface on an Express app.
 *
 * `deps` is split into two flavors:
 *   - First-class deps (pool, setRouteTags, capture500, safeError) — same
 *     contract as every other mounter in this directory.
 *   - Helpers (verifyEmail pipeline, scoring/engagement, lookalike centroid,
 *     fact persist) — kept in server.js so call-sites outside companies.js
 *     (dual-axis, scoring/preview, contacts verify, crons) keep their
 *     live-binding spy targets. Tests inject mocks for these via deps.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   setRouteTags: (tags: Record<string, unknown>) => void,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 *   runVerifyAndPersist: (ico: string, email: string, trigger: string) => Promise<unknown>,
 *   loadSectorEngagementPriors: () => Promise<Map<string, { replyRate: number, openRate: number }>>,
 *   priorsForSector: (map: Map<string, unknown> | null, sectorPrimary: string | null) => unknown,
 *   recomputeScoreForIco: (ico: string, weights?: unknown, sectorPriors?: unknown) => Promise<unknown>,
 *   computeEngagementForCompany: (companyId: number) => Promise<{ engagement_score: number, recent_60d_count: number }>,
 *   computeExpectedValueScore: (co: unknown, fixed: unknown, opts: unknown) => unknown,
 *   computeDataQuality: (co: unknown, facts: unknown) => unknown,
 *   computeReadiness: (co: unknown, facts: unknown) => unknown,
 *   loadLookalikeCentroid: (force?: boolean) => Promise<{ vec: unknown, builtAt: number, n: number }>,
 *   lookalikeScore: (co: unknown, vec: unknown, facts: unknown) => unknown,
 *   enrichmentPersistFacts: (pool: unknown, companyId: number, source: string, facts: unknown[], parser: string, opts: unknown) => Promise<number>,
 * }} deps
 */
import { clampInt } from '../lib/clampInt.js'

export function mountCompaniesRoutes(app, deps) {
  const {
    pool,
    setRouteTags,
    capture500,
    safeError,
    runVerifyAndPersist,
    loadSectorEngagementPriors,
    priorsForSector,
    recomputeScoreForIco,
    computeEngagementForCompany,
    computeExpectedValueScore,
    computeDataQuality,
    computeReadiness,
    loadLookalikeCentroid,
    lookalikeScore,
    enrichmentPersistFacts,
  } = deps
  app.get('/api/companies', async (req, res) => {
    setRouteTags({ 'page.type': 'company-list' })
    try {
      const { sort = 'score', dir = 'desc', limit = 50, offset = 0 } = req.query
      let { where, params, p } = buildCompaniesWhere(req)
      const col     = COMPANY_SORT_COLS[sort] ?? 'best_targeting_score'
      const sortDir = dir === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS LAST'
      const [{ rows }, { rows: [{ total }] }] = await Promise.all([
        pool.query(
          `SELECT ico,name,category_path,address_locality,best_targeting_score,email,
                  velikost_firmy,icp_tier,icp_score,email_status,email_verified_at,email_confidence,
                  website,telephone,sector_primary,region_normalized,pravni_forma,last_contacted,
                  composite_score,score_tier,scored_at
           FROM companies WHERE ${where}
           ORDER BY ${col} ${sortDir}, id ASC LIMIT $${p++} OFFSET $${p++}`,
          [...params, Number(limit), Number(offset)]
        ),
        pool.query(`SELECT COUNT(*)::int AS total FROM companies WHERE ${where}`, params),
      ])
      res.json({ rows, total })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── /api/companies/score-trends ───────────────────────────────────
  //
  // Batched score-history sparklines for the Companies table. The UI sends up
  // to ~50 IČOs per request and renders one mini-trend per row.
  //
  // Caught by 2026-04-30 visual smoke (`/api/companies/score-trends → 404`).
  // Companies.jsx (line 926) consumes this — when missing, the page silently
  // patches `null` per IČO so the table still renders, but the sparklines
  // disappear. Adding the endpoint restores them and removes the noisy 404
  // from the console.
  //
  // Response shape: `{ "<ico>": [{ at, score }, ...], ... }`. An IČO with no
  // history returns an empty array (not null) so the frontend `Array.isArray`
  // guard keeps a stable shape.
  //
  // MUST be declared BEFORE `/api/companies/:ico` — Express matches first, so
  // `score-trends` would otherwise be captured as the `:ico` parameter and 404
  // from the trailing handler.
  app.get('/api/companies/score-trends', async (req, res) => {
    setRouteTags({ 'companies.action': 'score-trends' })
    try {
      const days = clampInt(Number(req.query.days) || 30, 1, 365)
      const raw = String(req.query.icos ?? '').trim()
      if (!raw) return res.json({})

      // Hard cap on input set to prevent unbounded queries. UI batches to 200
      // upstream (Companies.jsx:922) — match that ceiling here.
      const icos = raw.split(',')
        .map(s => s.trim())
        .filter(s => /^\d{1,8}$/.test(s))
        .slice(0, 200)
      if (!icos.length) return res.json({})

      // outreach_score_history.contact_id → outreach_contacts.id, then
      // outreach_contacts.ico → companies.ico. We keep the JOIN one-sided:
      // a missing `outreach_score_history` (some envs don't have it yet)
      // should not 500 the endpoint; .catch returns an empty rowset and the
      // response degrades to `{ "<ico>": [] }`.
      let rows = []
      try {
        const result = await pool.query(`
          SELECT oc.ico AS ico,
                 h.created_at AS at,
                 h.new_score  AS score
          FROM outreach_score_history h
          JOIN outreach_contacts oc ON oc.id = h.contact_id
          WHERE oc.ico = ANY($1::text[])
            AND h.created_at > now() - ($2 || ' days')::interval
          ORDER BY oc.ico, h.created_at ASC
        `, [icos, String(days)])
        rows = result.rows
      } catch {
        rows = []
      }

      const byIco = {}
      for (const ico of icos) byIco[ico] = []
      for (const r of rows) {
        const k = String(r.ico)
        if (!byIco[k]) byIco[k] = []
        byIco[k].push({
          at: r.at instanceof Date ? r.at.toISOString() : r.at,
          score: r.score == null ? null : Number(r.score),
        })
      }
      return res.json(byIco)
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── /api/companies/stats ──────────────────────────────────────────
  // pg_class.reltuples is a planner estimate (refreshed by VACUUM/ANALYZE),
  // intentionally cheaper than COUNT(*) on a multi-million-row table.
  //
  // MUST be registered BEFORE /api/companies/:ico — Express stops at the
  // first match and `:ico` would otherwise capture "stats" as the param.
  app.get('/api/companies/stats', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT reltuples::bigint AS total FROM pg_class WHERE relname='companies'`)
      res.json({ total: Number(rows[0]?.total || 0) })
    } catch (e) { capture500(res, e, safeError) }
  })

  // Region / sector autocomplete. Prefix-matched on the normalized column,
  // ranked by company count so the common values surface first. Results are
  // capped at 20 rows — list is small enough that clients can filter more
  // aggressively on the typed query without another round-trip.
  app.get('/api/companies/regions', makeAutocompleteHandler(pool, capture500, safeError, 'region_normalized'))
  app.get('/api/companies/sectors', makeAutocompleteHandler(pool, capture500, safeError, 'sector_primary'))

  // Facet counts per filter option. Baseline universe = alive companies
  // (same predicate as /api/companies). Counts are filter-independent so the
  // 30s memo has a cache-hit rate close to 100% — trade: facet numbers don't
  // narrow as the user drills in. A follow-up can add filter-aware facets
  // with an LRU if the UX needs it.
  app.get('/api/companies/facets', async (_req, res) => {
    try {
      const now = Date.now()
      if (_facetsCache && _facetsCache.expiresAt > now) {
        res.setHeader('X-Cache', 'HIT')
        return res.json(_facetsCache.value)
      }
      const BASE = `datum_zaniku IS NULL AND v_likvidaci=false AND v_insolvenci=false`
      const groupQuery = (col) => pool.query(
        `SELECT ${col} AS k, COUNT(*)::int AS n FROM companies
          WHERE ${BASE} AND ${col} IS NOT NULL GROUP BY ${col}`
      )
      const boolQuery = (predicate) => pool.query(
        `SELECT COUNT(*)::int AS n FROM companies WHERE ${BASE} AND ${predicate}`
      )
      const [icp, size, email, eng, uncontacted, hasWeb, hasEmail] = await Promise.all([
        groupQuery('icp_tier'),
        groupQuery('velikost_firmy'),
        groupQuery('email_status'),
        groupQuery('engagement_cluster'),
        boolQuery('last_contacted IS NULL'),
        boolQuery(`website IS NOT NULL AND website <> ''`),
        boolQuery(`email IS NOT NULL AND email <> ''`),
      ])
      const byKey = ({ rows }) => Object.fromEntries(rows.map(r => [r.k, r.n]))
      const value = {
        icp: byKey(icp),
        size: byKey(size),
        email: byKey(email),
        engagement: byKey(eng),
        uncontacted: uncontacted.rows[0]?.n ?? 0,
        hasWebsite: hasWeb.rows[0]?.n ?? 0,
        hasEmail: hasEmail.rows[0]?.n ?? 0,
        cachedAt: new Date().toISOString(),
      }
      _facetsCache = { value, expiresAt: now + FACETS_TTL_MS }
      res.setHeader('X-Cache', 'MISS')
      res.json(value)
    } catch (e) { capture500(res, e, safeError) }
  })

  // /api/companies/:ico — drawer detail. MUST come AFTER every static-path
  // GET on /api/companies/<word> (stats, regions, sectors, facets,
  // score-trends — already declared above) since Express stops at the
  // first match and `:ico` would otherwise swallow them.
  app.get('/api/companies/:ico', async (req, res) => {
    try {
      const { rows: [co] } = await pool.query(
        `SELECT ico,name,category_path,address_locality,postal_code,street_address,
                best_targeting_score,email,email_status,email_verified_at,email_verification,email_confidence,
                website,telephone,
                velikost_firmy,icp_tier,icp_score,sector_primary,sector_tags,
                region_normalized,pravni_forma,rating_value,rating_count,
                description,total_sent,total_replied,total_opened,total_bounced,last_contacted,created_at,
                nace_code,engagement_cluster,datum_zaniku,v_likvidaci,v_insolvenci,
                description_tags,sector_confidence,
                composite_score,score_tier,score_components,scored_at,engagement_score,
                crm_client_id,exclusion_status
         FROM companies WHERE ico=$1`, [req.params.ico]
      )
      if (!co) return res.status(404).json({ error: 'not found' })
      // CRM-6: enrich with crm_clients badge fields when linked. Operator
      // CRM-6+: enrich with crm_clients badge fields when linked. Operator
      // sees "CRM aktivní" + status (Potenciální/Aktuální/Nezajímavý/Začínáme)
      // + owner_email + last_activity. Graceful: missing crm_clients table
      // (fresh DB before migration 050) yields null.
      if (co.crm_client_id) {
        const { rows: [crm] } = await pool.query(
          `SELECT crm_status, crm_relationship, owner_email, last_activity, imported_from
           FROM crm_clients WHERE id = $1`, [co.crm_client_id]
        ).catch(() => ({ rows: [] }))
        if (crm) co.crm = crm
      }
      // S4.4: campaign_enrollments was a vestigial table never written to.
      // Real campaign↔contact mapping is campaign_contacts (via contact_id,
      // not company_id). Resolve via contacts.ico → contacts.id → campaign_contacts.
      const { rows: campaigns } = await pool.query(
        `SELECT c.id, c.name, c.status, cc.current_step AS step,
                cc.created_at AS enrolled_at, cc.updated_at AS last_step_at
         FROM campaign_contacts cc
         JOIN campaigns c ON c.id = cc.campaign_id
         JOIN contacts ct ON ct.id = cc.contact_id
         WHERE ct.ico = $1
         ORDER BY cc.created_at DESC LIMIT 10`, [req.params.ico]
      ).catch(() => ({ rows: [] }))
      // description_tags must be null or array — coerce stored objects to null.
      if (co.description_tags !== null && !Array.isArray(co.description_tags)) {
        co.description_tags = null
      }
      // Merge enrichment facts (justice_cz, web_scrape, mx_lookup, vvz, …) so
      // the drawer can render them without extra round-trips. facts is a map of
      // field → { value, source, fetched_at } keyed by the latest entry for each
      // field. Missing MV (fresh DB) is tolerated — .catch returns empty map.
      const { rows: factRows } = await pool.query(
        `SELECT field, value, source, fetched_at
           FROM company_current_facts
          WHERE company_id = (SELECT id FROM companies WHERE ico=$1)`,
        [req.params.ico],
      ).catch(() => ({ rows: [] }))
      const enrichment = {}
      for (const f of factRows) {
        enrichment[f.field] = { value: f.value, source: f.source, fetched_at: f.fetched_at }
      }
      res.json({ ...co, campaigns, enrichment })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── Email verification ─────────────────────────────────────────────
  // The `runVerifyAndPersist` helper (and its greylist queue / domain cache
  // collaborators) is owned by server.js because the same function is also
  // called from the company-contacts verify endpoint, the full-check cron,
  // and the greylist retry cron. Tests mock the dep directly.
  app.post('/api/companies/:ico/verify-email', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [co] } = await client.query(
        `SELECT ico, email FROM companies WHERE ico=$1`, [req.params.ico]
      )
      if (!co) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'not found' })
      }
      if (!co.email) {
        await client.query(
          `UPDATE companies SET email_status='no_email', email_verified_at=now() WHERE ico=$1`,
          [co.ico]
        )
        await client.query(
          `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
           VALUES($1, 'dashboard', 'company', $2, $3::jsonb)`,
          ['company_email_verify', co.ico, JSON.stringify({ status: 'no_email', reason: 'no email' })]
        )
        await client.query('COMMIT')
        return res.json({ status: 'no_email', detail: 'Firma nemá e-mail' })
      }
      const result = await runVerifyAndPersist(co.ico, co.email, 'manual')
      await client.query(
        `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
         VALUES($1, 'dashboard', 'company', $2, $3::jsonb)`,
        ['company_email_verify', co.ico, JSON.stringify({ status: result.status, detail: result.detail })]
      )
      await client.query('COMMIT')
      res.json(result)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  app.post('/api/companies/bulk-verify-email', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const ids = Array.isArray(req.body?.icos) ? req.body.icos.slice(0, MAX_BULK_VERIFY) : null
      if (!ids || !ids.length) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'icos required (array, max 50)' })
      }
      const { rows } = await client.query(
        `SELECT ico, email FROM companies WHERE ico = ANY($1::text[])`, [ids]
      )
      const results = []
      for (const co of rows) {
        if (!co.email) {
          await client.query(
            `UPDATE companies SET email_status='no_email', email_verified_at=now() WHERE ico=$1`,
            [co.ico]
          )
          await client.query(
            `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
             VALUES($1, 'dashboard', 'company', $2, $3::jsonb)`,
            ['company_email_verify', co.ico, JSON.stringify({ status: 'no_email', trigger: 'bulk' })]
          )
          results.push({ ico: co.ico, status: 'no_email' })
          continue
        }
        try {
          const r = await runVerifyAndPersist(co.ico, co.email, 'bulk')
          await client.query(
            `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
             VALUES($1, 'dashboard', 'company', $2, $3::jsonb)`,
            ['company_email_verify', co.ico, JSON.stringify({ status: r.status, trigger: 'bulk' })]
          )
          results.push({ ico: co.ico, status: r.status, detail: r.detail })
        } catch (e) {
          results.push({ ico: co.ico, status: 'error', detail: e.message })
        }
      }
      await client.query('COMMIT')
      res.json({ verified: results.length, results })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  app.get('/api/companies/:ico/verification-history', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, email, old_status, new_status, detail, trigger, created_at
         FROM email_verification_log WHERE company_ico=$1
         ORDER BY created_at DESC LIMIT 50`, [req.params.ico]
      )
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── Sophisticated scoring ──────────────────────────────────────────
  app.post('/api/companies/:ico/recompute-score', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [co] } = await client.query(
        `SELECT id FROM companies WHERE ico=$1`, [req.params.ico]
      )
      if (!co) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'not found' })
      }
      const sectorPriors = await loadSectorEngagementPriors()
      const r = await recomputeScoreForIco(req.params.ico, null, sectorPriors)
      await client.query(
        `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
         VALUES($1, 'dashboard', 'company', $2, $3::jsonb)`,
        ['company_score_recompute', req.params.ico, JSON.stringify({ new_score: r?.score, new_tier: r?.tier })]
      )
      await client.query('COMMIT')
      res.json(r)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // EV score = propensity × deal-size proxy. Ranks "biggest opportunities"
  // rather than "best leads" — useful when sales capacity is tight.
  app.get('/api/companies/:ico/expected-value', async (req, res) => {
    try {
      const { rows: [co] } = await pool.query(`
        SELECT id, ico, icp_tier, email_confidence, sector_confidence, velikost_firmy,
               email, website, sector_primary, datum_zaniku, v_likvidaci, v_insolvenci,
               total_sent, total_replied, total_opened, total_bounced, last_contacted
          FROM companies WHERE ico=$1
      `, [req.params.ico])
      if (!co) return res.status(404).json({ error: 'not found' })
      const { engagement_score, recent_60d_count } = await computeEngagementForCompany(co.id)
      const sectorPriors = await loadSectorEngagementPriors()
      const engagementPriors = priorsForSector(sectorPriors, co.sector_primary)
      const ev = computeExpectedValueScore(
        { ...co, engagement_score, recent_60d_count },
        null,
        engagementPriors ? { engagementPriors } : {},
      )
      const { rows: facts } = await pool.query(
        `SELECT field, value, fetched_at FROM company_current_facts WHERE company_id=$1`,
        [co.id],
      )
      const dq = computeDataQuality(
        { ...co, sector: co.sector_primary, size: co.velikost_firmy },
        facts,
      )
      const adjusted_ev_score = Math.max(0, Math.min(100, Math.round(ev.ev_score * dq.multiplier)))
      res.json({
        ico: req.params.ico,
        ...ev,
        data_quality: { dqs: dq.dqs, multiplier: dq.multiplier, signals: dq.signals },
        adjusted_ev_score,
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  // Standalone DQS endpoint — useful for dashboard panels and ranking.
  app.get('/api/companies/:ico/data-quality', async (req, res) => {
    try {
      const { rows: [co] } = await pool.query(`
        SELECT id, ico, email, website, sector_primary, velikost_firmy,
               street_address, address_locality, datum_zaniku, v_likvidaci, v_insolvenci
          FROM companies WHERE ico=$1
      `, [req.params.ico])
      if (!co) return res.status(404).json({ error: 'company not found' })
      const { rows: facts } = await pool.query(
        `SELECT field, value, fetched_at FROM company_current_facts WHERE company_id=$1`,
        [co.id],
      )
      const dq = computeDataQuality(
        {
          ...co,
          sector: co.sector_primary,
          size: co.velikost_firmy,
          address: co.street_address || co.address_locality,
        },
        facts,
      )
      res.json({ ico: req.params.ico, ...dq })
    } catch (e) { capture500(res, e, safeError) }
  })

  // Engagement readiness — "should we contact them right now?".
  // Pairs with EV: dual-axis (value × readiness) drives the daily send list.
  app.get('/api/companies/:ico/readiness', async (req, res) => {
    try {
      const { rows: [co] } = await pool.query(`
        SELECT id, ico, email, email_status, exclusion_status, last_contacted,
               total_sent, total_bounced, datum_zaniku, v_likvidaci, v_insolvenci
          FROM companies WHERE ico=$1
      `, [req.params.ico])
      if (!co) return res.status(404).json({ error: 'company not found' })
      const { recent_60d_count } = await computeEngagementForCompany(co.id)
      const { rows: facts } = await pool.query(
        `SELECT field, value FROM company_current_facts WHERE company_id=$1
          AND field IN ('mx_provider','spf','dmarc')`,
        [co.id],
      )
      const r = computeReadiness({
        ...co,
        status: co.exclusion_status === 'pass' ? 'active' : co.exclusion_status,
        recent_60d_count,
      }, facts)
      res.json({ ico: req.params.ico, ...r })
    } catch (e) { capture500(res, e, safeError) }
  })

  // Lookalike — cosine similarity vs centroid of historical converters.
  app.get('/api/companies/:ico/lookalike', async (req, res) => {
    try {
      const { rows: [co] } = await pool.query(`
        SELECT id, icp_tier, velikost_firmy, email, website,
               email_confidence, sector_confidence, composite_score, engagement_score
          FROM companies WHERE ico=$1
      `, [req.params.ico])
      if (!co) return res.status(404).json({ error: 'company not found' })
      const c = await loadLookalikeCentroid()
      if (!c.vec) return res.status(503).json({ error: 'no converters yet — centroid empty' })
      const { rows: facts } = await pool.query(
        `SELECT field, value FROM company_current_facts WHERE company_id=$1
          AND field IN ('mx_provider','spf','dmarc')`,
        [co.id],
      )
      const r = lookalikeScore(co, c.vec, facts)
      res.json({ ico: req.params.ico, ...r, centroid_n: c.n })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── Manual fact ingestion — operator-entered fact, source='manual' ──
  // Test harness for the whole enrichment pipeline + escape hatch when an
  // automated parser missed something the operator knows is true.
  app.post('/api/companies/:ico/facts', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { field, value, ttl_days, base_confidence } = req.body || {}
      if (typeof field !== 'string' || field.length === 0 || field.length > 64) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'field required (1-64 chars)' })
      }
      if (value === undefined) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'value required' })
      }
      const { rows: [co] } = await client.query(`SELECT id FROM companies WHERE ico=$1`, [req.params.ico])
      if (!co) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'company not found' })
      }
      const fact = { field, value }
      if (Number.isFinite(Number(base_confidence))) fact.base_confidence = Number(base_confidence)
      if (Number.isFinite(Number(ttl_days)))        fact.ttl_days        = Number(ttl_days)
      const inserted = await enrichmentPersistFacts(pool, co.id, 'manual', [fact], 'manual_v1', {
        base_confidence: 0.99,
        ttl_days: 9999,
      })
      await client.query(
        `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
         VALUES($1, 'dashboard', 'company', $2, $3::jsonb)`,
        ['company_fact_add', req.params.ico, JSON.stringify({ field, value_type: typeof value, inserted })]
      )
      await client.query('COMMIT')
      res.json({ ok: true, inserted, dedup: inserted === 0 })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  app.get('/api/companies/:ico/facts', async (req, res) => {
    try {
      const { rows: [co] } = await pool.query(`SELECT id FROM companies WHERE ico=$1`, [req.params.ico])
      if (!co) return res.status(404).json({ error: 'company not found' })
      const { rows } = await pool.query(`
        SELECT id, source, field, value, base_confidence, fetched_at, ttl_days, parser_version
          FROM company_facts
         WHERE company_id = $1
         ORDER BY fetched_at DESC
         LIMIT 200
      `, [co.id])
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  // Latest non-expired fact per (company, field) — read from MV.
  // Cheap aggregate read for scoring + dashboard. Refreshed every 10 min.
  app.get('/api/companies/:ico/facts/current', async (req, res) => {
    try {
      const { rows: [co] } = await pool.query(`SELECT id FROM companies WHERE ico=$1`, [req.params.ico])
      if (!co) return res.status(404).json({ error: 'company not found' })
      const { rows } = await pool.query(`
        SELECT field, source, value, base_confidence, fetched_at, ttl_days, expires_at
          FROM company_current_facts
         WHERE company_id = $1
         ORDER BY field
      `, [co.id])
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── PATCH /api/companies/:ico — operator exclusion toggle ──────────────
  //
  // Allows the operator to manually set exclusion_status to 'excluded' or
  // 'pass' for a company. The classifier may set 'hard_block'/'soft_block'
  // automatically — this endpoint is the human override escape hatch.
  //
  // Body: { exclusion_status: 'excluded' | 'pass', reason?: string }
  //
  // Validation:
  //   - ICO must be 8 digits
  //   - exclusion_status must be 'excluded' or 'pass'
  //   - reason is optional string, max 500 chars
  //
  // Behaviour:
  //   - Idempotent: if status unchanged, returns 200 with no_change=true
  //     and does NOT write an audit row.
  //   - Transactional: UPDATE + audit INSERT in one transaction.
  //     If audit INSERT fails → ROLLBACK (company NOT updated).
  //   - Concurrent PATCHes on same ICO: last-write-wins (no optimistic lock).
  //     Rationale: operator traffic is single-user; conflict probability is
  //     negligible. Each write is audited so the log tells the full story.
  //
  // Audit action names:
  //   'company_exclude'  — status set to 'excluded'
  //   'company_include'  — status set back to 'pass'
  //
  // Issue #859
  app.patch('/api/companies/:ico', async (req, res) => {
    const ico = req.params.ico
    // Validate ICO format — must be exactly 8 ASCII digits.
    if (!/^\d{8}$/.test(ico)) {
      return res.status(400).json({ error: 'ICO must be 8 digits' })
    }

    const { exclusion_status: newStatus, reason } = req.body || {}

    // Only operator-settable values are allowed.
    const ALLOWED_STATUSES = ['excluded', 'pass']
    if (!ALLOWED_STATUSES.includes(newStatus)) {
      return res.status(400).json({
        error: `exclusion_status must be one of: ${ALLOWED_STATUSES.join(', ')}`,
      })
    }

    // Reason is optional; if provided, must be a short string.
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
      return res.status(400).json({ error: 'reason must be a string ≤ 500 chars' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Read current state — also confirms the ICO exists.
      const { rows: [co] } = await client.query(
        `SELECT id, ico, exclusion_status FROM companies WHERE ico = $1`,
        [ico],
      )
      if (!co) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'company not found' })
      }

      // Idempotent: same status → no-op, no audit row.
      if (co.exclusion_status === newStatus) {
        await client.query('ROLLBACK')
        return res.json({ ok: true, no_change: true })
      }

      const prevStatus = co.exclusion_status

      // Apply the update.
      await client.query(
        `UPDATE companies SET exclusion_status = $1, updated_at = now() WHERE id = $2`,
        [newStatus, co.id],
      )

      // Audit log INSERT — if this fails the whole tx rolls back.
      const action = newStatus === 'excluded' ? 'company_exclude' : 'company_include'
      const auditDetails = { prev_status: prevStatus, new_status: newStatus }
      if (reason) auditDetails.reason = reason
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, 'dashboard', 'company', $2, $3::jsonb)`,
        [action, ico, JSON.stringify(auditDetails)],
      )

      await client.query('COMMIT')
      res.json({ ok: true, ico, exclusion_status: newStatus })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
}

// Exposed for tests that need to reset the in-process facets cache between
// runs. Production code never calls this — the 30s TTL handles freshness.
function _resetCompaniesFacetsCacheForTests() {
  _facetsCache = null
}
