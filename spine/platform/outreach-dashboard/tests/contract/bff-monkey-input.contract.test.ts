// ═══════════════════════════════════════════════════════════════════════════
//  MONKEY — BFF boundary / malformed-input tests
//
//  Verifies that:
//  1. POST /api/campaigns with various malformed bodies → 400, never 500/crash
//  2. GET /api/companies?limit=-1 → graceful response, no crash
//  3. PATCH /api/mailboxes/999999 (nonexistent ID) → does not crash server
//  4. PATCH /api/mailboxes/:id with empty body → 400 (nothing to update)
//  5. POST /api/segments with missing required fields → handled gracefully
//  6. GET /api/companies with absurd query params → 200 or 4xx, never crash
//  7. Sentry.captureException throws → capture500 still returns 500
//  8. DELETE on non-numeric ID → handled gracefully (no crash)
//  9. PATCH /api/campaigns/:id with empty body → handled gracefully
// 10. POST /api/campaigns with oversized name (10k chars) → 400 or 500, no crash
// 11. server stays responsive after any malformed input sequence
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── Sentry mock with optional throw ───────────────────────────────────────
let sentryThrows = false

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn(),
    captureException: vi.fn(() => {
      if (sentryThrows) throw new Error('sentry-monkey-throw')
      return 'fake-id'
    }),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
    withIsolationScope: vi.fn((fn: (s: unknown) => void) =>
      fn({ setTag: vi.fn(), setContext: vi.fn() })
    ),
  }
})

// ── Controlled pg pool ─────────────────────────────────────────────────────
type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []

vi.mock('pg', () => {
  class Pool {
    async query(_sql: string, _params?: unknown[]) {
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
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
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'SENTRY_DSN_BFF']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.SENTRY_DSN_BFF = 'https://test@sentry.io/1'
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
  queryQueue.length = 0
  sentryThrows = false
})

function queueRows(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

async function req(method: string, path: string, body?: unknown, contentType = 'application/json') {
  const init: RequestInit = { method, headers: { 'content-type': contentType } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. POST /api/campaigns — malformed body → 400, not 500/crash
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: POST /api/campaigns — malformed body', () => {
  it('missing name → 400 with error message', async () => {
    const r = await req('POST', '/api/campaigns', {})
    expect(r.status).toBe(400)
    expect((r.body as any)?.error).toBeTruthy()
  })

  it('null name → 400', async () => {
    const r = await req('POST', '/api/campaigns', { name: null })
    expect(r.status).toBe(400)
  })

  it('numeric name (wrong type) → 400', async () => {
    const r = await req('POST', '/api/campaigns', { name: 12345 })
    expect(r.status).toBe(400)
  })

  it('empty string name → 400', async () => {
    const r = await req('POST', '/api/campaigns', { name: '' })
    expect(r.status).toBe(400)
  })

  it('completely empty body (no name field) → 400', async () => {
    const r = await req('POST', '/api/campaigns', { description: 'only desc' })
    expect(r.status).toBe(400)
  })

  it('valid name → graceful 5xx, not a crash', async () => {
    // Campaign create requires the Go orchestrator (Sprint C1, no direct-DB
    // fallback) and tests never point at prod (no-prod-egress sets GO_SERVER_URL
    // empty) → 503. The queued error covers any path that still reaches the DB.
    // Either way: a structured 5xx with an error envelope, never a crash.
    queryQueue.push(new Error('db chaos'))
    const r = await req('POST', '/api/campaigns', { name: 'test' })
    expect([500, 503]).toContain(r.status)
    expect((r.body as any)?.error).toBeTruthy()
  })

  it('name is array → 400', async () => {
    const r = await req('POST', '/api/campaigns', { name: ['a', 'b'] })
    expect(r.status).toBe(400)
  })

  it('server survives — next request after malformed body still works', async () => {
    // Malformed request first
    await req('POST', '/api/campaigns', {})
    // Then valid read
    queueRows([])
    const r = await req('GET', '/api/campaigns')
    expect(r.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET /api/companies?limit=-1 → graceful response
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: GET /api/companies — boundary query params', () => {
  it('?limit=-1 → graceful response (200 or 4xx), never crash', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    const r = await req('GET', '/api/companies?limit=-1')
    expect([200, 400, 422]).toContain(r.status)
  })

  it('?limit=0 → graceful response', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    const r = await req('GET', '/api/companies?limit=0')
    expect([200, 400]).toContain(r.status)
  })

  it('?limit=9999999 (huge) → graceful response', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    const r = await req('GET', '/api/companies?limit=9999999')
    expect([200, 400]).toContain(r.status)
  })

  it('?offset=-1 → does not crash', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    const r = await req('GET', '/api/companies?offset=-1')
    expect([200, 400]).toContain(r.status)
  })

  it('?scoreMin=abc (non-numeric) → does not crash', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    const r = await req('GET', '/api/companies?scoreMin=abc')
    expect([200, 400]).toContain(r.status)
  })

  it('?sort=DROP TABLE → falls back to default, does not inject SQL', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    const r = await req('GET', '/api/companies?sort=DROP+TABLE')
    expect([200, 400]).toContain(r.status)
  })

  it('many duplicate query params → no crash', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    const spam = Array.from({ length: 50 }, (_, i) => `icp=ideal&icp=good`).join('&')
    const r = await req('GET', `/api/companies?${spam}`)
    expect([200, 400]).toContain(r.status)
  })

  it('server stays alive after bad query params', async () => {
    await req('GET', '/api/companies?limit=-999')
    queueRows([])
    queueRows([{ total: 0 }])
    const r = await req('GET', '/api/companies')
    expect(r.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. PATCH /api/mailboxes/999999 — nonexistent ID
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: PATCH /api/mailboxes/:id — nonexistent / edge IDs', () => {
  it('PATCH nonexistent ID 999999 → does not crash (returns 4xx or 2xx)', async () => {
    // Pool returns no rows (ID doesn't exist)
    queueRows([])
    const r = await req('PATCH', '/api/mailboxes/999999', { display_name: 'ghost' })
    // BFF currently responds 200 with undefined body or 400 — must not 500
    expect(r.status).not.toBe(500)
    expect(r.status).not.toBe(503)
  })

  it('PATCH with empty body → 400 nothing to update', async () => {
    const r = await req('PATCH', '/api/mailboxes/1', {})
    expect(r.status).toBe(400)
    expect((r.body as any)?.error).toMatch(/nothing to update/i)
  })

  it('PATCH with only null values → 400', async () => {
    // FIELD_MAP entries with undefined values are skipped; null is kept
    // but no actual update field is set → 400
    const r = await req('PATCH', '/api/mailboxes/1', { status: null })
    // status=null IS a valid body key update (null clears it) — may return 2xx or 400
    // The key invariant is: no server crash
    expect([200, 400, 500]).toContain(r.status)
  })

  it('PATCH non-numeric ID string → graceful response (no crash)', async () => {
    const r = await req('PATCH', '/api/mailboxes/not-a-number', { status: 'active' })
    expect([200, 400, 404, 500]).toContain(r.status)
  })

  it('server stays responsive after PATCH to nonexistent mailbox', async () => {
    queueRows([])
    await req('PATCH', '/api/mailboxes/999999', { display_name: 'ghost' })
    queueRows([])
    const r = await req('GET', '/api/mailboxes')
    expect(r.status).toBe(200)
  })

  it('PATCH DB error → 500 with error envelope (no crash)', async () => {
    queryQueue.push(new Error('db down'))
    const r = await req('PATCH', '/api/mailboxes/1', { display_name: 'x' })
    expect(r.status).toBe(500)
    expect((r.body as any)?.error).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Sentry.captureException throws → capture500 still returns 500
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: Sentry captureException throws → BFF still 500', () => {
  it('sentry throw on GET /api/campaigns DB error → still 500, not crash', async () => {
    sentryThrows = true
    queryQueue.push(new Error('chaos'))
    const r = await req('GET', '/api/campaigns')
    expect(r.status).toBe(500)
    expect((r.body as any)?.error).toBeTruthy()
  })

  it('sentry throw on POST /api/campaigns → still structured 5xx (no crash)', async () => {
    sentryThrows = true
    queryQueue.push(new Error('insert fail'))
    const r = await req('POST', '/api/campaigns', { name: 'test' })
    // Create requires Go (unconfigured in tests) → 503 before the DB/Sentry
    // branch; Sentry-throw resilience itself is covered by the GET/PATCH cases.
    // Must not hang or crash.
    expect([500, 503]).toContain(r.status)
  })

  it('sentry throw on GET /api/mailboxes DB error → still returns response', async () => {
    sentryThrows = true
    queryQueue.push(new Error('mailbox chaos'))
    const r = await req('GET', '/api/mailboxes')
    expect(r.status).toBe(500)
  })

  it('sentry throw on PATCH /api/mailboxes/1 DB error → still 500', async () => {
    sentryThrows = true
    queryQueue.push(new Error('patch chaos'))
    const r = await req('PATCH', '/api/mailboxes/1', { display_name: 'x' })
    expect(r.status).toBe(500)
  })

  it('after sentry-throw sequence, server fully recovers', async () => {
    sentryThrows = true
    queryQueue.push(new Error('boom'))
    await req('GET', '/api/mailboxes')
    sentryThrows = false
    queueRows([])
    const r = await req('GET', '/api/mailboxes')
    expect(r.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. POST /api/segments — boundary inputs
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: POST /api/segments — malformed body', () => {
  it('missing name → DB may throw or return gracefully (never unhandled crash)', async () => {
    // Segments don't validate name in BFF; DB NOT NULL constraint fires
    queryQueue.push(new Error('null value in column "name" violates not-null constraint'))
    const r = await req('POST', '/api/segments', {})
    expect([400, 422, 500]).toContain(r.status)
  })

  it('name=null → handled gracefully', async () => {
    queryQueue.push(new Error('null violation'))
    const r = await req('POST', '/api/segments', { name: null })
    expect([400, 422, 500]).toContain(r.status)
  })

  it('valid segment insert succeeds when pool returns row', async () => {
    queueRows([{ id: 1, name: 'test', description: null, query: {}, company_count: 0, created_at: new Date().toISOString() }])
    const r = await req('POST', '/api/segments', { name: 'test', query: {} })
    expect(r.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. POST /api/campaigns with oversized name
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: POST /api/campaigns — oversized / exotic input', () => {
  it('10 000-char name string → 400 or 500 (name IS string, but DB may reject)', async () => {
    const hugeName = 'x'.repeat(10_000)
    // No DB queue — name check happens before DB call (name must be string)
    // name is a string so passes the typeof check, but DB may reject
    queueRows([{ id: 1 }])
    queueRows([{ id: 1 }])
    queueRows([{ id: 1, name: hugeName, status: 'draft', category_paths: [], sequence_config: '{}', category_match: 'prefix', created_at: new Date().toISOString() }])
    const r = await req('POST', '/api/campaigns', { name: hugeName })
    // Giant name is still a string → passes 400 check; create then needs Go
    // (503 when unconfigured, as in tests) or hits the DB. Never a crash.
    expect([200, 400, 500, 503]).toContain(r.status)
  })

  it('name with null bytes → 400 or graceful 5xx', async () => {
    const nullByteStr = 'campaign\x00name'
    queryQueue.push(new Error('invalid byte sequence for encoding "UTF8"'))
    const r = await req('POST', '/api/campaigns', { name: nullByteStr })
    // 503 when Go unconfigured (tests), else 400/500 from validation/DB. No crash.
    expect([400, 500, 503]).toContain(r.status)
  })

  it('body with deeply nested object → does not cause stack overflow', async () => {
    // Build nested object 100 levels deep
    let deep: unknown = { name: 'test' }
    for (let i = 0; i < 100; i++) deep = { wrapper: deep }
    queueRows([])
    const r = await req('POST', '/api/campaigns', deep)
    // name is buried, not at top level → 400
    expect([400, 500]).toContain(r.status)
  })
})
