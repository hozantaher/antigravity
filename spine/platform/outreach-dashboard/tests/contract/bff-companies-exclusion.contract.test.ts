// ═══════════════════════════════════════════════════════════════════════════
//  Issue #859 — PATCH /api/companies/:ico — operator exclusion_status toggle
//
// Contract invariants:
//  1. Endpoint is protected by X-API-Key (401 without it)
//  2. Invalid ICO format → 400
//  3. Invalid exclusion_status value → 400
//  4. Non-existent ICO → 404
//  5. pass → excluded: UPDATE + audit INSERT (action='company_exclude')
//  6. excluded → pass: UPDATE + audit INSERT (action='company_include')
//  7. Same status twice → 200 no_change=true (idempotent, no audit written)
//  8. Reason stored in audit details JSON
//  9. Audit INSERT failure → 500 + ROLLBACK (company NOT updated)
// 10. Concurrent PATCH: last-write-wins (documented choice, no optimistic lock)
//
// All DB calls go through the PoolClient (pool.connect() path) since this
// endpoint is fully transactional. The Pool mock supports both direct .query()
// (used by other routes in the same server) and the .connect() path.
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

const API_KEY = 'test-key-exclusion-859'
let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  process.env.OUTREACH_API_KEY = API_KEY
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

function queueResult(result: unknown[] | Error, rowCount?: number) {
  if (result instanceof Error) {
    queryQueue.push(result)
  } else {
    queryQueue.push({ rows: result, rowCount: rowCount ?? result.length })
  }
}

async function patchExclusion(
  ico: string,
  body: Record<string, unknown>,
  withAuth = true,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (withAuth) headers['x-api-key'] = API_KEY
  const r = await fetch(`${baseUrl}/api/companies/${ico}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : null
  return { status: r.status, body: json }
}

// ════════════════════════════════════════════════════════════════════
//  1. Auth guard
//
//  Contract tests run with BFF_AUTH_DISABLED=1 (tests/contract/setup.ts).
//  To verify the auth gate we temporarily disable that bypass and re-enable
//  it in afterEach — the same pattern used by auth-bypass.contract.test.ts.
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — auth guard', () => {
  beforeEach(() => {
    delete process.env.BFF_AUTH_DISABLED
  })
  afterEach(() => {
    process.env.BFF_AUTH_DISABLED = '1'
  })

  it('401 without X-API-Key header', async () => {
    const res = await patchExclusion('12345678', { exclusion_status: 'excluded' }, false)
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: 'unauthorized' })
  })
})

// ════════════════════════════════════════════════════════════════════
//  2+3. Input validation
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — input validation', () => {
  it('400 for ICO that is not exactly 8 digits (7 digits)', async () => {
    const res = await patchExclusion('1234567', { exclusion_status: 'excluded' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/ICO must be 8 digits/)
  })

  it('400 for ICO with letters', async () => {
    const res = await patchExclusion('1234567x', { exclusion_status: 'excluded' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/ICO must be 8 digits/)
  })

  it('400 for ICO with 9 digits', async () => {
    const res = await patchExclusion('123456789', { exclusion_status: 'excluded' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/ICO must be 8 digits/)
  })

  it('400 for invalid exclusion_status value', async () => {
    const res = await patchExclusion('12345678', { exclusion_status: 'hard_block' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/exclusion_status must be one of/)
  })

  it('400 for missing exclusion_status', async () => {
    const res = await patchExclusion('12345678', {})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/exclusion_status must be one of/)
  })

  it('400 for reason that exceeds 500 characters', async () => {
    const res = await patchExclusion('12345678', {
      exclusion_status: 'excluded',
      reason: 'x'.repeat(501),
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/reason must be a string/)
  })
})

// ════════════════════════════════════════════════════════════════════
//  4. 404 for non-existent ICO
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — 404 for non-existent company', () => {
  it('404 when ICO not found in DB', async () => {
    // Queue: BEGIN, SELECT (empty → not found), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([]) // SELECT — empty = not found

    const res = await patchExclusion('99999999', { exclusion_status: 'excluded' })
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: 'company not found' })

    // ROLLBACK must have been issued
    const rollback = calls.find(c => c.sql?.includes('ROLLBACK'))
    expect(rollback).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════
//  5. Happy path: pass → excluded
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — pass → excluded', () => {
  it('200 + UPDATE + audit INSERT with action=company_exclude', async () => {
    // Queue: BEGIN, SELECT (found, pass), UPDATE, INSERT audit, COMMIT
    queueResult([]) // BEGIN
    queueResult([{ id: 42, ico: '12345678', exclusion_status: 'pass' }]) // SELECT
    queueResult([], 1) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await patchExclusion('12345678', { exclusion_status: 'excluded' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, ico: '12345678', exclusion_status: 'excluded' })

    // Verify UPDATE was called
    const update = calls.find(c => c.sql?.includes('UPDATE companies SET exclusion_status'))
    expect(update).toBeDefined()
    expect(update?.params?.[0]).toBe('excluded')

    // Verify audit INSERT with correct action
    const audit = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(audit).toBeDefined()
    expect(audit?.params?.[0]).toBe('company_exclude')
    expect(audit?.params?.[1]).toBe('12345678')
    const details = JSON.parse(audit?.params?.[2] as string)
    expect(details.prev_status).toBe('pass')
    expect(details.new_status).toBe('excluded')
  })
})

// ════════════════════════════════════════════════════════════════════
//  6. Happy path: excluded → pass
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — excluded → pass', () => {
  it('200 + UPDATE + audit INSERT with action=company_include', async () => {
    // Queue: BEGIN, SELECT (found, excluded), UPDATE, INSERT audit, COMMIT
    queueResult([]) // BEGIN
    queueResult([{ id: 7, ico: '87654321', exclusion_status: 'excluded' }]) // SELECT
    queueResult([], 1) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await patchExclusion('87654321', { exclusion_status: 'pass' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, ico: '87654321', exclusion_status: 'pass' })

    const audit = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(audit).toBeDefined()
    expect(audit?.params?.[0]).toBe('company_include')
    expect(audit?.params?.[1]).toBe('87654321')
    const details = JSON.parse(audit?.params?.[2] as string)
    expect(details.prev_status).toBe('excluded')
    expect(details.new_status).toBe('pass')
  })
})

// ════════════════════════════════════════════════════════════════════
//  7. Idempotent — same status → no_change, no audit
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — idempotent', () => {
  it('200 no_change=true when status is already excluded', async () => {
    // Queue: BEGIN, SELECT (already excluded), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([{ id: 5, ico: '11111111', exclusion_status: 'excluded' }]) // SELECT

    const res = await patchExclusion('11111111', { exclusion_status: 'excluded' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, no_change: true })

    // No UPDATE issued
    const update = calls.find(c => c.sql?.includes('UPDATE companies SET exclusion_status'))
    expect(update).toBeUndefined()

    // No audit INSERT issued
    const audit = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(audit).toBeUndefined()
  })

  it('200 no_change=true when status is already pass', async () => {
    queueResult([]) // BEGIN
    queueResult([{ id: 6, ico: '22222222', exclusion_status: 'pass' }]) // SELECT

    const res = await patchExclusion('22222222', { exclusion_status: 'pass' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, no_change: true })

    const audit = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(audit).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════
//  8. Reason stored in audit details
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — reason stored in audit details', () => {
  it('reason field appears in audit details JSON when provided', async () => {
    queueResult([]) // BEGIN
    queueResult([{ id: 3, ico: '33333333', exclusion_status: 'pass' }]) // SELECT
    queueResult([], 1) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await patchExclusion('33333333', {
      exclusion_status: 'excluded',
      reason: 'Konkurent, případ #123',
    })
    expect(res.status).toBe(200)

    const audit = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(audit).toBeDefined()
    const details = JSON.parse(audit?.params?.[2] as string)
    expect(details.reason).toBe('Konkurent, případ #123')
  })

  it('reason field absent from audit details when not provided', async () => {
    queueResult([]) // BEGIN
    queueResult([{ id: 4, ico: '44444444', exclusion_status: 'pass' }]) // SELECT
    queueResult([], 1) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await patchExclusion('44444444', { exclusion_status: 'excluded' })
    expect(res.status).toBe(200)

    const audit = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(audit).toBeDefined()
    const details = JSON.parse(audit?.params?.[2] as string)
    expect(Object.prototype.hasOwnProperty.call(details, 'reason')).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════
//  9. Audit INSERT failure → 500 + ROLLBACK
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — audit INSERT failure rolls back', () => {
  it('500 + ROLLBACK when audit INSERT throws', async () => {
    // Queue: BEGIN, SELECT (found), UPDATE, INSERT audit FAILS, ROLLBACK
    queueResult([]) // BEGIN
    queueResult([{ id: 8, ico: '55555555', exclusion_status: 'pass' }]) // SELECT
    queueResult([], 1) // UPDATE
    queryQueue.push(new Error('audit table unavailable')) // INSERT audit — FAILS

    const res = await patchExclusion('55555555', { exclusion_status: 'excluded' })
    expect(res.status).toBe(500)

    // ROLLBACK must have been issued
    const rollback = calls.find(c => c.sql?.includes('ROLLBACK'))
    expect(rollback).toBeDefined()

    // Verify UPDATE was attempted (before the failure)
    const update = calls.find(c => c.sql?.includes('UPDATE companies SET exclusion_status'))
    expect(update).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════
//  10. Concurrent writes — last-write-wins (documented behaviour)
// ════════════════════════════════════════════════════════════════════

describe('PATCH /api/companies/:ico — concurrent write is last-write-wins', () => {
  it('two sequential PATCHes each succeed and each write an audit row', async () => {
    // First PATCH: pass → excluded
    queueResult([]) // BEGIN
    queueResult([{ id: 9, ico: '66666666', exclusion_status: 'pass' }])
    queueResult([], 1)
    queueResult([])
    queueResult([])

    const r1 = await patchExclusion('66666666', { exclusion_status: 'excluded' })
    expect(r1.status).toBe(200)
    expect(r1.body.exclusion_status).toBe('excluded')

    calls.length = 0
    queryQueue.length = 0

    // Second PATCH: excluded → pass (simulates another operator or retry)
    queueResult([]) // BEGIN
    queueResult([{ id: 9, ico: '66666666', exclusion_status: 'excluded' }])
    queueResult([], 1)
    queueResult([])
    queueResult([])

    const r2 = await patchExclusion('66666666', { exclusion_status: 'pass' })
    expect(r2.status).toBe(200)
    expect(r2.body.exclusion_status).toBe('pass')

    const audit2 = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(audit2?.params?.[0]).toBe('company_include')
  })
})
