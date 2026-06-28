// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — campaigns CRUD extended + MONKEY
//
//  POST /api/campaigns  — additional create scenarios + monkey payloads
//  GET  /api/campaigns/:id — additional detail scenarios
//  PATCH /api/campaigns/:id — status update variants + monkey payloads
//
//  Complements bff-campaigns.contract.test.ts (list + basic create + detail)
//  and bff-campaigns-actions.contract.test.ts (run/pause/patch/delete).
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class PoolClient {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    release() {}
  }

  class Pool {
    async connect(): Promise<PoolClient> {
      return new PoolClient()
    }
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// ── Go-proxy fetch stub ──────────────────────────────────────────────────────
// Sprint C1 (#1254): POST /api/campaigns now proxies to Go service.
// Tests that exercise the success / error path set GO_SERVER_URL and push
// Go response entries; all other URLs pass through to the real fetch.
type FetchStubResult = { ok: boolean; status: number; body: string }
const fetchQueue: FetchStubResult[] = []
let realFetch: typeof fetch

function installFetchStub() {
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input)
    if (url.startsWith('http://go-stub.local')) {
      if (!fetchQueue.length) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const next = fetchQueue.shift()!
      return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch
}

let baseUrl = ''
let server: import('http').Server

const savedEnv: Record<string, string | undefined> = {}
beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  installFetchStub()
  const mod = await import('../../server.js')
  // Strip AFTER import — Vite's loadEnv repopulates GO_SERVER_URL from .env.
  // Tests that exercise the Go-proxy path set it per-test.
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
  await new Promise<void>((resolve) => server.close(() => resolve()))
  globalThis.fetch = realFetch
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
  fetchQueue.length = 0
  delete process.env.GO_SERVER_URL
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/campaigns (create) — extended scenarios
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/campaigns (create)', () => {
  it('valid body → 200 with id (BFF returns 200, not 201)', async () => {
    // Sprint C1 (#1254): create is now proxied to Go; BFF does a SELECT after Go succeeds.
    process.env.GO_SERVER_URL = 'http://go-stub.local'
    fetchQueue.push({ ok: true, status: 200, body: JSON.stringify({ id: 99, estimate: 0 }) })
    queueRows([{ id: 99, name: 'Alpha', description: null, status: 'draft', category_paths: [], sequence_config: [], category_match: 'prefix', created_at: '2026-04-24' }])
    const res = await req('POST', '/api/campaigns', { name: 'Alpha' })
    expect(res.status).toBe(200)
    expect((res.body as any).id).toBe(99)
  })

  it('missing name → 400 with {error}', async () => {
    const res = await req('POST', '/api/campaigns', {})
    expect(res.status).toBe(400)
    expect((res.body as any).error).toBeTruthy()
  })

  it('empty string name → 400', async () => {
    const res = await req('POST', '/api/campaigns', { name: '' })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toBeTruthy()
  })

  it('DB error on INSERT → 500', async () => {
    // Sprint C1: DB INSERT is owned by Go. Equivalent failure: Go returns 500.
    // BFF forwards the error status via res.status(r.status).
    process.env.GO_SERVER_URL = 'http://go-stub.local'
    fetchQueue.push({ ok: false, status: 500, body: JSON.stringify({ error: 'unique_violation' }) })
    const res = await req('POST', '/api/campaigns', { name: 'Dup' })
    expect(res.status).toBe(500)
    expect((res.body as any).error).toBeTruthy()
  })

  it('MONKEY: 10 different payloads, none crash server (all return 4xx or 5xx)', async () => {
    const monkeyPayloads = [
      null,
      undefined,
      '',
      'raw string',
      42,
      [],
      [1, 2, 3],
      { name: null },
      { name: 0 },
      { name: true },
    ]

    for (const payload of monkeyPayloads) {
      // Queue a DB error in case it somehow passes validation and hits DB
      queueError('monkey stub error')

      let res: { status: number; body: unknown }
      if (payload === undefined) {
        // Send request with no body at all
        const r = await fetch(baseUrl + '/api/campaigns', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        })
        const text = await r.text()
        let json: unknown = null
        try { json = text ? JSON.parse(text) : null } catch { json = text }
        res = { status: r.status, body: json }
      } else {
        const bodyStr = payload === '' ? '' : JSON.stringify(payload)
        const r = await fetch(baseUrl + '/api/campaigns', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: bodyStr,
        })
        const text = await r.text()
        let json: unknown = null
        try { json = text ? JSON.parse(text) : null } catch { json = text }
        res = { status: r.status, body: json }
      }

      // Server must not crash — status must be a valid HTTP status
      expect(res.status, `payload ${JSON.stringify(payload)} → unexpected status`).toBeGreaterThanOrEqual(200)
      expect(res.status, `payload ${JSON.stringify(payload)} → unexpected status`).toBeLessThan(600)
      // None should return 2xx for invalid payloads (none have a valid string name)
      expect(res.status, `payload ${JSON.stringify(payload)} must not be 2xx`).not.toBeLessThan(400)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/campaigns/:id — extended scenarios
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/campaigns/:id', () => {
  it('existing → 200 with campaign + stats shape', async () => {
    queueRows([{
      id: 5, name: 'Beta', description: null, status: 'active',
      category_paths: ['stavebnictvi%'], sequence_config: [],
      category_match: 'prefix', created_at: '2026-04-01', updated_at: '2026-04-10',
    }])
    queueRows([{ status: 'sent', cnt: 30 }, { status: 'opened', cnt: 15 }])
    const res = await req('GET', '/api/campaigns/5')
    expect(res.status).toBe(200)
    const body = res.body as any
    expect(body.campaign).toBeDefined()
    expect(body.campaign.id).toBe(5)
    expect(body.stats).toBeDefined()
    expect(body.stats.sent).toBe(30)
    expect(body.stats.opened).toBe(15)
  })

  it('nonexistent id → 404', async () => {
    queueRows([]) // empty result set
    const res = await req('GET', '/api/campaigns/99999')
    expect(res.status).toBe(404)
    expect((res.body as any).error).toBeTruthy()
  })

  it('DB error on lookup → 500', async () => {
    queueError('connection lost')
    const res = await req('GET', '/api/campaigns/1')
    expect(res.status).toBe(500)
    expect((res.body as any).error).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PATCH /api/campaigns/:id (update) — extended scenarios
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /api/campaigns/:id (update)', () => {
  it('status change → 200 with updated row', async () => {
    const row = { id: 3, name: 'Gamma', status: 'paused', stats: {}, created_at: '2026-04-01' }
    // PATCH handler: BEGIN → SELECT id,status → UPDATE RETURNING → audit INSERT → COMMIT
    queueRows([]) // BEGIN
    queueRows([{ id: 3, status: 'running' }]) // SELECT current state
    queueRows([row]) // UPDATE RETURNING
    const res = await req('PATCH', '/api/campaigns/3', { status: 'paused' })
    expect(res.status).toBe(200)
    expect((res.body as any).status).toBe('paused')
  })

  it('unknown id → 404 (campaign not found before UPDATE)', async () => {
    // PATCH now checks campaign existence via SELECT before UPDATE.
    queueRows([]) // BEGIN
    // SELECT returns empty → 404
    const res = await req('PATCH', '/api/campaigns/99999', { status: 'archived' })
    expect(res.status).toBe(404)
  })

  it('DB error → 500', async () => {
    queueError('deadlock detected')
    const res = await req('PATCH', '/api/campaigns/1', { status: 'active' })
    expect(res.status).toBe(500)
    expect((res.body as any).error).toBeTruthy()
  })

  it('MONKEY: various patch payloads never crash server', async () => {
    const monkeyPayloads = [
      {},
      { status: null },
      { status: 123 },
      { status: '' },
      { status: 'a'.repeat(1000) },
      { unknown_field: true },
      'raw string',
      [],
    ]

    for (const payload of monkeyPayloads) {
      // Queue a stub result — for non-crashing payloads, PATCH hits DB
      queueRows([])
      queueError('monkey patch stub')

      const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload)
      const r = await fetch(baseUrl + '/api/campaigns/1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: bodyStr,
      })
      const text = await r.text()
      let json: unknown = null
      try { json = text ? JSON.parse(text) : null } catch { json = text }
      const res = { status: r.status, body: json }

      // Server must not crash — always returns a valid HTTP response
      expect(res.status, `PATCH payload ${JSON.stringify(payload)} → invalid status`).toBeGreaterThanOrEqual(200)
      expect(res.status, `PATCH payload ${JSON.stringify(payload)} → invalid status`).toBeLessThan(600)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/campaigns/:id/launch-stats — Day 1 launch monitoring widget
// ═══════════════════════════════════════════════════════════════════════
describe('GET /api/campaigns/:id/launch-stats', () => {
  function queueLaunchHappy() {
    queueRows([{ id: 1, name: 'Strojírenství', status: 'active' }])
    queueRows([{
      sent_1h: 5, bounced_1h: 0, suppressed_1h: 0,
      sent_24h: 7, bounced_24h: 1,
      last_send_at: '2026-05-05T07:14:00Z',
    }])
    queueRows([{ active: 193, eligible_now: 7, completed: 0 }])
  }

  it('happy path → 200 with full launch envelope', async () => {
    queueLaunchHappy()
    const res = await req('GET', '/api/campaigns/1/launch-stats')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.campaign).toMatchObject({ id: 1, name: 'Strojírenství', status: 'active' })
    expect(body.sent_1h).toBe(5)
    expect(body.bounced_1h).toBe(0)
    expect(body.sent_24h).toBe(7)
    expect(body.bounced_24h).toBe(1)
    expect(body.contacts_active).toBe(193)
    expect(body.contacts_eligible_now).toBe(7)
    expect(typeof body.generated_at).toBe('string')
  })

  it('non-numeric id → 400', async () => {
    const res = await req('GET', '/api/campaigns/abc/launch-stats')
    expect(res.status).toBe(400)
  })

  it('campaign missing → 200 with null campaign + zero counters (graceful, no 404 noise)', async () => {
    // Bug fix: campaign not found now returns 200 zero-state so the
    // LaunchStatsRow widget hides silently (no browser console 404 error).
    queueRows([]) // campaigns lookup empty
    const res = await req('GET', '/api/campaigns/99999/launch-stats')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.campaign).toBeNull()
    expect(body.sent_1h).toBe(0)
    expect(body.sent_24h).toBe(0)
    expect(body.contacts_active).toBe(0)
    expect(typeof body.generated_at).toBe('string')
  })

  it('send_events query failure → 200 with zero counters (graceful)', async () => {
    queueRows([{ id: 2, name: 'Test', status: 'active' }])
    queueError('send_events boom')
    queueRows([{ active: 10, eligible_now: 0, completed: 5 }])
    const res = await req('GET', '/api/campaigns/2/launch-stats')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.sent_1h).toBe(0)
    expect(body.sent_24h).toBe(0)
    expect(body.contacts_active).toBe(10)
  })

  it('campaign_contacts query failure → 200 with zero queue counters (graceful)', async () => {
    queueRows([{ id: 3, name: 'Test', status: 'active' }])
    queueRows([{ sent_1h: 1, bounced_1h: 0, suppressed_1h: 0, sent_24h: 1, bounced_24h: 0, last_send_at: null }])
    queueError('campaign_contacts boom')
    const res = await req('GET', '/api/campaigns/3/launch-stats')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.contacts_active).toBe(0)
    expect(body.contacts_eligible_now).toBe(0)
    expect(body.sent_1h).toBe(1)
  })

  it('campaign lookup DB error → 500', async () => {
    queueError('connection lost')
    const res = await req('GET', '/api/campaigns/1/launch-stats')
    expect(res.status).toBe(500)
  })

  it('id with leading zero accepted (regex \\d+)', async () => {
    queueLaunchHappy()
    const res = await req('GET', '/api/campaigns/0001/launch-stats')
    expect(res.status).toBe(200)
  })

  it('id with negative sign rejected', async () => {
    const res = await req('GET', '/api/campaigns/-1/launch-stats')
    expect(res.status).toBe(400)
  })

  it('id with sql injection attempt rejected at regex layer', async () => {
    const res = await req('GET', "/api/campaigns/1';DROP/launch-stats")
    expect([400, 404]).toContain(res.status) // route may 404 before validate
  })

  it('zero-activity campaign → all counters 0 + last_send_at null', async () => {
    queueRows([{ id: 7, name: 'Idle', status: 'paused' }])
    queueRows([{ sent_1h: 0, bounced_1h: 0, suppressed_1h: 0, sent_24h: 0, bounced_24h: 0, last_send_at: null }])
    queueRows([{ active: 0, eligible_now: 0, completed: 0 }])
    const res = await req('GET', '/api/campaigns/7/launch-stats')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.sent_1h).toBe(0)
    expect(body.last_send_at).toBeNull()
    expect(body.contacts_active).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/campaigns/:id/ramp-progress — Day 2+ staircase widget
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/campaigns/:id/ramp-progress', () => {
  it('happy path: campaign with sends → 200 with ramp_stage + daily_counts', async () => {
    queueRows([{ id: 1, name: 'Test Campaign', status: 'running' }])
    queueRows([
      { send_date: '2026-05-05', sent: 5 },
      { send_date: '2026-05-06', sent: 8 },
      { send_date: '2026-05-07', sent: 12 },
    ])
    const res = await req('GET', '/api/campaigns/1/ramp-progress')
    expect(res.status).toBe(200)
    const body = res.body as any
    expect(body.campaign).toBeDefined()
    expect(body.campaign.id).toBe(1)
    expect(body.started_at).toBeDefined()
    expect(body.daily_counts).toBeDefined()
    expect(body.daily_counts.length).toBeGreaterThan(0)
    expect(body.ramp_stage).toBeDefined()
    expect(['pre_launch', 'day_1_5', 'day_2_10', 'day_3_20', 'steady_30']).toContain(body.ramp_stage)
  })

  it('no sends yet → 200 pre_launch state with empty daily_counts', async () => {
    queueRows([{ id: 2, name: 'No Sends Yet', status: 'draft' }])
    queueRows([]) // empty send_events
    const res = await req('GET', '/api/campaigns/2/ramp-progress')
    expect(res.status).toBe(200)
    const body = res.body as any
    expect(body.ramp_stage).toBe('pre_launch')
    expect(body.started_at).toBeNull()
    expect(body.days_since_start).toBe(0)
    expect(body.daily_counts).toEqual([])
  })

  it('multiple days progress → 200 with cumulative daily_counts', async () => {
    queueRows([{ id: 4, name: 'Multi-day', status: 'running' }])
    queueRows([
      { send_date: '2026-05-05', sent: 5 },
      { send_date: '2026-05-06', sent: 7 },
      { send_date: '2026-05-07', sent: 12 },
    ])
    const res = await req('GET', '/api/campaigns/4/ramp-progress')
    expect(res.status).toBe(200)
    const body = res.body as any
    expect(body.daily_counts.length).toBe(3)
    expect(body.daily_counts[0].sent).toBe(5)
    expect(body.daily_counts[1].sent).toBe(7)
    expect(body.daily_counts[2].sent).toBe(12)
  })

  it('missing campaign → 200 pre_launch state (graceful, no 404 console noise)', async () => {
    // Bug fix: campaign not found now returns 200 pre_launch so the
    // RampStaircase widget hides itself silently (no browser console 404 error).
    queueRows([]) // no campaign
    const res = await req('GET', '/api/campaigns/99999/ramp-progress')
    expect(res.status).toBe(200)
    const body = res.body as any
    expect(body.ramp_stage).toBe('pre_launch')
    expect(body.campaign).toBeNull()
    expect(body.started_at).toBeNull()
    expect(body.daily_counts).toEqual([])
  })

  it('invalid id (non-numeric) → 400 bad request', async () => {
    const res = await req('GET', '/api/campaigns/abc/ramp-progress')
    expect(res.status).toBe(400)
    expect((res.body as any).error).toBeTruthy()
  })

  it('DB error on campaign lookup → 500', async () => {
    queueError('connection lost')
    const res = await req('GET', '/api/campaigns/1/ramp-progress')
    expect(res.status).toBe(500)
    expect((res.body as any).error).toBeTruthy()
  })
})
