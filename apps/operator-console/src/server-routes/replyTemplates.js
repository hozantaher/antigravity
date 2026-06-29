// Reply templates route — operator response scaffolds for the Odpovědi
// composer (#1022 [S5.4]). Read-only list of active templates the operator
// picks from to seed a reply, then tweaks + sends through the existing safe
// path. Content lives in reply_templates (migration 147); per
// feedback_templates_in_db the operator edits via SQL/settings, not the repo.
//
// Routes covered (1):
//   GET /api/reply-templates  — active templates, ordered for the picker

/**
 * Mount the reply-templates route surface.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountReplyTemplatesRoutes(app, deps) {
  const { pool, capture500, safeError } = deps

  app.get('/api/reply-templates', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, slug, label, body, sort_order
          FROM reply_templates
         WHERE active = TRUE
         ORDER BY sort_order, label
      `)
      res.json({
        templates: rows.map(r => ({
          id: r.id,
          slug: r.slug,
          label: r.label,
          body: r.body,
        })),
        generated_at: new Date().toISOString(),
      })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })
}
