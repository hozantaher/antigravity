// ═══════════════════════════════════════════════════════════════════════════
//  AS3 BFF contract — mailbox creation pool gate + GET /api/relay/pool-capacity
//
//  Covers:
//    POST /api/mailboxes    — succeeds when pool has free endpoints
//    POST /api/mailboxes    — 503 pool_exhausted when pool full
//    POST /api/mailboxes    — no gate when WIREPROXY_POOL_CONFIG unset (pool_size=0)
//    GET /api/relay/pool-capacity  — returns correct shape
//    GET /api/relay/pool-capacity  — filters by environment
//    preFlightPoolCapacity  — unit: calculates free_count correctly
//    preFlightPoolCapacity  — unit: pool_size=0 always can_add=false
// ═══════════════════════════════════════════════════════════════════════════

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
        query: async (sql: string, params?: unknown[]) => self.query(sql, params),
        release: () => {},
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'WIREPROXY_POOL_CONFIG']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
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
})

function queueRows(rows: unknown[]) {
  queryQueue.push({ rows })
}
function queueError(msg: string) {
  queryQueue.push(new Error(msg))
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text }
}

// ─── GET /api/relay/pool-capacity ────────────────────────────────────────────

describe('GET /api/relay/pool-capacity', () => {
  it('returns correct shape with pool_size from WIREPROXY_POOL_CONFIG', async () => {
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'ep-a', socks_addr: '127.0.0.1:1080' },
      { label: 'ep-b', socks_addr: '127.0.0.1:1081' },
      { label: 'ep-c', socks_addr: '127.0.0.1:1082' },
    ])
    // P0.1 fix: mountPoolCapacityRoutes makes 2 DB queries when endpoints.length > 0:
    //   1. COUNT pinned (preFlightPoolCapacity)
    //   2. SELECT id, from_address, pinned_endpoint_label (endpoint detail enrichment)
    queueRows([{ pinned: 1 }]) // query 1: COUNT
    queueRows([]) // query 2: endpoint detail (no rows for test simplicity)

    const r = await req('GET', '/api/relay/pool-capacity')
    expect(r.status).toBe(200)
    const body = r.body as Record<string, unknown>
    expect(body.pool_size).toBe(3)
    expect(body.pinned_count).toBe(1)
    expect(body.free_count).toBe(2)
    expect(body.can_add).toBe(true)
    // richer response: must include endpoints array
    expect(Array.isArray(body.endpoints)).toBe(true)
    expect((body.endpoints as unknown[]).length).toBe(3)

    process.env.WIREPROXY_POOL_CONFIG = savedEnv.WIREPROXY_POOL_CONFIG
  })

  it('returns pool_size=0 when WIREPROXY_POOL_CONFIG unset', async () => {
    delete process.env.WIREPROXY_POOL_CONFIG
    // pool_size=0 → preFlightPoolCapacity short-circuits without any DB query.

    const r = await req('GET', '/api/relay/pool-capacity')
    expect(r.status).toBe(200)
    const body = r.body as Record<string, unknown>
    expect(body.pool_size).toBe(0)
    expect(body.can_add).toBe(false)

    process.env.WIREPROXY_POOL_CONFIG = savedEnv.WIREPROXY_POOL_CONFIG
  })

  it('filters by environment query param', async () => {
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'ep-a' }, { label: 'ep-b' },
    ])
    // P0.1 fix: 2 queries — COUNT + endpoint detail
    queueRows([{ pinned: 0 }]) // COUNT
    queueRows([]) // endpoint detail

    const r = await req('GET', '/api/relay/pool-capacity?env=test')
    expect(r.status).toBe(200)

    // Verify the DB queries used 'test' as the env filter
    const envCalls = calls.filter(c => c.sql.includes('environment'))
    expect(envCalls.length).toBeGreaterThanOrEqual(1)
    // At least one env-filtered call should have 'test' as param
    const testEnvCall = envCalls.find(c => Array.isArray(c.params) && c.params.includes('test'))
    expect(testEnvCall).toBeTruthy()

    process.env.WIREPROXY_POOL_CONFIG = savedEnv.WIREPROXY_POOL_CONFIG
  })
})

// ─── POST /api/mailboxes — pool gate ─────────────────────────────────────────

describe('POST /api/mailboxes pool gate (AS3)', () => {
  it('allows creation when pool has free endpoints', async () => {
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'ep-a' }, { label: 'ep-b' },
    ])
    // capacity check: 1 pinned of 2
    queueRows([{ pinned: 1 }])
    // INSERT mailbox RETURNING
    queueRows([{
      id: 99, email: 'new@test.cz', display_name: 'New', host: 'smtp.cz',
      port: 587, smtp_username: 'new@test.cz', imap_host: null, imap_port: null,
      status: 'active', status_reason: null, daily_limit: 100, total_sent: 0,
      total_bounced: 0, consecutive_bounces: 0, last_send_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }])

    const r = await req('POST', '/api/mailboxes', {
      email: 'new@test.cz', smtp_host: 'smtp.cz', smtp_port: 587, password: 'secure123!',
    })
    // 200 success or non-503 (gate passed, downstream error is acceptable)
    expect(r.status).not.toBe(503)

    process.env.WIREPROXY_POOL_CONFIG = savedEnv.WIREPROXY_POOL_CONFIG
  })

  it('rejects with 503 pool_exhausted when pool full', async () => {
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'ep-a' }, { label: 'ep-b' },
    ])
    // Both endpoints pinned
    queueRows([{ pinned: 2 }])

    const r = await req('POST', '/api/mailboxes', {
      email: 'blocked@test.cz', smtp_host: 'smtp.cz', password: 'secure123!',
    })
    expect(r.status).toBe(503)
    const body = r.body as Record<string, unknown>
    expect(body.error).toBe('pool_exhausted')
    expect(body.pool_size).toBe(2)
    expect(body.pinned_count).toBe(2)
    expect(typeof body.message).toBe('string')
    expect(typeof body.runbook).toBe('string')

    process.env.WIREPROXY_POOL_CONFIG = savedEnv.WIREPROXY_POOL_CONFIG
  })

  it('skips gate when WIREPROXY_POOL_CONFIG unset (pool_size=0)', async () => {
    delete process.env.WIREPROXY_POOL_CONFIG
    // capacity check: 0 pinned of 0
    queueRows([{ pinned: 0 }])
    // INSERT RETURNING row
    queueRows([{
      id: 100, email: 'nopool@test.cz', display_name: 'NoPool', host: 'smtp.cz',
      port: 587, smtp_username: 'nopool@test.cz', imap_host: null, imap_port: null,
      status: 'active', status_reason: null, daily_limit: 100, total_sent: 0,
      total_bounced: 0, consecutive_bounces: 0, last_send_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }])

    const r = await req('POST', '/api/mailboxes', {
      email: 'nopool@test.cz', smtp_host: 'smtp.cz', password: 'secure123!',
    })
    // Should NOT 503 even though "pool is empty" — gate skipped when pool_size=0
    expect(r.status).not.toBe(503)

    process.env.WIREPROXY_POOL_CONFIG = savedEnv.WIREPROXY_POOL_CONFIG
  })
})

// ─── preFlightPoolCapacity unit tests ────────────────────────────────────────

describe('preFlightPoolCapacity (unit)', () => {
  it('computes free_count = pool_size - pinned_count', async () => {
    const { preFlightPoolCapacity } = await import('../../src/server-routes/mailboxes.js')
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([
      { label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' },
    ])
    const mockPool = {
      query: async () => ({ rows: [{ pinned: 2 }] }),
    }
    const cap = await preFlightPoolCapacity(mockPool as never, 'production')
    expect(cap.pool_size).toBe(4)
    expect(cap.pinned_count).toBe(2)
    expect(cap.free_count).toBe(2)
    expect(cap.can_add).toBe(true)

    process.env.WIREPROXY_POOL_CONFIG = savedEnv.WIREPROXY_POOL_CONFIG
  })

  it('free_count floors at 0 when pinned exceeds pool_size', async () => {
    const { preFlightPoolCapacity } = await import('../../src/server-routes/mailboxes.js')
    process.env.WIREPROXY_POOL_CONFIG = JSON.stringify([{ label: 'a' }])
    const mockPool = {
      query: async () => ({ rows: [{ pinned: 3 }] }), // stale data edge case
    }
    const cap = await preFlightPoolCapacity(mockPool as never, 'production')
    expect(cap.free_count).toBe(0)
    expect(cap.can_add).toBe(false)

    process.env.WIREPROXY_POOL_CONFIG = savedEnv.WIREPROXY_POOL_CONFIG
  })
})
