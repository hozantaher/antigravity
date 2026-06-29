// clusterRateLive.test.js — AH6 (2026-05-15)
//
// Unit coverage for the BFF live cluster throughput endpoint
//   GET /api/operator-metrics/cluster-rate-live
// (in src/server-routes/operatorMetrics.js).
//
// The widget consuming this endpoint refreshes every 30s, so the
// trailing-hour rate has to be cheap to compute and tolerant of an
// empty / fresh-env schema.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import {
  mountOperatorMetricsRoutes,
  resolveSpacingSeconds,
  computeCeilingPerHour,
  minutesSince,
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

async function get() {
  const r = await fetch(`${baseUrl}/api/operator-metrics/cluster-rate-live`)
  return { status: r.status, body: await r.json() }
}

// ─── Pure helper tests ───────────────────────────────────────────────────────

describe('computeCeilingPerHour', () => {
  it('multiplies active mailboxes by (3600 / spacing) and floors', () => {
    // 4 mailboxes × (3600 / 180) = 4 × 20 = 80
    expect(computeCeilingPerHour(4, 180)).toBe(80)
    // 1 × 60 = 60
    expect(computeCeilingPerHour(1, 60)).toBe(60)
    // 7 × (3600/180) = 140
    expect(computeCeilingPerHour(7, 180)).toBe(140)
  })

  it('returns 0 when active count is 0', () => {
    expect(computeCeilingPerHour(0, 180)).toBe(0)
  })

  it('clamps negative or non-numeric inputs to safe defaults', () => {
    expect(computeCeilingPerHour(-3, 180)).toBe(0)
    expect(computeCeilingPerHour('foo', 180)).toBe(0)
  })

  it('falls back to the 180s spacing when given non-positive spacing', () => {
    // 4 × (3600 / 180) = 80 — even when caller passed 0 / NaN.
    expect(computeCeilingPerHour(4, 0)).toBe(80)
    expect(computeCeilingPerHour(4, NaN)).toBe(80)
  })
})

describe('minutesSince', () => {
  const NOW = new Date('2026-05-15T12:00:00Z')
  it('returns whole minutes since the given ISO', () => {
    expect(minutesSince('2026-05-15T11:55:00Z', NOW)).toBe(5)
    expect(minutesSince('2026-05-15T11:00:00Z', NOW)).toBe(60)
  })
  it('returns 0 for future timestamps', () => {
    expect(minutesSince('2026-05-15T12:05:00Z', NOW)).toBe(0)
  })
  it('returns null for null / invalid input', () => {
    expect(minutesSince(null, NOW)).toBeNull()
    expect(minutesSince(undefined, NOW)).toBeNull()
    expect(minutesSince('not a date', NOW)).toBeNull()
  })
})

describe('resolveSpacingSeconds', () => {
  let pool
  beforeEach(() => {
    pool = { query: vi.fn() }
    delete process.env.MAILBOX_MIN_SPACING_SECONDS
  })

  it('returns the operator_settings value when present', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ value: '240' }] })
    const result = await resolveSpacingSeconds(pool)
    expect(result).toBe(240)
  })

  it('falls back to env var when operator_settings row missing', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    process.env.MAILBOX_MIN_SPACING_SECONDS = '90'
    const result = await resolveSpacingSeconds(pool)
    expect(result).toBe(90)
  })

  it('falls back to default (180) when neither operator_settings nor env resolves', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const result = await resolveSpacingSeconds(pool)
    expect(result).toBe(180)
  })

  it('ignores operator_settings rows with non-numeric value', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ value: 'banana' }] })
    const result = await resolveSpacingSeconds(pool)
    expect(result).toBe(180)
  })

  it('ignores operator_settings rows with zero / negative value', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ value: '0' }] })
    const result = await resolveSpacingSeconds(pool)
    expect(result).toBe(180)
  })

  it('tolerates pool.query rejecting (schema gap)', async () => {
    pool.query.mockRejectedValueOnce(new Error('relation "operator_settings" does not exist'))
    process.env.MAILBOX_MIN_SPACING_SECONDS = '120'
    const result = await resolveSpacingSeconds(pool)
    expect(result).toBe(120)
  })
})

// ─── Endpoint integration tests ──────────────────────────────────────────────

describe('GET /api/operator-metrics/cluster-rate-live', () => {
  let pool

  beforeEach(async () => {
    pool = { query: vi.fn() }
    delete process.env.MAILBOX_MIN_SPACING_SECONDS
    await startServer(pool)
  })

  afterEach(async () => {
    await stopServer()
    vi.restoreAllMocks()
  })

  /**
   * Stub the spacing + per-mailbox queries in order:
   *   1. resolveSpacingSeconds → operator_settings lookup
   *   2. perMailboxSql → active mailboxes window query
   */
  function stubQueries({ spacingRows = [{ value: '180' }], mailboxRows = [] } = {}) {
    pool.query
      .mockResolvedValueOnce({ rows: spacingRows })       // resolveSpacingSeconds
      .mockResolvedValueOnce({ rows: mailboxRows })       // perMailboxSql
  }

  it('returns empty payload when no active mailboxes exist', async () => {
    stubQueries({ mailboxRows: [] })
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.cluster.sent_60min).toBe(0)
    expect(r.body.cluster.rate_per_hour).toBe(0)
    expect(r.body.cluster.bounce_60min).toBe(0)
    expect(r.body.cluster.bounce_rate_pct).toBe(0)
    expect(r.body.mailboxes).toEqual([])
    expect(r.body.ceiling_per_h).toBe(0)
    expect(r.body.window_minutes).toBe(60)
    expect(r.body.spacing_seconds).toBe(180)
  })

  it('aggregates cluster totals across all per-mailbox rows', async () => {
    const lastSent = '2026-05-15T16:59:30Z'
    stubQueries({
      mailboxRows: [
        { from_address: 'mb1@post.cz', sent_60min: 19, bounce_60min: 0, last_sent_at: lastSent, status: 'active' },
        { from_address: 'mb2@post.cz', sent_60min: 16, bounce_60min: 1, last_sent_at: lastSent, status: 'active' },
        { from_address: 'mb3@post.cz', sent_60min: 22, bounce_60min: 0, last_sent_at: lastSent, status: 'active' },
        { from_address: 'mb4@post.cz', sent_60min: 21, bounce_60min: 0, last_sent_at: lastSent, status: 'active' },
      ],
    })
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.cluster.sent_60min).toBe(78)
    expect(r.body.cluster.rate_per_hour).toBe(78)
    expect(r.body.cluster.bounce_60min).toBe(1)
    // 1/78 ≈ 1.28%
    expect(r.body.cluster.bounce_rate_pct).toBe(1.3)
    expect(r.body.mailboxes).toHaveLength(4)
    expect(r.body.mailboxes[0].from_address).toBe('mb1@post.cz')
    expect(r.body.mailboxes[0].sent_60min).toBe(19)
    expect(r.body.mailboxes[0].rate_per_hour).toBe(19)
  })

  it('computes the ceiling as active_count × (3600 / spacing)', async () => {
    stubQueries({
      spacingRows: [{ value: '180' }],
      mailboxRows: [
        { from_address: 'a@p.cz', sent_60min: 1, bounce_60min: 0, last_sent_at: null, status: 'active' },
        { from_address: 'b@p.cz', sent_60min: 1, bounce_60min: 0, last_sent_at: null, status: 'active' },
        { from_address: 'c@p.cz', sent_60min: 1, bounce_60min: 0, last_sent_at: null, status: 'active' },
        { from_address: 'd@p.cz', sent_60min: 1, bounce_60min: 0, last_sent_at: null, status: 'active' },
      ],
    })
    const r = await get()
    // 4 × (3600 / 180) = 80
    expect(r.body.ceiling_per_h).toBe(80)
    expect(r.body.spacing_seconds).toBe(180)
  })

  it('reflects spacing override from operator_settings in the ceiling', async () => {
    stubQueries({
      spacingRows: [{ value: '60' }], // 60 sends/h per mailbox
      mailboxRows: [
        { from_address: 'a@p.cz', sent_60min: 1, bounce_60min: 0, last_sent_at: null, status: 'active' },
        { from_address: 'b@p.cz', sent_60min: 1, bounce_60min: 0, last_sent_at: null, status: 'active' },
      ],
    })
    const r = await get()
    // 2 × (3600 / 60) = 120
    expect(r.body.ceiling_per_h).toBe(120)
    expect(r.body.spacing_seconds).toBe(60)
  })

  it('emits minutes_since_last_send for each mailbox row', async () => {
    const veryRecent = new Date(Date.now() - 30_000).toISOString() // 30s ago
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    stubQueries({
      mailboxRows: [
        { from_address: 'fresh@p.cz', sent_60min: 5, bounce_60min: 0, last_sent_at: veryRecent, status: 'active' },
        { from_address: 'stuck@p.cz', sent_60min: 0, bounce_60min: 0, last_sent_at: tenMinAgo, status: 'active' },
      ],
    })
    const r = await get()
    const fresh = r.body.mailboxes.find((m) => m.from_address === 'fresh@p.cz')
    const stuck = r.body.mailboxes.find((m) => m.from_address === 'stuck@p.cz')
    expect(fresh.minutes_since_last_send).toBe(0)
    expect(stuck.minutes_since_last_send).toBeGreaterThanOrEqual(10)
  })

  it('returns degraded empty payload when the mailbox query throws (schema gap)', async () => {
    // First call (spacing) resolves; second call (mailboxes) rejects.
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('relation "send_events" does not exist'))
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body._degraded).toBe(true)
    expect(r.body.cluster.rate_per_hour).toBe(0)
    expect(r.body.mailboxes).toEqual([])
    expect(r.body.ceiling_per_h).toBe(0)
  })

  it('computes bounce rate of zero when no sends in window', async () => {
    stubQueries({
      mailboxRows: [
        { from_address: 'idle@p.cz', sent_60min: 0, bounce_60min: 0, last_sent_at: null, status: 'active' },
      ],
    })
    const r = await get()
    expect(r.body.cluster.bounce_rate_pct).toBe(0)
    // ceiling > 0 (1 active × 20/h @ 180s spacing)
    expect(r.body.ceiling_per_h).toBe(20)
  })

  it('emits ISO now_iso + window_minutes in response payload', async () => {
    stubQueries({ mailboxRows: [] })
    const r = await get()
    expect(typeof r.body.now_iso).toBe('string')
    expect(r.body.now_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(r.body.window_minutes).toBe(60)
  })

  it('passes the active-status filter to the perMailboxSql ($1) parameter', async () => {
    stubQueries({ mailboxRows: [] })
    await get()
    // Calls: [resolveSpacing, perMailboxSql]
    expect(pool.query).toHaveBeenCalledTimes(2)
    const secondCallParams = pool.query.mock.calls[1][1]
    expect(Array.isArray(secondCallParams)).toBe(true)
    expect(secondCallParams[0]).toEqual(['active'])
    expect(secondCallParams[1]).toBe(60) // window minutes
  })
})
