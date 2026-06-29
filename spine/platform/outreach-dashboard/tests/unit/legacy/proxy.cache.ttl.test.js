/**
 * Tests for P3: Real-time cache sync
 *
 * Verifies:
 *  - PROXY_TTL is 15s (not the old 60s)
 *  - Cache returns fresh data within 15s window
 *  - Cache fetches after TTL expires
 *  - invalidate() forces next call to fetch
 *  - empty_pool_critical → immediate invalidation
 *  - BFF does not call relay more than 1×/15s (rate limiting)
 *  - HEALTH_REFRESH_MS constant is 15s in the UI layer
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { buildProxyCacheManager, PROXY_TTL_MS } from '../../../proxyCacheLogic.js'

// ── PROXY_TTL constant ───────────────────────────────────────────────────────

describe('PROXY_TTL_MS constant', () => {
  test('is 15 000 ms (not the old 60 000 ms)', () => {
    expect(PROXY_TTL_MS).toBe(15_000)
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSnapshot(overrides = {}) {
  return {
    working: [{ addr: '1.2.3.4:1080' }],
    empty_pool_critical: false,
    consecutive_zero_refreshes: 0,
    last_refresh: new Date().toISOString(),
    ...overrides,
  }
}

function makeClock(startMs = 0) {
  let t = startMs
  return {
    now: () => t,
    advance: (ms) => { t += ms },
  }
}

// ── buildProxyCacheManager ───────────────────────────────────────────────────

describe('buildProxyCacheManager', () => {
  let clock
  let fetchFn

  beforeEach(() => {
    clock = makeClock(1_000_000)
    fetchFn = vi.fn().mockResolvedValue(makeSnapshot())
  })

  // ── TTL / freshness ────────────────────────────────────────────────────────

  test('fresh data returned from cache without calling fetchFn again', async () => {
    const mgr = buildProxyCacheManager({ ttlMs: 15_000, now: clock.now })
    // First call — populates cache
    await mgr.get(fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Second call within TTL — serves from cache
    clock.advance(14_000)
    await mgr.get(fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1) // no second relay hit
  })

  test('cache miss after TTL expires — fetchFn is called again', async () => {
    const mgr = buildProxyCacheManager({ ttlMs: 15_000, now: clock.now })
    await mgr.get(fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    clock.advance(15_001) // past TTL
    await mgr.get(fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  test('at exactly TTL boundary (15 000 ms) cache is expired — re-fetches', async () => {
    const mgr = buildProxyCacheManager({ ttlMs: 15_000, now: clock.now })
    await mgr.get(fetchFn)
    clock.advance(15_000) // exactly at TTL — now() - cachedAt == ttlMs → expired
    await mgr.get(fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(2) // stale, must re-fetch
  })

  // ── invalidate ─────────────────────────────────────────────────────────────

  test('invalidate() forces a fetch on the next get()', async () => {
    const mgr = buildProxyCacheManager({ ttlMs: 15_000, now: clock.now })
    await mgr.get(fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    mgr.invalidate()
    await mgr.get(fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  test('invalidate() clears cached value and timestamp', () => {
    const mgr = buildProxyCacheManager({ ttlMs: 15_000, now: clock.now })
    // seed the cache manually via get
    // check _state after invalidate
    mgr.invalidate()
    const { cache, cachedAt } = mgr._state()
    expect(cache).toBeNull()
    expect(cachedAt).toBe(0)
  })

  // ── empty_pool_critical → immediate invalidation ──────────────────────────

  test('empty_pool_critical=true → cachedAt is reset to 0 (cache never serves stale critical state)', async () => {
    const criticalSnap = makeSnapshot({ empty_pool_critical: true, working: [] })
    const criticalFetch = vi.fn().mockResolvedValue(criticalSnap)
    const mgr = buildProxyCacheManager({ ttlMs: 15_000, now: clock.now })

    await mgr.get(criticalFetch)

    // Even though < 15s have passed, next get() must fetch again
    clock.advance(1_000)
    await mgr.get(criticalFetch)
    expect(criticalFetch).toHaveBeenCalledTimes(2)
  })

  test('empty_pool_critical=false → normal TTL applies', async () => {
    const normalSnap = makeSnapshot({ empty_pool_critical: false })
    const normalFetch = vi.fn().mockResolvedValue(normalSnap)
    const mgr = buildProxyCacheManager({ ttlMs: 15_000, now: clock.now })

    await mgr.get(normalFetch)
    clock.advance(5_000)
    await mgr.get(normalFetch)

    expect(normalFetch).toHaveBeenCalledTimes(1) // still fresh
  })

  // ── BFF request rate ───────────────────────────────────────────────────────

  test('BFF calls relay at most 1× per 15s window (no burst within TTL)', async () => {
    const mgr = buildProxyCacheManager({ ttlMs: 15_000, now: clock.now })

    // Simulate 10 concurrent UI polls within 15s
    for (let i = 0; i < 10; i++) {
      clock.advance(1_000)
      await mgr.get(fetchFn)
    }

    // Only the very first call should have hit the relay
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

// ── UI polling interval constant ──────────────────────────────────────────────

describe('Mailboxes UI HEALTH_REFRESH_MS', () => {
  test('constant value in mailboxes/helpers.js is 15 000 ms', async () => {
    // Read the source file and extract the constant to catch accidental regressions.
    // Relocated from Mailboxes.jsx to components/mailboxes/helpers.js (Mailboxes.jsx
    // now imports it); read it from its canonical home.
    const fs = await import('fs/promises')
    const path = await import('path')
    const srcPath = path.resolve(__dirname, '../../../src/components/mailboxes/helpers.js')
    const src = await fs.readFile(srcPath, 'utf8')
    const match = src.match(/HEALTH_REFRESH_MS\s*=\s*(\d[\d_]*)/)
    expect(match).not.toBeNull()
    // Normalise numeric separators
    const value = Number(match[1].replace(/_/g, ''))
    expect(value).toBe(15_000)
  })
})
