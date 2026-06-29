// Categories — direct-DB read-only routes for the dashboard category browser.
// ─────────────────────────────────────────────────────────────────────────────
// Sprint G4 (2026-05-03): extracted verbatim from server.js per ADR-008 D2
// module sequence (after #691 G3 threads). Behavior is byte-equivalent to
// the inline declarations: same SQL, same response shape, same 404 on
// unknown slug, same Sentry capture path on error.
//
// These three routes back the Companies UI category drilldown:
//
//   GET /api/categories
//     Returns top-level categories (depth=0) by default, or a flat search
//     result when ?q is given, or direct children when ?parent=<path>.
//     Limit caps the row count for the search and root listings.
//
//   GET /api/categories/:slug/companies
//     Returns paginated companies within a category. ?prefix=true matches
//     descendant categories (path LIKE 'cat > %'); ?prefix=false matches
//     only the exact category. ?limit + ?offset paginate; total reflects
//     the unpaginated count for client-side pagination UX.
//
//   GET /api/categories/:slug
//     Returns a single category metadata + its direct children.
//
// Companion contract: tests/contract/bff-categories.contract.test.ts
// (pre-existing, byte-equivalent contract pinned before extract) +
// tests/contract/bff-categories-diagnostics-g4-extract.contract.test.ts
// (extract guard for G4).
//
// HARD RULE — `feedback_anti_trace_full_stack`: this handler does not
// dial SMTP/IMAP. It only reads from PG. No relay/proxy concerns.

/**
 * Mount the Categories route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountCategoriesRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/categories', async (req, res) => {
    try {
      const { q, parent, limit = 200 } = req.query
      let rows
      if (q) {
        ;({ rows } = await pool.query(
          `SELECT id,path,slug,name,parent_path,depth,company_count FROM categories
           WHERE path ILIKE $1 ORDER BY company_count DESC LIMIT $2`,
          [`%${q}%`, Number(limit)]
        ))
      } else if (parent) {
        ;({ rows } = await pool.query(
          `SELECT id,path,slug,name,parent_path,depth,company_count FROM categories
           WHERE parent_path=$1 ORDER BY company_count DESC`,
          [parent]
        ))
      } else {
        ;({ rows } = await pool.query(
          `SELECT id,path,slug,name,parent_path,depth,company_count FROM categories
           WHERE depth=0 ORDER BY company_count DESC LIMIT $1`,
          [Number(limit)]
        ))
      }
      res.json({ categories: rows || [], total: rows?.length || 0 })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/categories/:slug/companies', async (req, res) => {
    try {
      const { prefix = 'true', limit = 50, offset = 0 } = req.query
      const { rows: [cat] } = await pool.query(
        `SELECT path FROM categories WHERE slug=$1`, [req.params.slug]
      )
      if (!cat) return res.status(404).json({ error: 'not found' })
      const matchPrefix = prefix !== 'false'
      const where = matchPrefix
        ? `(category_path=$1 OR category_path LIKE $1 || ' > %')`
        : `category_path=$1`
      const { rows: [{ count }] } = await pool.query(
        `SELECT COUNT(*) FROM companies WHERE ${where}`, [cat.path]
      )
      const { rows } = await pool.query(
        `SELECT id,name,email,website,address_locality,icp_tier,icp_score,category_path
         FROM companies WHERE ${where} ORDER BY icp_score DESC NULLS LAST LIMIT $2 OFFSET $3`,
        [cat.path, Number(limit), Number(offset)]
      )
      res.json({ companies: rows, total: Number(count), limit: Number(limit), offset: Number(offset) })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/categories/:slug', async (req, res) => {
    try {
      const { rows: [cat] } = await pool.query(
        `SELECT id,path,slug,name,parent_path,depth,company_count FROM categories WHERE slug=$1`,
        [req.params.slug]
      )
      if (!cat) return res.status(404).json({ error: 'not found' })
      const { rows: children } = await pool.query(
        `SELECT id,path,slug,name,parent_path,depth,company_count FROM categories
         WHERE parent_path=$1 ORDER BY company_count DESC`,
        [cat.path]
      )
      res.json({ category: cat, children })
    } catch (e) { capture500(res, e, safeError) }
  })
}
