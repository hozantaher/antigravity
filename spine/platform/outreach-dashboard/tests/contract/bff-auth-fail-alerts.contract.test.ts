/**
 * BFF contract — GET /api/health/auth-fail-alerts (SEND-S6.3 UI surface)
 *
 * Returns watchdog_events rows with event_type='auth_fail_alert' from the
 * last 24h, joined against outreach_mailboxes so orphan rows (mailbox
 * deleted after the alert fired) are excluded rather than surfaced to the
 * operator as broken state.
 *
 * Contract locks in:
 *   - shape: { alerts: [{ mailbox_id, from_address, created_at, fail_count }], count }
 *   - empty → { alerts: [], count: 0 }
 *   - 24h windowing (query uses interval '24 hours')
 *   - sort order DESC by created_at
 *   - graceful degradation when watchdog_events table missing (relation does
 *     not exist) — returns empty, not 500
 *   - 500 on generic pg throw + JSON error envelope
 *   - parameterized SQL (no string concatenation of user input — this endpoint
 *     takes no user input, but the invariant is that the SQL string must
 *     contain the literal interval, not interpolated)
 *   - AUTH_EXEMPT: response does not depend on x-api-key presence
 *   - responses never include raw password or sensitive mailbox fields
 *   - unsupported methods reject (404 from express or handler-level 405)
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
  calls.length = 0
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(err: Error) { queryQueue.push(err) }

async function req(method: string, path: string, headers?: Record<string, string>) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...(headers ?? {}) } }
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text }
}

const ROUTE = '/api/health/auth-fail-alerts'

describe('GET /api/health/auth-fail-alerts', () => {
  it('empty — returns { alerts: [], count: 0 }', async () => {
    queueRows([])
    const r = await req('GET', ROUTE)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ alerts: [], count: 0 })
  })

  it('single alert — shape is { mailbox_id, from_address, created_at, fail_count }', async () => {
    queueRows([
      { mailbox_id: 3, from_address: 'a.mazher@email.cz', created_at: '2026-04-22T10:00:00Z', fail_count: 4 },
    ])
    const r = await req('GET', ROUTE)
    expect(r.status).toBe(200)
    const body = r.body as { alerts: Array<Record<string, unknown>>; count: number }
    expect(body.count).toBe(1)
    expect(body.alerts).toHaveLength(1)
    const a = body.alerts[0]
    expect(a.mailbox_id).toBe(3)
    expect(a.from_address).toBe('a.mazher@email.cz')
    expect(a.created_at).toBe('2026-04-22T10:00:00Z')
    expect(a.fail_count).toBe(4)
  })

  it('three alerts — count matches, rows preserve DB order (caller sorts DESC)', async () => {
    // Handler trusts the SQL ORDER BY — we verify the query string below and
    // assert the response mirrors the queued row order (newest first).
    queueRows([
      { mailbox_id: 5, from_address: 'c@e.cz', created_at: '2026-04-22T12:00:00Z', fail_count: 3 },
      { mailbox_id: 3, from_address: 'a@e.cz', created_at: '2026-04-22T11:30:00Z', fail_count: 5 },
      { mailbox_id: 4, from_address: 'b@e.cz', created_at: '2026-04-22T10:15:00Z', fail_count: 4 },
    ])
    const r = await req('GET', ROUTE)
    expect(r.status).toBe(200)
    const body = r.body as { alerts: Array<{ created_at: string }>; count: number }
    expect(body.count).toBe(3)
    expect(body.alerts.map((a) => a.created_at)).toEqual([
      '2026-04-22T12:00:00Z',
      '2026-04-22T11:30:00Z',
      '2026-04-22T10:15:00Z',
    ])
  })

  it('query uses 24h interval window and ORDER BY created_at DESC', async () => {
    queueRows([])
    await req('GET', ROUTE)
    const q = calls.find((c) => /auth_fail_alert/.test(c.sql))
    expect(q).toBeTruthy()
    expect(q!.sql).toMatch(/interval\s+'24 hours'/i)
    expect(q!.sql).toMatch(/ORDER BY[\s\S]*created_at[\s\S]*DESC/i)
    expect(q!.sql).toMatch(/event_type\s*=\s*'auth_fail_alert'/i)
  })

  it('query joins outreach_mailboxes — orphan alerts (mailbox deleted) are excluded', async () => {
    // The SQL uses an INNER JOIN so rows with mailbox_id pointing at a deleted
    // mailbox never reach the response. We assert the join by inspecting the
    // statement text — pg stub returns whatever we queue regardless.
    queueRows([])
    await req('GET', ROUTE)
    const q = calls.find((c) => /auth_fail_alert/.test(c.sql))
    expect(q).toBeTruthy()
    expect(q!.sql).toMatch(/JOIN\s+outreach_mailboxes/i)
  })

  it('pg throws unexpected error → 500 + { error }', async () => {
    queueError(new Error('ETIMEDOUT pg pool'))
    const r = await req('GET', ROUTE)
    expect(r.status).toBe(500)
    expect(typeof (r.body as { error: string }).error).toBe('string')
  })

  it('missing watchdog_events table (pre-migration) → 200 empty (graceful)', async () => {
    queueError(new Error('relation "watchdog_events" does not exist'))
    const r = await req('GET', ROUTE)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ alerts: [], count: 0 })
  })

  it('non-GET method does not respond 200', async () => {
    // Express returns 404 (no matching route) for POST/DELETE on a GET-only
    // route. Either 404 or 405 is an acceptable non-200 contract — this
    // endpoint must never accept writes.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      queueRows([])
      const r = await req(method, ROUTE)
      expect([404, 405]).toContain(r.status)
    }
  })

  it('response never contains sensitive mailbox columns (password, smtp_host, proxy_url)', async () => {
    // Even if the pg stub returns extra columns, the handler must project
    // only the public fields. We feed a poisoned row and assert it's filtered.
    queueRows([
      {
        mailbox_id: 3,
        from_address: 'a@e.cz',
        created_at: '2026-04-22T10:00:00Z',
        fail_count: 4,
        password: 'SHOULD-NEVER-LEAK',
        smtp_host: 'smtp.seznam.cz',
        proxy_url: 'socks5://u:p@h:1080',
      },
    ])
    const r = await req('GET', ROUTE)
    expect(r.status).toBe(200)
    expect(r.raw).not.toContain('SHOULD-NEVER-LEAK')
    expect(r.raw).not.toContain('socks5://')
    expect(r.raw).not.toContain('smtp.seznam.cz')
  })

  it('auth-exempt — operator gets alerts even without x-api-key (banner must stay visible)', async () => {
    // Simulate prod auth on. AUTH_EXEMPT includes this route → call succeeds.
    const prev = process.env.BFF_AUTH_DISABLED
    const prevKey = process.env.OUTREACH_API_KEY
    process.env.BFF_AUTH_DISABLED = '0'
    process.env.OUTREACH_API_KEY = 'some-prod-key-xyz'
    try {
      queueRows([])
      const r = await req('GET', ROUTE) // no x-api-key header
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ alerts: [], count: 0 })
    } finally {
      if (prev === undefined) delete process.env.BFF_AUTH_DISABLED
      else process.env.BFF_AUTH_DISABLED = prev
      if (prevKey === undefined) delete process.env.OUTREACH_API_KEY
      else process.env.OUTREACH_API_KEY = prevKey
    }
  })

  it('fail_count is numeric when present in metadata', async () => {
    queueRows([
      { mailbox_id: 7, from_address: 'x@e.cz', created_at: '2026-04-22T09:00:00Z', fail_count: 6 },
    ])
    const r = await req('GET', ROUTE)
    const body = r.body as { alerts: Array<{ fail_count: unknown }> }
    expect(typeof body.alerts[0].fail_count).toBe('number')
  })

  it('does not call pool.query with user-controlled string concatenation', async () => {
    queueRows([])
    await req('GET', ROUTE)
    // Safety: this route takes no user input. The only params are SQL
    // literals already inside the query string. Either zero params OR an
    // empty params array are acceptable — but if params exist, none of them
    // should be user-injectable.
    const q = calls.find((c) => /auth_fail_alert/.test(c.sql))
    expect(q).toBeTruthy()
    // No :id, no $1 placeholders should require user input — this query is
    // a pure constant lookup. Params array should be empty or undefined.
    if (q!.params) {
      expect(q!.params).toEqual([])
    }
  })
})
