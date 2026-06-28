// bff-funnel-summary.contract.test.js — FUN-1.6 contract tests.
//
// Verifies GET /api/funnel/summary:
//   - default days + response shape
//   - days clamping (1..90)
//   - campaign_id validation
//   - drop-off % computation
//   - timeseries gap-fill
//   - per-template reply_rate_pct
//   - 500 on pool error

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountFunnelSummaryRoute } from '../../src/server-routes/funnelSummary.js'

// A realistic funnel aggregation row.
const AGG_ROW = {
  sent: 100, opened: 40, replied: 20, classified_engagement: 10,
  lead_created: 5, lead_won: 2, lead_lost: 1,
  classified_negative: 8, classified_bounce: 3, suppressed: 7,
}

// A minimal template row.
const TMPL_ROW = {
  template_name: 'šablona-A',
  sent: 50, replied: 5, engaged: 2, leads: 1,
}

// A day row (already formatted by DB TO_CHAR).
const DAY_ROW = { day: '2026-05-25', sent: 10, replied: 2, lead_created: 1 }

function makePool({ aggRow = AGG_ROW, tmplRows = [TMPL_ROW], timelineRows = [DAY_ROW] } = {}) {
  const pool = { query: vi.fn() }
  pool.query
    .mockResolvedValueOnce({ rows: [aggRow] })        // main funnel agg
    .mockResolvedValueOnce({ rows: tmplRows })          // per-template
    .mockResolvedValueOnce({ rows: timelineRows })      // timeseries
  return pool
}

function makeApp(pool) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e?.message || String(e)
  mountFunnelSummaryRoute(app, { pool, capture500, safeError })
  return app
}

describe('GET /api/funnel/summary', () => {

  it('returns 200 with default days=14 when omitted', async () => {
    const app = makeApp(makePool())
    const res = await request(app).get('/api/funnel/summary')
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(14)
    expect(res.body.default_funnel_days).toBe(14)
  })

  it('returns funnel shape with all expected keys', async () => {
    const app = makeApp(makePool())
    const res = await request(app).get('/api/funnel/summary')
    expect(res.status).toBe(200)
    const f = res.body.funnel
    expect(f).toHaveProperty('sent')
    expect(f).toHaveProperty('opened')
    expect(f).toHaveProperty('replied')
    expect(f).toHaveProperty('classified_engagement')
    expect(f).toHaveProperty('lead_created')
    expect(f).toHaveProperty('lead_won')
    expect(f).toHaveProperty('classified_negative')
    expect(f).toHaveProperty('classified_bounce')
    expect(f).toHaveProperty('suppressed')
    expect(f).toHaveProperty('lead_lost')
    expect(f.dropoffs).toHaveProperty('sent_to_opened')
    expect(f.dropoffs).toHaveProperty('sent_to_replied')
    expect(f.dropoffs).toHaveProperty('replied_to_engaged')
    expect(f.dropoffs).toHaveProperty('engaged_to_lead')
    expect(f.dropoffs).toHaveProperty('lead_to_won')
  })

  it('treats days=0 as falsy → falls back to default 14', async () => {
    // parseInt('0') = 0, which is falsy, so || DEFAULT_FUNNEL_DAYS triggers.
    const app = makeApp(makePool())
    const res = await request(app).get('/api/funnel/summary?days=0')
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(14)
  })

  it('clamps days above 90 to 90', async () => {
    const app = makeApp(makePool())
    const res = await request(app).get('/api/funnel/summary?days=999')
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(90)
  })

  it('rejects non-positive campaign_id with 400', async () => {
    const pool = { query: vi.fn() }  // should not be called
    const app = makeApp(pool)
    const res = await request(app).get('/api/funnel/summary?campaign_id=0')
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  it('rejects string campaign_id with 400', async () => {
    const pool = { query: vi.fn() }
    const app = makeApp(pool)
    const res = await request(app).get('/api/funnel/summary?campaign_id=abc')
    expect(res.status).toBe(400)
  })

  it('computes drop-off percentages correctly', async () => {
    const app = makeApp(makePool())
    const res = await request(app).get('/api/funnel/summary')
    const d = res.body.funnel.dropoffs
    // sent=100 opened=40 → 40.0%; replied=20 → 20.0%; engaged=10 / replied=20 → 50.0%
    expect(d.sent_to_opened).toBe(40.0)
    expect(d.sent_to_replied).toBe(20.0)
    expect(d.replied_to_engaged).toBe(50.0)
    expect(d.engaged_to_lead).toBe(50.0)  // 5/10
    expect(d.lead_to_won).toBe(40.0)      // 2/5
  })

  it('returns null drop-off when denominator is zero', async () => {
    const emptyAgg = { ...AGG_ROW, sent: 0, opened: 0, replied: 0, classified_engagement: 0, lead_created: 0, lead_won: 0 }
    const app = makeApp(makePool({ aggRow: emptyAgg }))
    const res = await request(app).get('/api/funnel/summary')
    const d = res.body.funnel.dropoffs
    expect(d.sent_to_opened).toBeNull()
    expect(d.sent_to_replied).toBeNull()
  })

  it('includes per-template rows with reply_rate_pct', async () => {
    const app = makeApp(makePool())
    const res = await request(app).get('/api/funnel/summary')
    expect(Array.isArray(res.body.templates)).toBe(true)
    const tmpl = res.body.templates[0]
    expect(tmpl.template_name).toBe('šablona-A')
    expect(tmpl.reply_rate_pct).toBe(10.0)  // 5/50
    expect(tmpl).toHaveProperty('engage_rate_pct')
  })

  it('returns timeline array (gap-filled to days entries)', async () => {
    const app = makeApp(makePool())
    const res = await request(app).get('/api/funnel/summary?days=14')
    expect(Array.isArray(res.body.timeline)).toBe(true)
    expect(res.body.timeline).toHaveLength(14)
    // Each entry has day/sent/replied/lead_created
    const first = res.body.timeline[0]
    expect(first).toHaveProperty('day')
    expect(first).toHaveProperty('sent')
    expect(first).toHaveProperty('replied')
    expect(first).toHaveProperty('lead_created')
  })

  it('returns ran_at as ISO 8601 timestamp', async () => {
    const app = makeApp(makePool())
    const res = await request(app).get('/api/funnel/summary')
    expect(res.body.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('500 on pool error', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('db error')) }
    const app = makeApp(pool)
    const res = await request(app).get('/api/funnel/summary')
    expect(res.status).toBe(500)
  })

})
