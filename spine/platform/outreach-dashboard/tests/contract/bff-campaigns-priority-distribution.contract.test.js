// bff-campaigns-priority-distribution.contract.test.js
//
// Contract for GET /api/campaigns/:id/priority-distribution.
//
// Drives the TierDistributionPanel on CampaignDetail. Pure SELECT COUNT —
// no mutation — but still owns operator-visible semantics (tier label
// strings + the 404 / 400 branches the panel relies on for silent
// fallback).

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

describe('GET /api/campaigns/:id/priority-distribution', () => {
  let pool

  beforeEach(() => {
    pool = { query: vi.fn(), connect: vi.fn() }
  })

  it('rejects non-numeric id with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/abc/priority-distribution')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid campaign id')
  })

  it('returns 404 when campaign does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }) // campaign SELECT → empty
    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/9999/priority-distribution')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('campaign not found')
  })

  it('returns tier counts + mean priority for an existing campaign', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457 }] })   // campaign exists
      .mockResolvedValueOnce({ rows: [
        { tier: 'A_top_0.90+',       n: 6338 },
        { tier: 'B_high_0.78-0.89',  n: 12279 },
        { tier: 'C_mid_0.65-0.77',   n: 5532 },
        { tier: 'D_low_0.50-0.64',   n: 1929 },
        { tier: 'E_dead_below_0.50', n: 5121 },
      ] })                                                // tier breakdown
      .mockResolvedValueOnce({ rows: [{ mean: 0.7234 }] }) // mean priority

    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/457/priority-distribution')

    expect(res.status).toBe(200)
    expect(res.body.campaign_id).toBe(457)
    expect(res.body.total_pending).toBe(31199)
    expect(res.body.tiers).toEqual({
      'A_top_0.90+':       6338,
      'B_high_0.78-0.89':  12279,
      'C_mid_0.65-0.77':   5532,
      'D_low_0.50-0.64':   1929,
      'E_dead_below_0.50': 5121,
    })
    expect(res.body.mean_priority).toBeCloseTo(0.7234, 4)
    expect(res.body.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns zero-counts shape when no pending contacts exist', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457 }] })
      .mockResolvedValueOnce({ rows: [] })                  // no tier groups
      .mockResolvedValueOnce({ rows: [{ mean: null }] })

    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/457/priority-distribution')

    expect(res.status).toBe(200)
    expect(res.body.total_pending).toBe(0)
    expect(res.body.tiers).toEqual({
      'A_top_0.90+':       0,
      'B_high_0.78-0.89':  0,
      'C_mid_0.65-0.77':   0,
      'D_low_0.50-0.64':   0,
      'E_dead_below_0.50': 0,
    })
    expect(res.body.mean_priority).toBeNull()
  })

  it('SELECT uses status=pending + campaign_id filter', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ mean: null }] })

    const app = await makeApp(pool)
    await request(app).get('/api/campaigns/457/priority-distribution')

    // The 2nd pool.query is the tier breakdown SQL.
    const tierSql = pool.query.mock.calls[1][0].replace(/\s+/g, ' ').trim()
    expect(tierSql).toMatch(/FROM campaign_contacts/)
    expect(tierSql).toMatch(/WHERE campaign_id = \$1 AND status = 'pending'/)
    expect(tierSql).toMatch(/CASE WHEN priority >= 0\.90 THEN 'A_top_0\.90\+'/)
    expect(pool.query.mock.calls[1][1]).toEqual([457])
  })
})
