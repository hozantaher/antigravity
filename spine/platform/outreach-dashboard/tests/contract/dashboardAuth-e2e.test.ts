// dashboardAuth-e2e.test.ts — AW-F1 (2026-05-20)
//
// End-to-end contract test for the dashboard Basic Auth gate against
// the actual Express app booted in BFF_IMPORT_ONLY mode. Verifies the
// middleware is wired correctly and honors every documented escape
// hatch.
//
// Why a contract test in addition to the unit suite: the unit test
// exercises requireDashboardAuth() in isolation. This one proves the
// middleware is mounted on the right `app.use(...)` chain, before the
// X-API-Key middleware, and that the bypass list survives the boot-time
// route mount order. That assembly is exactly where the "is the auth
// disabled by accident?" bugs hide.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
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
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

const VALID_USER = 'operator'
const VALID_PASS = 'super-secret-test-password-aaaaaaaa1'
let VALID_HASH = ''

let baseUrl = ''
let server: import('http').Server

const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of [
    'BFF_AUTH_DISABLED', 'BFF_IMPORT_ONLY', 'DATABASE_URL',
    'OUTREACH_API_KEY', 'UNSUBSCRIBE_SECRET',
    'DASHBOARD_AUTH_ENABLED', 'DASHBOARD_USER', 'DASHBOARD_PASS_HASH',
  ]) {
    savedEnv[k] = process.env[k]
  }
  // bcrypt cost 4 for test speed; production uses 12. Server compares
  // against whatever hash is provided, so cost-4 still validates the path.
  VALID_HASH = bcrypt.hashSync(VALID_PASS, 4)

  process.env.BFF_IMPORT_ONLY = '1'
  process.env.OUTREACH_API_KEY = 'test-api-key'
  process.env.UNSUBSCRIBE_SECRET = 'test-unsub-secret'
  process.env.DATABASE_URL = 'postgres://stub/stub'

  vi.resetModules()
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
  // Reset env to a known per-test starting point. Each test overrides
  // exactly what it needs. Default = AUTH ENABLED + good creds; tests
  // that need disabled or missing creds adjust below.
  delete process.env.BFF_AUTH_DISABLED
  process.env.DASHBOARD_AUTH_ENABLED = 'true'
  process.env.DASHBOARD_USER = VALID_USER
  process.env.DASHBOARD_PASS_HASH = VALID_HASH
  // Set here (not just beforeAll): the no-prod-egress guard / vite re-apply the
  // real .env on server.js import, which would clobber a beforeAll value and
  // make the X-API-Key inner gate 401 on 'test-api-key'. beforeEach survives it.
  process.env.OUTREACH_API_KEY = 'test-api-key'
})

function basicHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
}

async function req(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; wwwAuth: string | null }> {
  const res = await fetch(baseUrl + path, { headers })
  return {
    status: res.status,
    body: await res.text(),
    wwwAuth: res.headers.get('www-authenticate'),
  }
}

// Use the X-API-Key for the inner gate so we isolate dashboardAuth in
// these assertions — otherwise wrong creds + no api key both 401 and
// it's ambiguous which gate fired. We bypass X-API-Key with
// BFF_AUTH_DISABLED at the bypass-path test.
const TARGET = '/api/replies/stats'

describe('AW-F1 dashboardAuth e2e contract', () => {
  it('GET protected route WITHOUT Authorization → 401 + WWW-Authenticate', async () => {
    const r = await req(TARGET, { 'x-api-key': 'test-api-key' })
    expect(r.status, 'must 401 when no Basic header sent').toBe(401)
    expect(r.wwwAuth, 'WWW-Authenticate challenge present').toContain('Basic')
    expect(r.wwwAuth).toContain('Hozan Taher Dashboard')
  })

  it('GET protected route with WRONG password → 401', async () => {
    const r = await req(TARGET, {
      'x-api-key': 'test-api-key',
      authorization: basicHeader(VALID_USER, 'wrong-password'),
    })
    expect(r.status).toBe(401)
  })

  it('GET protected route with WRONG username → 401', async () => {
    const r = await req(TARGET, {
      'x-api-key': 'test-api-key',
      authorization: basicHeader('wronguser', VALID_PASS),
    })
    expect(r.status).toBe(401)
  })

  it('GET protected route with CORRECT credentials → not 401 (auth passes)', async () => {
    const r = await req(TARGET, {
      'x-api-key': 'test-api-key',
      authorization: basicHeader(VALID_USER, VALID_PASS),
    })
    // Auth passes; the downstream route may 200/500 depending on DB
    // mock state. We only assert auth did not reject.
    expect(r.status, `expected non-401 with valid creds, got ${r.status}`).not.toBe(401)
  })

  it('BFF_AUTH_DISABLED=1 → no 401 even with no Authorization (test bypass)', async () => {
    process.env.BFF_AUTH_DISABLED = '1'
    const r = await req(TARGET)
    expect(r.status, 'BFF_AUTH_DISABLED must bypass both Basic + X-API-Key').not.toBe(401)
  })

  it('bypass path /api/health → never 401 even when AUTH_ENABLED + no creds', async () => {
    // No Authorization, no X-API-Key — but /api/health is in the
    // dashboardAuth bypass list AND in createAuthMiddleware AUTH_EXEMPT,
    // so both gates pass.
    const r = await req('/api/health')
    expect(r.status, '/api/health must never 401').not.toBe(401)
  })

  it('ENABLED + DASHBOARD_USER/HASH missing → 503 dashboard_auth_misconfigured', async () => {
    delete process.env.DASHBOARD_USER
    delete process.env.DASHBOARD_PASS_HASH
    const r = await req(TARGET, {
      'x-api-key': 'test-api-key',
      authorization: basicHeader(VALID_USER, VALID_PASS),
    })
    expect(r.status).toBe(503)
    expect(r.body).toContain('dashboard_auth_misconfigured')
  })
})
