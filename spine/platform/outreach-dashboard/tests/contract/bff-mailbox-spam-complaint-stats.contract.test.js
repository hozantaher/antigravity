// bff-mailbox-spam-complaint-stats.contract.test.js — Sprint M2 (#1272).
//
// Mirrors the M1 bounce-stats contract but for the spam-complaint
// surface. Different schema (reply_inbox aggregation, classification
// allowlist param) and lower alert threshold (0.1% vs 2.0%).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountMailboxSpamComplaintStatsRoutes } from '../../src/server-routes/mailboxSpamComplaintStats.js'

function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  mountMailboxSpamComplaintStatsRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

describe('GET /api/mailboxes/spam-complaint-stats', () => {
  let pool
  beforeEach(() => { pool = { query: vi.fn() } })

  it('rejects unknown window with 400', async () => {
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=year')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid window')
    expect(res.body.allowed).toEqual(['24h', '7d', '30d'])
  })

  it('default window is 7d', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sent: 0, complaints: 0 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats')
    expect(res.body.window).toBe('7d')
  })

  it('passes complaint_classifications array to mailbox query', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sent: 0, complaints: 0 }] })
    await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(pool.query.mock.calls[0][1]).toEqual([['negative', 'unsubscribe']])
  })

  it('aggregates fleet rate correctly', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sent: 10000, complaints: 12 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(res.body.fleet).toEqual({
      sent: 10000,
      complaints: 12,
      complaint_rate_pct: 0.12,
    })
  })

  it('flags mailbox at 0.1% as breached', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'active',
                 lifecycle_phase: 'production', sent: 1000, complaints: 1,
                 complaint_rate_pct: 0.1 }],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 1000, complaints: 1 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(true)
    expect(res.body.threshold_pct).toBe(0.1)
  })

  it('does NOT flag mailbox at 0.05%', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'active',
                 lifecycle_phase: 'production', sent: 2000, complaints: 1,
                 complaint_rate_pct: 0.05 }],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 2000, complaints: 1 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(false)
  })

  it('zero sent → rate 0, no div-by-zero', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'paused',
                 lifecycle_phase: 'warmup_d0', sent: 0, complaints: 0,
                 complaint_rate_pct: 0 }],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 0, complaints: 0 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(res.body.mailboxes[0].complaint_rate_pct).toBe(0)
    expect(res.body.fleet.complaint_rate_pct).toBe(0)
  })

  it('returns complaint_classifications and ran_at fields', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sent: 0, complaints: 0 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(res.body.complaint_classifications).toEqual(['negative', 'unsubscribe'])
    expect(res.body.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns 500 on pool error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'))
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(res.status).toBe(500)
  })

  it('uses 3-decimal precision for spam rate', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ mailbox_id: 1, from_address: 'a@x', status: 'active',
                 lifecycle_phase: 'production', sent: 3000, complaints: 1,
                 complaint_rate_pct: 0.033 }],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 3000, complaints: 1 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(res.body.mailboxes[0].complaint_rate_pct).toBe(0.033)
    expect(res.body.fleet.complaint_rate_pct).toBe(0.033)
  })

  it('orders mailboxes by complaint_rate DESC, sent DESC', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { mailbox_id: 2, from_address: 'b@x', status: 'active', lifecycle_phase: 'production', sent: 500, complaints: 2, complaint_rate_pct: 0.4 },
          { mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production', sent: 1000, complaints: 1, complaint_rate_pct: 0.1 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ sent: 1500, complaints: 3 }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/spam-complaint-stats?window=7d')
    expect(res.body.mailboxes[0].mailbox_id).toBe(2)
    expect(res.body.mailboxes[1].mailbox_id).toBe(1)
  })
})
