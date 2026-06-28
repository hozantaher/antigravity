// bff-campaigns-unskip.contract.test.js — Sprint O1.
//
// Verifies POST /api/campaigns/:id/unskip behavior. Used to walk the
// freemail-bug cohort (PR #1270) out of terminal status='skipped'
// without psql writes. Per HARD RULE feedback_audit_log_on_mutations
// the audit row + UPDATE must land in the same transaction.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mirror the campaigns mounter signature — partial import wouldn't
// expose just the unskip route, so we mount the whole module and
// stub minimum deps. The pool mock controls all SQL.
async function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const { mountCampaignsRoutes } = await import('../../src/server-routes/campaigns.js')
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  const setRouteTags = () => {} // no-op for tests
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

describe('POST /api/campaigns/:id/unskip', () => {
  let pool, client
  beforeEach(() => {
    client = makeClient()
    pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }
  })

  it('rejects non-numeric id with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/abc/unskip')
      .send({ confirm: true, reason: 'long-enough reason text' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid campaign id')
  })

  it('rejects missing confirm with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/unskip')
      .send({ reason: 'long-enough reason text' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('confirm must be true')
  })

  it('rejects reason under 10 chars', async () => {
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/unskip')
      .send({ confirm: true, reason: 'too short' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('reason must be at least 10 characters')
  })

  it('rejects when campaign does not exist (404)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }) // SELECT FROM campaigns → empty
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/9999/unskip')
      .send({ confirm: true, reason: 'valid reason here' })
    expect(res.status).toBe(404)
  })

  it('unskips with filter, audits in same tx, returns updated count', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'Strojírenství' }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ n: '21725' }] }) // SELECT COUNT
      .mockResolvedValueOnce({ rowCount: 21725 }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/unskip')
      .send({
        confirm: true,
        reason: 'Freemail dedup fix cohort reset',
        skip_reason_filter: 'per_domain_cooldown',
      })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(21725)
    expect(res.body.skip_reason_filter).toBe('per_domain_cooldown')

    // Audit row must be present in the client's call sequence
    // (the 4th query call, after BEGIN / SELECT count / UPDATE).
    const sqlCalls = client.query.mock.calls.map(c => c[0])
    expect(sqlCalls[3]).toContain('INSERT INTO operator_audit_log')
    const auditArgs = client.query.mock.calls[3][1]
    expect(auditArgs[0]).toBe('unknown') // operator default
    expect(auditArgs[1]).toBe('457')
    const auditPayload = JSON.parse(auditArgs[2])
    expect(auditPayload.updated_count).toBe(21725)
    expect(auditPayload.skip_reason_filter).toBe('per_domain_cooldown')
    expect(auditPayload.reason).toBe('Freemail dedup fix cohort reset')
  })

  it('unskips ALL skipped contacts when filter omitted', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'Strojírenství' }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ n: '500' }] })
      .mockResolvedValueOnce({ rowCount: 500 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({})
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/unskip')
      .send({ confirm: true, reason: 'full reset across all reasons' })
    expect(res.status).toBe(200)
    expect(res.body.skip_reason_filter).toBe(null)
    // Audit payload should reflect (all)
    const auditArgs = client.query.mock.calls[3][1]
    expect(JSON.parse(auditArgs[2]).skip_reason_filter).toBe(null)
  })

  it('captures X-Operator header in audit row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ n: '1' }] })
      .mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    await request(app).post('/api/campaigns/457/unskip')
      .set('X-Operator', 'tomas')
      .send({ confirm: true, reason: 'valid operator reason' })
    expect(client.query.mock.calls[3][1][0]).toBe('tomas')
  })

  it('rollback on DB error inside transaction', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ n: '10' }] }) // SELECT
      .mockRejectedValueOnce(new Error('update failed')) // UPDATE fails
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/unskip')
      .send({ confirm: true, reason: 'this will roll back' })
    expect(res.status).toBe(500)
    // ROLLBACK + release must have been called
    expect(client.query.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true)
    expect(client.release).toHaveBeenCalled()
  })

  it('reason is trimmed before audit + length check', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ n: '0' }] })
      .mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    const padded = '   ' + 'valid reason here' + '   '
    await request(app).post('/api/campaigns/457/unskip')
      .send({ confirm: true, reason: padded })
    const auditPayload = JSON.parse(client.query.mock.calls[3][1][2])
    expect(auditPayload.reason).toBe('valid reason here')
  })

  it('returns ISO timestamp in requested_at', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ n: '0' }] })
      .mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/unskip')
      .send({ confirm: true, reason: 'ten chars yes' })
    expect(res.body.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('empty-string filter treated as no filter', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ n: '0' }] })
      .mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/unskip')
      .send({ confirm: true, reason: 'ten chars yes', skip_reason_filter: '   ' })
    expect(res.body.skip_reason_filter).toBe(null)
  })

  it('whitespace-only filter treated as no filter', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ n: '0' }] })
      .mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    const res = await request(app).post('/api/campaigns/457/unskip')
      .send({ confirm: true, reason: 'ten chars yes', skip_reason_filter: '' })
    expect(res.body.skip_reason_filter).toBe(null)
  })
})
