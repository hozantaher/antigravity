// S9 — Proxy pool exhaustion watchdog.
//
// When the relay's working-proxy count drops below MIN_WORKING_PROXIES (3),
// this module calls POST /v1/admin/refresh-pool on the relay to trigger an
// immediate re-fetch+probe cycle. This closes the gap between the relay's
// 15-min background ticker and a sudden pool collapse (e.g. all proxies
// blocked mid-cycle).
//
// Pure factory — callers inject `relayProxyPool` and `fetch` so the function
// is fully testable without a DB or network.

export const MIN_WORKING_PROXIES = 3

/**
 * Build a `checkProxyPoolHealth` function bound to the given dependencies.
 *
 * @param {object} deps
 * @param {(pool: any) => Promise<any>}  deps.relayProxyPool - relay proxy pool snapshot getter
 * @param {any}                          deps.pool           - pg pool (passed through to relayProxyPool)
 * @param {() => string|null}            deps.getRelayBase   - resolves the relay base URL (no trailing slash)
 * @param {() => string|null}            deps.getRelayToken  - resolves the admin bearer token
 * @param {typeof globalThis.fetch}      [deps.fetchFn]      - injectable fetch (defaults to globalThis.fetch)
 * @returns {() => Promise<void>}
 */
export function makeProxyWatchdog({ relayProxyPool, pool, getRelayBase, getRelayToken, fetchFn = globalThis.fetch }) {
  return async function checkProxyPoolHealth() {
    try {
      const snap = await relayProxyPool(pool)
      if (!snap.error && (snap.working?.length ?? 0) < MIN_WORKING_PROXIES) {
        console.log(`[proxy-watchdog] pool low (${snap.working?.length ?? 0} proxies) — triggering relay refresh`)
        const base = getRelayBase()
        const token = getRelayToken()
        if (base && token) {
          await fetchFn(`${base}/v1/admin/refresh-pool`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          }).catch(e => console.warn('[proxy-watchdog] refresh call failed:', e.message))
        } else {
          console.warn('[proxy-watchdog] relay base/token not configured — skipping refresh call')
        }
      }
    } catch (e) {
      console.error('[proxy-watchdog] health check error:', e.message)
    }
  }
}
