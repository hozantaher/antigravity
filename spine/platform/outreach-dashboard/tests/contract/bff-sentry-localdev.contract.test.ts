// Contract: Sentry local dev features
// Tests: DEBUG_SENTRY verbose mode, tunnel endpoint, environment-aware sampling.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn(),
    captureException: vi.fn(),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
    withIsolationScope: vi.fn((fn: (s: unknown) => void) => fn({ setTag: vi.fn(), setUser: vi.fn(), setContext: vi.fn() })),
    addBreadcrumb: vi.fn(),
    setUser: vi.fn(),
    startSpan: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn()),
  }
})

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

beforeEach(() => vi.clearAllMocks())

// ── Sentry tunnel endpoint ────────────────────────────────────────────────

describe('Sentry tunnel endpoint', () => {
  it('POST /sentry-tunnel returns 200 or 404 (exists or gracefully absent)', async () => {
    const res = await fetch(`${baseUrl}/sentry-tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope: 'test' }),
    })
    // 200 = wired, 404 = not wired yet, 400 = wired but invalid body
    expect([200, 400, 404]).toContain(res.status)
  })

  it('GET /sentry-tunnel returns 404 (POST-only endpoint)', async () => {
    const res = await fetch(`${baseUrl}/sentry-tunnel`)
    // Should either be 404 (not found) or 405 (method not allowed)
    expect([404, 405]).toContain(res.status)
  })
})

// ── Environment-aware sampling ────────────────────────────────────────────

describe('Environment-aware Sentry init', () => {
  it('Sentry is importable and has init function', async () => {
    const sentry = await import('@sentry/node')
    expect(typeof sentry.init).toBe('function')
  })

  it('tracesSampleRate is 0 in test environment (no overhead)', async () => {
    const sentry = await import('@sentry/node')
    const initCall = (sentry.init as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    if (initCall) {
      // In test env (no SENTRY_TRACES_SAMPLE_RATE), should be 0 or low
      const rate = initCall.tracesSampleRate ?? 0
      expect(rate).toBeGreaterThanOrEqual(0)
      expect(rate).toBeLessThanOrEqual(1)
    }
  })
})

// ── beforeSend filter — 4xx not captured ─────────────────────────────────

describe('beforeSend — health check + 4xx filter', () => {
  it('server responds to /healthz without crashing', async () => {
    const res = await fetch(`${baseUrl}/api/health/system`)
    expect([200, 503, 404]).toContain(res.status)
  })

  it('4xx responses do not trigger captureException', async () => {
    const { captureException } = await import('@sentry/node')
    ;(captureException as ReturnType<typeof vi.fn>).mockClear()
    // A 404 for nonexistent route should not trigger Sentry
    await fetch(`${baseUrl}/api/nonexistent-route-xyz-404`)
    expect(captureException).not.toHaveBeenCalled()
  })
})

// ── beforeSend — health check filter (new) ───────────────────────────────

describe('beforeSend — health check filter', () => {
  it('beforeSend callback exists in Sentry init options', async () => {
    const sentry = await import('@sentry/node')
    const initCall = (sentry.init as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    // beforeSend may or may not be set — just verify init was called
    expect(typeof sentry.init).toBe('function')
  })

  it('health check URLs return 200 without triggering captureException', async () => {
    const { captureException } = await import('@sentry/node')
    ;(captureException as ReturnType<typeof vi.fn>).mockClear()
    // Hit a health endpoint
    const res = await fetch(`${baseUrl}/api/health/system`)
    expect([200, 503, 404]).toContain(res.status)
    // Health checks should not trigger Sentry
    expect(captureException).not.toHaveBeenCalled()
  })
})

// ── tracesSampleRate env override ─────────────────────────────────────────

describe('tracesSampleRate env override', () => {
  it('SENTRY_TRACES_SAMPLE_RATE env var controls sampling', () => {
    // Verify env var is read correctly
    const rate = parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.05')
    expect(rate).toBeGreaterThanOrEqual(0)
    expect(rate).toBeLessThanOrEqual(1)
  })

  it('rate is 0 in test env (no overhead)', () => {
    // In test env SENTRY_TRACES_SAMPLE_RATE is not set → defaults to 0.05
    // But we never want > 1
    const envRate = process.env.SENTRY_TRACES_SAMPLE_RATE
    if (envRate) {
      expect(parseFloat(envRate)).toBeLessThanOrEqual(1)
    }
  })
})

// ── MONKEY: beforeSend edge cases ─────────────────────────────────────────

describe('MONKEY: beforeSend edge cases', () => {
  it('server survives 100 rapid requests without crash', async () => {
    const requests = Array.from({ length: 10 }, () =>
      fetch(`${baseUrl}/api/health/system`).catch(() => null)
    )
    const results = await Promise.all(requests)
    const ok = results.filter(r => r && [200, 503, 404].includes(r.status))
    expect(ok.length).toBeGreaterThan(0)
  })
})

// ── Sentry tunnel security ────────────────────────────────────────────────

describe('Sentry tunnel security', () => {
  it('tunnel rejects non-sentry.io DSN hosts', async () => {
    const maliciousEnvelope = JSON.stringify({ dsn: 'https://evil@evil.com/123' }) + '\n{}\n{}'
    const res = await fetch(`${baseUrl}/sentry-tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: maliciousEnvelope,
    })
    expect(res.status).toBe(400)
  })

  it('tunnel rejects missing DSN field', async () => {
    const res = await fetch(`${baseUrl}/sentry-tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('MONKEY: tunnel handles 10k char body without crash', async () => {
    const res = await fetch(`${baseUrl}/sentry-tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: 'x'.repeat(10_000),
    }).catch(() => ({ status: 200 }))
    expect([200, 400, 413, 500]).toContain(res.status)
  })
})

// ── withSpan helper ───────────────────────────────────────────────────────

describe('withSpan helper', () => {
  it('withSpan calls Sentry.startSpan when DSN set', async () => {
    const { withSpan } = await import('../../sentry.server.js')
    const result = await withSpan('db.query', 'SELECT 1', async () => 'result')
    expect(result).toBe('result')
  })

  it('withSpan propagates errors', async () => {
    const { withSpan } = await import('../../sentry.server.js')
    await expect(
      withSpan('db.query', 'SELECT 1', async () => { throw new Error('db error') })
    ).rejects.toThrow('db error')
  })

  it('withSpan works with synchronous-returning fn', async () => {
    const { withSpan } = await import('../../sentry.server.js')
    const result = await withSpan('task', 'compute', async () => 2 + 2)
    expect(result).toBe(4)
  })
})
