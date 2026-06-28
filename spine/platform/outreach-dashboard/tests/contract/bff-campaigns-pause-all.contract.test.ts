// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — POST /api/campaigns/pause-all  (issue #909)
//
//  Halt-protocol emergency button. Verifies:
//
//    1.  401 without X-API-Key
//    2.  200 happy path: pauses N running campaigns, returns their IDs
//    3.  200 idempotent: no running campaigns → count=0, paused_campaigns=[]
//    4.  One audit row per paused campaign (action='campaign_pause_all')
//    5.  reason stored in audit details when supplied
//    6.  Transaction atomicity: UPDATE failure → ROLLBACK, no campaign paused
//    7.  Audit INSERT failure → ROLLBACK, no campaign paused
//    8.  Status 'sending' campaigns paused alongside 'running'
//    9.  Response shape: paused_campaigns, count, paused_at (ISO)
//   10.  Body-less POST (no Content-Type) still returns 200
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

// Mock pool with a connect() returning a client that uses the shared queue.
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

const API_KEY = 'test-key-pause-all-909'
let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY', 'GO_SERVER_URL', 'BFF_AUTH_DISABLED']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  // Set OUTREACH_API_KEY BEFORE importing server.js so auth middleware
  // is initialized with a valid key (same pattern as auth-bypass tests).
  process.env.OUTREACH_API_KEY = API_KEY
  delete process.env.BFF_AUTH_DISABLED
  delete process.env.GO_SERVER_URL
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
  // Restore key for each test in case a test unsets it for isolation.
  process.env.OUTREACH_API_KEY = API_KEY
  delete process.env.BFF_AUTH_DISABLED
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

function queueRows(rows: unknown[], rowCount?: number) {
  queryQueue.push({ rows, rowCount: rowCount ?? rows.length })
}
function queueError(msg: string) {
  queryQueue.push(new Error(msg))
}

async function pauseAll(body?: unknown, withKey = true) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (withKey) headers['x-api-key'] = API_KEY
  const r = await fetch(`${baseUrl}/api/campaigns/pause-all`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, body: json }
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Auth — authMiddleware reads OUTREACH_API_KEY per-request (not cached).
//     We test the missing-header path by sending a request without the header.
//     The key IS set in process.env (middleware will produce 401 due to
//     header mismatch), so we send a deliberately wrong/absent key.
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/campaigns/pause-all — auth', () => {
  it('1. returns 401 when X-API-Key is missing', async () => {
    const res = await pauseAll({}, false)
    // authMiddleware returns 401 when header is absent but key is configured.
    expect(res.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  2. Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/campaigns/pause-all — happy path', () => {
  it('2. pauses running campaigns and returns their IDs', async () => {
    // BEGIN, SELECT targets (2 running), UPDATE, 2× audit INSERT, COMMIT
    queueRows([]) // BEGIN
    queueRows([
      { id: 10, status: 'running' },
      { id: 20, status: 'running' },
    ]) // SELECT running/sending
    queueRows([]) // UPDATE campaigns SET status='paused'
    queueRows([]) // audit INSERT id=10
    queueRows([]) // audit INSERT id=20
    queueRows([]) // COMMIT

    const res = await pauseAll({ reason: 'bounce spike' })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.count).toBe(2)
    expect(Array.isArray(body.paused_campaigns)).toBe(true)
    expect((body.paused_campaigns as number[]).sort()).toEqual([10, 20])
    expect(typeof body.paused_at).toBe('string')
  })

  it('9. response shape always includes paused_campaigns, count, paused_at', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 5, status: 'running' }]) // SELECT
    queueRows([]) // UPDATE
    queueRows([]) // audit INSERT
    queueRows([]) // COMMIT

    const res = await pauseAll({})
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect('paused_campaigns' in body).toBe(true)
    expect('count' in body).toBe(true)
    expect('paused_at' in body).toBe(true)
    // paused_at is a valid ISO string
    expect(() => new Date(body.paused_at as string).toISOString()).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  3. Idempotent — no running campaigns
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/campaigns/pause-all — idempotent', () => {
  it('3. returns count=0 and empty array when no campaigns are running', async () => {
    queueRows([]) // BEGIN
    queueRows([]) // SELECT returns empty

    const res = await pauseAll({})
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.count).toBe(0)
    expect(body.paused_campaigns).toEqual([])
    // ROLLBACK was issued (SELECT returned nothing, we ROLLBACK early)
    const rollback = calls.find(c => c.sql?.includes('ROLLBACK'))
    expect(rollback).toBeDefined()
    // No UPDATE was issued
    const update = calls.find(c => c.sql?.includes("SET status='paused'"))
    expect(update).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  4. Audit rows
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/campaigns/pause-all — audit', () => {
  it('4. inserts one audit row per paused campaign', async () => {
    queueRows([]) // BEGIN
    queueRows([
      { id: 11, status: 'running' },
      { id: 22, status: 'running' },
      { id: 33, status: 'running' },
    ]) // SELECT
    queueRows([]) // UPDATE
    queueRows([]) // audit 11
    queueRows([]) // audit 22
    queueRows([]) // audit 33
    queueRows([]) // COMMIT

    await pauseAll({})

    const auditCalls = calls.filter(c =>
      c.sql?.includes('INSERT INTO operator_audit_log') &&
      c.sql?.includes('campaign_pause_all')
    )
    expect(auditCalls.length).toBe(3)
    const auditIds = auditCalls.map(c => c.params?.[0]).sort()
    expect(auditIds).toEqual(['11', '22', '33'])
  })

  it('5. audit details include reason when supplied', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 99, status: 'running' }]) // SELECT
    queueRows([]) // UPDATE
    queueRows([]) // audit INSERT
    queueRows([]) // COMMIT

    await pauseAll({ reason: 'operator manual stop' })

    const auditCall = calls.find(c => c.sql?.includes('campaign_pause_all'))
    expect(auditCall).toBeDefined()
    const details = JSON.parse(auditCall?.params?.[1] as string)
    expect(details.reason).toBe('operator manual stop')
    expect(details.prev_status).toBe('running')
    expect(typeof details.batch_size).toBe('number')
    expect(typeof details.timestamp).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  6. Transaction atomicity — UPDATE failure
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/campaigns/pause-all — atomicity', () => {
  it('6. UPDATE failure → ROLLBACK, 500, no campaign stays paused', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 55, status: 'running' }]) // SELECT
    queueError('deadlock detected on campaigns') // UPDATE fails

    const res = await pauseAll({})
    expect(res.status).toBe(500)

    const rollback = calls.find(c => c.sql?.includes('ROLLBACK'))
    expect(rollback).toBeDefined()

    // No COMMIT issued
    const commit = calls.find(c => c.sql?.includes('COMMIT'))
    expect(commit).toBeUndefined()
  })

  it('7. audit INSERT failure → ROLLBACK, 500', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 66, status: 'running' }]) // SELECT
    queueRows([]) // UPDATE succeeds
    queueError('permission denied on operator_audit_log') // first audit INSERT fails

    const res = await pauseAll({})
    expect(res.status).toBe(500)

    const rollback = calls.find(c => c.sql?.includes('ROLLBACK'))
    expect(rollback).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  8. 'sending' status is also paused
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/campaigns/pause-all — 'sending' status", () => {
  it("8. pauses campaigns with status='sending' alongside status='running'", async () => {
    queueRows([]) // BEGIN
    queueRows([
      { id: 101, status: 'running' },
      { id: 102, status: 'sending' },
    ]) // SELECT includes both
    queueRows([]) // UPDATE
    queueRows([]) // audit 101
    queueRows([]) // audit 102
    queueRows([]) // COMMIT

    const res = await pauseAll({})
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.count).toBe(2)
    expect((body.paused_campaigns as number[]).sort()).toEqual([101, 102])

    // Verify SELECT included 'sending' in the WHERE clause
    const selectCall = calls.find(c => c.sql?.includes("status IN ('running', 'sending')"))
    expect(selectCall).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  10. Body-less POST
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/campaigns/pause-all — body-less request', () => {
  it('10. works without a request body (reason defaults to null)', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 77, status: 'running' }]) // SELECT
    queueRows([]) // UPDATE
    queueRows([]) // audit
    queueRows([]) // COMMIT

    const headers: Record<string, string> = {}
    headers['x-api-key'] = API_KEY
    const r = await fetch(`${baseUrl}/api/campaigns/pause-all`, {
      method: 'POST',
      headers,
    })
    const body = await r.json()
    expect(r.status).toBe(200)
    expect(body.count).toBe(1)

    // audit details.reason should be null
    const auditCall = calls.find(c => c.sql?.includes('campaign_pause_all'))
    const details = JSON.parse(auditCall?.params?.[1] as string)
    expect(details.reason).toBeNull()
  })
})
