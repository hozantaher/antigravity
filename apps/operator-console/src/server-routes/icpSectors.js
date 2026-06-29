// icpSectors.js — BFF routes for ICP sector management (Sprint AJ).
// ─────────────────────────────────────────────────────────────────────────────
// Exposes the icp_sectors table (migration 061) so the operator can add,
// toggle, and tune target / anti-target sectors without code deploys.
//
// Routes:
//   GET    /api/icp-sectors           — list all sectors (filter ?kind=target|anti_target)
//   POST   /api/icp-sectors           — create new sector (validates unique code+kind)
//   PATCH  /api/icp-sectors/:id       — update active, weight, name, nace_prefixes
//   DELETE /api/icp-sectors/:id       — soft-delete (sets active=false, writes audit log)
//
// Audit log: every mutation writes to operator_audit_log (same pattern as operatorSettings.js).
// No X-Confirm-Send gate — this is not a send-path endpoint.

const VALID_KINDS = new Set(['target', 'anti_target'])

/**
 * Mount ICP sector management routes on the Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountICPSectorsRoutes(app, { pool, capture500, safeError }) {

  // ── GET /api/icp-sectors ──────────────────────────────────────────────────
  // Returns all sectors. Optional ?kind=target|anti_target filter.
  app.get('/api/icp-sectors', async (req, res) => {
    try {
      const { kind } = req.query
      let query = `
        SELECT id, code, name, kind, nace_prefixes, weight, active, created_at, updated_at, updated_by
        FROM icp_sectors
      `
      const params = []
      if (kind && VALID_KINDS.has(kind)) {
        params.push(kind)
        query += ` WHERE kind = $1`
      }
      query += ` ORDER BY kind ASC, weight DESC, code ASC`

      const { rows } = await pool.query(query, params)
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── POST /api/icp-sectors ─────────────────────────────────────────────────
  // Create a new sector. code+kind must be unique (DB constraint).
  app.post('/api/icp-sectors', async (req, res) => {
    try {
      const { code, name, kind, nace_prefixes, weight } = req.body ?? {}

      // Validation.
      if (!code || typeof code !== 'string' || code.trim() === '') {
        return res.status(400).json({ error: 'code must be a non-empty string' })
      }
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'name must be a non-empty string' })
      }
      if (!kind || !VALID_KINDS.has(kind)) {
        return res.status(400).json({ error: 'kind must be "target" or "anti_target"' })
      }
      const prefixes = Array.isArray(nace_prefixes)
        ? nace_prefixes.filter(p => typeof p === 'string' && p.trim())
        : []
      const w = Number.isInteger(weight) ? weight : 1
      const actor = req.headers['x-actor'] || 'dashboard'

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const { rows } = await client.query(
          `INSERT INTO icp_sectors (code, name, kind, nace_prefixes, weight, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, code, name, kind, nace_prefixes, weight, active, created_at, updated_at, updated_by`,
          [code.trim(), name.trim(), kind, prefixes, w, actor]
        )

        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            'icp_sector_create',
            actor,
            'icp_sectors',
            String(rows[0].id),
            JSON.stringify({ code: code.trim(), name: name.trim(), kind, nace_prefixes: prefixes, weight: w }),
          ]
        )

        await client.query('COMMIT')
        res.status(201).json(rows[0])
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        // Unique violation → 409
        if (e?.code === '23505') {
          return res.status(409).json({ error: `Sector with code "${code.trim()}" and kind "${kind}" already exists` })
        }
        capture500(res, e, safeError)
      } finally {
        client.release()
      }
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── PATCH /api/icp-sectors/:id ────────────────────────────────────────────
  // Update active, weight, name, or nace_prefixes for one sector.
  app.patch('/api/icp-sectors/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'id must be a positive integer' })
      }

      const allowed = ['active', 'weight', 'name', 'nace_prefixes']
      const updates = {}
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(req.body ?? {}, key)) {
          updates[key] = req.body[key]
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No updatable fields provided (allowed: active, weight, name, nace_prefixes)' })
      }

      // Type coercion + validation.
      if ('active' in updates) {
        updates.active = Boolean(updates.active)
      }
      if ('weight' in updates) {
        const w = Number(updates.weight)
        if (!Number.isFinite(w)) {
          return res.status(400).json({ error: 'weight must be a number' })
        }
        updates.weight = Math.round(w)
      }
      if ('name' in updates) {
        if (typeof updates.name !== 'string' || updates.name.trim() === '') {
          return res.status(400).json({ error: 'name must be a non-empty string' })
        }
        updates.name = updates.name.trim()
      }
      if ('nace_prefixes' in updates) {
        if (!Array.isArray(updates.nace_prefixes)) {
          return res.status(400).json({ error: 'nace_prefixes must be an array' })
        }
        updates.nace_prefixes = updates.nace_prefixes
          .filter(p => typeof p === 'string' && p.trim())
          .map(p => p.trim())
      }

      const actor = req.headers['x-actor'] || 'dashboard'
      const setClauses = []
      const params = []
      let idx = 1

      for (const [key, val] of Object.entries(updates)) {
        setClauses.push(`${key} = $${idx}`)
        params.push(val)
        idx++
      }
      setClauses.push(`updated_at = NOW()`, `updated_by = $${idx}`)
      params.push(actor)
      idx++
      params.push(id)

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const { rows } = await client.query(
          `UPDATE icp_sectors
           SET ${setClauses.join(', ')}
           WHERE id = $${idx}
           RETURNING id, code, name, kind, nace_prefixes, weight, active, created_at, updated_at, updated_by`,
          params
        )

        if (rows.length === 0) {
          await client.query('ROLLBACK')
          return res.status(404).json({ error: `icp_sector id=${id} not found` })
        }

        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            'icp_sector_update',
            actor,
            'icp_sectors',
            String(id),
            JSON.stringify({ id, updates }),
          ]
        )

        await client.query('COMMIT')
        res.json(rows[0])
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        capture500(res, e, safeError)
      } finally {
        client.release()
      }
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── DELETE /api/icp-sectors/:id ───────────────────────────────────────────
  // Soft-delete: sets active=false. Row is preserved for audit trail.
  app.delete('/api/icp-sectors/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'id must be a positive integer' })
      }

      const actor = req.headers['x-actor'] || 'dashboard'

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const { rows } = await client.query(
          `UPDATE icp_sectors
           SET active = false, updated_at = NOW(), updated_by = $1
           WHERE id = $2
           RETURNING id, code, name, kind, active, updated_at`,
          [actor, id]
        )

        if (rows.length === 0) {
          await client.query('ROLLBACK')
          return res.status(404).json({ error: `icp_sector id=${id} not found` })
        }

        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            'icp_sector_delete',
            actor,
            'icp_sectors',
            String(id),
            JSON.stringify({ id, code: rows[0].code, kind: rows[0].kind }),
          ]
        )

        await client.query('COMMIT')
        res.json({ deleted: true, id, active: false })
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        capture500(res, e, safeError)
      } finally {
        client.release()
      }
    } catch (e) { capture500(res, e, safeError) }
  })
}
