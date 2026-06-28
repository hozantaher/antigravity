// bff-vehicles-patch.contract.test.js — PATCH /api/vehicles/:id.
//
// Focus: a status change must stamp status_changed_at = now() so the UI's
// "Změněno" reflects the actual pipeline transition (the touch_updated_at
// trigger only sets updated_at). A non-status edit must NOT stamp it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(pool) {
  const app = express()
  app.use(express.json())
  const { mountVehiclesRoutes } = await import('../../src/server-routes/vehicles.js')
  mountVehiclesRoutes(app, {
    pool,
    capture500: (res, err) => res.status(500).json({ error: err.message }),
    safeError: (e) => e,
  })
  return app
}

describe('PATCH /api/vehicles/:id', () => {
  let pool, updateSql
  beforeEach(() => {
    updateSql = null
    pool = {
      query: vi.fn().mockImplementation(async (sql) => {
        if (typeof sql === 'string' && sql.startsWith('UPDATE vehicles SET')) {
          updateSql = sql
          return { rows: [{ id: 76, status: 'agreed' }] }
        }
        return { rows: [] }   // auditLog INSERT etc.
      }),
    }
  })

  it('stamps status_changed_at = now() when status changes', async () => {
    const app = await makeApp(pool)
    const res = await request(app).patch('/api/vehicles/76').send({ status: 'agreed' })
    expect(res.status).toBe(200)
    expect(updateSql).toContain('status = ')
    expect(updateSql).toContain('status_changed_at = now()')
  })

  it('does NOT stamp status_changed_at on a non-status edit', async () => {
    const app = await makeApp(pool)
    const res = await request(app).patch('/api/vehicles/76').send({ notes: 'volal jsem, zatím nic' })
    expect(res.status).toBe(200)
    expect(updateSql).toContain('notes = ')
    expect(updateSql).not.toContain('status_changed_at')
  })

  it('rejects an invalid status with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).patch('/api/vehicles/76').send({ status: 'bogus' })
    expect(res.status).toBe(400)
  })

  it('rejects an empty patch with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).patch('/api/vehicles/76').send({})
    expect(res.status).toBe(400)
  })
})
