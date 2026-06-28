// bff-campaigns-sequence.contract.test.js — Sprint L1 (#1285).
//
// Coverage:
//   - Validation: steps array, length 1..10, sequential indexes, monotonic
//     delays, bounds 0..90, template existence
//   - Campaign existence 404
//   - Audit log row contains prev / next sequence + step count diff
//   - X-Operator captured in actor
//   - ROLLBACK on UPDATE failure
//   - Trim template name before storage

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
    pool: poolMock, capture500, safeError, setRouteTags,
    Sentry: { captureException: () => {} },
  })
  return app
}

function makeClient() {
  return { query: vi.fn(), release: vi.fn() }
}

function validSteps() {
  return [
    { step: 0, template: 'intro_machinery', delay_days: 0 },
    { step: 1, template: 'followup1', delay_days: 5 },
  ]
}

describe('PUT /api/campaigns/:id/sequence', () => {
  let pool, client
  beforeEach(() => {
    client = makeClient()
    pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }
  })

  it('rejects non-numeric id', async () => {
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/abc/sequence').send({ steps: validSteps() })
    expect(res.status).toBe(400)
  })

  it('rejects missing steps array', async () => {
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('steps must be an array')
  })

  it('rejects empty steps array', async () => {
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({ steps: [] })
    expect(res.status).toBe(400)
  })

  it('rejects > 10 steps', async () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({
      step: i, template: 'intro_machinery', delay_days: i * 2,
    }))
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({ steps })
    expect(res.status).toBe(400)
  })

  it('rejects step index gap', async () => {
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({
      steps: [
        { step: 0, template: 'intro_machinery', delay_days: 0 },
        { step: 2, template: 'followup1', delay_days: 5 }, // gap
      ],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('wrong index')
  })

  it('rejects non-monotonic delay_days', async () => {
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({
      steps: [
        { step: 0, template: 'intro_machinery', delay_days: 5 },
        { step: 1, template: 'followup1', delay_days: 3 }, // less than prev
      ],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('less than previous')
  })

  it('rejects delay_days > 90', async () => {
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({
      steps: [{ step: 0, template: 'intro_machinery', delay_days: 95 }],
    })
    expect(res.status).toBe(400)
  })

  it('rejects unknown template name', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ name: 'intro_machinery' }] }) // only one found
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({
      steps: [
        { step: 0, template: 'intro_machinery', delay_days: 0 },
        { step: 1, template: 'nonexistent', delay_days: 5 },
      ],
    })
    expect(res.status).toBe(400)
    expect(res.body.missing).toEqual(['nonexistent'])
  })

  it('returns 404 when campaign missing', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ name: 'intro_machinery' }, { name: 'followup1' }] }) // templates
      .mockResolvedValueOnce({ rows: [] }) // campaign not found
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/9999/sequence').send({ steps: validSteps() })
    expect(res.status).toBe(404)
  })

  it('successful update commits + audits prev/next diff', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ name: 'intro_machinery' }, { name: 'followup1' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 457, name: 'X',
        sequence_config: [{ step: 0, template: 'intro_machinery', delay_days: 0 }],
      }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({ steps: validSteps() })
    expect(res.status).toBe(200)
    expect(res.body.sequence).toHaveLength(2)

    // Audit log is 3rd client.query — BEGIN, UPDATE, INSERT audit
    const auditCall = client.query.mock.calls[2]
    expect(auditCall[0]).toContain('operator_audit_log')
    const payload = JSON.parse(auditCall[1][2])
    expect(payload.next_sequence).toHaveLength(2)
    expect(payload.prev_sequence).toHaveLength(1)
    expect(payload.step_count_diff).toBe(1)
  })

  it('captures X-Operator header', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ name: 'intro_machinery' }, { name: 'followup1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'X', sequence_config: [] }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    await request(app).put('/api/campaigns/457/sequence')
      .set('X-Operator', 'tomas')
      .send({ steps: validSteps() })
    expect(client.query.mock.calls[2][1][0]).toBe('tomas')
  })

  it('rollback on UPDATE failure', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ name: 'intro_machinery' }, { name: 'followup1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'X', sequence_config: [] }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('db down')) // UPDATE fails
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({ steps: validSteps() })
    expect(res.status).toBe(500)
    expect(client.query.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true)
  })

  it('trims template name whitespace before storage', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ name: 'intro_machinery' }] })
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'X', sequence_config: [] }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({
      steps: [{ step: 0, template: '  intro_machinery  ', delay_days: 0 }],
    })
    expect(res.body.sequence[0].template).toBe('intro_machinery')
  })

  it('accepts max-length 10 steps', async () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      step: i, template: 'intro_machinery', delay_days: i * 5,
    }))
    pool.query
      .mockResolvedValueOnce({ rows: [{ name: 'intro_machinery' }] })
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'X', sequence_config: [] }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({ steps })
    expect(res.status).toBe(200)
    expect(res.body.sequence).toHaveLength(10)
  })

  it('accepts repeated delay_days (>= prev, not strictly greater)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ name: 'intro_machinery' }, { name: 'followup1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'X', sequence_config: [] }] })
    client.query
      .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({})
    const app = await makeApp(pool)
    const res = await request(app).put('/api/campaigns/457/sequence').send({
      steps: [
        { step: 0, template: 'intro_machinery', delay_days: 5 },
        { step: 1, template: 'followup1', delay_days: 5 }, // equal, not less
      ],
    })
    expect(res.status).toBe(200)
  })
})
