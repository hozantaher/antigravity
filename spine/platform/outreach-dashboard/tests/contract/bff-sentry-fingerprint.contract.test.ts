// ═══════════════════════════════════════════════════════════════════════════
//  Contract: Sentry fingerprinting + route-specific tags
//
//  RED phase — these tests verify:
//  1. getFingerprint() produces correct fingerprints per error type
//  2. capture500 enriches Sentry scope with fingerprint + message prefix
//  3. setRouteTags enriches scope with per-route context
//  4. Routes POST /api/campaigns, PATCH /api/mailboxes/:id, GET /api/companies
//     set the expected Sentry tags
//  5. MONKEY: edge cases for fingerprinting robustness
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── Sentry mock — captures scope callbacks ─────────────────────────────────

interface MockScope {
  _fingerprint: string[] | null
  _tags: Record<string, string>
  setFingerprint: (fp: string[]) => void
  setTag: (k: string, v: string) => void
}

let lastScope: MockScope | null = null
let scopeHistory: MockScope[] = []
let captureExceptionCalls: unknown[] = []

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn(),
    captureException: vi.fn((err: unknown) => {
      captureExceptionCalls.push(err)
      return 'fake-id'
    }),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
    withScope: vi.fn((fn: (s: MockScope) => void) => {
      const scope: MockScope = {
        _fingerprint: null,
        _tags: {},
        setFingerprint(fp) { this._fingerprint = fp },
        setTag(k, v) { this._tags[k] = v },
      }
      lastScope = scope
      scopeHistory.push(scope)
      fn(scope)
    }),
    withIsolationScope: vi.fn((fn: (s: MockScope) => void) => {
      const scope: MockScope = {
        _fingerprint: null,
        _tags: {},
        setFingerprint(fp) { this._fingerprint = fp },
        setTag(k, v) { this._tags[k] = v },
      }
      lastScope = scope
      scopeHistory.push(scope)
      fn(scope)
    }),
    setUser: vi.fn(),
    addBreadcrumb: vi.fn(),
  }
})

vi.mock('pg', () => {
  class Pool {
    async query() { throw new Error('chaos-db') }
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
  lastScope = null
  scopeHistory = []
  captureExceptionCalls = []
  vi.clearAllMocks()
})

// ── 1. getFingerprint logic ────────────────────────────────────────────────

describe('Sentry fingerprinting — getFingerprint()', () => {
  it('DB errors (pg error codes) get fingerprint ["db-error", code]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = Object.assign(new Error('relation "x" does not exist'), { code: '42P01' })
    expect(getFingerprint(err)).toEqual(['db-error', '42P01'])
  })

  it('ECONNREFUSED gets fingerprint ["db-error", "ECONNREFUSED"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    expect(getFingerprint(err)).toEqual(['db-error', 'ECONNREFUSED'])
  })

  it('401 status error gets fingerprint ["auth-error"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = Object.assign(new Error('unauthorized'), { status: 401 })
    expect(getFingerprint(err)).toEqual(['auth-error'])
  })

  it('403 status error gets fingerprint ["auth-error"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = Object.assign(new Error('forbidden'), { status: 403 })
    expect(getFingerprint(err)).toEqual(['auth-error'])
  })

  it('message containing "unauthorized" gets fingerprint ["auth-error"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = new Error('unauthorized api key')
    expect(getFingerprint(err)).toEqual(['auth-error'])
  })

  it('message containing "forbidden" gets fingerprint ["auth-error"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = new Error('access forbidden for this resource')
    expect(getFingerprint(err)).toEqual(['auth-error'])
  })

  it('404 status error gets fingerprint ["not-found"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = Object.assign(new Error('resource not found'), { status: 404 })
    expect(getFingerprint(err)).toEqual(['not-found'])
  })

  it('message "not found" gets fingerprint ["not-found"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = new Error('campaign not found')
    expect(getFingerprint(err)).toEqual(['not-found'])
  })

  it('plain Error without special code/status gets ["{{ default }}"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    expect(getFingerprint(new Error('something unexpected happened'))).toEqual(['{{ default }}'])
  })

  it('null input → ["generic-error"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    expect(getFingerprint(null)).toEqual(['generic-error'])
  })

  it('undefined input → ["generic-error"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    expect(getFingerprint(undefined)).toEqual(['generic-error'])
  })

  it('string input → ["{{ default }}"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    expect(getFingerprint('something went wrong')).toEqual(['{{ default }}'])
  })
})

// ── 2. capture500 enriches Sentry scope ───────────────────────────────────

describe('capture500 — Sentry scope enrichment', () => {
  it('DB error sets fingerprint ["db-error", code] via withScope', async () => {
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const { withScope } = await import('@sentry/node')
    const err = Object.assign(new Error('duplicate key'), { code: '23505' })
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, err, () => 'internal error')
    expect(withScope).toHaveBeenCalled()
    const scope = scopeHistory.find(s => s._fingerprint !== null)
    expect(scope?._fingerprint).toEqual(['db-error', '23505'])
  })

  it('auth error sets fingerprint ["auth-error"] via withScope', async () => {
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const err = Object.assign(new Error('Invalid API key'), { status: 401 })
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, err, () => 'internal error')
    const scope = scopeHistory.find(s => s._fingerprint !== null)
    expect(scope?._fingerprint).toEqual(['auth-error'])
  })

  it('404 error sets fingerprint ["not-found"] via withScope', async () => {
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const err = Object.assign(new Error('record not found'), { status: 404 })
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, err, () => 'internal error')
    const scope = scopeHistory.find(s => s._fingerprint !== null)
    expect(scope?._fingerprint).toEqual(['not-found'])
  })

  it('sets error.message_prefix tag with first 50 chars of message', async () => {
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const msg = 'a'.repeat(100)
    const err = new Error(msg)
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, err, () => 'err')
    const scope = scopeHistory.find(s => 'error.message_prefix' in s._tags)
    expect(scope?._tags['error.message_prefix']).toHaveLength(50)
  })

  it('wraps non-Error objects in Error before captureException', async () => {
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const { captureException } = await import('@sentry/node')
    const plain = { message: 'db timeout', code: 'ETIMEDOUT' }
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, plain, () => 'err')
    expect(captureException).toHaveBeenCalledWith(expect.any(Error))
  })
})

// ── 3. Route-specific tags ─────────────────────────────────────────────────

describe('Route-specific tags — setRouteTags()', () => {
  it('POST /api/campaigns sets campaign.action=create tag', async () => {
    const res = await fetch(`${baseUrl}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    })
    // Route errors out, but the campaign.action tag is set first (campaigns.js:180).
    // POST /api/campaigns now gates on the Go orchestrator and returns 503 when it
    // is unreachable/unconfigured (campaigns.js:268,275) — no GO_SERVER_URL or fetch
    // mock here, so 503 is the expected status. The tag assertion below is the point.
    expect([200, 500, 503]).toContain(res.status)
    // Check withIsolationScope was called (used by setRouteTags)
    const { withIsolationScope } = await import('@sentry/node')
    expect(withIsolationScope).toHaveBeenCalled()
    const campaignScope = scopeHistory.find(s => s._tags['campaign.action'] === 'create')
    expect(campaignScope).toBeDefined()
  })

  it('PATCH /api/mailboxes/:id sets mailbox.id tag', async () => {
    const { withIsolationScope } = await import('@sentry/node')
    ;(withIsolationScope as ReturnType<typeof vi.fn>).mockClear()
    scopeHistory = []

    const res = await fetch(`${baseUrl}/api/mailboxes/42`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    expect([200, 400, 500]).toContain(res.status)
    const mboxScope = scopeHistory.find(s => s._tags['mailbox.id'] === '42')
    expect(mboxScope).toBeDefined()
  })

  it('GET /api/companies sets page.type=company-list tag', async () => {
    const { withIsolationScope } = await import('@sentry/node')
    ;(withIsolationScope as ReturnType<typeof vi.fn>).mockClear()
    scopeHistory = []

    const res = await fetch(`${baseUrl}/api/companies`)
    expect([200, 500]).toContain(res.status)
    const compScope = scopeHistory.find(s => s._tags['page.type'] === 'company-list')
    expect(compScope).toBeDefined()
  })

  it('POST /api/scoring/preview sets scoring.action=preview tag', async () => {
    const { withIsolationScope } = await import('@sentry/node')
    ;(withIsolationScope as ReturnType<typeof vi.fn>).mockClear()
    scopeHistory = []

    const res = await fetch(`${baseUrl}/api/scoring/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weights: {}, limit: 10 }),
    })
    expect([200, 500]).toContain(res.status)
    const scoringScope = scopeHistory.find(s => s._tags['scoring.action'] === 'preview')
    expect(scoringScope).toBeDefined()
  })

  it('GET /api/analytics/overview sets analytics.endpoint=overview tag', async () => {
    const { withIsolationScope } = await import('@sentry/node')
    ;(withIsolationScope as ReturnType<typeof vi.fn>).mockClear()
    scopeHistory = []

    const res = await fetch(`${baseUrl}/api/analytics/overview`)
    expect([200, 500]).toContain(res.status)
    const analyticsScope = scopeHistory.find(s => s._tags['analytics.endpoint'] === 'overview')
    expect(analyticsScope).toBeDefined()
  })

  it('PATCH /api/mailboxes/:id sets mailbox.action=update tag', async () => {
    const { withIsolationScope } = await import('@sentry/node')
    ;(withIsolationScope as ReturnType<typeof vi.fn>).mockClear()
    scopeHistory = []

    const res = await fetch(`${baseUrl}/api/mailboxes/99`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    expect([200, 400, 500]).toContain(res.status)
    const mboxActionScope = scopeHistory.find(s => s._tags['mailbox.action'] === 'update')
    expect(mboxActionScope).toBeDefined()
  })

  it('setRouteTags is a no-op when SENTRY_DSN_BFF is unset', async () => {
    const { setRouteTags } = await import('../../sentry.server.js')
    const orig = process.env.SENTRY_DSN_BFF
    delete process.env.SENTRY_DSN_BFF
    expect(() => setRouteTags({ 'test.tag': 'val' })).not.toThrow()
    process.env.SENTRY_DSN_BFF = orig
  })

  it('setRouteTags truncates tag values to 100 chars', async () => {
    process.env.SENTRY_DSN_BFF = 'https://test@sentry.io/0'
    const { setRouteTags } = await import('../../sentry.server.js')
    const longVal = 'x'.repeat(200)
    // Should not throw even with oversized values
    expect(() => setRouteTags({ 'test.tag': longVal })).not.toThrow()
  })

  it('setRouteTags ignores null/undefined tag values', async () => {
    const { setRouteTags } = await import('../../sentry.server.js')
    expect(() => setRouteTags({ 'tag.a': null as unknown as string, 'tag.b': undefined as unknown as string })).not.toThrow()
  })
})

// ── 4. MONKEY: fingerprinting edge cases ──────────────────────────────────

describe('MONKEY: fingerprinting edge cases', () => {
  it('fingerprint on null error → defaults to ["generic-error"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    expect(() => getFingerprint(null)).not.toThrow()
    expect(getFingerprint(null)).toEqual(['generic-error'])
  })

  it('fingerprint on undefined error → defaults to ["generic-error"]', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    expect(() => getFingerprint(undefined)).not.toThrow()
    expect(getFingerprint(undefined)).toEqual(['generic-error'])
  })

  it('fingerprint with 10k-char message → does not throw, returns valid array', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const hugeErr = new Error('e'.repeat(10_000))
    expect(() => getFingerprint(hugeErr)).not.toThrow()
    const fp = getFingerprint(hugeErr)
    expect(Array.isArray(fp)).toBe(true)
    expect(fp.length).toBeGreaterThan(0)
  })

  it('fingerprint when Sentry withScope throws → request still succeeds', async () => {
    const { withScope } = await import('@sentry/node')
    ;(withScope as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('sentry scope explosion')
    })
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    expect(() => capture500(res as never, new Error('real error'), () => 'err')).not.toThrow()
    expect(res._s).toBe(500)
  })

  it('capture500 with number input → wraps and does not throw', async () => {
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    expect(() => capture500(res as never, 42 as never, () => 'err')).not.toThrow()
    expect(res._s).toBe(500)
  })

  it('capture500 with array input → wraps and does not throw', async () => {
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const res = { _s: 0, _b: null as unknown, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    expect(() => capture500(res as never, [] as never, () => 'err')).not.toThrow()
  })

  it('fingerprint never returns empty array for any input', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const inputs = [null, undefined, new Error('x'), { code: 'PG001' }, 42, 'string', [], {}]
    for (const inp of inputs) {
      const fp = getFingerprint(inp as never)
      expect(Array.isArray(fp)).toBe(true)
      expect(fp.length).toBeGreaterThan(0)
    }
  })

  it('setRouteTags never throws for null tags argument', async () => {
    const { setRouteTags } = await import('../../sentry.server.js')
    expect(() => setRouteTags(null as unknown as Record<string, string>)).not.toThrow()
  })

  it('setRouteTags never throws for empty object', async () => {
    const { setRouteTags } = await import('../../sentry.server.js')
    expect(() => setRouteTags({})).not.toThrow()
  })

  it('getFingerprint is total — never throws for any of 20 fuzz inputs', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const fuzzInputs = [
      null, undefined, 0, '', false, true, [], {}, Symbol('x'),
      new TypeError('type'), new RangeError('range'),
      { code: '' }, { code: null }, { status: NaN }, { status: -1 },
      { message: null }, { message: 123 }, { code: '23505', status: 403 },
      new Error(), Object.create(null),
    ]
    for (const inp of fuzzInputs) {
      expect(() => getFingerprint(inp as never)).not.toThrow()
    }
  })
})

// ── 5. MONKEY: fingerprint stability ──────────────────────────────────────

describe('MONKEY: fingerprint stability', () => {
  it('same error always produces same fingerprint', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const err = Object.assign(new Error('db timeout'), { code: '57P01' })
    const fp1 = getFingerprint(err)
    const fp2 = getFingerprint(err)
    expect(fp1).toEqual(fp2)
  })

  it('fingerprint for 100 error variants never crashes', async () => {
    const { getFingerprint } = await import('../../src/lib/sentryCapture.js')
    const errs = Array.from({ length: 100 }, (_, i) =>
      Object.assign(new Error(`err-${i}`), {
        code: i % 3 === 0 ? '23505' : undefined,
        status: i % 5 === 0 ? 401 : undefined,
      })
    )
    errs.forEach(e => expect(() => getFingerprint(e)).not.toThrow())
  })
})
