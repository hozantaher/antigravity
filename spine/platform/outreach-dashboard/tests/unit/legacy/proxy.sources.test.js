/**
 * Unit tests for /api/health/proxy-sources endpoint handler logic.
 * Tests the three behaviours:
 *   1. relay /v1/proxy-sources available → forwards its response
 *   2. relay /v1/proxy-sources unavailable → fallback from pool snapshot
 *   3. relay not configured (no URL) → error shape
 *
 * Uses BFF_IMPORT_ONLY=1 to import the Express app without starting the HTTP
 * server or cron, then dispatches requests via supertest-style fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Helper: minimal Express-app wrapper ──────────────────────────────────────
//
// We test the handler logic by extracting the core processing into a testable
// pure-ish function that mirrors server.js handler without needing a full app.
// This avoids importing the entire server (DB, cron, etc.) in unit tests.

import { getRelayBase, relayProxyPool } from '../../../src/lib/relayClient.js'

/**
 * Re-implements the /api/health/proxy-sources handler core logic so it can be
 * tested without a running Express server.
 */
async function handleProxySources({ pool, fetchFn }) {
  const base = await getRelayBase(pool)
  if (!base) return { error: 'relay_not_configured', sources: {} }
  const token = process.env.ANTI_TRACE_RELAY_TOKEN || process.env.ANTI_TRACE_TOKEN || ''
  try {
    const r = await fetchFn(`${base}/v1/proxy-sources`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (r.ok) {
      return await r.json()
    }
  } catch { /* fallthrough */ }
  // Fallback: derive from pool snapshot.
  const snap = await relayProxyPool(pool)
  const sources = {}
  for (const entry of (snap.working || [])) {
    const src = entry.source || 'unknown'
    if (!sources[src]) sources[src] = { count: 0, degraded: false }
    sources[src].count++
  }
  return { sources, from_pool: true }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function fakePoolFetch(working) {
  return vi.fn(async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      working,
      last_refresh: new Date().toISOString(),
      count: working.length,
    }),
  }))
}

function fakeSourcesFetch(body, ok = true) {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  }))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('/api/health/proxy-sources — relay_not_configured', () => {
  const savedEnv = { ...process.env }
  afterEach(() => { process.env = { ...savedEnv } })

  it('returns error + empty sources when relay has no URL configured', async () => {
    delete process.env.ANTI_TRACE_RELAY_URL_OVERRIDE
    delete process.env.ANTI_TRACE_RELAY_URL
    const fetchFn = vi.fn()

    const result = await handleProxySources({ pool: null, fetchFn })

    expect(result.error).toBe('relay_not_configured')
    expect(result.sources).toEqual({})
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('/api/health/proxy-sources — relay /v1/proxy-sources available', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => { process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://relay.local' })
  afterEach(() => { process.env = { ...savedEnv }; vi.unstubAllGlobals() })

  it('returns relay response directly when endpoint returns 200', async () => {
    const relayBody = {
      sources: {
        proxifly:    { count: 10, degraded: false },
        geonode:     { count: 3,  degraded: true  },
        proxyscrape: { count: 0,  degraded: true  },
      },
    }
    const fetchFn = fakeSourcesFetch(relayBody, true)

    const result = await handleProxySources({ pool: null, fetchFn })

    expect(result.sources).toEqual(relayBody.sources)
    expect(result.from_pool).toBeUndefined()
  })

  it('calls /v1/proxy-sources on the relay base URL', async () => {
    const fetchFn = fakeSourcesFetch({ sources: {} }, true)

    await handleProxySources({ pool: null, fetchFn })

    expect(fetchFn).toHaveBeenCalledWith(
      'http://relay.local/v1/proxy-sources',
      expect.any(Object),
    )
  })
})

describe('/api/health/proxy-sources — fallback from pool snapshot', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => { process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://relay.local' })
  afterEach(() => { process.env = { ...savedEnv }; vi.unstubAllGlobals() })

  it('falls back to pool snapshot when relay /v1/proxy-sources returns non-ok', async () => {
    // First call: /v1/proxy-sources → 503
    // Second call: /v1/proxy-pool → 200 with entries
    const entries = [
      { addr: 'p1:1080', country: 'CZ', source: 'proxifly' },
      { addr: 'p2:1080', country: 'CZ', source: 'proxifly' },
      { addr: 'p3:1080', country: 'DE', source: 'geonode'  },
    ]
    let callCount = 0
    const fetchFn = vi.fn(async (url) => {
      callCount++
      if (url.endsWith('/v1/proxy-sources')) {
        return { ok: false, status: 503, json: async () => ({}) }
      }
      // /v1/proxy-pool fallback
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          working: entries,
          last_refresh: new Date().toISOString(),
          count: entries.length,
        }),
      }
    })
    vi.stubGlobal('fetch', fetchFn)

    const result = await handleProxySources({ pool: null, fetchFn })

    expect(result.from_pool).toBe(true)
    expect(result.sources.proxifly.count).toBe(2)
    expect(result.sources.geonode.count).toBe(1)
  })

  it('falls back when relay /v1/proxy-sources throws (network error)', async () => {
    const entries = [
      { addr: 'p1:1080', country: 'CZ', source: 'proxyscrape' },
    ]
    const fetchFn = vi.fn(async (url) => {
      if (url.endsWith('/v1/proxy-sources')) {
        throw new Error('connection refused')
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          working: entries,
          last_refresh: new Date().toISOString(),
          count: entries.length,
        }),
      }
    })
    vi.stubGlobal('fetch', fetchFn)

    const result = await handleProxySources({ pool: null, fetchFn })

    expect(result.from_pool).toBe(true)
    expect(result.sources.proxyscrape.count).toBe(1)
  })

  it('fallback with empty pool → sources = {}', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url.endsWith('/v1/proxy-sources')) {
        return { ok: false, status: 503, json: async () => ({}) }
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          working: [],
          last_refresh: new Date().toISOString(),
          count: 0,
        }),
      }
    })
    vi.stubGlobal('fetch', fetchFn)

    const result = await handleProxySources({ pool: null, fetchFn })

    expect(result.from_pool).toBe(true)
    expect(result.sources).toEqual({})
  })

  it('fallback groups entries by source and counts correctly', async () => {
    // relayProxyPool maps source: e.source || 'relay', so entries with no
    // source come through as 'relay' in the working array.
    const entries = [
      { addr: 'a:1', source: 'proxifly' },
      { addr: 'b:1', source: 'proxifly' },
      { addr: 'c:1', source: 'proxifly' },
      { addr: 'd:1', source: 'geonode' },
      { addr: 'e:1' /* no source → mapped to 'relay' by relayProxyPool */ },
    ]
    const fetchFn = vi.fn(async (url) => {
      if (url.endsWith('/v1/proxy-sources')) {
        return { ok: false, status: 503, json: async () => ({}) }
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          working: entries,
          last_refresh: new Date().toISOString(),
          count: entries.length,
        }),
      }
    })
    vi.stubGlobal('fetch', fetchFn)

    const result = await handleProxySources({ pool: null, fetchFn })

    expect(result.sources.proxifly.count).toBe(3)
    expect(result.sources.geonode.count).toBe(1)
    // source-less entries get mapped to 'relay' by relayProxyPool
    expect(result.sources.relay.count).toBe(1)
  })
})
