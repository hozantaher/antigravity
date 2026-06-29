// Meta — categories surface for the Companies / segments UI.
// ─────────────────────────────────────────────────────────────────────────────
// D2.7 (2026-05-02): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after D2.5 mountScoringRoutes #~660). Behavior is byte-equivalent
// to the inline declarations: same SQL, same response shape, same Sentry
// capture, same Express route ordering. The two route-local in-memory caches
// (categories tree, categories search) move with the routes — they were
// only ever consumed by these handlers.
//
// Routes covered (4 total):
//   GET /api/meta/categories         — top-level category names (LIMIT 30)
//   GET /api/meta/categories/tree    — nested tree node listing (90s cache)
//   GET /api/meta/categories/search  — type-ahead search by name/path (60s cache)
//   GET /api/meta/categories/top     — filterable top-12 categories (icp/size/uncontacted/categories[])
//
// No external helpers required beyond pool / capture500 / safeError.

/**
 * Mount the Meta (categories) route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountMetaRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/meta/categories', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT split_part(category_path,' > ',1) AS cat, COUNT(*) AS cnt
         FROM companies WHERE category_path IS NOT NULL AND datum_zaniku IS NULL
         GROUP BY 1 ORDER BY cnt DESC LIMIT 30`
      )
      res.json(rows.map(r => r.cat).filter(Boolean))
    } catch (e) { capture500(res, e, safeError) }
  })

  // In-memory cache for category tree nodes (TTL 90s)
  const _catTreeCache = new Map()
  const CAT_TREE_TTL = 90_000
  function catTreeGet(key) {
    const e = _catTreeCache.get(key)
    if (!e) return null
    if (Date.now() > e.exp) { _catTreeCache.delete(key); return null }
    return e.data
  }
  function catTreeSet(key, data) { _catTreeCache.set(key, { data, exp: Date.now() + CAT_TREE_TTL }) }

  app.get('/api/meta/categories/tree', async (req, res) => {
    try {
      const parent = req.query.parent ? req.query.parent : null
      const cacheKey = parent ?? '__root__'
      const cached = catTreeGet(cacheKey)
      if (cached) return res.json(cached)
      const { rows } = await pool.query(
        `SELECT path, name, company_count AS cnt,
                EXISTS(SELECT 1 FROM categories c2 WHERE c2.parent_path = c.path) AS has_children
         FROM categories c
         WHERE parent_path ${parent ? '= $1' : 'IS NULL'}
         ORDER BY cnt DESC LIMIT 60`,
        parent ? [parent] : []
      )
      const result = rows.map(r => ({ name: r.name, path: r.path, cnt: Number(r.cnt), hasChildren: r.has_children }))
      catTreeSet(cacheKey, result)
      res.json(result)
    } catch (e) { capture500(res, e, safeError) }
  })

  // In-memory cache for category search (TTL 60s, max 256 entries)
  const _catSearchCache = new Map()
  const CAT_SEARCH_TTL = 60_000
  function catSearchGet(q) {
    const e = _catSearchCache.get(q)
    if (!e) return null
    if (Date.now() > e.exp) { _catSearchCache.delete(q); return null }
    return e.data
  }
  function catSearchSet(q, data) {
    if (_catSearchCache.size >= 256) _catSearchCache.delete(_catSearchCache.keys().next().value)
    _catSearchCache.set(q, { data, exp: Date.now() + CAT_SEARCH_TTL })
  }

  app.get('/api/meta/categories/search', async (req, res) => {
    try {
      const q = (req.query.q ?? '').trim()
      if (!q) return res.json([])
      const cached = catSearchGet(q)
      if (cached) return res.json(cached)
      const { rows } = await pool.query(
        `SELECT path, name, company_count AS cnt,
           CASE
             WHEN lower(name) = lower($1)          THEN 1
             WHEN lower(name) LIKE lower($1) || '%' THEN 2
             WHEN lower(path) ILIKE $2 || '%'        THEN 3
             ELSE 4
           END AS rank
         FROM categories
         WHERE name ILIKE $3 OR path ILIKE $3
         ORDER BY rank, cnt DESC
         LIMIT 30`,
        [q, q, `%${q}%`]
      )
      const result = rows.map(r => ({ path: r.path, name: r.name, cnt: Number(r.cnt), rank: Number(r.rank) }))
      catSearchSet(q, result)
      res.json(result)
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/meta/categories/top', async (req, res) => {
    try {
      const { icp, size, uncontacted } = req.query
      const categories = [].concat(req.query['categories[]'] ?? req.query.categories ?? []).filter(Boolean)
      const conds = ['datum_zaniku IS NULL', 'v_likvidaci=false', 'v_insolvenci=false', 'category_path IS NOT NULL']
      const params = []
      let p = 1
      if (icp)  { conds.push(`icp_tier = ANY($${p++}::text[])`); params.push(`{${icp}}`) }
      if (size) { conds.push(`velikost_firmy = ANY($${p++}::text[])`); params.push(`{${size}}`) }
      if (uncontacted === '1') conds.push('last_contacted IS NULL')
      if (categories.length) {
        const likes = categories.map(() => `category_path LIKE $${p++}`).join(' OR ')
        conds.push(`(${likes})`)
        categories.forEach(c => params.push(c + '%'))
      }
      const { rows } = await pool.query(
        `SELECT split_part(category_path,' > ',1) AS cat, COUNT(*) AS cnt
         FROM companies WHERE ${conds.join(' AND ')}
         GROUP BY 1 ORDER BY cnt DESC LIMIT 12`,
        params
      )
      res.json(rows.map(r => ({ name: r.cat, cnt: Number(r.cnt) })))
    } catch (e) { capture500(res, e, safeError) }
  })
}
