// bff-mailbox-reputation-score.contract.test.js — Sprint M5 (#1272).
//
// Coverage:
//   - window validation (7d/30d only — no 24h since composite over short
//     windows would be too noisy)
//   - weight + threshold constants exposed in response
//   - per-mailbox: sub-scores computed from bounce/spam/delivery/auth
//     signals via linear-decay against M1-M4 thresholds
//   - alert flag at < 70 composite score
//   - fleet rollup: avg score + count below threshold
//   - sort order: worst-first (ascending score)
//   - empty fleet → avg=100, count=0

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountMailboxReputationScoreRoutes } from '../../src/server-routes/mailboxReputationScore.js'

function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  mountMailboxReputationScoreRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

describe('GET /api/mailboxes/reputation-score', () => {
  let pool
  beforeEach(() => { pool = { query: vi.fn() } })

  it('rejects unknown window', async () => {
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=24h')
    expect(res.status).toBe(400)
    expect(res.body.allowed).toEqual(['7d', '30d'])
  })

  it('default window is 7d', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score')
    expect(res.body.window).toBe('7d')
  })

  it('accepts both 7d and 30d', async () => {
    for (const w of ['7d', '30d']) {
      pool.query.mockResolvedValueOnce({ rows: [] })
      const res = await request(makeApp(pool)).get(`/api/mailboxes/reputation-score?window=${w}`)
      expect(res.status).toBe(200)
      expect(res.body.window).toBe(w)
    }
  })

  it('returns weights + thresholds in response for UI consumption', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    expect(res.body.weights).toEqual({ bounce: 0.40, spam: 0.30, delivery: 0.15, auth: 0.15 })
    expect(res.body.thresholds).toEqual({
      bounce_pct: 2.0,
      spam_pct: 0.1,
      delivery_long_tail_pct: 5.0,
      auth_locks: 3,
    })
    expect(res.body.threshold_score).toBe(70)
  })

  it('perfect mailbox (zero of everything) scores 100', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
        sent: 1000, bounced: 0, long_tail: 0, complaints: 0, auth_locks: 0,
      }],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    expect(res.body.mailboxes[0].reputation_score).toBe(100)
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(false)
    expect(res.body.mailboxes[0].sub_scores).toEqual({ bounce: 100, spam: 100, delivery: 100, auth: 100 })
  })

  it('mailbox at exactly each threshold scores 50 on that signal', async () => {
    // 2% bounce + 0.1% spam + 5% delivery long-tail + 3 auth locks
    // = all four sub_scores at 50
    pool.query.mockResolvedValueOnce({
      rows: [{
        mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
        sent: 1000, bounced: 20, long_tail: 50, complaints: 1, auth_locks: 3,
      }],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    const sub = res.body.mailboxes[0].sub_scores
    // bounce: 20 / (1000+20) = 1.96% → close to threshold, sub ~51
    // spam: 1/1000 = 0.1% exact → sub = 50
    // delivery: 50/1000 = 5% exact → sub = 50
    // auth: 3/3 → sub = 50
    expect(sub.spam).toBe(50)
    expect(sub.delivery).toBe(50)
    expect(sub.auth).toBe(50)
  })

  it('mailbox at 2× threshold scores 0 on that signal', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
        sent: 1000, bounced: 0, long_tail: 100, complaints: 0, auth_locks: 0,
      }],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    // delivery 10% = 2× threshold 5% → sub = 0
    expect(res.body.mailboxes[0].sub_scores.delivery).toBe(0)
  })

  it('alert flag fires below 70 score', async () => {
    // Force composite below 70: terrible bounce (10%) + perfect rest
    pool.query.mockResolvedValueOnce({
      rows: [{
        mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
        sent: 900, bounced: 100, long_tail: 0, complaints: 0, auth_locks: 0,
      }],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    // bounce 100/1000 = 10% → sub 0; spam/delivery/auth all 100
    // composite = 0*0.4 + 100*0.3 + 100*0.15 + 100*0.15 = 60
    expect(res.body.mailboxes[0].reputation_score).toBe(60)
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(true)
  })

  it('does not flag at exactly 70', async () => {
    // bounce_pct that puts composite exactly at 70:
    // Need composite = 70. Sub-scores spam=delivery=auth=100, weights .3+.15+.15=.6 → 60
    // So bounce sub * 0.4 must be 10 → bounce sub = 25
    // sub_score = max(0, 100 - (bounce_pct/2.0)*50). 25 = 100 - (x/2)*50 → x = 3.0
    // bounce_pct 3% with sent=970, bounced=30: 30/1000 = 3%
    pool.query.mockResolvedValueOnce({
      rows: [{
        mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
        sent: 970, bounced: 30, long_tail: 0, complaints: 0, auth_locks: 0,
      }],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    expect(res.body.mailboxes[0].reputation_score).toBe(70)
    expect(res.body.mailboxes[0].alert_threshold_breached).toBe(false)
  })

  it('handles zero-sent mailbox (no div-by-zero, all sub-scores 100)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        mailbox_id: 1, from_address: 'a@x', status: 'paused', lifecycle_phase: 'warmup_d0',
        sent: 0, bounced: 0, long_tail: 0, complaints: 0, auth_locks: 0,
      }],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    expect(res.body.mailboxes[0].reputation_score).toBe(100)
    expect(res.body.mailboxes[0].inputs.bounce_rate_pct).toBe(0)
  })

  it('sorts mailboxes worst-first (ascending score)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { mailbox_id: 1, from_address: 'good@x', status: 'active', lifecycle_phase: 'production',
          sent: 1000, bounced: 0, long_tail: 0, complaints: 0, auth_locks: 0 },
        { mailbox_id: 2, from_address: 'bad@x', status: 'active', lifecycle_phase: 'production',
          sent: 900, bounced: 100, long_tail: 50, complaints: 5, auth_locks: 4 },
        { mailbox_id: 3, from_address: 'mid@x', status: 'active', lifecycle_phase: 'production',
          sent: 980, bounced: 20, long_tail: 10, complaints: 1, auth_locks: 0 },
      ],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    const scores = res.body.mailboxes.map(m => m.reputation_score)
    expect(scores).toEqual([...scores].sort((a, b) => a - b))
    expect(res.body.mailboxes[0].from_address).toBe('bad@x')
  })

  it('empty fleet → avg 100, count 0', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    expect(res.body.fleet).toEqual({ mailbox_count: 0, avg_score: 100, below_threshold: 0 })
    expect(res.body.mailboxes).toEqual([])
  })

  it('fleet rollup counts mailboxes below threshold', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { mailbox_id: 1, from_address: 'a@x', status: 'active', lifecycle_phase: 'production',
          sent: 1000, bounced: 0, long_tail: 0, complaints: 0, auth_locks: 0 },
        { mailbox_id: 2, from_address: 'b@x', status: 'active', lifecycle_phase: 'production',
          sent: 900, bounced: 100, long_tail: 50, complaints: 5, auth_locks: 4 },
      ],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    expect(res.body.fleet.mailbox_count).toBe(2)
    expect(res.body.fleet.below_threshold).toBe(1)
  })

  it('500 on db error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'))
    const res = await request(makeApp(pool)).get('/api/mailboxes/reputation-score?window=7d')
    expect(res.status).toBe(500)
  })
})
