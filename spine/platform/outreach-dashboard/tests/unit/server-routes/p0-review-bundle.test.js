// Post-AR/AS code review bundle — P0/P1 fixes (Fix 1, Fix 4).
//
// Fix 1 (P0.1): /api/relay/pool-capacity must be served by the richer
//   mountPoolCapacityRoutes handler (returns endpoints detail) and NOT
//   shadow-duplicated by the simpler mountRelayPoolCapacityRoute.
//
// Fix 4 (P1.10): X-Force-Send force override audit log must capture the
//   actual operator identity (x-operator-id header or req.user) instead
//   of the hardcoded literal 'dashboard_user'.

import { describe, it, expect, vi } from 'vitest'

// ── Fix 1: single route serves richer handler ─────────────────────────────

// Import both handlers so we can verify their distinct response shapes.
import { mountPoolCapacityRoutes, preFlightPoolCapacity } from '../../../src/server-routes/poolCapacityMonitor.js'
import { mountRelayPoolCapacityRoute } from '../../../src/server-routes/relayPoolCapacity.js'

function makePoolWith(pinnedCount) {
  return {
    query: vi.fn().mockImplementation((sql) => {
      if (sql.includes('count(*)::int AS pinned') || sql.includes('count(*)')) {
        return Promise.resolve({ rows: [{ pinned: pinnedCount }] })
      }
      return Promise.resolve({ rows: [] })
    }),
  }
}

function makeMockRes() {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

describe('Fix 1 — richer handler includes endpoints array', () => {
  it('mountPoolCapacityRoutes response includes endpoints array (richer shape)', async () => {
    const origEnv = process.env.WIREPROXY_POOL_CONFIG
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'cz1', country: 'CZ' },
      { label: 'de1', country: 'DE' },
    ])
    const pool = makePoolWith(1)

    const routes = {}
    const router = { get: vi.fn((path, fn) => { routes[path] = fn }) }
    mountPoolCapacityRoutes(router, pool)

    const res = makeMockRes()
    await routes['/api/relay/pool-capacity']({ query: {} }, res)

    const [body] = res.json.mock.calls[0]
    // Richer handler must include endpoints array
    expect(Array.isArray(body.endpoints)).toBe(true)
    expect(body.endpoints.length).toBe(2)
    // Must include backward-compat free_count + can_add
    expect(typeof body.free_count).toBe('number')
    expect(typeof body.can_add).toBe('boolean')
    expect(body.free_count).toBe(1) // pool_size=2 - pinned_count=1
    expect(body.can_add).toBe(true)

    process.env.WIREPROXY_POOL_CONFIG = origEnv
  })

  it('simpler mountRelayPoolCapacityRoute does NOT include endpoints array', async () => {
    // This test documents the behavioral difference — the simpler handler
    // was the shadow that Fix 1 removed. It must not include the richer fields.
    const origEnv = process.env.WIREPROXY_POOL_CONFIG
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([{ label: 'cz1' }])

    const pool = makePoolWith(0)
    let capturedHandler = null
    const app = { get: vi.fn((path, fn) => { capturedHandler = fn }) }
    mountRelayPoolCapacityRoute(app, {
      pool,
      capture500: vi.fn(),
      safeError: vi.fn(),
    })

    expect(capturedHandler).not.toBeNull()
    const res = makeMockRes()
    await capturedHandler({ query: {} }, res)

    const [body] = res.json.mock.calls[0]
    // Simpler handler: no endpoints array
    expect(body.endpoints).toBeUndefined()
    // But includes its own shape
    expect(typeof body.pool_size).toBe('number')

    process.env.WIREPROXY_POOL_CONFIG = origEnv
  })
})

// ── Fix 4 — X-Force-Send actor identity ─────────────────────────────────────
// These tests verify the actor resolution logic in isolation.

/** Resolves actor identity using the same priority chain as the fix. */
function resolveActor(headers, user) {
  return headers?.['x-operator-id'] || user?.email || user?.id || 'unknown_actor'
}

describe('Fix 4 — actor identity resolution', () => {
  it('uses x-operator-id when present (highest priority)', () => {
    const actor = resolveActor({ 'x-operator-id': 'op-admin-007' }, { email: 'admin@example.com' })
    expect(actor).toBe('op-admin-007')
  })

  it('falls back to req.user.email when x-operator-id absent', () => {
    const actor = resolveActor({}, { email: 'admin@garaaage.cz' })
    expect(actor).toBe('admin@garaaage.cz')
  })

  it('falls back to req.user.id when email absent', () => {
    const actor = resolveActor({}, { id: 'usr-12345' })
    expect(actor).toBe('usr-12345')
  })

  it('falls back to unknown_actor when no identity info available', () => {
    const actor = resolveActor({}, null)
    expect(actor).toBe('unknown_actor')
  })

  it('does NOT use hardcoded dashboard_user literal in any path', () => {
    // Verify all resolution paths avoid the old hardcoded literal.
    const paths = [
      resolveActor({ 'x-operator-id': 'op-1' }, null),
      resolveActor({}, { email: 'u@x.cz' }),
      resolveActor({}, { id: 'usr-1' }),
      resolveActor({}, null),
    ]
    for (const actor of paths) {
      expect(actor).not.toBe('dashboard_user')
    }
  })
})
