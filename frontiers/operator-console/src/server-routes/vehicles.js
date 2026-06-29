// AU-F1 (2026-05-19) — vehicles inventory BFF routes.
//
// Workflow surface for the operator's heavy-machinery dealership: a
// reply arrives in /replies, operator extracts a vehicle from the body
// (make / model / year / mileage / price), saves here. The save also
// upserts crm_clients (by email) so the prospect becomes a tracked
// relationship and stamps the source reply handled.
//
// Endpoints:
//   GET    /api/vehicles                — paginated list with filters
//   GET    /api/vehicles/:id            — single vehicle
//   POST   /api/vehicles                — create from reply (upserts crm_client)
//   PATCH  /api/vehicles/:id            — update fields / status
//   DELETE /api/vehicles/:id            — soft delete (status='cancelled')
//
// All mutations write to operator_audit_log per feedback_audit_log_on_mutations T0.

import {
  bareEmail,
  upsertCrmClient,
  lookupContactByEmail,
  markReplyHandled,
  auditLog,
} from '../lib/vehicleCapture.js'

const ALLOWED_STATUSES = ['offered', 'negotiating', 'agreed', 'paid', 'picked_up', 'cancelled']
const DEFAULT_PAGE_SIZE = 30
// Vehicles inventory IS the operator's sales pipeline ("leady JSOU vozidla") and
// the table has no pagination UI — it's meant to be scanned whole. Cap raised
// 100→500 so the list isn't silently truncated as inventory grows; the client
// requests size=500. Beyond 500 would need real pagination (follow-up).
const MAX_PAGE_SIZE = 500

function clampPageSize(size) {
  const n = Number.parseInt(size, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(n, MAX_PAGE_SIZE)
}

// bareEmail, upsertCrmClient, lookupContactByEmail, markReplyHandled, auditLog
// now live in ../lib/vehicleCapture.js — shared with runVehicleAutoCaptureCron
// so manual + automated capture link contacts/companies/crm identically.
// Manual mutations pass actor:'operator' to auditLog; auto-capture omits it
// (defaults to 'system').

/**
 * Mount vehicle inventory routes.
 *
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: Function, safeError: Function }} deps
 */
export function mountVehiclesRoutes(app, { pool, capture500, safeError }) {
  // List + filter
  app.get('/api/vehicles', async (req, res) => {
    try {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
      const size = clampPageSize(req.query.size)
      const offset = (page - 1) * size

      const conds = []
      const params = []
      let p = 1

      // All conds are qualified with the `v.` alias. Both the outer query and
      // the inner count alias vehicles as `v`, so the SAME where clause is
      // unambiguous in both — `crm_client_id` would otherwise collide with
      // companies.crm_client_id once the JOIN is present (SQLSTATE 42702).
      if (req.query.status) {
        const statuses = String(req.query.status).split(',').map(s => s.trim()).filter(s => ALLOWED_STATUSES.includes(s))
        if (statuses.length > 0) {
          conds.push(`v.status = ANY($${p++}::text[])`)
          params.push(statuses)
        }
      }
      const q = (req.query.q || '').toString().trim()
      if (q.length >= 2) {
        conds.push(`(v.make ILIKE $${p} OR v.model ILIKE $${p} OR v.vin ILIKE $${p} OR v.notes ILIKE $${p})`)
        params.push(`%${q}%`)
        p++
      }
      if (req.query.crm_client_id) {
        const cid = Number.parseInt(req.query.crm_client_id, 10)
        if (Number.isFinite(cid)) {
          conds.push(`v.crm_client_id = $${p++}`)
          params.push(cid)
        }
      }
      // source_reply_id — used by the Odpovědi capture panel to check
      // whether a reply already produced a vehicle (avoid duplicate capture).
      if (req.query.source_reply_id) {
        const sid = Number.parseInt(req.query.source_reply_id, 10)
        if (Number.isFinite(sid)) {
          conds.push(`v.source_reply_id = $${p++}`)
          params.push(sid)
        }
      }
      // contact_id — used by the Kontakty detail to list a contact's
      // vehicles (the kontakt→vozidlo edge, reverse of vozidlo→kontakt).
      if (req.query.contact_id) {
        const ctid = Number.parseInt(req.query.contact_id, 10)
        if (Number.isFinite(ctid)) {
          conds.push(`v.contact_id = $${p++}`)
          params.push(ctid)
        }
      }
      // Filter by the owning company's IČO. Expressed as a subquery on
      // v.company_id (not a co.ico join) so the SAME where clause stays valid
      // in BOTH the joined outer query and the bare inner count subquery.
      if (req.query.company_ico) {
        const ico = String(req.query.company_ico).trim()
        if (ico) {
          conds.push(`v.company_id IN (SELECT id FROM companies WHERE ico = $${p++})`)
          params.push(ico)
        }
      }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
      // total comes from a SEPARATE count query. Piggybacking it as a per-row
      // `(SELECT count(*)...) AS total_count` returned 0 on an over-range page:
      // when OFFSET skips past the last row, `rows` is empty and there is no row
      // left to read total_count from. The list query appends size/offset after
      // the shared filter params ($1..$N); the count query reuses just the filter.
      const sql = `
        SELECT v.*,
               cc.name AS crm_client_name,
               cc.email AS crm_client_email,
               co.name AS company_name
          FROM vehicles v
          LEFT JOIN crm_clients cc ON cc.id = v.crm_client_id
          LEFT JOIN companies   co ON co.id = v.company_id
        ${where}
         ORDER BY v.created_at DESC
         LIMIT $${p++} OFFSET $${p++}
      `
      const countSql = `SELECT count(*)::int AS total FROM vehicles v ${where}`
      const [{ rows }, { rows: [countRow] }] = await Promise.all([
        pool.query(sql, [...params, size, offset]),
        pool.query(countSql, params),
      ])
      const total = countRow?.total ?? 0
      res.json({ rows, total: Number(total), page, size })
    } catch (e) { capture500(res, e, safeError) }
  })

  // Single vehicle detail
  app.get('/api/vehicles/:id', async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
      const { rows: [v] } = await pool.query(
        `SELECT v.*,
                cc.name AS crm_client_name,
                cc.email AS crm_client_email,
                co.name AS company_name,
                co.ico AS company_ico
           FROM vehicles v
           LEFT JOIN crm_clients cc ON cc.id = v.crm_client_id
           LEFT JOIN companies   co ON co.id = v.company_id
          WHERE v.id = $1`,
        [id]
      )
      if (!v) return res.status(404).json({ error: 'not found' })
      res.json(v)
    } catch (e) { capture500(res, e, safeError) }
  })

  // Create — from reply
  app.post('/api/vehicles', async (req, res) => {
    try {
      const b = req.body || {}
      if (!b.make || !b.model) {
        return res.status(400).json({ error: 'make and model are required' })
      }
      if (b.status && !ALLOWED_STATUSES.includes(b.status)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` })
      }

      // Provenance lookups — best-effort, never block the insert.
      const emailBare = bareEmail(b.source_reply_email)
      let contactId = b.contact_id || null
      let companyId = b.company_id || null
      let crmClientId = b.crm_client_id || null
      let contactName = null

      if (!contactId && emailBare) {
        const lookup = await lookupContactByEmail(pool, emailBare).catch(() => null)
        if (lookup) {
          contactId = lookup.contact_id
          companyId = companyId || lookup.company_id
          contactName = lookup.contact_name
        }
      }

      if (!crmClientId && emailBare) {
        crmClientId = await upsertCrmClient(pool, {
          email: emailBare,
          name: contactName || b.crm_client_name || null,
          ico: b.ico || null,
          companyId,
        }).catch(() => null)
      }

      const { rows: [created] } = await pool.query(
        `INSERT INTO vehicles (
           make, model, year, vin,
           mileage_km, fuel, transmission, body_type, color,
           price_asking_eur, price_offered_eur, price_agreed_eur,
           status,
           source_reply_id, source_reply_email,
           contact_id, company_id, crm_client_id,
           notes, photos
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8, $9,
           $10, $11, $12,
           $13,
           $14, $15,
           $16, $17, $18,
           $19, $20
         )
         RETURNING *`,
        [
          b.make.trim(), b.model.trim(), b.year || null, b.vin || null,
          b.mileage_km || null, b.fuel || null, b.transmission || null, b.body_type || null, b.color || null,
          b.price_asking_eur || null, b.price_offered_eur || null, b.price_agreed_eur || null,
          b.status || 'offered',
          b.source_reply_id || null, emailBare || null,
          contactId, companyId, crmClientId,
          b.notes || null, JSON.stringify(b.photos || []),
        ]
      )

      // Mark source reply handled — best-effort, audit log even if it fails.
      if (b.source_reply_id) {
        await markReplyHandled(pool, Number(b.source_reply_id)).catch(() => null)
      }

      await auditLog(pool, {
        action: 'vehicle_created',
        actor: 'operator',
        entityId: created.id,
        details: {
          make: created.make, model: created.model, year: created.year,
          source_reply_id: created.source_reply_id,
          crm_client_id: created.crm_client_id,
          price_offered_eur: created.price_offered_eur,
        },
      }).catch(() => null)

      res.status(201).json(created)
    } catch (e) { capture500(res, e, safeError) }
  })

  // Update — partial. Common cases: status transition, notes, agreed price.
  app.patch('/api/vehicles/:id', async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
      const b = req.body || {}

      if (b.status && !ALLOWED_STATUSES.includes(b.status)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` })
      }

      const fields = []
      const params = []
      let p = 1
      const SET = (col, val) => { fields.push(`${col} = $${p++}`); params.push(val) }

      if (b.make !== undefined)              SET('make', b.make)
      if (b.model !== undefined)             SET('model', b.model)
      if (b.year !== undefined)              SET('year', b.year || null)
      if (b.vin !== undefined)               SET('vin', b.vin || null)
      if (b.mileage_km !== undefined)        SET('mileage_km', b.mileage_km || null)
      if (b.fuel !== undefined)              SET('fuel', b.fuel || null)
      if (b.transmission !== undefined)      SET('transmission', b.transmission || null)
      if (b.body_type !== undefined)         SET('body_type', b.body_type || null)
      if (b.color !== undefined)             SET('color', b.color || null)
      if (b.price_asking_eur !== undefined)  SET('price_asking_eur', b.price_asking_eur || null)
      if (b.price_offered_eur !== undefined) SET('price_offered_eur', b.price_offered_eur || null)
      if (b.price_agreed_eur !== undefined)  SET('price_agreed_eur', b.price_agreed_eur || null)
      if (b.status !== undefined)            SET('status', b.status)
      // Stamp the stage-transition time so the UI's "Změněno" reflects the
      // actual pipeline move (the touch_updated_at trigger only sets updated_at).
      if (b.status !== undefined)            fields.push(`status_changed_at = now()`)
      if (b.notes !== undefined)             SET('notes', b.notes || null)
      if (b.photos !== undefined)            SET('photos', JSON.stringify(b.photos))

      if (fields.length === 0) {
        return res.status(400).json({ error: 'no fields to update' })
      }

      params.push(id)
      const { rows: [updated] } = await pool.query(
        `UPDATE vehicles SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`,
        params
      )
      if (!updated) return res.status(404).json({ error: 'not found' })

      await auditLog(pool, {
        action: 'vehicle_updated',
        actor: 'operator',
        entityId: id,
        details: { fields_changed: Object.keys(b), new_status: updated.status },
      }).catch(() => null)

      res.json(updated)
    } catch (e) { capture500(res, e, safeError) }
  })

  // Soft delete — sets status='cancelled' (preserves audit trail).
  app.delete('/api/vehicles/:id', async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
      const { rows: [updated] } = await pool.query(
        `UPDATE vehicles SET status = 'cancelled' WHERE id = $1 RETURNING id, status`,
        [id]
      )
      if (!updated) return res.status(404).json({ error: 'not found' })
      await auditLog(pool, {
        action: 'vehicle_cancelled',
        actor: 'operator',
        entityId: id,
        details: { },
      }).catch(() => null)
      res.json(updated)
    } catch (e) { capture500(res, e, safeError) }
  })
}
