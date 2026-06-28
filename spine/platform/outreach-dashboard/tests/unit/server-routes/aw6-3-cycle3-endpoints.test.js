// AW6-3 — cycle-3 BFF endpoint edge cases (PR #1195 follow-up).
//
// Sprint AW6-3 fills the test gaps left by aw8-2-bff-endpoints.test.js.
// The existing file covers the happy path + a handful of error branches;
// this file targets the boundary + adversarial cases that the cycle-2
// review surfaced as operator-visible failure modes:
//
//   1. queue-depth — string-typed numeric fields from relay coerce to
//      numbers (defensive: a future relay refactor could ship strings).
//   2. queue-depth — null bridge_status passes through.
//   3. queue-depth — fetch timeout is treated as 'ok=false' not 500.
//   4. queue-depth — falsy queue_depth=0 is preserved (not coerced to a
//      pending_envelopes fallback).
//   5. in-flight-count — id=0 (DB-valid id, "?? 0" coercion edge).
//   6. in-flight-count — id beyond 32-bit boundary still passes the regex
//      and is bound as a number (defensive against bigint truncation).
//   7. in-flight-count — pool.query rejects with a non-Error value (string)
//      should still degrade gracefully to count=0.
//   8. last-24h-summary — partial DB failure (send_events fails, active
//      campaigns query succeeds) — endpoint returns zeros for the failed
//      part but the active count from the working query.
//   9. last-24h-summary — null fields from DB rows coerce to 0 (the
//      `?? 0` operator catches NULL but not undefined columns).
//  10. last-24h-summary — generated_at is a valid ISO 8601 string and is
//      monotonically increasing across two consecutive calls.
//  11. relayQueueDepth — fallback ANTI_TRACE_URL/ANTI_TRACE_TOKEN env
//      pair (legacy var names) is honoured. The route reads both pairs
//      and either is sufficient.
//  12. relayQueueDepth — relay returns body without queue_depth NOR
//      pending_envelopes — falls back to 0 (defensive).
//
// Per memory feedback_extreme_testing (HARD): ≥10 cases per change site.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mountRelayQueueDepthRoute } from '../../../src/server-routes/relayQueueDepth.js'
import { mountCampaignsRoutes } from '../../../src/server-routes/campaigns.js'

function makeMockRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    set: vi.fn(),
  }
  res.status.mockReturnValue(res)
  res.set.mockReturnValue(res)
  return res
}

function makeApp() {
  const routes = { get: {}, post: {}, put: {}, patch: {}, delete: {} }
  return {
    _routes: routes,
    get: vi.fn((path, handler) => { routes.get[path] = handler }),
    post: vi.fn((path, handler) => { routes.post[path] = handler }),
    put: vi.fn((path, handler) => { routes.put[path] = handler }),
    patch: vi.fn((path, handler) => { routes.patch[path] = handler }),
    delete: vi.fn((path, handler) => { routes.delete[path] = handler }),
    use: vi.fn(),
  }
}

function noopDeps() {
  return {
    setRouteTags: () => {},
    capture500: (res, e) => res.status(500).json({ error: e?.message || String(e) }),
    safeError: (e) => e?.message || String(e),
    Sentry: { captureException: () => {} },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AW6-3 case 1..4 + 11..12 — relay queue-depth edge cases.
// ─────────────────────────────────────────────────────────────────────────────

describe('AW6-3 — GET /api/relay/queue-depth edge cases', () => {
  let originalFetch
  beforeEach(() => {
    originalFetch = global.fetch
    delete process.env.ANTI_TRACE_RELAY_URL
    delete process.env.ANTI_TRACE_RELAY_TOKEN
    delete process.env.ANTI_TRACE_URL
    delete process.env.ANTI_TRACE_TOKEN
  })
  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // ── 1. String-typed numeric fields coerce via Number() ────────────────────
  // Production relay returns numbers, but a JSON-encoded relay deploy that
  // accidentally double-stringifies the metric values would otherwise
  // pass strings through untouched. The route uses `Number(body.queue_depth)`
  // — pin that contract.
  it('coerces string-typed queue_depth to number via Number()', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        queue_depth: '17', // string
        oldest_pending_age_seconds: '4',
        uptime_seconds: '3600',
        bridge_status: 'ok',
      }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.queue_depth).toBe(17)
    expect(typeof body.queue_depth).toBe('number')
    expect(body.oldest_pending_age_seconds).toBe(4)
    expect(typeof body.oldest_pending_age_seconds).toBe('number')
  })

  // ── 2. Null bridge_status passes through ──────────────────────────────────
  it('passes through bridge_status=null without converting to "null" string', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queue_depth: 5, bridge_status: null }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.bridge_status).toBe(null)
  })

  // ── 3. Fetch timeout (AbortSignal.timeout 4_000) → ok=false, not 500 ──────
  // The route uses AbortSignal.timeout(4_000) — DOMException AbortError
  // surfaces as a fetch rejection with name='AbortError'. We model it.
  it('returns ok=false on AbortError (timeout simulation)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    const abortErr = new Error('signal is aborted without reason')
    abortErr.name = 'AbortError'
    global.fetch = vi.fn().mockRejectedValue(abortErr)
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    expect(res.status).not.toHaveBeenCalledWith(500)
    const [body] = res.json.mock.calls[0]
    expect(body.ok).toBe(false)
    expect(body.queue_depth).toBe(0)
  })

  // ── 4. queue_depth=0 is preserved (not falsy-coerced to fallback) ─────────
  // Defensive: `body.queue_depth ?? body.pending_envelopes ?? 0` uses ??
  // so a literal 0 wins over the fallback. This pin prevents a regression
  // to `||` which would mistreat 0 as falsy.
  it('preserves queue_depth=0 (not coerced to pending_envelopes fallback)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queue_depth: 0, pending_envelopes: 99 }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.queue_depth).toBe(0)
    expect(body.queue_depth).not.toBe(99)
  })

  // ── 11. Legacy ANTI_TRACE_URL/ANTI_TRACE_TOKEN env pair honoured ──────────
  // The route reads BOTH (RELAY_URL/RELAY_TOKEN) AND (ANTI_TRACE_URL/
  // ANTI_TRACE_TOKEN). Some legacy deploys still use the older names.
  // Documented contract — pin so a refactor doesn't break legacy ops.
  it('honours legacy ANTI_TRACE_URL/ANTI_TRACE_TOKEN env pair', async () => {
    process.env.ANTI_TRACE_URL = 'http://legacy-relay.test'
    process.env.ANTI_TRACE_TOKEN = 'legacy-tok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queue_depth: 7 }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    expect(global.fetch).toHaveBeenCalled()
    const [calledUrl, opts] = global.fetch.mock.calls[0]
    expect(calledUrl).toMatch(/legacy-relay/)
    expect(opts.headers.Authorization).toBe('Bearer legacy-tok')
    const [body] = res.json.mock.calls[0]
    expect(body.queue_depth).toBe(7)
  })

  // ── 12. Body without queue_depth NOR pending_envelopes → 0 ────────────────
  it('falls back to 0 when neither queue_depth nor pending_envelopes present', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ uptime_seconds: 3600 }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.ok).toBe(true)
    expect(body.queue_depth).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AW6-3 case 5..7 — in-flight-count edge cases.
// ─────────────────────────────────────────────────────────────────────────────

describe('AW6-3 — GET /api/campaigns/:id/in-flight-count edge cases', () => {
  // ── 5. id=0 — valid numeric id (Postgres bigserial starts at 1, but the
  // route accepts any non-negative integer). Pins the regex contract.
  it('accepts id=0 and queries with parameter [0]', async () => {
    const app = makeApp()
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ count: 0 }] }) }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/:id/in-flight-count'](
      { params: { id: '0' } },
      res,
    )
    const sqlCall = pool.query.mock.calls[0]
    expect(sqlCall[1]).toEqual([0])
    const [body] = res.json.mock.calls[0]
    expect(body.count).toBe(0)
  })

  // ── 6. id beyond 32-bit boundary — pin bigint contract ────────────────────
  it('handles 64-bit-shaped id without truncation (Number conversion)', async () => {
    const app = makeApp()
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ count: 1 }] }) }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    // 2_147_483_649 = 2^31 + 1; safely within Number.MAX_SAFE_INTEGER.
    await app._routes.get['/api/campaigns/:id/in-flight-count'](
      { params: { id: '2147483649' } },
      res,
    )
    const sqlCall = pool.query.mock.calls[0]
    expect(sqlCall[1]).toEqual([2147483649])
  })

  // ── 7. pool.query rejects with non-Error value (string) → graceful 0 ──────
  it('degrades gracefully when DB rejects with a non-Error string', async () => {
    const app = makeApp()
    const pool = { query: vi.fn().mockRejectedValue('connection lost') }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/:id/in-flight-count'](
      { params: { id: '5' } },
      res,
    )
    const [body] = res.json.mock.calls[0]
    expect(body.count).toBe(0)
    // Must not 500 — degraded UI is the contract.
    expect(res.status).not.toHaveBeenCalledWith(500)
  })

  // ── 13. id with trailing whitespace (browser-prefilled URL) → 400 ─────────
  // The regex /^\d+$/ does not accept whitespace; verify the contract so a
  // refactor to /^\s*\d+\s*$/ doesn't silently break id binding.
  it('rejects id with trailing whitespace as 400', async () => {
    const app = makeApp()
    const pool = { query: vi.fn() }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/:id/in-flight-count'](
      { params: { id: '5 ' } },
      res,
    )
    expect(res.status).toHaveBeenCalledWith(400)
    expect(pool.query).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AW6-3 case 8..10 — last-24h-summary edge cases.
// ─────────────────────────────────────────────────────────────────────────────

describe('AW6-3 — GET /api/campaigns/last-24h-summary edge cases', () => {
  // ── 8. Partial DB failure: send_events query rejects, active campaigns OK
  it('returns zeros for failed send_events but active count from working query', async () => {
    const app = makeApp()
    let queryCount = 0
    const pool = {
      query: vi.fn().mockImplementation(() => {
        queryCount++
        if (queryCount === 1) {
          // send_events aggregate fails
          return Promise.reject(new Error('send_events query timeout'))
        }
        // active_campaigns succeeds
        return Promise.resolve({ rows: [{ active_campaigns: 7 }] })
      }),
    }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/last-24h-summary']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.sent).toBe(0)
    expect(body.bounced).toBe(0)
    expect(body.replied).toBe(0)
    expect(body.suppressed).toBe(0)
    expect(body.active_campaigns).toBe(7)
  })

  // ── 9. Null DB row fields coerce to 0 via ?? 0 ────────────────────────────
  it('coerces null row fields to 0', async () => {
    const app = makeApp()
    let queryCount = 0
    const pool = {
      query: vi.fn().mockImplementation(() => {
        queryCount++
        if (queryCount === 1) {
          return Promise.resolve({
            rows: [{ sent: null, bounced: null, replied: null, suppressed: null }],
          })
        }
        return Promise.resolve({ rows: [{ active_campaigns: null }] })
      }),
    }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/last-24h-summary']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.sent).toBe(0)
    expect(body.bounced).toBe(0)
    expect(body.replied).toBe(0)
    expect(body.suppressed).toBe(0)
    expect(body.active_campaigns).toBe(0)
  })

  // ── 10. generated_at is valid ISO 8601 + monotonic across calls ──────────
  it('returns valid ISO 8601 generated_at, monotonic across calls', async () => {
    const app = makeApp()
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ sent: 1, bounced: 0, replied: 0, suppressed: 0, active_campaigns: 1 }],
      }),
    }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })

    const res1 = makeMockRes()
    await app._routes.get['/api/campaigns/last-24h-summary']({}, res1)
    const [body1] = res1.json.mock.calls[0]
    expect(body1.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(new Date(body1.generated_at).toISOString()).toBe(body1.generated_at)

    // Wait at least 1ms so monotonicity is observable.
    await new Promise((r) => setTimeout(r, 5))

    const res2 = makeMockRes()
    await app._routes.get['/api/campaigns/last-24h-summary']({}, res2)
    const [body2] = res2.json.mock.calls[0]
    expect(new Date(body2.generated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(body1.generated_at).getTime(),
    )
  })
})
