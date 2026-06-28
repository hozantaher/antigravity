// Sprint AS4 + AS7 — Pool capacity monitor unit tests.
//
// AS4 (runPoolCapacityCron):
//   T01 empty pool config → skipped
//   T02 ratio < 0.8 → no alert
//   T03 ratio 0.8..1.0 → Sentry warning
//   T04 ratio >= 1.0 (exact) → Sentry error
//   T05 ratio > 1.0 (overcommit) → Sentry error
//   T06 Sentry unavailable → no throw (best-effort)
//
// AS4 (/api/relay/pool-capacity endpoint):
//   T07 returns pool_size, pinned_count, ratio in response
//   T08 returns endpoint list from WIREPROXY_POOL_CONFIG
//   T09 redacts mailbox email (local-part replaced with <u>)
//   T10 endpoint with no pinned mailbox → pinned_to null
//
// AS7 (migration 085 logic via preFlightPoolCapacity):
//   T11 existing pin preserved — pinned mailboxes counted, not re-assigned here
//   T12 preFlightPoolCapacity returns 0 when pool empty
//   T13 preFlightPoolCapacity counts only production mailboxes with non-null label
//
// ≥13 test cases (> 10 required by feedback_extreme_testing).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runPoolCapacityCron, preFlightPoolCapacity, mountPoolCapacityRoutes } from '../../../src/server-routes/poolCapacityMonitor.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSentry() {
  return { captureMessage: vi.fn() }
}

/**
 * Build a simple pool mock that returns the given pinned_count.
 * preFlightPoolCapacity fires one SELECT; mountPoolCapacityRoutes fires two.
 */
function makePool(pinnedCount, additionalRows = []) {
  const calls = []
  return {
    _calls: calls,
    query: vi.fn().mockImplementation((sql) => {
      // First query = SELECT count(...)::int AS pinned
      if (typeof sql === 'string' && sql.includes('count(*)::int AS pinned')) {
        return Promise.resolve({ rows: [{ pinned: pinnedCount }] })
      }
      // Second query = SELECT id, from_address, pinned_endpoint_label (endpoint route)
      return Promise.resolve({ rows: additionalRows })
    }),
  }
}

const BASE_POOL_CONFIG = JSON.stringify([
  { label: 'cz-prg-wg-101', country: 'CZ' },
  { label: 'cz-prg-wg-102', country: 'CZ' },
  { label: 'cz-prg-wg-103', country: 'CZ' },
  { label: 'cz-prg-wg-104', country: 'CZ' },
  { label: 'sk-bts-wg-201', country: 'SK' },
])

beforeEach(() => {
  delete process.env.WIREPROXY_POOL_CONFIG
})

afterEach(() => {
  delete process.env.WIREPROXY_POOL_CONFIG
  vi.restoreAllMocks()
})

// ── AS4: runPoolCapacityCron ─────────────────────────────────────────────────

describe('T01 empty pool → skipped', () => {
  it('returns skipped=true when WIREPROXY_POOL_CONFIG is empty array', async () => {
    process.env.WIREPROXY_POOL_CONFIG = '[]'
    const pool = makePool(0)
    const result = await runPoolCapacityCron(pool)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no_pool_config')
    expect(pool.query).not.toHaveBeenCalled()
  })
})

describe('T02 ratio < 0.8 → no alert', () => {
  it('alerted=null and no Sentry call', async () => {
    process.env.WIREPROXY_POOL_CONFIG = BASE_POOL_CONFIG // pool_size=5
    const pool = makePool(2) // ratio 2/5 = 0.4
    const Sentry = makeSentry()
    const result = await runPoolCapacityCron(pool, { Sentry })
    expect(result.alerted).toBeNull()
    expect(result.ratio).toBeCloseTo(0.4)
    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })
})

describe('T03 ratio 0.8..1.0 → Sentry warning', () => {
  it('fires warning when 4 of 5 endpoints pinned', async () => {
    process.env.WIREPROXY_POOL_CONFIG = BASE_POOL_CONFIG // pool_size=5
    const pool = makePool(4) // ratio 4/5 = 0.8
    const Sentry = makeSentry()
    const result = await runPoolCapacityCron(pool, { Sentry })
    expect(result.alerted).toBe('warning')
    expect(Sentry.captureMessage).toHaveBeenCalledOnce()
    const [msg, level] = Sentry.captureMessage.mock.calls[0]
    expect(msg).toContain('pool_high_utilization')
    expect(msg).toContain('pinned=4')
    expect(msg).toContain('pool_size=5')
    expect(level).toBe('warning')
  })
})

describe('T04 ratio exactly 1.0 → Sentry error', () => {
  it('fires error when all endpoints pinned', async () => {
    process.env.WIREPROXY_POOL_CONFIG = BASE_POOL_CONFIG // pool_size=5
    const pool = makePool(5) // ratio = 1.0
    const Sentry = makeSentry()
    const result = await runPoolCapacityCron(pool, { Sentry })
    expect(result.alerted).toBe('error')
    const [msg, level] = Sentry.captureMessage.mock.calls[0]
    expect(msg).toContain('pool_exhausted')
    expect(level).toBe('error')
  })
})

describe('T05 ratio > 1.0 overcommit → Sentry error', () => {
  it('fires error when pinned > pool_size', async () => {
    process.env.WIREPROXY_POOL_CONFIG = BASE_POOL_CONFIG // pool_size=5
    // Q4.1 hysteresis state (lastAlertState) is module-level and leaks across
    // tests — T04 leaves it at 'error', so an overcommit tick would be a
    // no-op "state unchanged". Prime a non-error baseline so this tick is a
    // genuine error transition that fires.
    await runPoolCapacityCron(makePool(2), { Sentry: makeSentry() }) // ratio 0.4 → 'ok'
    const pool = makePool(7) // ratio = 1.4
    const Sentry = makeSentry()
    const result = await runPoolCapacityCron(pool, { Sentry })
    expect(result.alerted).toBe('error')
    expect(result.ratio).toBeCloseTo(1.4)
  })
})

describe('T06 Sentry.captureMessage throws → no re-throw', () => {
  it('cron result still returned when Sentry throws', async () => {
    process.env.WIREPROXY_POOL_CONFIG = BASE_POOL_CONFIG
    const pool = makePool(4)
    const brokenSentry = { captureMessage: vi.fn().mockImplementation(() => { throw new Error('sentry down') }) }
    await expect(runPoolCapacityCron(pool, { Sentry: brokenSentry })).resolves.toBeDefined()
  })
})

// ── AS4: /api/relay/pool-capacity endpoint ───────────────────────────────────

function makeMockRes() {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res) // chainable
  return res
}

function makeRouter() {
  const routes = {}
  return {
    get: vi.fn((path, handler) => { routes[path] = handler }),
    _routes: routes,
  }
}

describe('T07 /api/relay/pool-capacity returns metrics', () => {
  it('includes pool_size, pinned_count, ratio', async () => {
    process.env.WIREPROXY_POOL_CONFIG = BASE_POOL_CONFIG // pool_size=5
    const pool = makePool(3, []) // pinned=3
    const router = makeRouter()
    mountPoolCapacityRoutes(router, pool)

    const res = makeMockRes()
    await router._routes['/api/relay/pool-capacity']({}, res)

    const [body] = res.json.mock.calls[0]
    expect(body.pool_size).toBe(5)
    expect(body.pinned_count).toBe(3)
    expect(body.ratio).toBeCloseTo(0.6)
  })
})

describe('T08 /api/relay/pool-capacity returns endpoint list', () => {
  it('endpoints array has correct labels and countries', async () => {
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'cz-prg-wg-101', country: 'CZ' },
      { label: 'sk-bts-wg-201', country: 'SK' },
    ])
    const pool = makePool(0, [])
    const router = makeRouter()
    mountPoolCapacityRoutes(router, pool)

    const res = makeMockRes()
    await router._routes['/api/relay/pool-capacity']({}, res)

    const [body] = res.json.mock.calls[0]
    expect(body.endpoints).toHaveLength(2)
    expect(body.endpoints[0].label).toBe('cz-prg-wg-101')
    expect(body.endpoints[0].country).toBe('CZ')
    expect(body.endpoints[1].label).toBe('sk-bts-wg-201')
  })
})

describe('T09 /api/relay/pool-capacity redacts mailbox email', () => {
  it('from_address_redacted hides local-part', async () => {
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'cz-prg-wg-101', country: 'CZ' },
    ])
    const pool = makePool(1, [
      { id: 12834, from_address: 'goran@garaaage.cz', pinned_endpoint_label: 'cz-prg-wg-101' },
    ])
    const router = makeRouter()
    mountPoolCapacityRoutes(router, pool)

    const res = makeMockRes()
    await router._routes['/api/relay/pool-capacity']({}, res)

    const [body] = res.json.mock.calls[0]
    const ep = body.endpoints.find(e => e.label === 'cz-prg-wg-101')
    expect(ep.pinned_to).not.toBeNull()
    expect(ep.pinned_to.from_address_redacted).not.toContain('goran')
    expect(ep.pinned_to.from_address_redacted).toMatch(/^<u>@/)
    expect(ep.pinned_to.id).toBe(12834)
  })
})

describe('T10 /api/relay/pool-capacity endpoint with no pin → pinned_to null', () => {
  it('unpinned endpoint has pinned_to=null', async () => {
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'cz-prg-wg-101', country: 'CZ' },
      { label: 'cz-prg-wg-102', country: 'CZ' },
    ])
    // Only first endpoint is pinned
    const pool = makePool(1, [
      { id: 1, from_address: 'a@garaaage.cz', pinned_endpoint_label: 'cz-prg-wg-101' },
    ])
    const router = makeRouter()
    mountPoolCapacityRoutes(router, pool)

    const res = makeMockRes()
    await router._routes['/api/relay/pool-capacity']({}, res)

    const [body] = res.json.mock.calls[0]
    const unpinned = body.endpoints.find(e => e.label === 'cz-prg-wg-102')
    expect(unpinned.pinned_to).toBeNull()
  })
})

// ── AS7: migration 085 / preFlightPoolCapacity ───────────────────────────────

describe('T11 existing pin preserved (preFlightPoolCapacity counts correctly)', () => {
  it('returns correct pinned_count when Goran 12834 already pinned', async () => {
    process.env.WIREPROXY_POOL_CONFIG = BASE_POOL_CONFIG // pool_size=5
    // DB reports 1 already-pinned mailbox (Goran)
    const pool = makePool(1)
    const result = await preFlightPoolCapacity(pool)
    expect(result.pinned_count).toBe(1)
    expect(result.pool_size).toBe(5)
    expect(result.ratio).toBeCloseTo(0.2)
    // P0.1 fix: SQL now uses parameterized $1 instead of hardcoded 'production'
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('pinned_endpoint_label IS NOT NULL')
    expect(sql).toContain('environment = $1')
    expect(params).toContain('production')
  })
})

describe('T12 preFlightPoolCapacity with empty pool', () => {
  it('returns 0/0/0 when no pool configured', async () => {
    process.env.WIREPROXY_POOL_CONFIG = '[]'
    const pool = makePool(0)
    const result = await preFlightPoolCapacity(pool)
    expect(result.pool_size).toBe(0)
    expect(result.pinned_count).toBe(0)
    expect(result.ratio).toBe(0)
    expect(pool.query).not.toHaveBeenCalled()
  })
})

describe('T13 preFlightPoolCapacity filters production + non-null only', () => {
  it('SQL uses parameterized environment filter + IS NOT NULL guard', async () => {
    process.env.WIREPROXY_POOL_CONFIG = BASE_POOL_CONFIG
    const pool = makePool(2)
    await preFlightPoolCapacity(pool)
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('pinned_endpoint_label IS NOT NULL')
    // P0.1 fix: parameterized query ($1) with default env='production'
    expect(sql).toContain('environment = $1')
    expect(params).toContain('production')
  })
})
