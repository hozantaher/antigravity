// bff-campaigns-filter-tier.contract.test.js — UX-1 (2026-05-14)
//
// Verifies POST /api/campaigns/:id/filter-tier behavior. State-mutating
// route — per feedback_audit_log_on_mutations the operator_audit_log
// INSERT must land in the same transaction as the UPDATE.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const { mountCampaignsRoutes } = await import('../../src/server-routes/campaigns.js')
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  const setRouteTags = () => {}
  mountCampaignsRoutes(app, {
    pool: poolMock,
    capture500,
    safeError,
    setRouteTags,
    Sentry: { captureException: () => {} },
  })
  return app
}

function makeClient() {
  return { query: vi.fn(), release: vi.fn() }
}

describe('POST /api/campaigns/:id/filter-tier', () => {
  let pool, client
  beforeEach(() => {
    client = makeClient()
    pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }
  })

  it('rejects non-numeric id with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/abc/filter-tier').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid campaign_id')
  })

  it('rejects max above E-tier band with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/filter-tier?max=0.80').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_max')
  })

  it('rejects max <= 0 with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/filter-tier?max=0').send({})
    expect(res.status).toBe(400)
  })

  it('rejects non-numeric max with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/filter-tier?max=foo').send({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when campaign does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }) // campaign SELECT → empty
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/9999/filter-tier').send({})
    expect(res.status).toBe(404)
  })

  it('dry_run returns count without UPDATE', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'cmp' }] })  // campaign exists
      .mockResolvedValueOnce({ rows: [{ n: 5121 }] })               // count
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/filter-tier?dry_run=1')
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.dry_run).toBe(true)
    expect(res.body.rows_skipped).toBe(5121)
    // No connect() call → no transaction opened for dry_run.
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('happy path flips rows + INSERTs audit row in same tx', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'cmp' }] })
    // client.query sequence: BEGIN, UPDATE, INSERT audit, COMMIT
    client.query
      .mockResolvedValueOnce(undefined)                  // BEGIN
      .mockResolvedValueOnce({ rowCount: 5121 })         // UPDATE
      .mockResolvedValueOnce({ rowCount: 1 })            // INSERT audit
      .mockResolvedValueOnce(undefined)                  // COMMIT
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/filter-tier?max=0.50')
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.rows_skipped).toBe(5121)
    expect(res.body.max_priority).toBeCloseTo(0.50, 4)
    expect(res.body.dry_run).toBe(false)

    // Verify ordering: BEGIN -> UPDATE -> INSERT audit -> COMMIT.
    // Whitespace-collapse to keep regex assertions resilient to multi-line
    // formatting in the SQL string literal.
    const calls = client.query.mock.calls.map((c) => c[0].replace(/\s+/g, ' '))
    expect(calls[0]).toMatch(/BEGIN/)
    expect(calls[1]).toMatch(/UPDATE campaign_contacts/)
    expect(calls[1]).toMatch(/status\s*=\s*'skipped'/)
    expect(calls[1]).toMatch(/priority\s*<\s*\$2/)
    expect(calls[1]).toMatch(/status\s*IN \('pending', 'in_flight'\)/)
    expect(calls[2]).toMatch(/INSERT INTO operator_audit_log/)
    expect(calls[2]).toMatch(/campaign_filter_tier/)
    expect(calls[3]).toMatch(/COMMIT/)
    expect(client.release).toHaveBeenCalled()
  })

  it('rolls back on UPDATE failure', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'cmp' }] })
    client.query
      .mockResolvedValueOnce(undefined)                       // BEGIN
      .mockRejectedValueOnce(new Error('constraint_violation')) // UPDATE fails
      .mockResolvedValueOnce(undefined)                       // ROLLBACK
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/filter-tier?max=0.50')
      .send({})
    expect(res.status).toBe(500)
    const rollbackCall = client.query.mock.calls.find((c) => /ROLLBACK/.test(c[0]))
    expect(rollbackCall).toBeTruthy()
    expect(client.release).toHaveBeenCalled()
  })

  it('reads operator id from x-operator header for audit actor', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'cmp' }] })
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce(undefined)
    const app = await makeApp(pool)
    await request(app)
      .post('/api/campaigns/457/filter-tier?max=0.50')
      .set('x-operator', 'tomas')
      .send({})
    const insertCall = client.query.mock.calls.find((c) => /operator_audit_log/.test(c[0]))
    expect(insertCall[1][0]).toBe('tomas')
  })
})

describe('GET /api/campaigns/:id/reply-projection', () => {
  let pool
  beforeEach(() => {
    pool = { query: vi.fn(), connect: vi.fn() }
  })

  it('rejects non-numeric id with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/abc/reply-projection')
    expect(res.status).toBe(400)
  })

  it('returns zero-state 200 when campaign does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/9999/reply-projection')
    expect(res.status).toBe(200)
    expect(res.body.sent_today).toBe(0)
    expect(res.body.replied_today).toBe(0)
    expect(res.body.first_send_at).toBeNull()
  })

  it('returns sent_today + replied_today + projection for existing campaign', async () => {
    const now = new Date('2026-05-14T18:00:00Z').toISOString()
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457 }] })
      .mockResolvedValueOnce({ rows: [{
        sent_today: 247, replied_today: 0, sent_total: 247, first_send_at: now,
      }] })
    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/457/reply-projection')
    expect(res.status).toBe(200)
    expect(res.body.campaign_id).toBe(457)
    expect(res.body.sent_today).toBe(247)
    expect(res.body.replied_today).toBe(0)
    expect(res.body.sent_total).toBe(247)
    // 1.5% * 247 ≈ 4 (rounded)
    expect(res.body.projection_replies).toBe(4)
    expect(res.body.first_send_at).toBe(now)
  })

  it('projection is 0 when no sends yet', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457 }] })
      .mockResolvedValueOnce({ rows: [{
        sent_today: 0, replied_today: 0, sent_total: 0, first_send_at: null,
      }] })
    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/457/reply-projection')
    expect(res.body.projection_replies).toBe(0)
  })
})
