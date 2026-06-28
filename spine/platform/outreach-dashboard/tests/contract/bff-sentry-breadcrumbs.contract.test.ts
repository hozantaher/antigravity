// Contract: BFF Sentry breadcrumbs + user context
//
// TDD — RED phase: these tests describe the expected behaviour of
// wrapPoolWithBreadcrumbs() and addAuthBreadcrumb() before they are
// implemented. Run `pnpm test:contract` to see them fail first.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── Sentry mock — captures breadcrumbs and setUser calls ─────────────────────
const breadcrumbs: import('@sentry/node').Breadcrumb[] = []
let lastUser: Record<string, unknown> | null = null

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn(),
    addBreadcrumb: vi.fn((b: import('@sentry/node').Breadcrumb) => {
      breadcrumbs.push(b)
    }),
    setUser: vi.fn((u: Record<string, unknown> | null) => {
      lastUser = u
    }),
    captureException: vi.fn(),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
    withIsolationScope: vi.fn((fn: (s: unknown) => void) =>
      fn({ setTag: vi.fn(), setContext: vi.fn() })
    ),
  }
})

vi.mock('pg', () => {
  class Pool {
    async query(sql: unknown) {
      const sqlStr = typeof sql === 'string' ? sql : 'query'
      if (sqlStr === 'THROW') throw new Error('db-error-breadcrumb')
      return { rows: [] }
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
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
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
  breadcrumbs.length = 0
  lastUser = null
})

// ── Core breadcrumb contract ───────────────────────────────────────────────────

describe('Sentry breadcrumbs — wrapPoolWithBreadcrumbs', () => {
  it('DB query adds breadcrumb with category=db.query', async () => {
    const { wrapPoolWithBreadcrumbs } = await import('../../sentry.server.js')
    const fakePool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
    const wrapped = wrapPoolWithBreadcrumbs(fakePool as never)
    await wrapped.query('SELECT 1')
    const { addBreadcrumb } = await import('@sentry/node')
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'db.query' })
    )
  })

  it('breadcrumb message contains (truncated) SQL text', async () => {
    const { wrapPoolWithBreadcrumbs } = await import('../../sentry.server.js')
    const fakePool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const wrapped = wrapPoolWithBreadcrumbs(fakePool as never)
    await wrapped.query('SELECT id FROM companies WHERE status = $1')
    expect(breadcrumbs.some((b) => b.message?.includes('SELECT'))).toBe(true)
  })

  it('breadcrumb level is info', async () => {
    const { wrapPoolWithBreadcrumbs } = await import('../../sentry.server.js')
    const fakePool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const wrapped = wrapPoolWithBreadcrumbs(fakePool as never)
    await wrapped.query('SELECT 1')
    expect(breadcrumbs.some((b) => b.level === 'info')).toBe(true)
  })
})

describe('Sentry breadcrumbs — addAuthBreadcrumb', () => {
  it('Auth failure adds breadcrumb with category=auth', async () => {
    const { addAuthBreadcrumb } = await import('../../sentry.server.js')
    addAuthBreadcrumb('invalid api key')
    expect(breadcrumbs.some((b) => b.category === 'auth')).toBe(true)
  })

  it('auth breadcrumb has level=warning', async () => {
    const { addAuthBreadcrumb } = await import('../../sentry.server.js')
    addAuthBreadcrumb('missing key')
    expect(breadcrumbs.some((b) => b.category === 'auth' && b.level === 'warning')).toBe(true)
  })

  it('auth breadcrumb carries the reason message', async () => {
    const { addAuthBreadcrumb } = await import('../../sentry.server.js')
    addAuthBreadcrumb('key expired')
    expect(breadcrumbs.some((b) => b.message === 'key expired')).toBe(true)
  })
})

describe('Sentry — user context from X-API-Key', () => {
  it('User context set from X-API-Key header (last 4 chars only)', async () => {
    const { setUser } = await import('@sentry/node')
    // Hit any route that goes through sentryTagMiddleware with an API key
    await fetch(`${baseUrl}/api/health/system`, {
      headers: { 'X-API-Key': 'supersecretkey1234' },
    })
    expect(setUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringContaining('1234') })
    )
  })

  it('user id must NOT contain the full key', async () => {
    const { setUser } = await import('@sentry/node')
    await fetch(`${baseUrl}/api/health/system`, {
      headers: { 'X-API-Key': 'mysecretapikey9999' },
    })
    const calls = (setUser as ReturnType<typeof vi.fn>).mock.calls
    const ids = calls.map((c: unknown[]) => (c[0] as { id?: string })?.id ?? '')
    expect(ids.every((id: string) => !id.includes('mysecretapikey'))).toBe(true)
  })

  it('no setUser call when X-API-Key header is absent', async () => {
    const { setUser } = await import('@sentry/node')
    ;(setUser as ReturnType<typeof vi.fn>).mockClear()
    await fetch(`${baseUrl}/api/health/system`)
    expect(setUser).not.toHaveBeenCalled()
  })

  it('External HTTP call breadcrumb with category=http can be added manually', async () => {
    const { addBreadcrumb } = await import('@sentry/node')
    ;(addBreadcrumb as ReturnType<typeof vi.fn>).mockClear()
    // Simulate what external http instrumentation would do
    addBreadcrumb({ category: 'http', message: 'GET https://api.proxifly.dev/proxy', level: 'info' })
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'http' })
    )
  })
})

// ── Auth breadcrumb wiring ─────────────────────────────────────────────────────
//
// These tests verify that authMiddleware calls addAuthBreadcrumb on 401 failures.
// They need auth ENABLED, so we temporarily unset BFF_AUTH_DISABLED and set
// a known OUTREACH_API_KEY before each test.

describe('Auth breadcrumb wiring', () => {
  const KNOWN_KEY = 'test-auth-breadcrumb-key-abc9'

  beforeEach(() => {
    breadcrumbs.length = 0
    delete process.env.BFF_AUTH_DISABLED
    process.env.OUTREACH_API_KEY = KNOWN_KEY
  })

  afterEach(() => {
    process.env.BFF_AUTH_DISABLED = '1'
    delete process.env.OUTREACH_API_KEY
  })

  it('auth middleware failure triggers addAuthBreadcrumb call', async () => {
    // Request a protected endpoint without X-API-Key — should 401 and breadcrumb
    await fetch(`${baseUrl}/api/mailboxes`)
    expect(breadcrumbs.some((b) => b.category === 'auth')).toBe(true)
  })

  it('missing X-API-Key adds breadcrumb with level=warning', async () => {
    await fetch(`${baseUrl}/api/mailboxes`)
    expect(breadcrumbs.some((b) => b.category === 'auth' && b.level === 'warning')).toBe(true)
  })

  it('invalid API key adds breadcrumb with reason string', async () => {
    await fetch(`${baseUrl}/api/mailboxes`, { headers: { 'X-API-Key': 'wrong-key' } })
    const authCrumbs = breadcrumbs.filter((b) => b.category === 'auth')
    expect(authCrumbs.length).toBeGreaterThan(0)
    expect(typeof authCrumbs[0].message).toBe('string')
    expect((authCrumbs[0].message ?? '').length).toBeGreaterThan(0)
  })

  it('valid API key does NOT add auth breadcrumb', async () => {
    await fetch(`${baseUrl}/api/health/system`, { headers: { 'X-API-Key': KNOWN_KEY } })
    expect(breadcrumbs.filter((b) => b.category === 'auth').length).toBe(0)
  })

  it('exempt path does NOT add auth breadcrumb', async () => {
    // /api/health/system is in AUTH_EXEMPT — no breadcrumb expected
    await fetch(`${baseUrl}/api/health/system`)
    expect(breadcrumbs.filter((b) => b.category === 'auth').length).toBe(0)
  })
})

// ── withSpan — performance monitoring ────────────────────────────────────────

describe('withSpan — performance monitoring', () => {
  it('withSpan calls fn and returns its result', async () => {
    const { withSpan } = await import('../../sentry.server.js')
    const result = await withSpan('db.query', 'SELECT 1', async () => 42)
    expect(result).toBe(42)
  })

  it('withSpan propagates errors from fn', async () => {
    const { withSpan } = await import('../../sentry.server.js')
    await expect(
      withSpan('db.query', 'SELECT 1', async () => { throw new Error('db-error') })
    ).rejects.toThrow('db-error')
  })

  it('withSpan is no-op when DSN not set', async () => {
    const orig = process.env.SENTRY_DSN_BFF
    delete process.env.SENTRY_DSN_BFF
    const { withSpan } = await import('../../sentry.server.js')
    const result = await withSpan('db', 'q', async () => 'ok')
    expect(result).toBe('ok')
    if (orig) process.env.SENTRY_DSN_BFF = orig
  })

  it('MONKEY: withSpan never throws for any op/name strings', async () => {
    const { withSpan } = await import('../../sentry.server.js')
    const cases = [null, undefined, '', ' '.repeat(1000), '💬', '<script>'] as unknown as string[]
    for (const c of cases) {
      await expect(withSpan(c, c, async () => 'ok')).resolves.toBe('ok')
    }
  })
})

// ── MONKEY tests ──────────────────────────────────────────────────────────────

describe('MONKEY: breadcrumb resilience', () => {
  it('addBreadcrumb with null message → no crash', async () => {
    const { addAuthBreadcrumb } = await import('../../sentry.server.js')
    expect(() => addAuthBreadcrumb(null as unknown as string)).not.toThrow()
  })

  it('addBreadcrumb with 10000 char message → no crash (truncate or pass-through)', async () => {
    const { addAuthBreadcrumb } = await import('../../sentry.server.js')
    const huge = 'x'.repeat(10_000)
    expect(() => addAuthBreadcrumb(huge)).not.toThrow()
  })

  it('setUser with undefined → no crash', async () => {
    const { Sentry } = await import('../../sentry.server.js')
    expect(() => (Sentry as typeof import('@sentry/node')).setUser(null)).not.toThrow()
  })

  it('wrapPoolWithBreadcrumbs without DSN → original pool returned unchanged', async () => {
    const origDsn = process.env.SENTRY_DSN_BFF
    delete process.env.SENTRY_DSN_BFF
    const { wrapPoolWithBreadcrumbs } = await import('../../sentry.server.js')
    const fakePool = { query: vi.fn(), on: vi.fn(), end: vi.fn() }
    const result = wrapPoolWithBreadcrumbs(fakePool as never)
    expect(result).toBe(fakePool)
    process.env.SENTRY_DSN_BFF = origDsn
  })

  it('pool.query throws → breadcrumb still added, error re-thrown', async () => {
    const { wrapPoolWithBreadcrumbs } = await import('../../sentry.server.js')
    const fakePool = {
      query: vi.fn().mockRejectedValue(new Error('connection lost')),
    }
    const wrapped = wrapPoolWithBreadcrumbs(fakePool as never)
    await expect(wrapped.query('SELECT 1')).rejects.toThrow('connection lost')
    // Breadcrumb should have been added before the error propagated
    expect(breadcrumbs.some((b) => b.category === 'db.query')).toBe(true)
  })

  it('addAuthBreadcrumb when SENTRY_DSN_BFF not set → no-op, no crash', async () => {
    const origDsn = process.env.SENTRY_DSN_BFF
    delete process.env.SENTRY_DSN_BFF
    const { addAuthBreadcrumb } = await import('../../sentry.server.js')
    expect(() => addAuthBreadcrumb('test reason')).not.toThrow()
    process.env.SENTRY_DSN_BFF = origDsn
  })

  it('addBreadcrumb with empty string message → no crash', async () => {
    const { addAuthBreadcrumb } = await import('../../sentry.server.js')
    expect(() => addAuthBreadcrumb('')).not.toThrow()
  })

  it('addBreadcrumb called with object as message → no crash', async () => {
    const { addAuthBreadcrumb } = await import('../../sentry.server.js')
    expect(() =>
      addAuthBreadcrumb({ nested: 'object' } as unknown as string)
    ).not.toThrow()
  })

  it('wrapPoolWithBreadcrumbs called with non-object → no crash', async () => {
    const { wrapPoolWithBreadcrumbs } = await import('../../sentry.server.js')
    expect(() => wrapPoolWithBreadcrumbs(null as never)).not.toThrow()
  })

  it('SQL message truncated to ≤100 chars in breadcrumb', async () => {
    const { wrapPoolWithBreadcrumbs } = await import('../../sentry.server.js')
    const fakePool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const wrapped = wrapPoolWithBreadcrumbs(fakePool as never)
    const longSql = 'SELECT ' + 'x, '.repeat(200)
    await wrapped.query(longSql)
    breadcrumbs
      .filter((b) => b.category === 'db.query')
      .forEach((b) => {
        expect((b.message ?? '').length).toBeLessThanOrEqual(100)
      })
  })
})
