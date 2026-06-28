// AW8-2 — BFF endpoint unit tests for the dashboard cycle 2 features.
//
// Covers three new BFF endpoints:
//
//   GET /api/relay/queue-depth       — proxy to anti-trace-relay /v1/status
//   GET /api/campaigns/:id/in-flight-count
//   GET /api/campaigns/last-24h-summary
//
// Each endpoint must:
//   - degrade gracefully (200 with ok:false) when relay/DB unavailable —
//     never blow up the dashboard for an optional observability feed
//   - return numeric counts in canonical shape
//   - never leak secrets / PII into response

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/relay/queue-depth
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/relay/queue-depth', () => {
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

  it('returns ok=false when ANTI_TRACE_RELAY_URL not set', async () => {
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/ANTI_TRACE_RELAY_URL/)
    expect(body.queue_depth).toBe(0)
  })

  it('returns ok=true with metrics when relay responds', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        queue_depth: 42,
        oldest_pending_age_seconds: 7,
        uptime_seconds: 3600,
        bridge_status: 'ok',
      }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.ok).toBe(true)
    expect(body.queue_depth).toBe(42)
    expect(body.oldest_pending_age_seconds).toBe(7)
    expect(body.uptime_seconds).toBe(3600)
    expect(body.bridge_status).toBe('ok')
  })

  it('falls back to pending_envelopes if queue_depth missing', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pending_envelopes: 17 }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.queue_depth).toBe(17)
  })

  it('returns ok=false on relay 5xx', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/relay status 503/)
  })

  it('returns ok=false on network error (never throws)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/relay fetch error/)
  })

  it('does not leak Bearer token into response', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'super-secret-token-do-not-leak'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queue_depth: 0 }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [body] = res.json.mock.calls[0]
    const stringified = JSON.stringify(body)
    expect(stringified).not.toContain('super-secret-token')
  })

  it('strips trailing slash from RELAY_URL before /v1/status', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test///'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queue_depth: 5 }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [calledUrl] = global.fetch.mock.calls[0]
    expect(calledUrl).toBe('http://relay.test/v1/status')
  })

  it('passes Authorization Bearer header correctly', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
    process.env.ANTI_TRACE_RELAY_TOKEN = 'mytok'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queue_depth: 0 }),
    })
    const app = makeApp()
    mountRelayQueueDepthRoute(app)
    const res = makeMockRes()
    await app._routes.get['/api/relay/queue-depth']({}, res)
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.headers.Authorization).toBe('Bearer mytok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/campaigns/:id/in-flight-count
// ─────────────────────────────────────────────────────────────────────────────

function makePoolWithCount(count) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ count }] }),
  }
}

function noopDeps() {
  return {
    setRouteTags: () => {},
    capture500: (res, e) => res.status(500).json({ error: e.message }),
    safeError: (e) => e?.message || String(e),
    Sentry: { captureException: () => {} },
  }
}

describe('GET /api/campaigns/:id/in-flight-count', () => {
  it('returns count from campaign_contacts WHERE status=in_flight', async () => {
    const app = makeApp()
    const pool = makePoolWithCount(3)
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/:id/in-flight-count'](
      { params: { id: '42' } },
      res,
    )
    const [body] = res.json.mock.calls[0]
    expect(body.count).toBe(3)
    expect(body.generated_at).toMatch(/\d{4}-\d{2}-\d{2}T/)
    // Verify SQL bound the campaign id
    const sqlCall = pool.query.mock.calls[0]
    expect(sqlCall[0]).toMatch(/status\s*=\s*'in_flight'/)
    expect(sqlCall[1]).toEqual([42])
  })

  it('returns 400 on non-numeric id', async () => {
    const app = makeApp()
    const pool = makePoolWithCount(0)
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/:id/in-flight-count'](
      { params: { id: 'abc' } },
      res,
    )
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('returns 0 when DB query fails (graceful degrade)', async () => {
    const app = makeApp()
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/:id/in-flight-count'](
      { params: { id: '5' } },
      res,
    )
    const [body] = res.json.mock.calls[0]
    expect(body.count).toBe(0)
  })

  it('handles count=0 case correctly', async () => {
    const app = makeApp()
    const pool = makePoolWithCount(0)
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/:id/in-flight-count'](
      { params: { id: '1' } },
      res,
    )
    const [body] = res.json.mock.calls[0]
    expect(body.count).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/campaigns/last-24h-summary
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/campaigns/last-24h-summary', () => {
  it('returns aggregated sent/bounced/replied/suppressed across all campaigns', async () => {
    const app = makeApp()
    let queryCount = 0
    const pool = {
      query: vi.fn().mockImplementation(() => {
        queryCount++
        if (queryCount === 1) {
          // send_events aggregate
          return Promise.resolve({
            rows: [{ sent: 142, bounced: 3, replied: 5, suppressed: 1 }],
          })
        }
        // active campaigns count
        return Promise.resolve({ rows: [{ active_campaigns: 2 }] })
      }),
    }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/last-24h-summary']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.sent).toBe(142)
    expect(body.bounced).toBe(3)
    expect(body.replied).toBe(5)
    expect(body.suppressed).toBe(1)
    expect(body.active_campaigns).toBe(2)
    expect(body.generated_at).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('returns zeros when DB queries fail', async () => {
    const app = makeApp()
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/last-24h-summary']({}, res)
    const [body] = res.json.mock.calls[0]
    expect(body.sent).toBe(0)
    expect(body.bounced).toBe(0)
    expect(body.replied).toBe(0)
    expect(body.active_campaigns).toBe(0)
  })

  it('uses send_events table with 24h interval', async () => {
    const app = makeApp()
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{}] }),
    }
    mountCampaignsRoutes(app, { pool, ...noopDeps() })
    const res = makeMockRes()
    await app._routes.get['/api/campaigns/last-24h-summary']({}, res)
    const sendEventsCall = pool.query.mock.calls.find(c =>
      c[0]?.includes?.('send_events') && c[0]?.includes?.('24 hours')
    )
    expect(sendEventsCall).toBeTruthy()
  })
})
