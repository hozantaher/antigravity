// dailySummary.test.js — ADD-3 (2026-05-14)
//
// Unit coverage for the BFF aggregate endpoint
// GET /api/operator-metrics/daily-summary
// (in src/server-routes/operatorMetrics.js).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import {
  mountOperatorMetricsRoutes,
  classifyTrend,
  percentDelta,
} from '../../../src/server-routes/operatorMetrics.js'

let server
let baseUrl

function startServer(pool) {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    const deps = {
      pool,
      capture500: (res, err, safeError) => res.status(500).json({ error: safeError(err) }),
      safeError: (e) => (e && e.message) || 'error',
    }
    mountOperatorMetricsRoutes(app, deps)
    server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
}

function stopServer() {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
}

async function get(query = {}) {
  const qs = new URLSearchParams(query).toString()
  const r = await fetch(`${baseUrl}/api/operator-metrics/daily-summary${qs ? '?' + qs : ''}`)
  return { status: r.status, body: await r.json() }
}

describe('classifyTrend', () => {
  it('classifies positive delta above band as up', () => {
    expect(classifyTrend(11)).toBe('up')
    expect(classifyTrend(50)).toBe('up')
  })
  it('classifies negative delta below band as down', () => {
    expect(classifyTrend(-11)).toBe('down')
    expect(classifyTrend(-99)).toBe('down')
  })
  it('classifies values inside ±10% band as flat', () => {
    expect(classifyTrend(0)).toBe('flat')
    expect(classifyTrend(9)).toBe('flat')
    expect(classifyTrend(-9)).toBe('flat')
  })
  it('handles non-finite input safely', () => {
    expect(classifyTrend(NaN)).toBe('flat')
    expect(classifyTrend(undefined)).toBe('flat')
  })
})

describe('percentDelta', () => {
  it('computes ((c - b) / b) * 100 rounded', () => {
    expect(percentDelta(110, 100)).toBe(10)
    expect(percentDelta(50, 100)).toBe(-50)
  })
  it('returns 0 when both values are zero', () => {
    expect(percentDelta(0, 0)).toBe(0)
  })
  it('returns 100 when baseline is zero but current is positive', () => {
    expect(percentDelta(5, 0)).toBe(100)
  })
})

describe('GET /api/operator-metrics/daily-summary', () => {
  let pool

  beforeEach(async () => {
    pool = {
      query: vi.fn(),
    }
    await startServer(pool)
  })

  afterEach(async () => {
    await stopServer()
    vi.restoreAllMocks()
  })

  function stubAggregates({
    sent = 247,
    bounces = 9,
    replies = 0,
    unmatched = 3,
    baselineSent = 250,
    baselineReplies = 1,
    isoDate = '2026-05-13',
  } = {}) {
    // 6 calls in order:
    //   1. sends + bounces (yesterday)
    //   2. replies (yesterday)
    //   3. unmatched (yesterday)
    //   4. baseline sends (day before)
    //   5. baseline replies (day before)
    //   6. iso date resolution
    pool.query
      .mockResolvedValueOnce({ rows: [{ sent_count: sent, bounce_count: bounces }] })
      .mockResolvedValueOnce({ rows: [{ reply_count: replies }] })
      .mockResolvedValueOnce({ rows: [{ unmatched_count: unmatched }] })
      .mockResolvedValueOnce({ rows: [{ sent_count: baselineSent }] })
      .mockResolvedValueOnce({ rows: [{ reply_count: baselineReplies }] })
      .mockResolvedValueOnce({ rows: [{ d: isoDate }] })
  }

  it('rejects an invalid date param with 400', async () => {
    const r = await get({ date: '2026/05/13' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_date')
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('returns aggregate payload for date=yesterday', async () => {
    stubAggregates({ sent: 247, bounces: 9, replies: 0, unmatched: 7 })
    const r = await get({ date: 'yesterday' })
    expect(r.status).toBe(200)
    expect(r.body.date).toBe('2026-05-13')
    expect(r.body.sent).toBe(247)
    expect(r.body.bounces).toBe(9)
    expect(r.body.bounce_rate_pct).toBe(3.6)
    expect(r.body.replies).toBe(0)
    expect(r.body.reply_rate_pct).toBe(0)
    expect(r.body.new_unmatched).toBe(7)
    expect(r.body.vs_baseline.baseline_sent).toBe(250)
  })

  it('classifies trend "flat" when sent within ±10% of baseline', async () => {
    stubAggregates({ sent: 247, baselineSent: 250 })
    const r = await get({ date: 'yesterday' })
    expect(r.body.vs_baseline.trend).toBe('flat')
  })

  it('classifies trend "up" on >+10% sent_delta_pct', async () => {
    stubAggregates({ sent: 300, baselineSent: 200 })
    const r = await get({ date: 'yesterday' })
    expect(r.body.vs_baseline.trend).toBe('up')
    expect(r.body.vs_baseline.sent_delta_pct).toBe(50)
  })

  it('classifies trend "down" on >-10% sent_delta_pct', async () => {
    stubAggregates({ sent: 100, baselineSent: 200 })
    const r = await get({ date: 'yesterday' })
    expect(r.body.vs_baseline.trend).toBe('down')
    expect(r.body.vs_baseline.sent_delta_pct).toBe(-50)
  })

  it('handles empty day (zero sends, zero replies) without dividing by zero', async () => {
    stubAggregates({ sent: 0, bounces: 0, replies: 0, unmatched: 0, baselineSent: 0, baselineReplies: 0 })
    const r = await get({ date: 'yesterday' })
    expect(r.status).toBe(200)
    expect(r.body.sent).toBe(0)
    expect(r.body.bounce_rate_pct).toBe(0)
    expect(r.body.reply_rate_pct).toBe(0)
    expect(r.body.vs_baseline.sent_delta_pct).toBe(0)
  })

  it('accepts explicit YYYY-MM-DD date and uses it as parameter', async () => {
    stubAggregates({ isoDate: '2026-05-10' })
    await get({ date: '2026-05-10' })
    // First query call params should include the iso date
    const firstCallParams = pool.query.mock.calls[0][1]
    expect(firstCallParams).toEqual(['2026-05-10'])
  })

  it('returns 500 on unexpected DB error in baseline query', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ sent_count: 1, bounce_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ reply_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ unmatched_count: 0 }] })
      // baseline sends rejects — bypasses the per-query .catch since we
      // only catch first 3
      .mockResolvedValueOnce({ rows: [{ sent_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ reply_count: 0 }] })
      // iso date — make it throw with no catch shield
      .mockRejectedValueOnce(new Error('connection refused'))
    const r = await get({ date: 'yesterday' })
    expect(r.status).toBe(500)
  })
})
