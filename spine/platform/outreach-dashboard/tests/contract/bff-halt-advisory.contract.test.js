// GET /api/campaigns/:id/halt-advisory — halt advisory contract (#1004 [S1.3]).
//
// Read-only advisory: bounce rate from send_events.status vs operator_settings
// thresholds. Coverage:
//   boundary: invalid id → 400
//   ok:       low bounce rate → status 'ok'
//   pause:    rate ≥ pause threshold → 'warn_pause'
//   stop:     rate ≥ stop threshold → 'hard_stop'
//   honesty:  complaint_rate is null (no Seznam FBL)
//   thresholds come from DB, with named defaults as fallback

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mountHaltAdvisoryRoutes } from '../../src/server-routes/haltAdvisory.js'

// Route the mock by SQL: operator_settings → thresholds; send_events → counts.
function buildApp({ thresholds, sendCounts }) {
  const pool = {
    query: vi.fn(async (sql) => {
      if (/operator_settings/.test(sql)) {
        return { rows: thresholds }   // [{key, value}]
      }
      if (/send_events/.test(sql)) {
        return { rows: sendCounts }   // [{status, n}]
      }
      return { rows: [] }
    }),
  }
  const app = express()
  app.use(express.json())
  mountHaltAdvisoryRoutes(app, {
    pool,
    capture500: (res, err) => res.status(500).json({ error: String(err?.message || err) }),
    safeError: (e) => String(e?.message || e),
  })
  return app
}

const DB_THRESHOLDS = [
  { key: 'halt_bounce_pause_pct', value: '5' },
  { key: 'halt_bounce_stop_pct', value: '10' },
  { key: 'halt_complaint_pause_pct', value: '0.3' },
]

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/campaigns/:id/halt-advisory', () => {
  it('rejects an invalid campaign id with 400', async () => {
    const app = buildApp({ thresholds: DB_THRESHOLDS, sendCounts: [] })
    const res = await request(app).get('/api/campaigns/0/halt-advisory')
    expect(res.status).toBe(400)
  })

  it('low bounce rate → ok + complaint_rate null (no FBL)', async () => {
    const app = buildApp({
      thresholds: DB_THRESHOLDS,
      sendCounts: [{ status: 'sent', n: 5691 }, { status: 'bounced', n: 84 }, { status: 'failed', n: 2 }],
    })
    const res = await request(app).get('/api/campaigns/457/halt-advisory')
    expect(res.status).toBe(200)
    expect(res.body.bounce_rate_pct).toBe(1.45)   // 84 / (5691+84)
    expect(res.body.status).toBe('ok')
    expect(res.body.complaint_rate_pct).toBeNull()
    expect(res.body.thresholds.bounce_pause_pct).toBe(5)
  })

  it('rate ≥ pause threshold → warn_pause', async () => {
    const app = buildApp({
      thresholds: DB_THRESHOLDS,
      sendCounts: [{ status: 'sent', n: 93 }, { status: 'bounced', n: 7 }],   // 7/100 = 7%
    })
    const res = await request(app).get('/api/campaigns/1/halt-advisory')
    expect(res.body.bounce_rate_pct).toBe(7)
    expect(res.body.status).toBe('warn_pause')
  })

  it('rate ≥ stop threshold → hard_stop', async () => {
    const app = buildApp({
      thresholds: DB_THRESHOLDS,
      sendCounts: [{ status: 'sent', n: 88 }, { status: 'bounced', n: 12 }],  // 12/100 = 12%
    })
    const res = await request(app).get('/api/campaigns/1/halt-advisory')
    expect(res.body.bounce_rate_pct).toBe(12)
    expect(res.body.status).toBe('hard_stop')
  })

  it('falls back to named default thresholds when DB has no rows', async () => {
    const app = buildApp({ thresholds: [], sendCounts: [{ status: 'sent', n: 100 }] })
    const res = await request(app).get('/api/campaigns/1/halt-advisory')
    expect(res.body.thresholds).toEqual({ bounce_pause_pct: 5, bounce_stop_pct: 10, complaint_pause_pct: 0.3 })
    expect(res.body.status).toBe('ok')
  })

  it('zero sends → 0% rate, no divide-by-zero', async () => {
    const app = buildApp({ thresholds: DB_THRESHOLDS, sendCounts: [] })
    const res = await request(app).get('/api/campaigns/1/halt-advisory')
    expect(res.body.bounce_rate_pct).toBe(0)
    expect(res.body.status).toBe('ok')
  })
})
