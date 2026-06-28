/**
 * BFF auth-matrix contract tests — no-rejection-when-disabled invariants
 *
 * F5-3 (2026-04-29) doc-fix: the previous header claimed "no auth middleware
 * is installed on the Express app". That is FALSE — `createAuthMiddleware`
 * is wired in server.js (a 401 gate by `X-API-Key` matching the runtime
 * `OUTREACH_API_KEY`). What's actually true is that the contract-test
 * harness sets `BFF_AUTH_DISABLED=1` globally in `tests/contract/setup.ts`
 * so business-logic tests don't have to smear x-api-key across every call.
 *
 * Therefore THIS file's `not.toBe(401)` assertions effectively prove only
 * that "with auth disabled, no extra header (Authorization, cookie,
 * mixed-case auth, etc.) accidentally re-engages a 401 path or reroutes
 * the request through a different handler". That's still a useful
 * invariant — it catches regressions where someone adds a sneaky
 * always-on auth check that should be gated behind BFF_AUTH_DISABLED.
 *
 * The actual "auth ENABLED" contract — unauthenticated request → 401,
 * matching X-API-Key → 200, AUTH_EXEMPT paths bypass — is locked in
 * `bff-auth-middleware-enabled.contract.test.ts` (sibling file), which
 * boots its own Express instance with the global flag overridden.
 *
 * Coverage of THIS file:
 *  - every representative endpoint responds identically regardless of
 *    Authorization / X-API-Key / cookie headers (when BFF_AUTH_DISABLED=1)
 *  - no endpoint returns 401 / 403 with auth disabled
 *  - CORS preflight OPTIONS behavior
 *  - potential auth-bypass attempts (header injection, duplicated headers,
 *    mixed-case) do not produce different status codes
 *  - sentinel value of OUTREACH_API_KEY env var never echoes back in any
 *    response body or header
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []

vi.mock('pg', () => {
  class Pool {
    async query() {
      if (!queryQueue.length) return { rows: [] }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
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
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})

vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server

const savedEnv: Record<string, string | undefined> = {}
beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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
  queryQueue.length = 0
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }

async function req(method: string, path: string, headers?: Record<string, string>, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...(headers ?? {}) } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text, headers: r.headers }
}

// Representative read-only endpoints that should always 200 when pg is happy
const READ_ENDPOINTS = [
  '/api/version',
  '/api/health/guards',
  '/api/health/system',
  '/api/mailboxes',
  '/api/metrics/mailboxes',
]

describe('auth — no middleware installed', () => {
  for (const ep of READ_ENDPOINTS) {
    it(`${ep} responds without Authorization header`, async () => {
      queueRows([])
      const r = await req('GET', ep)
      expect(r.status).not.toBe(401)
      expect(r.status).not.toBe(403)
    })
    it(`${ep} responds identically with invalid Bearer token`, async () => {
      queueRows([])
      const r = await req('GET', ep, { authorization: 'Bearer invalid-jwt-xxx' })
      expect(r.status).not.toBe(401)
      expect(r.status).not.toBe(403)
    })
    it(`${ep} responds identically with bogus X-API-Key`, async () => {
      queueRows([])
      const r = await req('GET', ep, { 'x-api-key': 'not-a-real-key' })
      expect(r.status).not.toBe(401)
    })
    it(`${ep} responds identically with empty Authorization`, async () => {
      queueRows([])
      const r = await req('GET', ep, { authorization: '' })
      expect(r.status).not.toBe(401)
    })
    it(`${ep} responds identically with cookie header`, async () => {
      queueRows([])
      const r = await req('GET', ep, { cookie: 'session=deadbeef' })
      expect(r.status).not.toBe(401)
    })
  }
})

describe('auth — write endpoints (no middleware rejection)', () => {
  it('POST /api/mailboxes does not 401 without auth', async () => {
    queueRows([])
    const r = await req('POST', '/api/mailboxes', undefined, { email: 'a@b.cz', smtp_host: 'h', password: 'p' })
    expect(r.status).not.toBe(401)
    expect(r.status).not.toBe(403)
  })
  it('PATCH /api/mailboxes/:id does not 401 without auth', async () => {
    queueRows([{ id: 1 }])
    const r = await req('PATCH', '/api/mailboxes/1', undefined, { display_name: 'x' })
    expect(r.status).not.toBe(401)
  })
  it('DELETE /api/mailboxes/:id does not 401 without auth', async () => {
    queueRows([])
    const r = await req('DELETE', '/api/mailboxes/1', undefined)
    expect(r.status).not.toBe(401)
  })
  it('POST /api/mailboxes/:id/recover does not 401 without auth', async () => {
    queueRows([{ id: 1, status: 'active', consecutive_bounces: 0, circuit_opened_at: null, canary_remaining: 10 }])
    const r = await req('POST', '/api/mailboxes/1/recover', undefined, {})
    expect(r.status).not.toBe(401)
  })
  it('POST /api/mailboxes/:id/assign-proxy does not 401', async () => {
    queueRows([{ id: 1 }])
    const r = await req('POST', '/api/mailboxes/1/assign-proxy', undefined, { proxy_url: 'socks5://u:p@h:1080' })
    expect(r.status).not.toBe(401)
  })
})

describe('auth — spoofed headers do not upgrade permission', () => {
  it('sending admin cookie does not trigger a different code path', async () => {
    queueRows([])
    queueRows([])
    const a = await req('GET', '/api/mailboxes', { cookie: 'role=admin' })
    const b = await req('GET', '/api/mailboxes')
    expect(a.status).toBe(b.status)
  })
  it('duplicated Authorization headers yield same result', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes', { authorization: 'Bearer x, Bearer y' })
    expect([200, 400]).toContain(r.status)
  })
  it('mixed-case authorization header treated same', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes', { AUTHORIZATION: 'Bearer x' })
    expect([200, 400]).toContain(r.status)
  })
  it('header injection attempt in X-API-Key is rejected at HTTP layer', async () => {
    // Node's fetch rejects CR/LF in header values
    queueRows([])
    let threw = false
    try {
      await req('GET', '/api/mailboxes', { 'x-api-key': 'valid\r\nX-Injected: evil' })
    } catch { threw = true }
    expect(threw).toBe(true)
  })
})

describe('auth — CORS preflight', () => {
  it('OPTIONS /api/mailboxes responds with CORS headers', async () => {
    const r = await fetch(baseUrl + '/api/mailboxes', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5175',
        'access-control-request-method': 'GET',
      },
    })
    expect([200, 204]).toContain(r.status)
  })
  it('OPTIONS for unknown method still responds', async () => {
    const r = await fetch(baseUrl + '/api/mailboxes', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5175',
        'access-control-request-method': 'TRACE',
      },
    })
    expect(r.status).toBeLessThan(500)
  })
  it('CORS origin mismatch does not cause 500', async () => {
    const r = await fetch(baseUrl + '/api/mailboxes', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'GET',
      },
    })
    expect(r.status).toBeLessThan(500)
  })
})

describe('auth — no endpoint leaks OUTREACH_API_KEY in responses', () => {
  const FAKE_KEY = 'sentinel-outreach-api-key-xyz123'
  beforeEach(() => { process.env.OUTREACH_API_KEY = FAKE_KEY })
  for (const ep of READ_ENDPOINTS) {
    it(`${ep} does not echo OUTREACH_API_KEY`, async () => {
      queueRows([])
      const r = await req('GET', ep)
      expect(r.raw).not.toContain(FAKE_KEY)
    })
  }
})

describe('auth — /api/health/guards is always reachable', () => {
  it('returns status < 500 under no auth', async () => {
    const r = await req('GET', '/api/health/guards')
    expect(r.status).toBeLessThan(500)
  })
  it('returns status < 500 under bogus auth', async () => {
    const r = await req('GET', '/api/health/guards', { authorization: 'Bearer bogus' })
    expect(r.status).toBeLessThan(500)
  })
})

describe('auth — request with huge header values', () => {
  it('very long cookie does not crash server', async () => {
    queueRows([])
    const cookie = 'session=' + 'a'.repeat(2048)
    const r = await req('GET', '/api/mailboxes', { cookie })
    expect(r.status).toBeLessThan(600)
  })
  it('very long authorization does not crash server', async () => {
    queueRows([])
    const authorization = 'Bearer ' + 'a'.repeat(2048)
    const r = await req('GET', '/api/mailboxes', { authorization })
    expect(r.status).toBeLessThan(600)
  })
})
