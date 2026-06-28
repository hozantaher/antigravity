// bff-template-metrics.contract.test.js — Sprint L2 (#1287).
//
// Locks the request/response contract for GET /api/templates/metrics.
// Handler: src/server-routes/templateMetrics.js
//
// Test plan (12 cases — risk-proportional: read-only diagnostic + named
// threshold + rate derivations all need validation paths):
//
//  1. Rejects unknown window with 400 + allowed list
//  2. Default window is 7d
//  3. Empty result (no sends) returns empty templates array
//  4. Happy path: rates derived correctly (open/reply/spam)
//  5. spam_alert_threshold_breached fires at exactly 0.1%
//  6. Does NOT breach alert at 0.09%
//  7. Zero sent_count → all rates 0, no division by zero
//  8. reply_count excludes auto_reply classification
//  9. spam_count includes negative + unsubscribe only
// 10. used_in_campaigns populated from sequence_config scan
// 11. Sort order: reply_rate DESC then sent DESC
// 12. Returns 500 on pool error
// 13. Response includes ran_at ISO timestamp + spam_alert_threshold_pct

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountTemplateMetricsRoutes } from '../../src/server-routes/templateMetrics.js'

function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  mountTemplateMetricsRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

// Convenience factory for a metric row
function metricRow(name, sent, opens, replies, spams) {
  return { template_name: name, sent_count: sent, open_count: opens, reply_count: replies, spam_count: spams }
}

describe('GET /api/templates/metrics', () => {
  let pool
  beforeEach(() => { pool = { query: vi.fn() } })

  // ── Test 1: invalid window ────────────────────────────────────────────────
  it('rejects unknown window with 400', async () => {
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=week')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid window')
    expect(res.body.allowed).toEqual(['7d', '30d'])
  })

  // ── Test 2: default window ────────────────────────────────────────────────
  it('default window is 7d', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // metrics query (0 rows → early return)
    const res = await request(makeApp(pool)).get('/api/templates/metrics')
    expect(res.status).toBe(200)
    expect(res.body.window).toBe('7d')
  })

  // ── Test 3: empty result ──────────────────────────────────────────────────
  it('returns empty templates array when no sends in window', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    expect(res.status).toBe(200)
    expect(res.body.templates).toEqual([])
  })

  // ── Test 4: rate derivation ───────────────────────────────────────────────
  it('derives open/reply/spam rates correctly', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [metricRow('promo-v1', 1000, 200, 50, 1)] })
      .mockResolvedValueOnce({ rows: [] }) // no campaigns
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    expect(res.status).toBe(200)
    const t = res.body.templates[0]
    expect(t.template_name).toBe('promo-v1')
    expect(t.sent_count).toBe(1000)
    expect(t.open_rate_pct).toBe(20)
    expect(t.reply_rate_pct).toBe(5)
    expect(t.spam_rate_pct).toBe(0.1)
  })

  // ── Test 5: alert breaches at exactly 0.1% ────────────────────────────────
  it('flags alert_threshold_breached at exactly 0.1% spam rate', async () => {
    // 1 spam per 1000 sends = exactly 0.1%
    pool.query
      .mockResolvedValueOnce({ rows: [metricRow('cold-v2', 1000, 0, 0, 1)] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    const t = res.body.templates[0]
    expect(t.spam_rate_pct).toBe(0.1)
    expect(t.alert_threshold_breached).toBe(true)
    expect(res.body.spam_alert_threshold_pct).toBe(0.1)
  })

  // ── Test 6: no breach at 0.09% ───────────────────────────────────────────
  it('does NOT breach alert at 0.09% spam rate', async () => {
    // 9 spams per 10000 sends = 0.09%
    pool.query
      .mockResolvedValueOnce({ rows: [metricRow('cold-v2', 10000, 0, 0, 9)] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    const t = res.body.templates[0]
    expect(t.spam_rate_pct).toBe(0.09)
    expect(t.alert_threshold_breached).toBe(false)
  })

  // ── Test 7: zero sends → no division by zero ─────────────────────────────
  it('zero sent_count yields all zero rates', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [metricRow('unused-tpl', 0, 0, 0, 0)] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    const t = res.body.templates[0]
    expect(t.open_rate_pct).toBe(0)
    expect(t.reply_rate_pct).toBe(0)
    expect(t.spam_rate_pct).toBe(0)
    expect(t.alert_threshold_breached).toBe(false)
  })

  // ── Test 8: auto_reply excluded from reply_count ──────────────────────────
  it('auto_reply exclusion is reflected in reply_count (DB-side filter)', async () => {
    // The SQL filter (classification != 'auto_reply') is done DB-side.
    // Contract test: reply_count from DB is used as-is — 3 real replies.
    pool.query
      .mockResolvedValueOnce({ rows: [metricRow('intro-v1', 100, 10, 3, 0)] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    expect(res.body.templates[0].reply_count).toBe(3)
  })

  // ── Test 9: spam_count covers negative+unsubscribe ────────────────────────
  it('spam_count reflects negative + unsubscribe rows (DB-side classification filter)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [metricRow('sales-v3', 500, 30, 10, 5)] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    expect(res.body.templates[0].spam_count).toBe(5)
  })

  // ── Test 10: used_in_campaigns from sequence_config ───────────────────────
  it('populates used_in_campaigns for matching campaigns', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [metricRow('intro-v1', 100, 0, 0, 0)] })
      .mockResolvedValueOnce({
        rows: [
          { campaign_id: 10, config_text: '{"steps":[{"template":"intro-v1"}]}' },
          { campaign_id: 11, config_text: '{"steps":[{"template":"other-tpl"}]}' },
          { campaign_id: 12, config_text: '{"steps":[{"template":"intro-v1"},{"template":"follow-v1"}]}' },
        ],
      })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    const used = res.body.templates[0].used_in_campaigns
    expect(used).toContain(10)
    expect(used).toContain(12)
    expect(used).not.toContain(11)
  })

  // ── Test 11: sort order reply_rate DESC then sent DESC ────────────────────
  it('sorts by reply_rate_pct DESC then sent_count DESC', async () => {
    // tpl-b: 5% reply rate, 200 sent
    // tpl-a: 2% reply rate, 1000 sent
    // tpl-c: 5% reply rate, 400 sent (higher sent → second after tpl-c)
    pool.query
      .mockResolvedValueOnce({
        rows: [
          metricRow('tpl-a', 1000, 0, 20, 0),
          metricRow('tpl-b', 200,  0, 10, 0),
          metricRow('tpl-c', 400,  0, 20, 0),
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    const names = res.body.templates.map(t => t.template_name)
    // tpl-c (5%, 400 sent) before tpl-b (5%, 200 sent) before tpl-a (2%)
    expect(names[0]).toBe('tpl-c')
    expect(names[1]).toBe('tpl-b')
    expect(names[2]).toBe('tpl-a')
  })

  // ── Test 12: 500 on pool error ────────────────────────────────────────────
  it('returns 500 on pool error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db connection lost'))
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('db connection lost')
  })

  // ── Test 13: response envelope fields ─────────────────────────────────────
  it('response includes ran_at ISO timestamp and spam_alert_threshold_pct', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(makeApp(pool)).get('/api/templates/metrics?window=7d')
    expect(res.body.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(res.body.spam_alert_threshold_pct).toBe(0.1)
  })
})
