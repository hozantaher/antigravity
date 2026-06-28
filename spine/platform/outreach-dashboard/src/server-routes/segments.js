// Segments route surface — list + create (read/write entry-points only).
// ─────────────────────────────────────────────────────────────────────────────
// T3.7 (2026-05-01): extracted verbatim from server.js per ADR-008 D2 module
// sequence. Behavior is byte-equivalent: same SQL, same response shape, same
// Sentry capture.
//
// Routes extracted (2):
//   GET  /api/segments — list all segments
//   POST /api/segments — create a new segment from {name, description, query}
//
// The remaining segment endpoints (PATCH /:id, DELETE /:id, /preview,
// /:id/companies, /:id/rebuild) stay inline in server.js for now — they
// depend on `buildPreviewWhere` and `buildSegmentWhere` helpers that are
// shared with other surfaces and out of scope for this extraction. A
// follow-up will hoist those helpers and pull the rest of the segment
// surface across.

/**
 * Mount the Segments route surface (list + create) on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountSegmentsRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/segments', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT id,name,description,query,company_count,created_at FROM segments ORDER BY created_at DESC`)
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })
  app.post('/api/segments', async (req, res) => {
    let client
    try {
      const { name, description, query } = req.body
      client = await pool.connect()
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO segments(name,description,query) VALUES($1,$2,$3) RETURNING *`,
        [name, description||null, query||{}]
      )
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('segment_create', 'dashboard', 'segment', $1, $2::jsonb)`,
        [String(rows[0].id), JSON.stringify({ name: rows[0].name })]
      )
      await client.query('COMMIT')
      res.json(rows[0])
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK') } catch {} }
      capture500(res, e, safeError)
    } finally {
      if (client) client.release()
    }
  })
}
