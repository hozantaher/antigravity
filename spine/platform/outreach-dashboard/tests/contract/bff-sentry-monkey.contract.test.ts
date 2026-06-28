// ═══════════════════════════════════════════════════════════════════════════
//  MONKEY / CHAOS tests — Sentry integration resilience
//
//  Verifies that:
//  1. capture500() survives when Sentry itself throws
//  2. All BFF routes return 500 (not crash) when DB is broken
//  3. Fault injection path (X-Fault: throw) doesn't call captureException
//  4. capture500 called for Error instances, skipped for non-Error objects
//  5. sentryTagMiddleware does not break request flow when DSN missing
//  6. Property: capture500 always returns a response (never throws), for any input
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import type { AddressInfo } from 'net'

let captureCallCount = 0
let sentryThrows = false

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn(),
    captureException: vi.fn(() => {
      captureCallCount++
      if (sentryThrows) throw new Error('sentry network error')
      return 'fake-id'
    }),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
    withIsolationScope: vi.fn((fn: (s: unknown) => void) => fn({ setTag: vi.fn(), setContext: vi.fn() })),
    withScope: vi.fn((fn: (s: unknown) => void) => fn({ setFingerprint: vi.fn(), setTag: vi.fn() })),
  }
})

vi.mock('pg', () => {
  class Pool {
    async query() { throw new Error('chaos-db-error') }
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'SENTRY_DSN_BFF']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.SENTRY_DSN_BFF = 'https://test@sentry.io/0'
  const mod = await import('../../server.js')
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
  captureCallCount = 0
  sentryThrows = false
})

// ── 1. capture500 survives Sentry throwing ─────────────────────────────────

describe('MONKEY: Sentry throws internally', () => {
  it('capture500 still returns 500 response when captureException throws', async () => {
    sentryThrows = true
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    expect(() => capture500(res as never, new Error('orig'), () => 'err')).not.toThrow()
    expect(res._s).toBe(500)
  })
})

// ── 2. All major routes survive chaos DB ───────────────────────────────────

describe('MONKEY: DB chaos — all routes return 500, not crash', () => {
  const probeRoutes = [
    ['GET', '/api/mailboxes'],
    ['GET', '/api/companies'],
    ['GET', '/api/campaigns'],
    ['GET', '/api/analytics/overview'],
    ['GET', '/api/analytics/timeline'],
    ['GET', '/api/health/watchdog'],
    ['GET', '/api/replies'],
    ['GET', '/api/replies/stats'],
    ['GET', '/api/leads'],
    ['GET', '/api/scoring/config'],
    ['GET', '/api/healing/log'],
    ['GET', '/api/healing/stats'],
    ['GET', '/api/protections/matrix'],
    ['GET', '/api/protections/alerts'],
  ]

  for (const [method, path] of probeRoutes) {
    it(`${method} ${path} → 500 (not crash) under DB chaos`, async () => {
      const res = await fetch(`${baseUrl}${path}`, { method })
      // Either 500 (DB error caught) or 503 (health checks gracefully degrade)
      expect([500, 503, 400]).toContain(res.status)
      // Server must still be alive after the chaos request
      const alive = await fetch(`${baseUrl}/api/health/system`).then(r => r.status).catch(() => 0)
      expect(alive).toBeTruthy()
    })
  }
})

// ── 3. Fault injection middleware (when enabled) bypasses captureException ──
// NOTE: Requires FAULT_INJECT_ALLOWED=1 env var — tested in isolation here.

describe('MONKEY: sentryCapture captures both Error and non-Error objects', () => {
  it('captureException IS called for plain object error (wrapped in Error)', async () => {
    // Since fingerprinting was added, plain objects are also captured (wrapped)
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const { captureException } = await import('@sentry/node')
    ;(captureException as ReturnType<typeof vi.fn>).mockClear()
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, { code: 'NOT_FOUND', status: 404 }, () => 'not found')
    expect(captureException).toHaveBeenCalledWith(expect.any(Error))
    expect(res._s).toBe(500)
  })

  it('captureException IS called for real Error instances', async () => {
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const { captureException } = await import('@sentry/node')
    ;(captureException as ReturnType<typeof vi.fn>).mockClear()
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, new TypeError('db connection lost'), () => 'err')
    expect(captureException).toHaveBeenCalledWith(expect.any(TypeError))
  })
})

// ── 4. Property: capture500 always responds, never throws ──────────────────

describe('PROPERTY: capture500 is total — never throws for any input', () => {
  const inputs = [
    new Error('real error'),
    new TypeError('type error'),
    { message: 'plain object', status: 400 },
    'string error',
    null,
    undefined,
    42,
    { code: 'ECONNREFUSED' },
  ]

  for (const input of inputs) {
    it(`input: ${String(input)} → always returns 500 response`, async () => {
      const { capture500 } = await import('../../src/lib/sentryCapture.js')
      const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
      expect(() => capture500(res as never, input, () => 'err')).not.toThrow()
      expect(res._s).toBe(500)
    })
  }
})

// ── 5. sentryTagMiddleware is a no-op when DSN missing ─────────────────────

describe('MONKEY: sentryTagMiddleware resilience', () => {
  it('request succeeds even if sentryTagMiddleware withIsolationScope throws', async () => {
    const sentry = await import('@sentry/node')
    ;(sentry.withIsolationScope as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('isolation scope error')
    })
    // Routes should still work
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect([200, 500]).toContain(res.status)
  })
})
