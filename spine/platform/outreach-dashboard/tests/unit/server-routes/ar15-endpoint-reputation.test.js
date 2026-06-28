// AR15 — Mullvad endpoint reputation monitoring cron + operator endpoint tests.
//
// Coverage (≥10 per feedback_extreme_testing):
//   T01 no endpoints with ≥50 sends → checked=0 flagged=0
//   T02 single endpoint at 2× mean → flagged
//   T03 single endpoint below 2× mean → not flagged
//   T04 UPSERT called for every endpoint (flagged or not)
//   T05 Sentry captureMessage called when flagged
//   T06 Sentry absent → no throw
//   T07 multiple endpoints, only elevated ones flagged
//   T08 operator endpoint returns 200 + endpoints array
//   T09 operator endpoint handles DB error → 500
//   T10 migration 083 table: schema verification via SELECT
//   T11 boundary: rate exactly 2× mean → flagged
//   T12 pool.query error in cron propagates

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMullvadEndpointReputationCron, mountEndpointHealthRoute } from '../../../src/server-routes/endpointHealth.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEndpointRow({ label = 'cz-prg-1', sends = 100, bounces = 5, rate = 0.05, mean_rate = 0.03 } = {}) {
  return { label, sends, bounces, rate, mean_rate }
}

function makeCronPool({ statsRows = [], upsertRowCount = 1 } = {}) {
  const query = vi.fn()
  // First call: SELECT endpoint stats
  query.mockResolvedValueOnce({ rows: statsRows })
  // Subsequent calls: UPSERT for each row
  for (let i = 0; i < statsRows.length; i++) {
    query.mockResolvedValue({ rowCount: upsertRowCount })
  }
  return { query }
}

// ── Cron tests ─────────────────────────────────────────────────────────────────

describe('AR15 — runMullvadEndpointReputationCron', () => {
  it('T01 no endpoints returned → checked=0 flagged=0', async () => {
    const pool = makeCronPool({ statsRows: [] })
    const result = await runMullvadEndpointReputationCron(pool)
    expect(result.checked).toBe(0)
    expect(result.flagged).toBe(0)
  })

  it('T02 endpoint at 2× mean bounce rate → flagged', async () => {
    // mean=0.03, rate=0.06 → 2× → flagged
    const pool = makeCronPool({
      statsRows: [makeEndpointRow({ label: 'cz-prg-2', sends: 100, bounces: 6, rate: 0.06, mean_rate: 0.03 })],
    })
    const result = await runMullvadEndpointReputationCron(pool)
    expect(result.flagged).toBe(1)
    expect(result.endpoints[0].flagged).toBe(true)
  })

  it('T03 endpoint below 2× mean → not flagged (checked but not flagged)', async () => {
    // rate=0.05, mean=0.03 → 1.67× → below threshold
    const pool = makeCronPool({
      statsRows: [makeEndpointRow({ label: 'cz-prg-1', sends: 100, bounces: 5, rate: 0.05, mean_rate: 0.03 })],
    })
    const result = await runMullvadEndpointReputationCron(pool)
    expect(result.flagged).toBe(0)
    expect(result.checked).toBe(1)
    expect(result.endpoints[0].flagged).toBe(false)
  })

  it('T04 UPSERT called for every endpoint regardless of flagged status', async () => {
    const statsRows = [
      makeEndpointRow({ label: 'cz-prg-1', rate: 0.05, mean_rate: 0.03 }),
      makeEndpointRow({ label: 'cz-prg-2', rate: 0.10, mean_rate: 0.03 }),
    ]
    const pool = makeCronPool({ statsRows })
    await runMullvadEndpointReputationCron(pool)
    // First call = stats SELECT, then 1 UPSERT per row = 3 total
    expect(pool.query).toHaveBeenCalledTimes(3)
    const upsertCall = pool.query.mock.calls[1]
    expect(upsertCall[0]).toContain('INSERT INTO mailbox_egress_endpoint_health')
  })

  it('T05 Sentry captureMessage called when endpoint is flagged', async () => {
    const pool = makeCronPool({
      statsRows: [makeEndpointRow({ rate: 0.10, mean_rate: 0.03 })],
    })
    const Sentry = { captureMessage: vi.fn() }
    await runMullvadEndpointReputationCron(pool, { Sentry })
    expect(Sentry.captureMessage).toHaveBeenCalledOnce()
    const [msg, level] = Sentry.captureMessage.mock.calls[0]
    expect(msg).toContain('endpoint_reputation_elevated')
    expect(level).toBe('warning')
  })

  it('T06 Sentry absent (no deps) → no throw', async () => {
    const pool = makeCronPool({
      statsRows: [makeEndpointRow({ rate: 0.10, mean_rate: 0.03 })],
    })
    await expect(runMullvadEndpointReputationCron(pool, {})).resolves.not.toThrow()
  })

  it('T07 multiple endpoints — only elevated flagged', async () => {
    const statsRows = [
      makeEndpointRow({ label: 'cz-prg-1', rate: 0.05, mean_rate: 0.05 }),  // 1× = not flagged
      makeEndpointRow({ label: 'cz-prg-2', rate: 0.12, mean_rate: 0.05 }),  // 2.4× = flagged
      makeEndpointRow({ label: 'at-vie-1', rate: 0.04, mean_rate: 0.05 }),  // 0.8× = not flagged
    ]
    const pool = makeCronPool({ statsRows })
    const result = await runMullvadEndpointReputationCron(pool)
    expect(result.flagged).toBe(1)
    expect(result.checked).toBe(3)
    const flaggedEndpoints = result.endpoints.filter(e => e.flagged)
    expect(flaggedEndpoints).toHaveLength(1)
    expect(flaggedEndpoints[0].label).toBe('cz-prg-2')
  })

  it('T11 boundary: rate exactly 2× mean → flagged', async () => {
    // 2 × 0.05 = 0.10 exactly
    const pool = makeCronPool({
      statsRows: [makeEndpointRow({ rate: 0.10, mean_rate: 0.05 })],
    })
    const result = await runMullvadEndpointReputationCron(pool)
    expect(result.flagged).toBe(1)
  })

  it('T12 pool.query throws → error propagates', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('DB failure')) }
    await expect(runMullvadEndpointReputationCron(pool)).rejects.toThrow('DB failure')
  })
})

// ── Operator endpoint tests ───────────────────────────────────────────────────

describe('AR15 — mountEndpointHealthRoute', () => {
  function makeExpressApp() {
    const routes = {}
    return {
      get: vi.fn((path, handler) => { routes[path] = handler }),
      routes,
    }
  }

  it('T08 GET /api/relay/endpoint-health returns 200 + endpoints array', async () => {
    const app = makeExpressApp()
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { endpoint_label: 'cz-prg-1', sends_7d: 200, bounces_7d: 4, bounce_rate_pct: 2.0, avg_rate_pct: 3.0, ratio: 0.67, flagged: false },
        ],
      }),
    }
    mountEndpointHealthRoute(app, pool)

    const handler = app.routes['/api/relay/endpoint-health']
    expect(handler).toBeDefined()

    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await handler({}, res)

    expect(res.json).toHaveBeenCalledOnce()
    const payload = res.json.mock.calls[0][0]
    expect(payload.ok).toBe(true)
    expect(Array.isArray(payload.endpoints)).toBe(true)
    expect(payload.endpoints[0].endpoint_label).toBe('cz-prg-1')
  })

  it('T09 operator endpoint DB error → 500', async () => {
    const app = makeExpressApp()
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('conn refused')),
    }
    mountEndpointHealthRoute(app, pool)

    const handler = app.routes['/api/relay/endpoint-health']
    const json = vi.fn()
    const res = { json, status: vi.fn().mockReturnValue({ json }) }
    await handler({}, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('T10 schema: table creation verified in migration SQL (static check)', async () => {
    // Verify migration 083 SQL defines mailbox_egress_endpoint_health
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const sql = readFileSync(
      resolve(import.meta.dirname, '../../../../../../scripts/migrations/083_endpoint_health_track.sql'),
      'utf8',
    )
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mailbox_egress_endpoint_health')
    expect(sql).toContain('endpoint_label')
    expect(sql).toContain('bounce_rate')
    expect(sql).toContain('flagged')
    expect(sql).toContain('083_endpoint_health_track')
  })
})
