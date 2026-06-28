/**
 * Unit tests for proxyWatchdog.js — S9 proxy pool exhaustion watchdog.
 *
 * All tests are pure-function / dependency-injected, no DB or real network.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { makeProxyWatchdog, MIN_WORKING_PROXIES } from '../../../proxyWatchdog.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSnap(workingCount, { error = undefined } = {}) {
  return {
    working: Array.from({ length: workingCount }, (_, i) => ({ addr: `1.2.3.${i}:1080` })),
    error,
  }
}

function makeWatchdog({
  snap = makeSnap(5),
  base = 'http://relay.internal',
  token = 'test-token',
  fetchFn = vi.fn().mockResolvedValue({ ok: true }),
} = {}) {
  const relayProxyPool = vi.fn().mockResolvedValue(snap)
  const pool = {} // opaque — passed through to relayProxyPool
  const watchdog = makeProxyWatchdog({
    relayProxyPool,
    pool,
    getRelayBase: () => base,
    getRelayToken: () => token,
    fetchFn,
  })
  return { watchdog, relayProxyPool, fetchFn }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('makeProxyWatchdog', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  test('pool >= MIN_WORKING_PROXIES — does NOT call relay refresh', async () => {
    const { watchdog, fetchFn } = makeWatchdog({ snap: makeSnap(MIN_WORKING_PROXIES) })
    await watchdog()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('pool > MIN_WORKING_PROXIES — does NOT call relay refresh', async () => {
    const { watchdog, fetchFn } = makeWatchdog({ snap: makeSnap(10) })
    await watchdog()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('pool < MIN_WORKING_PROXIES — calls POST /v1/admin/refresh-pool', async () => {
    const { watchdog, fetchFn } = makeWatchdog({ snap: makeSnap(MIN_WORKING_PROXIES - 1) })
    await watchdog()
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('http://relay.internal/v1/admin/refresh-pool')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer test-token')
  })

  test('pool = 0 — calls refresh', async () => {
    const { watchdog, fetchFn } = makeWatchdog({ snap: makeSnap(0) })
    await watchdog()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  test('relay URL not set — no fetch call, no crash', async () => {
    const { watchdog, fetchFn } = makeWatchdog({ snap: makeSnap(0), base: null })
    await expect(watchdog()).resolves.toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('relay token not set — no fetch call, no crash', async () => {
    const { watchdog, fetchFn } = makeWatchdog({ snap: makeSnap(0), token: null })
    await expect(watchdog()).resolves.toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('relayProxyPool throws — no crash, no fetch', async () => {
    const relayProxyPool = vi.fn().mockRejectedValue(new Error('relay down'))
    const fetchFn = vi.fn()
    const watchdog = makeProxyWatchdog({
      relayProxyPool, pool: {},
      getRelayBase: () => 'http://relay.internal',
      getRelayToken: () => 'tok',
      fetchFn,
    })
    await expect(watchdog()).resolves.toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('snap.error set — skips refresh even when working count low', async () => {
    // relayProxyPool returns {error: 'relay_not_configured', working: []}
    const { watchdog, fetchFn } = makeWatchdog({
      snap: { working: [], error: 'relay_not_configured' },
    })
    await watchdog()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('fetch throws — no crash, watchdog resolves', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network error'))
    const { watchdog } = makeWatchdog({ snap: makeSnap(0), fetchFn })
    await expect(watchdog()).resolves.toBeUndefined()
  })

  test('MIN_WORKING_PROXIES constant is 3', () => {
    expect(MIN_WORKING_PROXIES).toBe(3)
  })

  describe('snap shape variants — monkey', () => {
    const weirdSnaps = [
      { working: undefined },
      { working: null },
      { working: 'not-an-array' },
      {},
      null,
    ]
    for (const snap of weirdSnaps) {
      test(`snap=${JSON.stringify(snap)} — no crash`, async () => {
        const relayProxyPool = vi.fn().mockResolvedValue(snap)
        const fetchFn = vi.fn().mockResolvedValue({ ok: true })
        const watchdog = makeProxyWatchdog({
          relayProxyPool, pool: {},
          getRelayBase: () => 'http://relay.internal',
          getRelayToken: () => 'tok',
          fetchFn,
        })
        await expect(watchdog()).resolves.toBeUndefined()
      })
    }
  })

  test('trailing slash on base URL is stripped by caller (base already clean)', async () => {
    // makeProxyWatchdog trusts the base URL from getRelayBase — no strip needed
    // as getRelayBase in server.js calls stripTrailingSlashes via relayClient.
    // This test verifies that a clean URL produces the correct endpoint.
    const fetchFn = vi.fn().mockResolvedValue({ ok: true })
    const watchdog = makeProxyWatchdog({
      relayProxyPool: vi.fn().mockResolvedValue(makeSnap(0)),
      pool: {},
      getRelayBase: () => 'http://relay.internal',
      getRelayToken: () => 'tok',
      fetchFn,
    })
    await watchdog()
    expect(fetchFn.mock.calls[0][0]).toBe('http://relay.internal/v1/admin/refresh-pool')
  })
})
