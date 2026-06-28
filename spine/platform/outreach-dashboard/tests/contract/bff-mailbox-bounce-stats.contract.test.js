// bff-mailbox-bounce-stats.contract.test.js — Sprint M1 (#1272).
//
// Verifies the GET /api/mailboxes/bounce-stats endpoint:
//   - window param validation
//   - mailbox + fleet aggregation shape
//   - alert_threshold_breached flag
//   - empty-fleet edge case

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountMailboxBounceStatsRoutes } from '../../src/server-routes/mailboxBounceStats.js'

function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  mountMailboxBounceStatsRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

describe('GET /api/mailboxes/bounce-stats', () => {
  let pool
  beforeEach(() => {
    pool = { query: vi.fn() }
  })

  it('rejects unknown window with 400', async () => {
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=foo')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid window')
    expect(res.body.allowed).toEqual(['24h', '7d', '30d'])
  })

  it('default window is 7d when omitted', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })           // mailbox list empty
      .mockResolvedValueOnce({ rows: [{ sent: 0, bounced: 0 }] }) // fleet zero
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats')
    expect(res.status).toBe(200)
    expect(res.body.window).toBe('7d')
  })

  it('accepts 24h / 7d / 30d windows', async () => {
    for (const w of ['24h', '7d', '30d']) {
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ sent: 0, bounced: 0 }] })
      const app = makeApp(pool)
      const res = await request(app).get(`/api/mailboxes/bounce-stats?window=${w}`)
      expect(res.status).toBe(200)
      expect(res.body.window).toBe(w)
    }
  })

  it('aggregates fleet rollup correctly', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sent: 100, bounced: 5 }] })
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=7d')
    expect(res.body.fleet).toEqual({
      sent: 100,
      bounced: 5,
      bounce_rate_pct: 4.76, // 5 / 105 = 0.0476
    })
  })

  it('returns per-mailbox rows with alert flag when ≥2%', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production', sent: 100, bounced: 3, bounce_rate_pct: 2.91 },
          { mailbox_id: 2, from_address: 'b@x', status: 'active', lifecycle_phase: 'production', sent: 100, bounced: 1, bounce_rate_pct: 0.99 },
          { mailbox_id: 3, from_address: 'c@x', status: 'paused', lifecycle_phase: 'production', sent: 0,   bounced: 0, bounce_rate_pct: 0 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 200, bounced: 4 }] })
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=7d')
    expect(res.body.mailboxes).toHaveLength(3)
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(true)
    expect(res.body.mailboxes[1].alert_threshold_breached).toBe(false)
    expect(res.body.mailboxes[2].alert_threshold_breached).toBe(false)
    expect(res.body.threshold_pct).toBe(2.0)
  })

  it('handles empty fleet (no production mailboxes)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sent: 0, bounced: 0 }] })
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=7d')
    expect(res.status).toBe(200)
    expect(res.body.fleet.bounce_rate_pct).toBe(0)
    expect(res.body.mailboxes).toEqual([])
  })

  it('handles zero-sent mailbox (no division by zero)', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'warmup_d0', sent: 0, bounced: 0, bounce_rate_pct: 0 }],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 0, bounced: 0 }] })
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=7d')
    expect(res.body.mailboxes[0].bounce_rate_pct).toBe(0)
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(false)
  })

  it('returns ran_at as ISO 8601 timestamp', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sent: 0, bounced: 0 }] })
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=7d')
    expect(res.body.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('500 on pool error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'))
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=7d')
    expect(res.status).toBe(500)
  })

  it('alert_threshold_breached exact at 2%', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production', sent: 98, bounced: 2, bounce_rate_pct: 2.0 }],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 98, bounced: 2 }] })
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=7d')
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(true)
  })

  it('alert_threshold_breached false at 1.99%', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production', sent: 98, bounced: 2, bounce_rate_pct: 1.99 }],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 98, bounced: 2 }] })
    const app = makeApp(pool)
    const res = await request(app).get('/api/mailboxes/bounce-stats?window=7d')
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(false)
  })
})
