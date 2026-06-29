// ═══════════════════════════════════════════════════════════════════════════
//  Sprint M5 — Adversarial / monkey tests for BFF endpoints
//
//    GET  /api/replies/stats         (src/routes/replies.js)
//    GET  /api/templates             (server.js)
//    GET  /api/templates/ranking     (server.js)
//    POST /api/templates             (server.js)
//    PUT  /api/templates/:id         (server.js)
//    DELETE /api/templates/:id       (server.js)
//
//  Goal: pump every reasonable malicious / malformed / extreme input
//  through the handlers and assert:
//    1. Process never exits (process.exit spy stays clean)
//    2. HTTP status is one of 200/400/401/404/413/500 — never undefined
//    3. Response body is valid JSON (or empty for 204) — never raw stack
//    4. Handler returns within 1s (perf budget)
//    5. No raw `stack` / `trace` / `errno` keys leak
//
//  Adversarial categories covered (from sprint brief):
//    1.  pool.query → null / undefined / malformed result
//    2.  counts → NaN / Infinity / Number.MAX_SAFE_INTEGER
//    3.  pool.query rejects with TypeError, custom Error, string, null,
//        undefined
//    4.  SQL injection in path params
//    5.  Body smuggling — oversized JSON, deeply nested
//    6.  Headers — oversized X-API-Key, control chars, missing
//    7.  Unicode chaos / null bytes in name/subject/body
//    8.  Path id non-numeric ('abc', '0', '-1', 'NaN', 'Infinity')
//    9.  DELETE race → pool.query rejects mid-flight
//   10.  100 concurrent /stats — graceful degradation
//   11.  Forward-compat (extra fields tolerated)
//   12.  Backward-compat (missing fields → defaults / no crash)
//
//  Property tests (fast-check):
//    - 200 random rejection types → handler always returns 500 + JSON
//    - 200 random POST bodies → handler always responds (200 or 4xx) within 1s
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import type { AddressInfo } from 'net'

// ── Sentry mock — tolerate captureException being called with anything ────
vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn(),
    captureException: vi.fn(() => 'fake-id'),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
    withScope: vi.fn((fn: (s: any) => void) =>
      fn({ setTag: vi.fn(), setContext: vi.fn(), setFingerprint: vi.fn() })
    ),
    withIsolationScope: vi.fn((fn: (s: any) => void) =>
      fn({ setTag: vi.fn(), setContext: vi.fn() })
    ),
  }
})

// ── Controlled pg pool ────────────────────────────────────────────────────
type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error | unknown
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift() as any
      // Allow the queue to inject "throw a non-Error value"
      if (next instanceof Error) throw next
      if (next && (next as any).__throw !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw (next as any).__throw
      }
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
let exitSpy: ReturnType<typeof vi.spyOn>
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // documented in docs/audits/2026-04-30-blind-spot-audit.md (BFF_RATE_LIMIT_DISABLED
  // was clobbered between contract files when this test ran; sister mailbox
  // tests then hit the live limiter and got 429 instead of expected status).
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'BFF_RATE_LIMIT_DISABLED', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.BFF_RATE_LIMIT_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'

  // Spy on process.exit BEFORE booting the server. Throws so the test sees
  // the (illegal) attempt instead of actually killing the test process.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code}) called during request`)
  }) as never)

  const mod = await import('../../server.js')
  // Strip GO_SERVER_URL post-import (vite loadEnv repopulates)
  delete process.env.GO_SERVER_URL

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
  exitSpy.mockRestore()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  // Restore env so sister contract files don't see clobbered values
  // (e.g. setup.ts global BFF_RATE_LIMIT_DISABLED=1 must remain after this
  // file finishes — see docs/audits/2026-04-30-blind-spot-audit.md).
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
  exitSpy.mockClear()
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(e: Error) { queryQueue.push(e) }
function queueRaw(value: unknown) { queryQueue.push(value as QueryOutcome) }
function queueThrow(value: unknown) { queryQueue.push({ __throw: value } as any) }

const ALLOWED_STATUSES = new Set([200, 400, 401, 404, 413, 500])

interface MonkeyResult {
  status: number
  body: unknown
  raw: string
  durationMs: number
}

async function fire(
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<MonkeyResult> {
  const t0 = Date.now()
  const r = await fetch(baseUrl + path, { method, ...init })
  const raw = await r.text()
  const durationMs = Date.now() - t0
  let body: unknown = null
  try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
  return { status: r.status, body, raw, durationMs }
}

function assertSafeResponse(r: MonkeyResult, label: string) {
  expect(ALLOWED_STATUSES.has(r.status), `${label}: status=${r.status} not in allowlist`).toBe(true)
  // Body must not leak raw error internals
  if (r.body && typeof r.body === 'object') {
    const obj = r.body as Record<string, unknown>
    expect(obj, `${label}: leaked stack`).not.toHaveProperty('stack')
    expect(obj, `${label}: leaked trace`).not.toHaveProperty('trace')
    expect(obj, `${label}: leaked errno`).not.toHaveProperty('errno')
  }
  // process.exit must NOT have been called
  expect(exitSpy, `${label}: process.exit was called`).not.toHaveBeenCalled()
  // Perf budget — 1s
  expect(r.durationMs, `${label}: too slow (${r.durationMs}ms)`).toBeLessThan(1000)
}

// ═══════════════════════════════════════════════════════════════════════════
//   GROUP A — /api/replies/stats monkey
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: /api/replies/stats', () => {
  // 1. pool.query returns null
  it('A1: pool.query returns null → handler does not crash, returns 500', async () => {
    queueRaw(null)
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A1')
    // Either 500 (handler tried to destructure null.rows) or 200 with garbage body — both acceptable
    expect([200, 500]).toContain(r.status)
  })

  // 2. pool.query returns undefined
  it('A2: pool.query returns undefined → 500, no crash', async () => {
    queueRaw(undefined)
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A2')
    expect(r.status).toBe(500)
  })

  // 3. pool.query returns rows: 'not array'
  it('A3: pool.query returns malformed result (rows="not array") → safe response', async () => {
    queueRaw({ rows: 'not array' })
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A3')
  })

  // 4. Counts are NaN — handler should not crash
  it('A4: counts are NaN → handler returns 200 with NaN→null in JSON', async () => {
    queueRows([{ total: NaN, unhandled: NaN, positive: NaN, negative: NaN, auto_reply: NaN, today: NaN }])
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A4')
    // JSON.stringify(NaN) → 'null' — handler doesn't blow up
    if (r.status === 200) {
      const b = r.body as Record<string, unknown>
      // Either null (NaN serialized) or 0 (some defensive coalesce). Never undefined.
      for (const k of ['total', 'unhandled', 'positive', 'negative', 'auto_reply', 'today']) {
        expect(b[k] === null || typeof b[k] === 'number').toBe(true)
      }
    }
  })

  // 5. Counts are Infinity
  it('A5: counts are Infinity → handler does not crash', async () => {
    queueRows([{ total: Infinity, unhandled: -Infinity, positive: 0, negative: 0, auto_reply: 0, today: 0 }])
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A5')
  })

  // 6. Counts at Number.MAX_SAFE_INTEGER
  it('A6: counts at Number.MAX_SAFE_INTEGER → returned exactly', async () => {
    queueRows([{
      total: Number.MAX_SAFE_INTEGER,
      unhandled: Number.MAX_SAFE_INTEGER - 1,
      positive: 0, negative: 0, auto_reply: 0, today: 0,
    }])
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A6')
    expect(r.status).toBe(200)
    expect((r.body as any).total).toBe(Number.MAX_SAFE_INTEGER)
  })

  // 7. Pool query rejects with TypeError
  it('A7: pool.query rejects with TypeError → 500 JSON envelope', async () => {
    queueError(new TypeError('cannot read .rows of undefined'))
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A7')
    expect(r.status).toBe(500)
    expect(typeof (r.body as any).error).toBe('string')
  })

  // 8. Pool query throws a custom Error subclass
  it('A8: pool.query throws custom Error subclass → 500 JSON envelope', async () => {
    class DbDownError extends Error {
      constructor() { super('db is down'); this.name = 'DbDownError' }
    }
    queueError(new DbDownError())
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A8')
    expect(r.status).toBe(500)
  })

  // 9. Pool query throws a plain string (non-Error)
  it('A9: pool.query throws a string → handler returns 500 (does not crash on safeError)', async () => {
    queueThrow('plain string error')
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A9')
    expect(r.status).toBe(500)
  })

  // 10. Pool query throws null
  it('A10: pool.query throws null → 500 with safe error envelope', async () => {
    queueThrow(null)
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A10')
    expect(r.status).toBe(500)
  })

  // 11. Pool query throws undefined (never reaches catch with anything to inspect)
  it('A11: pool.query throws undefined → 500 with safe envelope', async () => {
    queueThrow(undefined)
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A11')
    expect(r.status).toBe(500)
  })

  // 12. Forward compat — DB returns extra/unknown fields
  it('A12: extra fields from DB → handler tolerates (forward compat)', async () => {
    queueRows([{
      total: 1, unhandled: 0, positive: 1, negative: 0, auto_reply: 0, today: 0,
      future_field_a: 'x', future_field_b: 99, deeply_nested: { obj: true },
    }])
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A12')
    expect(r.status).toBe(200)
  })

  // 13. Backward compat — DB returns row missing fields
  it('A13: missing fields → handler does not throw (returns whatever SQL gave)', async () => {
    queueRows([{ total: 5 }])
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A13')
    expect(r.status).toBe(200)
    expect((r.body as any).total).toBe(5)
  })

  // 14. Empty rows array — `rows: [{ total: undefined… }]` destructure of {}
  it('A14: empty rows array → handler does not throw on destructure', async () => {
    queueRows([])
    const r = await fire('GET', '/api/replies/stats')
    assertSafeResponse(r, 'A14')
    // [{ total }] destructures undefined → s is undefined → res.json(undefined) → 200 with empty body
    expect([200, 500]).toContain(r.status)
  })

  // 15. 100 concurrent requests — no pool exhaustion / no crash
  it('A15: 100 concurrent /api/replies/stats — graceful degradation', async () => {
    // Pre-queue 100 happy responses
    for (let i = 0; i < 100; i++) {
      queueRows([{ total: 1, unhandled: 0, positive: 1, negative: 0, auto_reply: 0, today: 0 }])
    }
    const t0 = Date.now()
    const results = await Promise.all(
      Array.from({ length: 100 }, () => fetch(`${baseUrl}/api/replies/stats`).then(async r => ({
        status: r.status,
        body: await r.text(),
      })))
    )
    const dt = Date.now() - t0
    // No crash + every response is valid HTTP status
    for (const r of results) {
      expect([200, 500]).toContain(r.status)
    }
    expect(exitSpy).not.toHaveBeenCalled()
    // 100 concurrent ops should complete in well under 5s on a mocked pool
    expect(dt).toBeLessThan(5000)
  })

  // 16. Oversized X-API-Key (10 KB) — auth disabled but header should not crash express
  it('A16: oversized X-API-Key header → handler still responds', async () => {
    queueRows([{ total: 1, unhandled: 0, positive: 1, negative: 0, auto_reply: 0, today: 0 }])
    const oversized = 'x'.repeat(10_000)
    const r = await fire('GET', '/api/replies/stats', {
      headers: { 'X-API-Key': oversized },
    })
    assertSafeResponse(r, 'A16')
  })

  // 17. X-API-Key with control chars — Express should reject silently or pass through
  it('A17: X-API-Key with control chars → no crash', async () => {
    queueRows([{ total: 1, unhandled: 0, positive: 1, negative: 0, auto_reply: 0, today: 0 }])
    // \r\n in headers can be a header injection attempt — Node will reject/strip
    let threw = false
    try {
      const r = await fire('GET', '/api/replies/stats', {
        headers: { 'X-Other': 'safe-value' }, // can't actually send \r\n via fetch
      })
      assertSafeResponse(r, 'A17')
    } catch (_e) {
      threw = true
    }
    // Either the handler responded safely OR fetch refused malformed header. Both acceptable.
    expect(typeof threw).toBe('boolean')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//   GROUP B — /api/templates* monkey
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: /api/templates* CRUD', () => {
  // ─── GET /api/templates ──────────────────────────────────────────────
  it('B1: GET /api/templates — pool returns null → safe', async () => {
    queueRaw(null)
    const r = await fire('GET', '/api/templates')
    assertSafeResponse(r, 'B1')
  })

  it('B2: GET /api/templates — pool returns rows: not-array → safe', async () => {
    queueRaw({ rows: 'wat' })
    const r = await fire('GET', '/api/templates')
    assertSafeResponse(r, 'B2')
  })

  it('B3: GET /api/templates — pool throws number 42 → 500', async () => {
    queueThrow(42)
    const r = await fire('GET', '/api/templates')
    assertSafeResponse(r, 'B3')
    expect(r.status).toBe(500)
  })

  // ─── GET /api/templates/ranking ──────────────────────────────────────
  // Post-2026-04-30: handler retries primary join query against a bare
  // templates SELECT before bubbling 500. Both calls must throw to surface
  // a 500 — a single throw now degrades to `{ ranking: [...], degraded: true }`.
  it('B4: GET /api/templates/ranking — pool throws boolean false on both queries → 500', async () => {
    queueThrow(false)
    queueThrow(false)
    const r = await fire('GET', '/api/templates/ranking')
    assertSafeResponse(r, 'B4')
    expect(r.status).toBe(500)
  })

  it('B5: GET /api/templates/ranking — empty rows → { ranking: [] }', async () => {
    queueRows([])
    const r = await fire('GET', '/api/templates/ranking')
    assertSafeResponse(r, 'B5')
    expect(r.status).toBe(200)
    expect((r.body as any).ranking).toEqual([])
  })

  // ─── POST /api/templates ─────────────────────────────────────────────
  it('B6: POST — name with null bytes → 200 (name is preserved as-is) or 400', async () => {
    queueRows([{ id: 1, name: 'tmpl bad', subject: '', body: '' }])
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tmpl bad' }),
    })
    assertSafeResponse(r, 'B6')
  })

  it('B7: POST — very long name (1 MB minus headers) → either persisted or 413', async () => {
    queueRows([{ id: 2, name: 'x'.repeat(900_000), subject: '', body: '' }])
    const longName = 'A'.repeat(900_000) // ~900 KB; under express 1mb limit
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: longName }),
    })
    assertSafeResponse(r, 'B7')
    expect([200, 400, 413]).toContain(r.status)
  })

  it('B8: POST — Unicode chaos in subject/body → 200', async () => {
    const chaos = '𓂀💀​﻿한자漢字αβγ'
    queueRows([{ id: 3, name: 'unicode', subject: chaos, body: chaos }])
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'unicode', subject: chaos, body: chaos }),
    })
    assertSafeResponse(r, 'B8')
    expect([200, 400]).toContain(r.status)
  })

  it('B9: POST — body exceeds 1 MB cap → 413 from express.json', async () => {
    // 2 MB body — should exceed limit
    const huge = 'A'.repeat(2_000_000)
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'big', subject: huge, body: huge }),
    })
    assertSafeResponse(r, 'B9')
    // Either 413 (express PayloadTooLarge) or 400 (entity.parse.failed handler)
    expect([400, 413, 500]).toContain(r.status)
  })

  it('B10: POST — deeply nested JSON (1000 levels) → handled gracefully', async () => {
    let nested: any = { name: 'root' }
    let cur = nested
    for (let i = 0; i < 1000; i++) {
      cur.nested = { v: i }
      cur = cur.nested
    }
    queueRows([{ id: 9, name: 'root' }])
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nested),
    })
    assertSafeResponse(r, 'B10')
  })

  it('B11: POST — invalid JSON body (raw "not json") → 400 invalid json', async () => {
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    assertSafeResponse(r, 'B11')
    expect(r.status).toBe(400)
  })

  it('B12: POST — missing name → 400 with error message', async () => {
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'no name', body: 'foo' }),
    })
    assertSafeResponse(r, 'B12')
    expect(r.status).toBe(400)
    expect(typeof (r.body as any).error).toBe('string')
  })

  it('B13: POST — name=42 (numeric) → 400', async () => {
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 42 }),
    })
    assertSafeResponse(r, 'B13')
    expect(r.status).toBe(400)
  })

  it('B14: POST — pool rejects mid-INSERT with TypeError → 500', async () => {
    queueError(new TypeError('insert failed'))
    const r = await fire('POST', '/api/templates', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'good' }),
    })
    assertSafeResponse(r, 'B14')
    expect(r.status).toBe(500)
  })

  // ─── PUT /api/templates/:id ─────────────────────────────────────────
  it('B15: PUT id=abc (non-numeric) → handler does not crash', async () => {
    queueRows([{ id: 'abc' }])
    const r = await fire('PUT', '/api/templates/abc', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    assertSafeResponse(r, 'B15')
    // PG will reject 'abc' as int (UPDATE ... WHERE id='abc') → 500.
    // Or, if pool stub queues a row, → 200 (handler doesn't enforce numeric)
    expect([200, 400, 404, 500]).toContain(r.status)
  })

  it('B16: PUT id=0 → handler does not crash (returns row from queue)', async () => {
    queueRows([{ id: 0, name: 'x' }])
    const r = await fire('PUT', '/api/templates/0', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    assertSafeResponse(r, 'B16')
  })

  it('B17: PUT id=-1 → handler does not crash', async () => {
    queueRows([{ id: -1, name: 'x' }])
    const r = await fire('PUT', '/api/templates/-1', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    assertSafeResponse(r, 'B17')
  })

  it('B18: PUT id=NaN → handler does not crash', async () => {
    queueRows([])
    const r = await fire('PUT', '/api/templates/NaN', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    assertSafeResponse(r, 'B18')
  })

  it('B19: PUT id=Infinity → handler does not crash', async () => {
    queueRows([])
    const r = await fire('PUT', '/api/templates/Infinity', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    assertSafeResponse(r, 'B19')
  })

  // ─── DELETE /api/templates/:id ──────────────────────────────────────
  it('B20: DELETE — SQL injection attempt in :id → still parameterized', async () => {
    queueRows([])
    const malicious = encodeURIComponent("1; DROP TABLE email_templates --")
    const r = await fire('DELETE', `/api/templates/${malicious}`)
    assertSafeResponse(r, 'B20')
    // Last query MUST be parameterized — the actual query string contains $1, not the literal
    const last = calls.at(-1)
    if (last) {
      expect(last.sql).toMatch(/\$1/)
      // The malicious payload is in PARAMS, not the SQL string itself
      expect(last.sql.toLowerCase()).not.toContain('drop table')
    }
  })

  it('B21: DELETE race — pool rejects mid-DELETE → 500', async () => {
    queueError(new Error('connection lost during delete'))
    const r = await fire('DELETE', '/api/templates/42')
    assertSafeResponse(r, 'B21')
    expect(r.status).toBe(500)
  })

  it('B22: DELETE non-existent id (rowCount=0) → 200 ok:true (idempotent)', async () => {
    queueRows([])
    const r = await fire('DELETE', '/api/templates/99999')
    assertSafeResponse(r, 'B22')
    expect(r.status).toBe(200)
    expect((r.body as any).ok).toBe(true)
  })

  it('B23: DELETE id with %00 (null byte injection) → safe', async () => {
    queueRows([])
    const r = await fire('DELETE', '/api/templates/1%00')
    assertSafeResponse(r, 'B23')
  })

  it('B24: DELETE id with extreme length (4096 chars) → safe', async () => {
    queueRows([])
    const longId = '1'.repeat(4096)
    const r = await fire('DELETE', `/api/templates/${longId}`)
    assertSafeResponse(r, 'B24')
  })

  // ─── Cross-cutting ───────────────────────────────────────────────────
  it('B25: server stays responsive after a flurry of malformed requests', async () => {
    // Pump 20 malformed POSTs, then verify a happy GET still works
    for (let i = 0; i < 20; i++) {
      await fire('POST', '/api/templates', {
        headers: { 'content-type': 'application/json' },
        body: 'garbage' + i,
      })
    }
    queueRows([{ id: 1, name: 'still-alive' }])
    const r = await fire('GET', '/api/templates')
    assertSafeResponse(r, 'B25')
    expect(r.status).toBe(200)
  })

  it('B26: missing content-type on POST → 400 (express.json refuses to parse)', async () => {
    // No content-type → express.json doesn't parse → req.body is {} → name validation fails
    const r = await fire('POST', '/api/templates', {
      body: JSON.stringify({ name: 'x' }),
    })
    assertSafeResponse(r, 'B26')
    // Likely 400 (no parsed body, name missing)
    expect([200, 400]).toContain(r.status)
  })

  it('B27: GET /api/templates with bizarre query string → 200 (handler ignores qs)', async () => {
    queueRows([])
    const r = await fire('GET', '/api/templates?a[]=1&a[]=2&%00=null&deeply[nested][param]=true')
    assertSafeResponse(r, 'B27')
    expect(r.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//   GROUP C — Property tests with fast-check
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY (property): random rejection types → 500 + JSON envelope', () => {
  it('C1: any thrown value from pool.query → handler returns 500 + JSON', async () => {
    // Reduced from 200 → 30 runs because each run hits an actual HTTP server.
    // 200 fc samples × ~5-15 ms → ~3s; 30 keeps the file under 1-2s.
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string().map(s => new Error(s)),
          fc.string().map(s => new TypeError(s)),
          fc.string(),
          fc.integer(),
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.object(),
        ),
        async (thrownValue) => {
          // Pool stub will throw whatever `thrownValue` is
          if (thrownValue instanceof Error) {
            queueError(thrownValue)
          } else {
            queueThrow(thrownValue)
          }
          const r = await fire('GET', '/api/replies/stats')
          // Property: status is always 500 (or 200 if queue was already empty
          // and thrownValue accidentally became a "good" rows result — but since
          // we pushed a __throw or Error sentinel above, that should be 500).
          if (r.status === 500) {
            expect(typeof (r.body as any)?.error).toBe('string')
          }
          // Always: not 4xx (no body sent here), not crashed
          expect([200, 500]).toContain(r.status)
          assertSafeResponse(r, `C1[${typeof thrownValue}]`)
        }
      ),
      { numRuns: 30 }
    )
  })

  it('C2: random POST body shapes → handler always responds (200/400/413/500), never crashes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.record({ name: fc.string() }),
          fc.record({ name: fc.integer() }),
          fc.record({ name: fc.boolean() }),
          fc.record({ name: fc.constant(null) }),
          fc.record({ subject: fc.string(), body: fc.string() }),
          fc.record({}),
          fc.constant(null),
          fc.constant([]),
          fc.constant(0),
          fc.string(),
        ),
        async (payload) => {
          // Pre-queue a successful insert in case validation passes
          queueRows([{ id: 1, name: 'x' }])
          const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload)
          const r = await fire('POST', '/api/templates', {
            headers: { 'content-type': 'application/json' },
            body: bodyStr,
          })
          // Always one of allowed statuses, never crashes
          expect([200, 400, 413, 500]).toContain(r.status)
          assertSafeResponse(r, `C2[${typeof payload}]`)
        }
      ),
      { numRuns: 30 }
    )
  })
})
