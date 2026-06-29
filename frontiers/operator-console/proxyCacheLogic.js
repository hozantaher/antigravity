/**
 * proxyCacheLogic.js — Testable proxy-pool BFF cache helpers.
 *
 * Extracted from server.js to enable unit testing of TTL, invalidation,
 * and empty_pool_critical behaviour without spinning up Express + DB.
 *
 * server.js still owns the live `proxyCache`/`proxyCachedAt` variables and
 * calls `buildProxyCacheManager()` to create its instance.
 */

export const PROXY_TTL_MS = 15 * 1000 // 15 s — matches PROXY_TTL in server.js

/**
 * buildProxyCacheManager creates an isolated cache instance suitable for
 * injection in tests or direct use by server.js.
 *
 * @param {object} opts
 * @param {number} [opts.ttlMs=PROXY_TTL_MS] — override TTL for tests
 * @param {() => number} [opts.now=Date.now] — injectable clock for tests
 */
export function buildProxyCacheManager({ ttlMs = PROXY_TTL_MS, now = Date.now } = {}) {
  let cache = null
  let cachedAt = 0

  /** Returns true when the cached value is still fresh. */
  function isFresh() {
    return cache !== null && now() - cachedAt < ttlMs
  }

  /**
   * get — returns the cached snapshot when fresh, otherwise fetches a fresh
   * one via `fetchFn`. If the snapshot has `empty_pool_critical: true` the
   * cache timestamp is zeroed so the next call always fetches.
   *
   * @param {() => Promise<object>} fetchFn — calls the relay /v1/proxy-pool
   */
  async function get(fetchFn) {
    if (isFresh()) return cache
    const snapshot = await fetchFn()
    cache = snapshot
    cachedAt = now()
    // Immediate invalidation on critical empty-pool state.
    if (snapshot && snapshot.empty_pool_critical) {
      cachedAt = 0
    }
    return cache
  }

  /** invalidate resets the cache so the next get() always fetches. */
  function invalidate() {
    cache = null
    cachedAt = 0
  }

  /** Expose internal state for testing purposes only. */
  function _state() {
    return { cache, cachedAt }
  }

  return { get, invalidate, isFresh, _state }
}
