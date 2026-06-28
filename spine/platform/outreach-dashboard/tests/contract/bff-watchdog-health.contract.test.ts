// ═══════════════════════════════════════════════════════════════════════
//  BFF contract — watchdog + guards health endpoints
//
//  Covers:
//    GET /api/health/watchdog  — shape, empty DB, DB error, concurrent
//    GET /api/health/guards    — last_run field, null last_run
// ═══════════════════════════════════════════════════════════════════════

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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY', 'BFF_AUTH_DISABLED']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.OUTREACH_API_KEY = 'test-key-12345'
  delete process.env.BFF_AUTH_DISABLED  // Override global setup.ts default
  vi.resetModules()  // Force re-import so auth middleware reads fresh env
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
  calls.length = 0
  // Reset auth env for each test (setup.ts tries to restore BFF_AUTH_DISABLED=1)
  delete process.env.BFF_AUTH_DISABLED
  process.env.OUTREACH_API_KEY = 'test-key-12345'
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function get(path: string, headers?: Record<string, string>) {
  const opts: RequestInit = {}
  if (headers) opts.headers = headers
  const r = await fetch(baseUrl + path, opts)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/health/watchdog
// ═══════════════════════════════════════════════════════════════════════

const authHeader = { 'x-api-key': 'test-key-12345' }

describe('GET /api/health/watchdog', () => {
  it('returns watchdog health shape with all required fields', async () => {
    const recent = new Date(Date.now() - 30_000).toISOString()
    queueRows([{}]) // audit log insert success
    queueRows([{ created_at: recent }])
    queueRows([{ event_type: 'auto_pause', n: 3 }])
    const res = await get('/api/health/watchdog', authHeader)
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    // All four required fields must be present
    expect(body).toHaveProperty('last_event_at')
    expect(body).toHaveProperty('stale')
    expect(body).toHaveProperty('counts_24h')
    expect(body).toHaveProperty('healthy')
    // Types must match contract
    expect(typeof body.stale).toBe('boolean')
    expect(typeof body.healthy).toBe('boolean')
    expect(typeof body.counts_24h).toBe('object')
  })

  it('healthy:true and stale:false when recent event exists (< 15min)', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString() // 1 minute ago
    queueRows([{}]) // audit log insert
    queueRows([{ created_at: recent }])
    queueRows([])
    const res = await get('/api/health/watchdog', authHeader)
    expect(res.status).toBe(200)
    const body = res.body as { healthy: boolean; stale: boolean }
    expect(body.healthy).toBe(true)
    expect(body.stale).toBe(false)
  })

  it('empty DB → graceful response with stale:true and null last_event_at', async () => {
    queueRows([{}])  // audit log insert
    queueRows([])    // no events — last query returns empty
    queueRows([])    // counts query also empty
    const res = await get('/api/health/watchdog', authHeader)
    expect(res.status).toBe(200)
    const body = res.body as { last_event_at: null; stale: boolean; healthy: boolean; counts_24h: Record<string, unknown> }
    expect(body.last_event_at).toBeNull()
    expect(body.stale).toBe(true)
    expect(body.healthy).toBe(false)
    expect(body.counts_24h).toEqual({})
  })

  it('DB error on missing table → 200 fallback (not 500)', async () => {
    queueRows([{}])  // audit log insert
    queueError('relation "watchdog_events" does not exist')
    const res = await get('/api/health/watchdog', authHeader)
    // BFF catches missing-table error and returns graceful 200
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      last_event_at: null,
      stale: true,
      counts_24h: {},
      healthy: false,
    })
  })

  it('DB error on generic pg error → 500', async () => {
    queueRows([{}])  // audit log insert
    queueError('connection refused')
    const res = await get('/api/health/watchdog', authHeader)
    expect(res.status).toBe(500)
  })

  it('counts_24h maps event_type → count correctly', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    queueRows([{}]) // audit log insert
    queueRows([{ created_at: recent }])
    queueRows([
      { event_type: 'auto_pause', n: 4 },
      { event_type: 'proxy_reassign', n: 2 },
    ])
    const res = await get('/api/health/watchdog', authHeader)
    const counts = (res.body as { counts_24h: Record<string, number> }).counts_24h
    expect(counts.auto_pause).toBe(4)
    expect(counts.proxy_reassign).toBe(2)
  })

  it('counts query uses 24-hour interval window', async () => {
    queueRows([{}]) // audit log insert
    queueRows([])
    queueRows([])
    await get('/api/health/watchdog', authHeader)
    // Skip the audit INSERT call; check second and third queries
    // calls[0] = audit INSERT, calls[1] = last event query, calls[2] = counts query
    expect(calls[2].sql).toMatch(/24 hours/i)
  })

  it('SECURITY: requires X-API-Key header (401 without auth)', async () => {
    const res = await get('/api/health/watchdog')
    expect(res.status).toBe(401)
    const body = res.body as Record<string, string>
    expect(body.error).toBe('unauthorized')
  })

  it('SECURITY: accepts valid X-API-Key header', async () => {
    queueRows([{}]) // audit log insert
    queueRows([]) // last event
    queueRows([]) // counts
    const res = await get('/api/health/watchdog', { 'x-api-key': 'test-key-12345' })
    expect(res.status).toBe(200)
  })

  it('SECURITY: rejects invalid X-API-Key header', async () => {
    const res = await get('/api/health/watchdog', { 'x-api-key': 'wrong-key' })
    expect(res.status).toBe(401)
  })

  it('AUDIT: logs access to operator_audit_log when X-API-Key is valid', async () => {
    queueRows([{}]) // audit log insert → success
    queueRows([]) // last event
    queueRows([]) // counts
    await get('/api/health/watchdog', { 'x-api-key': 'test-key-12345' })
    // First call should be the audit log INSERT
    expect(calls[0].sql).toMatch(/INSERT INTO operator_audit_log/)
    expect(calls[0].sql).toMatch(/watchdog_api_read/)
  })

  it('AUDIT: audit log failure (missing table) does not block endpoint', async () => {
    queueError('relation "operator_audit_log" does not exist') // audit table missing
    queueRows([{}]) // still need to queue for the main handler
    queueRows([]) // last event
    queueRows([]) // counts
    const res = await get('/api/health/watchdog', { 'x-api-key': 'test-key-12345' })
    // Endpoint should still succeed even if audit log table missing
    expect(res.status).toBe(200)
  })

  it('MONKEY: concurrent requests → server survives (10 parallel)', async () => {
    // Queue enough rows for all 10 concurrent requests
    // Each request: 1 audit INSERT, 1 last event query, 1 counts query
    for (let i = 0; i < 10; i++) {
      queueRows([{}]) // audit log insert
      queueRows([]) // last event query → empty
      queueRows([]) // counts query → empty
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, () => get('/api/health/watchdog', authHeader))
    )
    for (const r of results) {
      expect([200, 500]).toContain(r.status)
      // None should be an unhandled crash (non-HTTP response)
      expect(r.body).not.toBeNull()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/health/guards
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/health/guards', () => {
  it('returns last_run field in response', async () => {
    const res = await get('/api/health/guards')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body).toHaveProperty('last_run')
  })

  it('null last_run is valid (server just booted, guards not yet run)', async () => {
    // GET /api/health/guards reads lastStaleGuardRun which is null on fresh boot
    const res = await get('/api/health/guards')
    expect(res.status).toBe(200)
    // last_run can be null — this is the normal "not yet run" state
    const body = res.body as { last_run: unknown }
    expect(body.last_run === null || body.last_run === undefined || typeof body.last_run === 'string').toBe(true)
  })

  it('response is always 200 (synchronous in-memory read, no DB call)', async () => {
    // /api/health/guards does not touch the DB — it returns an in-memory value
    const res = await get('/api/health/guards')
    expect(res.status).toBe(200)
    // No DB calls should have been made
    expect(calls).toHaveLength(0)
  })

  it('concurrent requests → all succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => get('/api/health/guards'))
    )
    for (const r of results) {
      expect(r.status).toBe(200)
      expect((r.body as Record<string, unknown>)).toHaveProperty('last_run')
    }
  })
})
