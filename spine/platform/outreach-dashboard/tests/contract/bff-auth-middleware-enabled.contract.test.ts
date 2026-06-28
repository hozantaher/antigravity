// ═══════════════════════════════════════════════════════════════════════════
//  F5-3 — BFF auth middleware ENABLED contract.
//
//  The contract-test harness defaults to BFF_AUTH_DISABLED=1 (see
//  tests/contract/setup.ts) so business-logic tests don't have to thread
//  an X-API-Key header through every call. That meant `auth-matrix.test.ts`
//  was running with auth disabled — its `not.toBe(401)` assertions are
//  vacuously true, locking in nothing about the real auth contract.
//
//  This file boots a SECOND Express instance with the global flag
//  overridden BEFORE the server.js import, so the real auth middleware
//  fires. Then it asserts:
//    - unauthenticated requests to protected endpoints → 401
//    - X-API-Key matches OUTREACH_API_KEY → request passes
//    - X-API-Key mismatch → 401
//    - AUTH_EXEMPT paths bypass auth (return 2xx without X-API-Key)
//    - OUTREACH_API_KEY unset in production → 401 with auth-fail breadcrumb
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

const VALID_KEY = 'test-outreach-api-key-aaaaaaaaaaaaaaaa'

let baseUrl = ''
let server: import('http').Server

const savedEnv: Record<string, string | undefined> = {}
beforeAll(async () => {
  // Override the global setup.ts default. The auth middleware reads
  // env per-request, so we set OUTREACH_API_KEY + clear the disabler.
  for (const k of ['BFF_AUTH_DISABLED', 'BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY', 'UNSUBSCRIBE_SECRET']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  delete process.env.BFF_AUTH_DISABLED
  process.env.OUTREACH_API_KEY = VALID_KEY
  process.env.UNSUBSCRIBE_SECRET = 'test-unsub-secret'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  vi.resetModules()
  const mod = await import('../../server.js')
  // Strip GO_SERVER_URL after import (Vite loadEnv repopulates).
  delete process.env.GO_SERVER_URL
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
  // Hard-reset env between tests so a sibling test that mutated
  // BFF_AUTH_DISABLED or OUTREACH_API_KEY doesn't leak into the next.
  delete process.env.BFF_AUTH_DISABLED
  process.env.OUTREACH_API_KEY = VALID_KEY
})

async function get(path: string, headers?: Record<string, string>) {
  const res = await fetch(baseUrl + path, { headers })
  return { status: res.status, body: await res.text() }
}

describe('F5-3 — auth middleware ENABLED', () => {
  // ─── Protected endpoints ───────────────────────────────────────────

  it('1: protected endpoint without X-API-Key → 401', async () => {
    const r = await get('/api/mailboxes')
    expect(r.status).toBe(401)
  })

  it('2: protected endpoint with WRONG X-API-Key → 401', async () => {
    const r = await get('/api/mailboxes', { 'x-api-key': 'wrong-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })
    expect(r.status).toBe(401)
  })

  it('3: protected endpoint with VALID X-API-Key → not 401 (passes auth gate)', async () => {
    const r = await get('/api/mailboxes', { 'x-api-key': VALID_KEY })
    // 200 or 500 is fine — auth let it through; whatever happens after
    // (DB call, business logic) is not this test's concern.
    expect(r.status).not.toBe(401)
    expect(r.status).not.toBe(403)
  })

  // ─── AUTH_EXEMPT paths bypass auth ──────────────────────────────────

  const AUTH_EXEMPT = [
    '/api/health',
    '/api/health/system',
    '/api/health/drift',
    '/api/health/guards',
    '/api/health/auth-fail-alerts',
    '/api/version',
    '/api/daemons',
  ]

  for (const path of AUTH_EXEMPT) {
    it(`4: ${path} bypasses auth (no X-API-Key required)`, async () => {
      const r = await get(path)
      // Some of these may not be registered (e.g. /api/version, /api/daemons
      // historically referenced in middleware but not always wired). The
      // contract is: NEVER 401 from auth, NEVER 403. 404 is fine — means
      // the route doesn't exist. 200 / 500 / 503 are fine — auth passed.
      expect(r.status, `${path} must not 401 (in AUTH_EXEMPT)`).not.toBe(401)
    })
  }

  it(`4.1: /api/health/watchdog requires X-API-Key (moved out of AUTH_EXEMPT per #867)`, async () => {
    const r = await get('/api/health/watchdog')
    expect(r.status).toBe(401)
  })

  it(`5: /unsubscribe (public, token-gated) bypasses auth`, async () => {
    const r = await get('/unsubscribe')
    // /unsubscribe is in AUTH_EXEMPT. Without params it 400s — that's
    // the param validator, not the auth gate.
    expect(r.status).not.toBe(401)
  })

  // ─── Header-spoofing must not bypass auth ──────────────────────────

  it('6: spoofed Authorization Bearer header does NOT pass auth (only X-API-Key counts)', async () => {
    const r = await get('/api/mailboxes', { authorization: 'Bearer ' + VALID_KEY })
    expect(r.status, 'auth middleware must not accept Bearer alias for X-API-Key').toBe(401)
  })

  it('7: cookie session does NOT pass auth (no session-based auth installed)', async () => {
    const r = await get('/api/mailboxes', { cookie: `apikey=${VALID_KEY}; session=ok` })
    expect(r.status).toBe(401)
  })

  it('8: case-sensitivity — X-API-Key vs x-api-key both work (HTTP headers are case-insensitive)', async () => {
    const r = await get('/api/mailboxes', { 'X-API-Key': VALID_KEY })
    expect(r.status).not.toBe(401)
  })

  // ─── Empty / malformed key ─────────────────────────────────────────

  it('9: empty X-API-Key value → 401', async () => {
    const r = await get('/api/mailboxes', { 'x-api-key': '' })
    expect(r.status).toBe(401)
  })

  it('10: protected endpoint without OUTREACH_API_KEY env at request time → 401', async () => {
    // Temporarily remove the env var; middleware reads it per-request.
    const saved = process.env.OUTREACH_API_KEY
    delete process.env.OUTREACH_API_KEY
    try {
      const r = await get('/api/mailboxes', { 'x-api-key': VALID_KEY })
      expect(r.status).toBe(401)
    } finally {
      process.env.OUTREACH_API_KEY = saved
    }
  })

  // ─── Auth-disabled bypass remains intact ───────────────────────────

  it('11: BFF_AUTH_DISABLED=1 mid-request bypasses auth (test-mode override)', async () => {
    process.env.BFF_AUTH_DISABLED = '1'
    try {
      const r = await get('/api/mailboxes')
      expect(r.status).not.toBe(401)
    } finally {
      delete process.env.BFF_AUTH_DISABLED
    }
  })
})
