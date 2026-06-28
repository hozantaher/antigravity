// bff-campaigns-skip-by-domains.contract.test.js — Sprint AH2.
//
// Verifies POST /api/campaigns/:id/skip-by-domains behavior. Used by the
// SkipByDomainPanel drawer on CampaignDetail to bulk-skip campaign_contacts
// matching an operator-supplied domain list. Per HARD RULE
// feedback_audit_log_on_mutations the per-row audit + UPDATE must land
// in the same transaction.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const { mountCampaignsRoutes } = await import('../../src/server-routes/campaigns.js')
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  const setRouteTags = () => {} // no-op
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

describe('POST /api/campaigns/:id/skip-by-domains', () => {
  let pool, client
  beforeEach(() => {
    client = makeClient()
    pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }
  })

  it('rejects non-numeric id with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/abc/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['renofarmy.cz'],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid campaign id')
  })

  it('rejects empty domains array with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: [],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/domains must be a non-empty array/)
  })

  it('rejects missing domains field with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(400)
  })

  it('rejects more than 50 domains', async () => {
    const app = await makeApp(pool)
    const domains = Array.from({ length: 51 }, (_, i) => `domain${i}.cz`)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains,
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('too_many_domains')
  })

  it('rejects invalid domain syntax', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['not-a-domain', '@@bad@@', 'renofarmy'],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_domain')
  })

  it('rejects missing reason', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['renofarmy.cz'],
        confirm: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/reason must be a non-empty string/)
  })

  it('rejects missing confirm in mutation path', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['renofarmy.cz'],
        reason: 'operator_detected_holding_overlap',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('confirm must be true')
  })

  it('rejects missing X-Confirm-Send header with 412', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .send({
        domains: ['renofarmy.cz'],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(412)
    expect(res.body.error).toBe('missing_confirm_header')
  })

  it('rejects invalid status_filter entry', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['renofarmy.cz'],
        reason: 'operator_detected_holding_overlap',
        status_filter: ['sent'], // sent NOT allowed
        confirm: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_status_filter')
  })

  it('returns 404 when campaign does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }) // campaign SELECT empty
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/9999/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['renofarmy.cz'],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(404)
  })

  it('dry-run returns matched count + top domains, no UPDATE', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'Strojírenství' }] })
      .mockResolvedValueOnce({
        rows: [
          { domain: 'renofarmy.cz', count: 90 },
          { domain: 'iex.cz', count: 14 },
        ],
      })
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains?dry_run=true')
      .send({
        domains: ['renofarmy.cz', 'iex.cz'],
        reason: 'operator_detected_holding_overlap',
      })
    expect(res.status).toBe(200)
    expect(res.body.dry_run).toBe(true)
    expect(res.body.matched).toBe(104)
    expect(res.body.top_domains).toEqual([
      { domain: 'renofarmy.cz', count: 90 },
      { domain: 'iex.cz', count: 14 },
    ])
    // Mutation client.connect should NOT have been called.
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('mutation path: UPDATE + per-row audit in same tx', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'Strojírenství' }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          { id: 1001, contact_id: 5001, domain: 'renofarmy.cz' },
          { id: 1002, contact_id: 5002, domain: 'iex.cz' },
          { id: 1003, contact_id: 5003, domain: 'renofarmy.cz' },
        ],
      }) // UPDATE … RETURNING
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['renofarmy.cz', 'iex.cz'],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(3)
    expect(res.body.dry_run).toBe(false)
    // top_domains sorted by count desc.
    expect(res.body.top_domains[0]).toEqual({ domain: 'renofarmy.cz', count: 2 })
    expect(res.body.top_domains[1]).toEqual({ domain: 'iex.cz', count: 1 })

    // Audit was the 3rd call (after BEGIN + UPDATE).
    const sqlCalls = client.query.mock.calls.map((c) => c[0])
    expect(sqlCalls[2]).toContain('INSERT INTO operator_audit_log')
    // Audit params: 6 per row × 3 rows = 18 params.
    expect(client.query.mock.calls[2][1].length).toBe(18)
    // First action label.
    expect(client.query.mock.calls[2][1][0]).toBe('campaign_contact.bulk_skip_by_domain')
    // Final call must be COMMIT.
    expect(sqlCalls[3]).toBe('COMMIT')
  })

  it('mutation path: zero matches still commits (no audit insert)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE 0 rows
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['no-match.cz'],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(0)
    // No INSERT INTO operator_audit_log should appear.
    const sqlCalls = client.query.mock.calls.map((c) => c[0])
    expect(sqlCalls.some((s) => /INSERT INTO operator_audit_log/.test(s))).toBe(false)
    expect(sqlCalls[sqlCalls.length - 1]).toBe('COMMIT')
  })

  it('rolls back on DB error inside transaction', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('update failed'))
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .send({
        domains: ['renofarmy.cz'],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    expect(res.status).toBe(500)
    expect(client.query.mock.calls.some((c) => c[0] === 'ROLLBACK')).toBe(true)
    expect(client.release).toHaveBeenCalled()
  })

  it('lowercases + dedupes domain list before SQL', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
      .mockResolvedValueOnce({ rows: [] })
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains?dry_run=true')
      .send({
        domains: ['Renofarmy.CZ', '  renofarmy.cz ', 'IEX.cz'],
        reason: 'operator_detected_holding_overlap',
      })
    expect(res.status).toBe(200)
    expect(res.body.domains).toEqual(['renofarmy.cz', 'iex.cz'])
  })

  it('captures X-Operator header in audit row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1001, contact_id: 5001, domain: 'renofarmy.cz' }] })
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    await request(app)
      .post('/api/campaigns/457/skip-by-domains')
      .set('X-Confirm-Send', 'yes')
      .set('X-Operator', 'tomas')
      .send({
        domains: ['renofarmy.cz'],
        reason: 'operator_detected_holding_overlap',
        confirm: true,
      })
    // 3rd call is the audit INSERT; param[1] is actor.
    expect(client.query.mock.calls[2][1][1]).toBe('tomas')
  })

  it('default status_filter restricts to pending + in_flight when omitted', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457, name: 'X' }] })
      .mockResolvedValueOnce({ rows: [] })
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/campaigns/457/skip-by-domains?dry_run=true')
      .send({
        domains: ['renofarmy.cz'],
        reason: 'operator_detected_holding_overlap',
      })
    expect(res.status).toBe(200)
    expect(res.body.status_filter).toEqual(['pending', 'in_flight'])
  })
})
