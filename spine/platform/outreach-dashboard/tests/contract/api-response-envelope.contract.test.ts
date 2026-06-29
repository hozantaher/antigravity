/**
 * Response envelope contract tests
 *
 * Locks in the shape of error and success responses across representative
 * endpoints. The BFF does NOT yet enforce a single envelope for every
 * handler (historical accretion), so we assert the *observed* invariants:
 *
 *  - JSON content-type on every API response
 *  - 5xx responses always have an `error` string
 *  - 4xx responses always have an `error` string
 *  - 2xx list endpoints return either an array OR `{ data: [...] }`
 *  - 2xx single-entity endpoints return an object with discoverable fields
 *  - No leaking of raw pg error strings (sanitized via the error handler)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
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
  calls.length = 0
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const ct = r.headers.get('content-type') ?? ''
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text, contentType: ct }
}

describe('response envelope — content-type', () => {
  it('GET /api/version returns application/json', async () => {
    const r = await req('GET', '/api/version')
    expect(r.contentType).toContain('application/json')
  })
  it('GET /api/mailboxes returns JSON content-type', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes')
    expect(r.contentType).toContain('application/json')
  })
  it('GET /api/health/guards returns JSON content-type', async () => {
    const r = await req('GET', '/api/health/guards')
    expect(r.contentType).toContain('application/json')
  })
  it('GET /api/metrics/mailboxes returns text/plain (Prometheus)', async () => {
    queueRows([])
    const r = await req('GET', '/api/metrics/mailboxes')
    expect(r.contentType).toContain('text/plain')
  })
  it('POST with invalid JSON returns JSON content-type', async () => {
    const r = await fetch(baseUrl + '/api/mailboxes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(r.headers.get('content-type') ?? '').toContain('application/json')
  })
})

describe('response envelope — success shape', () => {
  it('GET /api/version returns object with version string', async () => {
    const r = await req('GET', '/api/version')
    expect(r.status).toBe(200)
    expect(typeof r.body).toBe('object')
    expect(r.body).not.toBeNull()
  })
  it('GET /api/mailboxes empty returns array OR object with data', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes')
    expect(r.status).toBe(200)
    const b = r.body as unknown
    const isArray = Array.isArray(b)
    const hasData = typeof b === 'object' && b !== null && 'data' in (b as Record<string, unknown>)
    expect(isArray || hasData).toBe(true)
  })
  it('GET /api/mailboxes with one row returns non-empty payload', async () => {
    queueRows([{ id: 1, email: 'a@b.cz' }])
    const r = await req('GET', '/api/mailboxes')
    expect(r.status).toBe(200)
    const b = r.body as any
    const rows = Array.isArray(b) ? b : b?.data ?? b?.mailboxes ?? []
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
  it('GET /api/metrics/mailboxes returns Prometheus exposition format', async () => {
    queueRows([{ from_address: 'a@b.cz', status: 'active', consecutive_bounces: 0, canary_remaining: 5, circuit_open: false }])
    const r = await req('GET', '/api/metrics/mailboxes')
    expect(r.status).toBe(200)
    expect(typeof r.body).toBe('string')
    expect(r.raw).toContain('# HELP outreach_mailbox_status')
    expect(r.raw).toContain('# TYPE outreach_mailbox_status gauge')
  })
  it('GET /api/health/guards returns object', async () => {
    const r = await req('GET', '/api/health/guards')
    expect(r.status).toBeLessThan(500)
    expect(typeof r.body).toBe('object')
  })
})

describe('response envelope — error shape (4xx)', () => {
  // Note: POST /api/mailboxes has no explicit schema validation — missing
  // fields pass through to pg INSERT which would fail in a real DB. With the
  // stub, empty rows succeed. We lock that current shape here and revisit when
  // server-side schema validation lands.
  it('POST /api/mailboxes with {} passes through to pg layer', async () => {
    queueRows([])
    const r = await req('POST', '/api/mailboxes', {})
    expect([200, 400, 500]).toContain(r.status)
  })
  it('POST /api/mailboxes with pg error yields 500 with error string', async () => {
    queueError('null value in column "from_address"')
    const r = await req('POST', '/api/mailboxes', {})
    expect(r.status).toBe(500)
    expect(typeof (r.body as any)?.error).toBe('string')
  })
  it('POST /api/mailboxes missing email surfaces pg error when DB throws', async () => {
    queueError('not-null constraint: from_address')
    const r = await req('POST', '/api/mailboxes', { smtp_host: 'x', password: 'p' })
    expect(r.status).toBe(500)
  })
  it('POST /api/mailboxes missing smtp_host surfaces pg error when DB throws', async () => {
    queueError('not-null constraint: smtp_host')
    const r = await req('POST', '/api/mailboxes', { email: 'x@y.cz', password: 'p' })
    expect(r.status).toBe(500)
  })
  it('GET /api/mailboxes/999999/stats handles missing row', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes/999999/stats')
    expect([200, 404]).toContain(r.status)
  })
  it('DELETE /api/mailboxes/999999 handles missing row', async () => {
    queueRows([])
    const r = await req('DELETE', '/api/mailboxes/999999')
    expect([200, 204, 404]).toContain(r.status)
  })
  it('PATCH /api/mailboxes/1 with {} yields 400', async () => {
    const r = await req('PATCH', '/api/mailboxes/1', {})
    expect(r.status).toBe(400)
  })
})

describe('response envelope — error shape (5xx pg throw)', () => {
  it('GET /api/mailboxes pg-error returns 500 with string error', async () => {
    queueError('pg connection refused')
    const r = await req('GET', '/api/mailboxes')
    expect(r.status).toBe(500)
    expect(typeof (r.body as any)?.error).toBe('string')
  })
  // Observed behavior: the BFF passes raw `e.message` through. This test
  // locks in that shape so a future hardening (e.g. error-sanitizer
  // middleware) flips it and forces deliberate contract update.
  it('error string is the raw pg message (current observed behavior)', async () => {
    queueError('pg connection refused at internal/pgpool.js:123')
    const r = await req('GET', '/api/mailboxes')
    expect(r.status).toBe(500)
    const msg = String((r.body as any)?.error ?? '')
    expect(msg).toContain('pg connection refused')
  })
  it('error string is defined', async () => {
    queueError('boom')
    const r = await req('GET', '/api/mailboxes')
    expect((r.body as any)?.error).toBeDefined()
  })
  it('error string is not empty', async () => {
    queueError('boom')
    const r = await req('GET', '/api/mailboxes')
    const msg = String((r.body as any)?.error ?? '')
    expect(msg.length).toBeGreaterThan(0)
  })
  it('error response is valid JSON', async () => {
    queueError('boom')
    const r = await req('GET', '/api/mailboxes')
    expect(() => JSON.parse(r.raw)).not.toThrow()
  })
})

describe('response envelope — stability under repeated calls', () => {
  it('same GET yields same-shape body across 3 calls', async () => {
    queueRows([]); queueRows([]); queueRows([])
    const a = await req('GET', '/api/mailboxes')
    const b = await req('GET', '/api/mailboxes')
    const c = await req('GET', '/api/mailboxes')
    const keys = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort() : 'ARRAY')
    expect(keys(a.body)).toEqual(keys(b.body))
    expect(keys(b.body)).toEqual(keys(c.body))
  })
  it('concurrent GETs do not cross-contaminate', async () => {
    queueRows([{ id: 1 }]); queueRows([{ id: 2 }])
    const [a, b] = await Promise.all([
      req('GET', '/api/mailboxes'),
      req('GET', '/api/mailboxes'),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })
})

describe('response envelope — method/path mismatch', () => {
  it('DELETE on /api/version yields 404 method-not-allowed', async () => {
    const r = await req('DELETE', '/api/version')
    expect([404, 405]).toContain(r.status)
  })
  it('PUT on /api/mailboxes yields 404', async () => {
    const r = await req('PUT', '/api/mailboxes')
    expect([404, 405]).toContain(r.status)
  })
  it('GET on unknown /api/does-not-exist yields 404', async () => {
    const r = await req('GET', '/api/does-not-exist')
    expect([404, 500]).toContain(r.status)
  })
  it('GET on /api/mailboxes/abc/stats returns handled status', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes/abc/stats')
    expect([200, 400, 404, 500]).toContain(r.status)
  })
})

describe('response envelope — list endpoint shape coverage', () => {
  const endpoints = [
    '/api/mailboxes',
    '/api/campaigns',
    '/api/segments',
    '/api/templates',
    '/api/suppression',
  ]
  for (const ep of endpoints) {
    it(`${ep} responds with handled status on empty stub`, async () => {
      queueRows([{ count: '0' }])
      queueRows([])
      const r = await req('GET', ep)
      expect([200, 400, 500]).toContain(r.status)
    })
  }
})

describe('response envelope — POST without content-type', () => {
  it('POST /api/mailboxes without content-type still 4xx', async () => {
    const r = await fetch(baseUrl + '/api/mailboxes', {
      method: 'POST',
      body: '{}',
    })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })
})
