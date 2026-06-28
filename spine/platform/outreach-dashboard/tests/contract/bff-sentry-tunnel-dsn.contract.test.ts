// ═══════════════════════════════════════════════════════════════════════════
//  S-H1 — /sentry-tunnel DSN strict parsing (anti-SSRF)
//
//  Pre-fix shape (features/platform/outreach-dashboard/server.js:163-183):
//    if (!dsn.includes('@sentry.io')) reject
//    const projectId = dsn.split('/').at(-1)
//    fetch(`https://sentry.io/api/${projectId}/envelope/`)
//
//  Bugs:
//   1. Substring match — `https://x@sentry.io.evil.tld/123` passes the
//      includes() check, then we'd proxy to `sentry.io/api/123/envelope/`
//      (lucky), but the DSN parser was loose — see #2.
//   2. `dsn.split('/').at(-1)` returned anything after the last slash.
//      A DSN like `https://x@sentry.io/api/0/store?evil` → projectId =
//      "0/store?evil" interpolated raw → upstream URL becomes
//      `https://sentry.io/api/0/store?evil/envelope/` — open path-injection
//      onto arbitrary sentry.io/api/* endpoints (e.g. organisation API).
//
//  Post-fix uses `new URL()` parse + strict host equality + projectId regex.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

vi.mock('pg', () => {
  class Pool {
    async query() { return { rows: [], rowCount: 0 } }
    async connect() {
      const self = this
      return {
        async query(s, p) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(typeof s === 'string' ? s : '')) return { rows: [], rowCount: 0 }
          return self.query(s, p)
        },
        release() {},
      }
    }
        on() {} end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let parseSentryDSN: (dsn: unknown) => { host: string; projectId: string } | null
let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

const fetchCalls: Array<{ url: string; init?: RequestInit }> = []

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'UNSUBSCRIBE_SECRET', 'SENTRY_DSN_BFF']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.UNSUBSCRIBE_SECRET = 'test-unsub-secret'
  // Critical: must be set BEFORE import to register the route.
  process.env.SENTRY_DSN_BFF = 'https://abc@o123.ingest.sentry.io/456'

  // Stub fetch only for upstream sentry.io calls. Test-local requests
  // (the test fetching its own /sentry-tunnel) MUST pass through to the
  // running Express server.
  const realFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : (url as URL).toString()
    if (/^https:\/\/[^/]*sentry\.io\//.test(urlStr)) {
      fetchCalls.push({ url: urlStr, init })
      return new Response('', { status: 200 })
    }
    return realFetch(url as Parameters<typeof realFetch>[0], init)
  }) as typeof fetch

  vi.resetModules()
  const mod = await import('../../server.js')
  parseSentryDSN = mod.parseSentryDSN as typeof parseSentryDSN
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  fetchCalls.length = 0
})

// ─── parseSentryDSN unit cases ───────────────────────────────────────

describe('parseSentryDSN — strict shape', () => {
  it('1: valid sentry.io DSN parses', () => {
    const out = parseSentryDSN('https://abc@sentry.io/456')
    expect(out).toEqual({ host: 'sentry.io', projectId: '456' })
  })

  it('2: valid o<n>.ingest.sentry.io DSN parses', () => {
    const out = parseSentryDSN('https://abc@o12345.ingest.sentry.io/789')
    expect(out).toEqual({ host: 'o12345.ingest.sentry.io', projectId: '789' })
  })

  it('3: ATTACK — sentry.io substring trick rejected', () => {
    expect(parseSentryDSN('https://abc@sentry.io.evil.tld/456')).toBeNull()
    expect(parseSentryDSN('https://abc@evilsentry.io/456')).toBeNull()
    expect(parseSentryDSN('https://abc@notsentry.io/456')).toBeNull()
  })

  it('4: HTTP downgrade rejected (must be HTTPS)', () => {
    expect(parseSentryDSN('http://abc@sentry.io/456')).toBeNull()
  })

  it('5: Query string in DSN is ignored (URL.pathname strips it)', () => {
    // URL parsing correctly separates pathname from query, so ?evil is not
    // part of the path. This DSN is valid.
    const out = parseSentryDSN('https://abc@sentry.io/456?evil')
    expect(out).toEqual({ host: 'sentry.io', projectId: '456' })
  })

  it('6: ATTACK — multi-segment path rejected (only /projectId allowed)', () => {
    expect(parseSentryDSN('https://abc@sentry.io/api/0/store')).toBeNull()
    expect(parseSentryDSN('https://abc@sentry.io/1/2/3')).toBeNull()
  })

  it('7: Non-numeric projectId rejected', () => {
    expect(parseSentryDSN('https://abc@sentry.io/abc')).toBeNull()
    expect(parseSentryDSN('https://abc@sentry.io/456abc')).toBeNull()
  })

  it('8: Empty DSN rejected', () => {
    expect(parseSentryDSN('')).toBeNull()
    expect(parseSentryDSN(null)).toBeNull()
    expect(parseSentryDSN(undefined)).toBeNull()
  })

  it('9: Non-string types rejected', () => {
    expect(parseSentryDSN(123 as unknown)).toBeNull()
    expect(parseSentryDSN({} as unknown)).toBeNull()
  })

  it('10: Case-insensitive hostname check', () => {
    const out = parseSentryDSN('https://abc@SENTRY.IO/456')
    expect(out).toEqual({ host: 'sentry.io', projectId: '456' })
  })

  it('11: Subdomain on ingest.sentry.io case-insensitive', () => {
    const out = parseSentryDSN('https://abc@O12345.INGEST.SENTRY.IO/789')
    expect(out).toEqual({ host: 'o12345.ingest.sentry.io', projectId: '789' })
  })

  it('12: Multiple subdomains on ingest.sentry.io allowed (endsWith check)', () => {
    // The check is `host.endsWith('.ingest.sentry.io')`, so foo.o12345.ingest.sentry.io
    // technically passes. In practice, Sentry SDKs only issue o<n>.ingest.sentry.io,
    // but the parser accepts any *.ingest.sentry.io. This is acceptable because:
    // 1. All such hosts still point to Sentry's infrastructure
    // 2. An attacker cannot inject arbitrary paths (regex ^\\d+$ on projectId)
    const out = parseSentryDSN('https://abc@foo.o12345.ingest.sentry.io/789')
    expect(out).toEqual({ host: 'foo.o12345.ingest.sentry.io', projectId: '789' })
  })
})

// ─── /sentry-tunnel integration tests ────────────────────────────────

describe('POST /sentry-tunnel', () => {
  it('13: valid request to sentry.io succeeds', async () => {
    const envelope = JSON.stringify({ dsn: 'https://abc@sentry.io/456' }) + '\n' + JSON.stringify({})
    const res = await fetch(`${baseUrl}/sentry-tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: envelope,
    })
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://sentry.io/api/456/envelope/')
  })

  it('14: org-scoped DSN (o<n>.ingest.sentry.io) proxies with correct host', async () => {
    const envelope = JSON.stringify({ dsn: 'https://abc@o12345.ingest.sentry.io/789' }) + '\n' + JSON.stringify({})
    const res = await fetch(`${baseUrl}/sentry-tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: envelope,
    })
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://o12345.ingest.sentry.io/api/789/envelope/')
  })

  it('15: invalid DSN rejected with 400', async () => {
    const envelope = JSON.stringify({ dsn: 'https://x@sentry.io.evil.tld/456' }) + '\n' + JSON.stringify({})
    const res = await fetch(`${baseUrl}/sentry-tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: envelope,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid dsn' })
    expect(fetchCalls).toHaveLength(0) // no upstream call
  })

  it('16: malformed envelope (not JSON) returns 200 (fail-closed)', async () => {
    const envelope = 'not json at all\n'
    const res = await fetch(`${baseUrl}/sentry-tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: envelope,
    })
    expect(res.status).toBe(200) // never block on parse failure
  })
})
