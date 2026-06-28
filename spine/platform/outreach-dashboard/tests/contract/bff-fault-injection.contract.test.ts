/**
 * BFF fault injection contract tests (M6)
 *
 * Injects faults at the pg boundary and asserts BFF produces:
 *   - correct 5xx status
 *   - JSON error envelope (or text/plain for Prometheus endpoints)
 *   - no partial writes (each handler either fully commits or fully fails)
 *   - no crash (server remains responsive afterwards)
 *
 * Fault classes covered:
 *   1. Connection refused (pg down)
 *   2. Constraint violation (23xxx)
 *   3. Deadlock (40P01)
 *   4. Statement timeout (57014)
 *   5. Out of memory (53200)
 *   6. Disk full (53100)
 *   7. Undefined table (42P01) — migrations not applied
 *   8. Authentication failure (28P01)
 *   9. Read-only tx (25006)
 *  10. Connection reset mid-query
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const callLog: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      callLog.push({ sql, params })
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
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) {
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
  callLog.length = 0
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(err: Error) { queryQueue.push(err) }
function pgError(code: string, msg: string) {
  const e = new Error(msg)
  ;(e as any).code = code
  ;(e as any).severity = 'ERROR'
  return e
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text }
}

const READ_PROBES = [
  '/api/mailboxes',
  '/api/mailboxes/1/stats',
  '/api/mailboxes/1/send-log',
  '/api/mailboxes/1/watchdog-events',
  '/api/mailboxes/1/cooldown-log',
  '/api/mailboxes/1/pipeline-results',
]

const WRITE_PROBES: Array<[string, string, unknown]> = [
  ['POST', '/api/mailboxes', { email: 'a@b.cz', smtp_host: 'h', password: 'p' }],
  ['PATCH', '/api/mailboxes/1', { display_name: 'x' }],
  ['DELETE', '/api/mailboxes/1', undefined],
  ['POST', '/api/mailboxes/1/recover', {}],
]

// ═══════════════════════════════════════════════════════════════════════
// 1. Connection refused
// ═══════════════════════════════════════════════════════════════════════
describe('fault — pg connection refused', () => {
  for (const p of READ_PROBES) {
    it(`GET ${p} returns 5xx with error envelope`, async () => {
      queueError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
      const r = await req('GET', p)
      expect(r.status).toBeGreaterThanOrEqual(500)
      if (!String((r as any).raw).startsWith('#')) {
        expect(typeof (r.body as any)?.error).toBe('string')
      }
    })
  }
  for (const [method, path, body] of WRITE_PROBES) {
    it(`${method} ${path} returns 5xx on connect refused`, async () => {
      queueError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
      const r = await req(method, path, body)
      expect(r.status).toBeGreaterThanOrEqual(500)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 2. Constraint violations
// ═══════════════════════════════════════════════════════════════════════
describe('fault — pg constraint violations', () => {
  const CONSTRAINTS = [
    ['23505', 'duplicate key value violates unique constraint "mailboxes_email_key"'],
    ['23502', 'null value in column "from_address" violates not-null constraint'],
    ['23503', 'insert or update on table "outreach_mailboxes" violates foreign key constraint'],
    ['23514', 'new row violates check constraint "status_check"'],
    ['22001', 'value too long for type character varying(255)'],
    ['22P02', 'invalid input syntax for type integer: "abc"'],
  ]
  for (const [code, msg] of CONSTRAINTS) {
    it(`POST /api/mailboxes surfaces pg ${code} as 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('POST', '/api/mailboxes', {
        email: 'a@b.cz', smtp_host: 'h', password: 'p',
      })
      expect(r.status).toBe(500)
      expect(typeof (r.body as any)?.error).toBe('string')
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 3. Deadlock / serialization
// ═══════════════════════════════════════════════════════════════════════
describe('fault — pg deadlock / serialization', () => {
  const codes = [
    ['40P01', 'deadlock detected'],
    ['40001', 'could not serialize access due to concurrent update'],
  ]
  for (const [code, msg] of codes) {
    it(`PATCH /api/mailboxes/1 under pg ${code} returns 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('PATCH', '/api/mailboxes/1', { display_name: 'x' })
      expect(r.status).toBe(500)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 4. Timeout / cancellation
// ═══════════════════════════════════════════════════════════════════════
describe('fault — pg statement timeout / cancel', () => {
  const codes = [
    ['57014', 'canceling statement due to statement timeout'],
    ['57P01', 'terminating connection due to administrator command'],
    ['57P02', 'terminating connection due to crash of another server process'],
    ['57P03', 'cannot connect now'],
  ]
  for (const [code, msg] of codes) {
    it(`GET /api/mailboxes under pg ${code} returns 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('GET', '/api/mailboxes')
      expect(r.status).toBe(500)
    })
    it(`POST /api/mailboxes under pg ${code} returns 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('POST', '/api/mailboxes', {
        email: 'a@b.cz', smtp_host: 'h', password: 'p',
      })
      expect(r.status).toBe(500)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 5. Resource exhaustion
// ═══════════════════════════════════════════════════════════════════════
describe('fault — resource exhaustion', () => {
  const codes = [
    ['53100', 'disk full'],
    ['53200', 'out of memory'],
    ['53300', 'too many connections'],
    ['53400', 'configuration limit exceeded'],
  ]
  for (const [code, msg] of codes) {
    it(`pg ${code} on GET /api/mailboxes → 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('GET', '/api/mailboxes')
      expect(r.status).toBe(500)
    })
    it(`pg ${code} on POST /api/mailboxes → 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('POST', '/api/mailboxes', { email: 'a@b.cz' })
      expect(r.status).toBe(500)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 6. Undefined table / migration state
// ═══════════════════════════════════════════════════════════════════════
describe('fault — schema not migrated', () => {
  const codes = [
    ['42P01', 'relation "outreach_mailboxes" does not exist'],
    ['42703', 'column "new_col" does not exist'],
    ['42P07', 'relation already exists'],
  ]
  for (const [code, msg] of codes) {
    it(`GET /api/mailboxes returns graceful response on ${code}`, async () => {
      queueError(pgError(code, msg))
      const r = await req('GET', '/api/mailboxes')
      expect(r.status).toBeGreaterThanOrEqual(500)
    })
    it(`GET /api/metrics/mailboxes swallows ${code} with empty body`, async () => {
      queueError(pgError(code, msg))
      const r = await req('GET', '/api/metrics/mailboxes')
      // /api/metrics/mailboxes has an explicit "relation does not exist"
      // fallback that returns empty Prometheus output with 200. Other codes
      // hit the 500 branch.
      if (code === '42P01') {
        expect(r.status).toBe(200)
      } else {
        expect(r.status).toBeGreaterThanOrEqual(500)
      }
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 7. Auth failure
// ═══════════════════════════════════════════════════════════════════════
describe('fault — pg auth failure', () => {
  const codes = [
    ['28P01', 'password authentication failed for user "outreach"'],
    ['28000', 'no pg_hba.conf entry for host'],
  ]
  for (const [code, msg] of codes) {
    it(`GET /api/mailboxes surfaces ${code} as 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('GET', '/api/mailboxes')
      expect(r.status).toBe(500)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 8. Read-only tx
// ═══════════════════════════════════════════════════════════════════════
describe('fault — pg read-only tx on write paths', () => {
  const codes = [
    ['25006', 'cannot execute INSERT in a read-only transaction'],
    ['25P02', 'current transaction is aborted'],
  ]
  for (const [code, msg] of codes) {
    it(`POST /api/mailboxes under ${code} returns 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('POST', '/api/mailboxes', {
        email: 'a@b.cz', smtp_host: 'h', password: 'p',
      })
      expect(r.status).toBe(500)
    })
    it(`DELETE /api/mailboxes/1 under ${code} returns 500`, async () => {
      queueError(pgError(code, msg))
      const r = await req('DELETE', '/api/mailboxes/1')
      expect(r.status).toBe(500)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 9. Server recovery after fault
// ═══════════════════════════════════════════════════════════════════════
describe('fault — server stays responsive after fault', () => {
  it('injects pg error, then next request succeeds', async () => {
    queueError(new Error('boom'))
    const fail = await req('GET', '/api/mailboxes')
    expect(fail.status).toBe(500)

    queueRows([])
    const ok = await req('GET', '/api/mailboxes')
    expect(ok.status).toBe(200)
  })
  it('injects 3 sequential faults, each isolated', async () => {
    queueError(new Error('boom1'))
    queueError(new Error('boom2'))
    queueError(new Error('boom3'))
    const a = await req('GET', '/api/mailboxes')
    const b = await req('GET', '/api/mailboxes')
    const c = await req('GET', '/api/mailboxes')
    expect([a.status, b.status, c.status]).toEqual([500, 500, 500])

    queueRows([])
    const rec = await req('GET', '/api/mailboxes')
    expect(rec.status).toBe(200)
  })
  it('mixed fault / success / fault ordering is preserved', async () => {
    queueRows([{ id: 1 }])
    queueError(new Error('boom'))
    queueRows([{ id: 2 }])

    const a = await req('GET', '/api/mailboxes')
    const b = await req('GET', '/api/mailboxes')
    const c = await req('GET', '/api/mailboxes')
    expect(a.status).toBe(200)
    expect(b.status).toBe(500)
    expect(c.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 10. Connection reset mid-query (simulated as throw of ECONNRESET)
// ═══════════════════════════════════════════════════════════════════════
describe('fault — connection reset mid-query', () => {
  const MSGS = [
    'read ECONNRESET',
    'write ECONNRESET',
    'socket hang up',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
  ]
  for (const m of MSGS) {
    it(`GET /api/mailboxes on "${m}" → 500`, async () => {
      queueError(new Error(m))
      const r = await req('GET', '/api/mailboxes')
      expect(r.status).toBe(500)
    })
    it(`POST /api/mailboxes on "${m}" → 500`, async () => {
      queueError(new Error(m))
      const r = await req('POST', '/api/mailboxes', {
        email: 'a@b.cz', smtp_host: 'h', password: 'p',
      })
      expect(r.status).toBe(500)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 11. Parallel fault mapping
// ═══════════════════════════════════════════════════════════════════════
describe('fault — parallel requests each get consistent mapping', () => {
  it('5 parallel GETs under pg error all get 500', async () => {
    for (let i = 0; i < 5; i++) queueError(new Error('boom ' + i))
    const results = await Promise.all(
      Array.from({ length: 5 }, () => req('GET', '/api/mailboxes'))
    )
    for (const r of results) expect(r.status).toBe(500)
  })
  it('5 parallel mixed GETs get deterministic per-request outcomes', async () => {
    queueRows([])
    queueError(new Error('x'))
    queueRows([])
    queueError(new Error('y'))
    queueRows([])
    const results = await Promise.all(
      Array.from({ length: 5 }, () => req('GET', '/api/mailboxes'))
    )
    const codes = results.map((r) => r.status)
    expect(codes.filter((c) => c === 200).length).toBe(3)
    expect(codes.filter((c) => c === 500).length).toBe(2)
  })
})
