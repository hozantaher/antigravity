// ═══════════════════════════════════════════════════════════════════════════
//  no-prod-egress — global test guard: tests MUST NOT touch production.
//
//  Runs FIRST in every vitest scope (default / contract / integration / all).
//  It makes reaching production structurally impossible, not merely unlikely.
//
//  WHY THIS EXISTS (incident 2026-06-25):
//    The local `.env` points GO_SERVER_URL + OUTREACH_API_KEY + DATABASE_URL at
//    PROD (machinery-outreach-production / junction.proxy.rlwy.net). A contract
//    test (bff-monkey-input) mocked `pg` but NOT `fetch`, and never stripped
//    GO_SERVER_URL — so `POST /api/campaigns` with a valid name was forwarded by
//    the BFF to the REAL prod Go service, which created the campaign in prod.
//    The mocked readback hid the side effect, so the test passed GREEN while
//    leaking. Result: 16 junk campaigns ('test', 'x'*10000) in prod.
//    The prior mitigation (delete GO_SERVER_URL in tests/contract/setup.ts) (a)
//    only ran in `contract` scope, not `all`, and (b) "didn't stick" because the
//    value was re-applied from .env on `server.js` import.
//
//  TWO LAYERS OF DEFENSE:
//    1. Neutralize prod-pointing env. server.js reads GO_SERVER_URL at REQUEST
//       time, so a beforeEach re-scrub guarantees the value is safe at the moment
//       any handler runs — independent of import-time re-application. Empty
//       GO_SERVER_URL makes POST /api/campaigns return 503 (no outbound at all).
//    2. A global fetch guard that THROWS on any non-loopback host, turning a
//       silent prod write into a loud red test failure.
//
//  Tests that legitimately exercise the Go-proxy path must set GO_SERVER_URL to
//  their OWN stub (a loopback/non-prod URL) and stub its fetch — see the
//  contract suites that already do this. A prod-pointing value is never allowed.
//
//  Enforced by tests/audit/no-prod-egress.test.js — do not weaken without
//  updating the ratchet (and never to unblock a leak; fix the test instead).
// ═══════════════════════════════════════════════════════════════════════════

import { beforeEach } from 'vitest'

// Any env value matching one of these is a production / external endpoint and
// must never be live during tests.
export const PROD_HOST_PATTERNS = [
  /rlwy\.net/i, // Railway TCP proxy (Postgres)
  /railway\.app/i, // Railway HTTP (Go orchestrator, relay)
  /neon\.tech/i,
  /supabase\.(co|in)/i,
  /seznam\.cz/i, // SMTP/IMAP
  /\bemail\.cz/i,
  /\bgmail\.com/i,
  /\.up\.railway\.app/i,
]

// Safe replacements. Empty GO_SERVER_URL → create path returns 503 (no fetch).
// Loopback:1 DATABASE_URL → any un-mocked pg.Pool fails fast on connect rather
// than ever reaching prod. Relay URLs to loopback:1 for the same reason.
export const SAFE_ENV = {
  GO_SERVER_URL: '',
  // Empty (not a loopback stub) so DB-audit tests that `if (!DATABASE_URL) skip`
  // skip gracefully instead of trying to connect. Prod Postgres is reachable
  // ONLY via the rlwy.net DSN, which the host-pattern scrub neutralizes — so
  // empty here still guarantees no prod DB access.
  DATABASE_URL: '',
  OUTREACH_API_KEY: 'test-key-not-prod',
  // Empty, not a stub URL: code gates behaviour on whether a relay is configured
  // (e.g. campaignPreflight's relayConfigured), so a non-empty value would flip
  // that and diverge from the no-.env baseline. Prod relay URLs (*.up.railway.app)
  // are caught by the host-pattern scrub + fetch guard regardless. Tests needing a
  // relay set their own ANTI_TRACE_RELAY_URL_OVERRIDE stub.
  ANTI_TRACE_RELAY_URL: '',
  ANTI_TRACE_URL: '',
  ANTI_TRACE_RELAY_URL_OVERRIDE: '',
}

// Hard-reset every managed var to a safe stub. Module-eval ONLY (before any
// test imports server.js) — establishes a safe initial process state.
export function applySafeEnv() {
  for (const [k, v] of Object.entries(SAFE_ENV)) process.env[k] = v
}

// Scrub ONLY values that point at a prod/external host. Safe in beforeEach: it
// neutralizes vite's import-time re-application of the prod .env (prod URLs match
// the patterns → reset) WITHOUT clobbering a test's own stubs (e.g.
// 'https://relay.test', 'test-api-key', 'http://go-stub.local'), which tests set
// in their beforeAll and rely on for the whole file.
export function scrubProdEnv() {
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && PROD_HOST_PATTERNS.some((re) => re.test(v))) {
      process.env[k] = k in SAFE_ENV ? SAFE_ENV[k] : ''
    }
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', ''])

export function hostOf(input) {
  try {
    let url
    if (typeof input === 'string') url = input
    else if (input instanceof URL) url = input.href
    else if (input && typeof input.url === 'string') url = input.url // Request
    else return null
    if (!url) return null
    if (url.startsWith('/')) return 'localhost' // relative → same origin (MSW)
    return new URL(url).hostname
  } catch {
    return null
  }
}

// Install a fetch guard that blocks egress to any non-loopback host. Tests only
// ever talk to their own in-process server (127.0.0.1) or MSW-mocked relative
// paths; a real outbound is always a bug. Returns true if installed.
export function installFetchGuard() {
  const realFetch = globalThis.fetch
  if (typeof realFetch !== 'function' || realFetch.__noProdGuard) return false
  const guarded = function noProdEgressFetch(input, init) {
    const host = hostOf(input)
    if (host && !LOOPBACK.has(host)) {
      const target = typeof input === 'string' ? input : input?.url ?? String(input)
      // Reject (not sync-throw) to match real fetch semantics: network failures
      // surface as a rejected promise, so `await`/`.catch()` callers handle it.
      return Promise.reject(
        new Error(
          `[no-prod-egress] BLOCKED outbound fetch to "${host}" (${target}). ` +
            'Tests must not touch prod/external hosts — mock it (vi.mock / MSW) ' +
            'or point GO_SERVER_URL at a 127.0.0.1 stub.',
        ),
      )
    }
    return realFetch.call(this, input, init)
  }
  guarded.__noProdGuard = true
  globalThis.fetch = guarded
  return true
}

// Apply immediately at setup-file eval (runs before any test module import).
applySafeEnv()
scrubProdEnv()
installFetchGuard()

// Re-scrub before every test: server.js reads GO_SERVER_URL per-request, so this
// guarantees the value is safe at the moment any handler executes, even if vite
// re-applied .env when the test imported server.js in beforeAll.
beforeEach(() => {
  scrubProdEnv()
})
