// bff-mailbox-delivery-time-stats.contract.test.js — Sprint M3 (#1272).
//
// Mirrors M1/M2 contract patterns: window validation, bucket math,
// long-tail alert flag at 5%, percentile fields present, db error → 500.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountMailboxDeliveryTimeStatsRoutes } from '../../src/server-routes/mailboxDeliveryTimeStats.js'

function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  mountMailboxDeliveryTimeStatsRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

describe('GET /api/mailboxes/delivery-time-stats', () => {
  let pool
  beforeEach(() => { pool = { query: vi.fn() } })

  it('rejects unknown window', async () => {
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=ever')
    expect(res.status).toBe(400)
    expect(res.body.allowed).toEqual(['24h', '7d', '30d'])
  })

  it('default window is 7d', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0, long_tail: 0, p50_seconds: 0, p95_seconds: 0 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats')
    expect(res.body.window).toBe('7d')
  })

  it('returns 7 bucket fields per mailbox', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
          total: 100,
          b_under_30s: 80, b_30_60s: 10, b_1_2min: 5, b_2_5min: 3, b_5_15min: 1, b_15_60min: 1, b_over_60min: 0,
          long_tail_count: 2, long_tail_pct: 2.0,
          p50_seconds: 5, p95_seconds: 45,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 100, long_tail: 2, p50_seconds: 5, p95_seconds: 45 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=7d')
    expect(Object.keys(res.body.mailboxes[0].buckets).sort()).toEqual([
      '15_60min', '1_2min', '2_5min', '30_60s', '5_15min', 'over_60min', 'under_30s',
    ])
    expect(res.body.mailboxes[0].buckets.under_30s).toBe(80)
    expect(res.body.mailboxes[0].p95_seconds).toBe(45)
  })

  it('flags long_tail_pct >= 5% as breached', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
          total: 100, b_under_30s: 90, b_30_60s: 5, b_1_2min: 0, b_2_5min: 0, b_5_15min: 3, b_15_60min: 2, b_over_60min: 0,
          long_tail_count: 5, long_tail_pct: 5.0,
          p50_seconds: 5, p95_seconds: 600 }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 100, long_tail: 5, p50_seconds: 5, p95_seconds: 600 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=7d')
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(true)
    expect(res.body.threshold_pct).toBe(5.0)
  })

  it('does not flag at 4.99%', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
          total: 100, b_under_30s: 90, b_30_60s: 6, b_1_2min: 0, b_2_5min: 0, b_5_15min: 3, b_15_60min: 1, b_over_60min: 0,
          long_tail_count: 4, long_tail_pct: 4.99,
          p50_seconds: 5, p95_seconds: 580 }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 100, long_tail: 4, p50_seconds: 5, p95_seconds: 580 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=7d')
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(false)
  })

  it('handles zero-send fleet (no div-by-zero)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0, long_tail: 0, p50_seconds: 0, p95_seconds: 0 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=7d')
    expect(res.body.fleet.long_tail_pct).toBe(0)
    expect(res.body.fleet.p50_seconds).toBe(0)
  })

  it('returns long_tail_seconds constant', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0, long_tail: 0, p50_seconds: 0, p95_seconds: 0 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=7d')
    expect(res.body.long_tail_seconds).toBe(300)
  })

  it('500 on pool error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'))
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=7d')
    expect(res.status).toBe(500)
  })

  it('all three windows accepted', async () => {
    for (const w of ['24h', '7d', '30d']) {
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: 0, long_tail: 0, p50_seconds: 0, p95_seconds: 0 }] })
      const res = await request(makeApp(pool)).get(`/api/mailboxes/delivery-time-stats?window=${w}`)
      expect(res.status).toBe(200)
      expect(res.body.window).toBe(w)
    }
  })

  it('fleet long_tail_pct rounds to 2 decimals', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 333, long_tail: 7, p50_seconds: 12, p95_seconds: 95 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=7d')
    expect(res.body.fleet.long_tail_pct).toBe(2.1) // 7/333 * 100 = 2.102…
  })

  it('orders mailboxes by long_tail_pct DESC, p95 DESC, total DESC', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { mailbox_id: 2, from_address: 'b@x', status: 'active', lifecycle_phase: 'production',
            total: 100, b_under_30s: 80, b_30_60s: 5, b_1_2min: 5, b_2_5min: 0, b_5_15min: 5, b_15_60min: 5, b_over_60min: 0,
            long_tail_count: 10, long_tail_pct: 10.0, p50_seconds: 10, p95_seconds: 200 },
          { mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
            total: 200, b_under_30s: 195, b_30_60s: 5, b_1_2min: 0, b_2_5min: 0, b_5_15min: 0, b_15_60min: 0, b_over_60min: 0,
            long_tail_count: 0, long_tail_pct: 0.0, p50_seconds: 4, p95_seconds: 30 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: 300, long_tail: 10, p50_seconds: 5, p95_seconds: 100 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/delivery-time-stats?window=7d')
    expect(res.body.mailboxes[0].mailbox_id).toBe(2)
    expect(res.body.mailboxes[1].mailbox_id).toBe(1)
  })
})
