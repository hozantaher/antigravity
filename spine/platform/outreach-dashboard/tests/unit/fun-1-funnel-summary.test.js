// fun-1-funnel-summary.test.js — FUN-1.6 unit tests.
//
// Tests for pure-logic aspects of the funnel summary:
//   - pct() rounding (1 decimal, round-half-up)
//   - days clamping (1..90)
//   - timeline gap-fill (sorted, contiguous days, correct fill values)
//   - template reply_rate_pct edge cases
//   - drop-off chain: null when denom=0, number otherwise
//
// All tests use mocked pool (same pattern as contract layer) so they run
// offline without Postgres.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mountFunnelSummaryRoute } from '../../src/server-routes/funnelSummary.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeApp(pool) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err?.message || String(err) })
  const safeError = (e) => e?.message || String(e)
  mountFunnelSummaryRoute(app, { pool, capture500, safeError })
  return app
}

const ZERO_AGG = {
  sent: 0, opened: 0, replied: 0, classified_engagement: 0,
  lead_created: 0, lead_won: 0, lead_lost: 0,
  classified_negative: 0, classified_bounce: 0, suppressed: 0,
}

function makePool({ agg = ZERO_AGG, tmpls = [], timeline = [] } = {}) {
  const pool = { query: vi.fn() }
  pool.query
    .mockResolvedValueOnce({ rows: [agg] })
    .mockResolvedValueOnce({ rows: tmpls })
    .mockResolvedValueOnce({ rows: timeline })
  return pool
}

// ── Days clamping ──────────────────────────────────────────────────────────

describe('days parameter clamping', () => {
  it('negative days → clamped to 1', async () => {
    const res = await request(makeApp(makePool()))
      .get('/api/funnel/summary?days=-10')
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(1)
  })

  it('days=0 is falsy → falls back to default 14', async () => {
    // parseInt('0')=0 is falsy; the || DEFAULT_FUNNEL_DAYS fires.
    const res = await request(makeApp(makePool()))
      .get('/api/funnel/summary?days=0')
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(14)
  })

  it('91 days → clamped to 90', async () => {
    const res = await request(makeApp(makePool()))
      .get('/api/funnel/summary?days=91')
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(90)
  })

  it('90 days → accepted as-is', async () => {
    const res = await request(makeApp(makePool()))
      .get('/api/funnel/summary?days=90')
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(90)
  })

  it('non-numeric days → default 14', async () => {
    const res = await request(makeApp(makePool()))
      .get('/api/funnel/summary?days=foo')
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(14)
  })
})

// ── pct() rounding via drop-off output ────────────────────────────────────

describe('drop-off percentage rounding', () => {
  it('rounds to 1 decimal place (3/7 = 42.9%)', async () => {
    const agg = { ...ZERO_AGG, sent: 7, opened: 3, replied: 3 }
    const res = await request(makeApp(makePool({ agg })))
      .get('/api/funnel/summary')
    // 3/7 = 0.4285... → round to 42.9
    expect(res.body.funnel.dropoffs.sent_to_opened).toBe(42.9)
  })

  it('rounds 2/3 = 66.7%', async () => {
    const agg = { ...ZERO_AGG, sent: 3, replied: 2, opened: 2 }
    const res = await request(makeApp(makePool({ agg })))
      .get('/api/funnel/summary')
    expect(res.body.funnel.dropoffs.sent_to_opened).toBe(66.7)
  })

  it('100% when num == denom', async () => {
    const agg = { ...ZERO_AGG, sent: 10, opened: 10, replied: 10, classified_engagement: 10 }
    const res = await request(makeApp(makePool({ agg })))
      .get('/api/funnel/summary')
    expect(res.body.funnel.dropoffs.sent_to_opened).toBe(100.0)
  })

  it('null when denom = 0 (no sends)', async () => {
    const res = await request(makeApp(makePool({ agg: ZERO_AGG })))
      .get('/api/funnel/summary')
    const d = res.body.funnel.dropoffs
    expect(d.sent_to_opened).toBeNull()
    expect(d.sent_to_replied).toBeNull()
    expect(d.replied_to_engaged).toBeNull()
    expect(d.engaged_to_lead).toBeNull()
    expect(d.lead_to_won).toBeNull()
  })
})

// ── Timeline gap-fill ──────────────────────────────────────────────────────

describe('timeline gap-fill', () => {
  it('returns exactly days entries for days=7', async () => {
    // DB returns only 2 rows; gap-fill should pad to 7
    const today = new Date()
    const fmt = (d) => d.toISOString().slice(0, 10)
    const rows = [
      { day: fmt(new Date(today.getTime() - 1 * 86400000)), sent: 5, replied: 1, lead_created: 0 },
      { day: fmt(today), sent: 3, replied: 0, lead_created: 1 },
    ]
    const res = await request(makeApp(makePool({ timeline: rows })))
      .get('/api/funnel/summary?days=7')
    expect(res.body.timeline).toHaveLength(7)
  })

  it('gap days have sent=0, replied=0, lead_created=0', async () => {
    // No timeline rows from DB → all 3 days should be zero-filled
    const res = await request(makeApp(makePool({ timeline: [] })))
      .get('/api/funnel/summary?days=3')
    const filled = res.body.timeline
    expect(filled).toHaveLength(3)
    filled.forEach(d => {
      expect(d.sent).toBe(0)
      expect(d.replied).toBe(0)
      expect(d.lead_created).toBe(0)
      expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  it('preserves real DB rows (no double-count)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const rows = [{ day: today, sent: 42, replied: 7, lead_created: 3 }]
    const res = await request(makeApp(makePool({ timeline: rows })))
      .get('/api/funnel/summary?days=1')
    expect(res.body.timeline).toHaveLength(1)
    expect(res.body.timeline[0].sent).toBe(42)
    expect(res.body.timeline[0].replied).toBe(7)
    expect(res.body.timeline[0].lead_created).toBe(3)
  })

  it('timeline is sorted ascending by day', async () => {
    const res = await request(makeApp(makePool()))
      .get('/api/funnel/summary?days=5')
    const days = res.body.timeline.map(r => r.day)
    const sorted = [...days].sort()
    expect(days).toEqual(sorted)
  })
})

// ── Template rate computation ──────────────────────────────────────────────

describe('per-template rate computation', () => {
  it('reply_rate_pct = null when template sent=0', async () => {
    const tmpls = [{ template_name: 'šablona-zero', sent: 0, replied: 0, engaged: 0, leads: 0 }]
    const res = await request(makeApp(makePool({ tmpls })))
      .get('/api/funnel/summary')
    expect(res.body.templates[0].reply_rate_pct).toBeNull()
  })

  it('engage_rate_pct rounds correctly (1/3 = 33.3%)', async () => {
    const tmpls = [{ template_name: 'tmpl', sent: 3, replied: 1, engaged: 1, leads: 0 }]
    const res = await request(makeApp(makePool({ tmpls })))
      .get('/api/funnel/summary')
    expect(res.body.templates[0].engage_rate_pct).toBe(33.3)
  })

  it('template_name passed through correctly', async () => {
    const tmpls = [
      { template_name: 'alpha', sent: 10, replied: 2, engaged: 1, leads: 0 },
      { template_name: 'beta',  sent: 20, replied: 5, engaged: 3, leads: 1 },
    ]
    const res = await request(makeApp(makePool({ tmpls })))
      .get('/api/funnel/summary')
    expect(res.body.templates.map(t => t.template_name)).toEqual(['alpha', 'beta'])
  })
})

// ── Misc ──────────────────────────────────────────────────────────────────

describe('misc response shape', () => {
  it('campaign_id null when not provided', async () => {
    const res = await request(makeApp(makePool())).get('/api/funnel/summary')
    expect(res.body.campaign_id).toBeNull()
  })

  it('template_name null when not provided', async () => {
    const res = await request(makeApp(makePool())).get('/api/funnel/summary')
    expect(res.body.template_name).toBeNull()
  })

  it('contains ran_at ISO timestamp', async () => {
    const res = await request(makeApp(makePool())).get('/api/funnel/summary')
    expect(res.body.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })
})
