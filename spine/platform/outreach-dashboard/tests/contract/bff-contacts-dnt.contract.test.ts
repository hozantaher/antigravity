// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/contacts PATCH dnt field (#861)
//
//  GDPR Art. 21 opt-out: operator marks a contact as Do Not Track.
//  Tests:
//    1.  401 without X-API-Key (BFF_AUTH_DISABLED cleared)
//    2.  400 dnt=non-boolean value
//    3.  200 set dnt=true → audit action=contact_dnt_set visible
//    4.  200 set dnt=false → audit action=contact_dnt_clear visible
//    5.  500 audit INSERT fails → ROLLBACK
//    6.  Idempotent re-set: dnt=true when already true → no audit emitted
//    7.  Combined PATCH: status + dnt in one body → both columns updated
//    8.  dnt=null in body → 400 (not a boolean)
//    9.  dnt column present in GET /api/contacts/:id response
//   10.  404 PATCH dnt on non-existent contact
//   11.  dnt=false on contact already false → no audit (idempotent clear)
//   12.  PATCH dnt=true + status together inside one transaction (COMMIT visible)
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class PoolClient {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [] }
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
      if (!queryQueue.length) return { rows: [] }
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
  // contract/setup.ts keeps BFF_AUTH_DISABLED=1 between tests — restore here
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.BFF_RATE_LIMIT_DISABLED = '1'
})

function queue(result: unknown[] | Error) {
  queryQueue.push(result instanceof Error ? result : { rows: result })
}

async function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ─── Test 1: 401 without X-API-Key ──────────────────────────────────────────

describe('PATCH /api/contacts/:id dnt — auth gate', () => {
  it('401 when BFF_AUTH_DISABLED is not set and no x-api-key supplied', async () => {
    // Temporarily enable auth so we can verify the gate
    delete process.env.BFF_AUTH_DISABLED
    process.env.OUTREACH_API_KEY = 'secret-key'
    const res = await req('PATCH', '/api/contacts/42', { dnt: true })
    // Restore for subsequent tests
    process.env.BFF_AUTH_DISABLED = '1'
    delete process.env.OUTREACH_API_KEY
    expect(res.status).toBe(401)
  })
})

// ─── Test 2: 400 invalid dnt value ──────────────────────────────────────────

describe('PATCH /api/contacts/:id dnt — validation', () => {
  it('400 when dnt is a string instead of boolean', async () => {
    const res = await req('PATCH', '/api/contacts/42', { dnt: 'yes' })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toMatch(/dnt must be a boolean/)
  })

  it('400 when dnt is a number', async () => {
    const res = await req('PATCH', '/api/contacts/42', { dnt: 1 })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toMatch(/dnt must be a boolean/)
  })

  it('400 when dnt is null', async () => {
    const res = await req('PATCH', '/api/contacts/42', { dnt: null })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toMatch(/dnt must be a boolean/)
  })
})

// ─── Test 3: 200 set dnt=true → audit visible ───────────────────────────────

describe('PATCH /api/contacts/:id dnt=true', () => {
  it('200 contact_dnt_set: audit emitted when dnt false→true', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active', dnt: false }
    const contactAfter  = { id: 42, email: 'john@example.com', first_name: null, last_name: null, company_name: null, status: 'active', dnt: true }

    queue([])                   // BEGIN
    queue([contactBefore])      // SELECT
    queue([contactAfter])       // UPDATE RETURNING
    queue([])                   // INSERT audit
    queue([])                   // COMMIT

    const res = await req('PATCH', '/api/contacts/42', { dnt: true })

    expect(res.status).toBe(200)
    expect((res.body as any).dnt).toBe(true)

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.params?.[0]).toBe('contact_dnt_set')
    expect(auditCall?.params?.[1]).toBe('dashboard')
    expect(auditCall?.params?.[2]).toBe('contact')
    expect(auditCall?.params?.[3]).toBe('42')

    const details = JSON.parse(auditCall?.params?.[4] as string)
    expect(details.prev_dnt).toBe(false)
    expect(details.new_dnt).toBe(true)
    expect(details.email_redacted).toBe('j***@example.com')

    expect(calls.find(c => c.sql === 'COMMIT')).toBeDefined()
  })
})

// ─── Test 4: 200 set dnt=false → audit visible ──────────────────────────────

describe('PATCH /api/contacts/:id dnt=false', () => {
  it('200 contact_dnt_clear: audit emitted when dnt true→false', async () => {
    const contactBefore = { id: 77, email: 'jane@test.org', status: 'active', dnt: true }
    const contactAfter  = { id: 77, email: 'jane@test.org', first_name: null, last_name: null, company_name: null, status: 'active', dnt: false }

    queue([])
    queue([contactBefore])
    queue([contactAfter])
    queue([])   // INSERT audit
    queue([])   // COMMIT

    const res = await req('PATCH', '/api/contacts/77', { dnt: false })

    expect(res.status).toBe(200)
    expect((res.body as any).dnt).toBe(false)

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.params?.[0]).toBe('contact_dnt_clear')
    const details = JSON.parse(auditCall?.params?.[4] as string)
    expect(details.prev_dnt).toBe(true)
    expect(details.new_dnt).toBe(false)
  })
})

// ─── Test 5: 500 audit fail → ROLLBACK ──────────────────────────────────────

describe('PATCH /api/contacts/:id dnt — audit failure', () => {
  it('500 when audit INSERT throws → ROLLBACK, no COMMIT', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active', dnt: false }
    const contactAfter  = { id: 42, email: 'john@example.com', first_name: null, last_name: null, company_name: null, status: 'active', dnt: true }

    queue([])
    queue([contactBefore])
    queue([contactAfter])
    queue(new Error('audit table unavailable'))  // INSERT audit fails

    const res = await req('PATCH', '/api/contacts/42', { dnt: true })

    expect(res.status).toBe(500)
    expect(calls.find(c => c.sql === 'ROLLBACK')).toBeDefined()
    expect(calls.find(c => c.sql === 'COMMIT')).toBeUndefined()
  })
})

// ─── Test 6: idempotent re-set dnt=true when already true ───────────────────

describe('PATCH /api/contacts/:id dnt — idempotent', () => {
  it('200 no audit when dnt=true and contact already has dnt=true', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active', dnt: true }
    const contactAfter  = { id: 42, email: 'john@example.com', first_name: null, last_name: null, company_name: null, status: 'active', dnt: true }

    queue([])
    queue([contactBefore])
    queue([contactAfter])
    queue([])   // COMMIT (no audit)

    const res = await req('PATCH', '/api/contacts/42', { dnt: true })

    expect(res.status).toBe(200)
    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
    expect(calls.find(c => c.sql === 'COMMIT')).toBeDefined()
  })

  it('200 no audit when dnt=false and contact already has dnt=false', async () => {
    const contactBefore = { id: 43, email: 'other@example.com', status: 'active', dnt: false }
    const contactAfter  = { id: 43, email: 'other@example.com', first_name: null, last_name: null, company_name: null, status: 'active', dnt: false }

    queue([])
    queue([contactBefore])
    queue([contactAfter])
    queue([])   // COMMIT (no audit)

    const res = await req('PATCH', '/api/contacts/43', { dnt: false })

    expect(res.status).toBe(200)
    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})

// ─── Test 7: combined PATCH (status + dnt) → both update in 1 tx ────────────

describe('PATCH /api/contacts/:id — combined status + dnt', () => {
  it('200 both status and dnt columns updated in single transaction', async () => {
    // Use status=suppressed to get contact_suppress audit action
    const contactBefore = { id: 55, email: 'combo@mail.cz', status: 'active', dnt: false }
    const contactAfter  = { id: 55, email: 'combo@mail.cz', first_name: null, last_name: null, company_name: null, status: 'suppressed', dnt: true }

    queue([])                 // BEGIN
    queue([contactBefore])    // SELECT
    queue([contactAfter])     // UPDATE RETURNING
    queue([])                 // INSERT audit (status change)
    queue([])                 // INSERT audit (dnt change)
    queue([])                 // COMMIT

    const res = await req('PATCH', '/api/contacts/55', { status: 'suppressed', dnt: true })

    expect(res.status).toBe(200)
    expect((res.body as any).status).toBe('suppressed')
    expect((res.body as any).dnt).toBe(true)

    // Verify both audit entries
    const auditCalls = calls.filter(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCalls.length).toBe(2)

    const actions = auditCalls.map(c => c.params?.[0])
    expect(actions).toContain('contact_suppress')
    expect(actions).toContain('contact_dnt_set')

    expect(calls.find(c => c.sql === 'COMMIT')).toBeDefined()
    expect(calls.find(c => c.sql === 'ROLLBACK')).toBeUndefined()
  })
})

// ─── Test 9 (ordering): dnt column present in GET /api/contacts/:id ─────────

describe('GET /api/contacts/:id — dnt field in response', () => {
  it('returns dnt field from contact row', async () => {
    queue([{ id: 7, email: 'a@x.cz', first_name: 'Jan', status: 'active', dnt: true }])
    queue([]) // send_history

    const res = await req('GET', '/api/contacts/7')
    expect(res.status).toBe(200)
    expect((res.body as any).dnt).toBe(true)
  })
})

// ─── Test 10: 404 PATCH dnt on non-existent contact ─────────────────────────

describe('PATCH /api/contacts/:id dnt — not found', () => {
  it('404 when contact does not exist', async () => {
    queue([])   // BEGIN
    queue([])   // SELECT (no rows)

    const res = await req('PATCH', '/api/contacts/999', { dnt: true })

    expect(res.status).toBe(404)
    expect((res.body as any).error).toBe('not found')
    expect(calls.find(c => c.sql === 'ROLLBACK')).toBeDefined()
    expect(calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))).toBeUndefined()
  })
})

// ─── Test 12: dnt UPDATE SQL includes the dnt column ────────────────────────

describe('PATCH /api/contacts/:id dnt — SQL shape', () => {
  it('UPDATE SQL includes dnt=$N column assignment', async () => {
    const contactBefore = { id: 1, email: 'x@y.z', status: 'active', dnt: false }
    const contactAfter  = { id: 1, email: 'x@y.z', first_name: null, last_name: null, company_name: null, status: 'active', dnt: true }

    queue([])
    queue([contactBefore])
    queue([contactAfter])
    queue([])   // audit
    queue([])   // COMMIT

    await req('PATCH', '/api/contacts/1', { dnt: true })

    const updateCall = calls.find(c => c.sql?.startsWith('UPDATE contacts'))
    expect(updateCall).toBeDefined()
    expect(updateCall?.sql).toMatch(/dnt=\$/)
  })

  it('RETURNING clause includes dnt column', async () => {
    const contactBefore = { id: 2, email: 'a@b.c', status: 'active', dnt: false }
    const contactAfter  = { id: 2, email: 'a@b.c', first_name: null, last_name: null, company_name: null, status: 'active', dnt: true }

    queue([])
    queue([contactBefore])
    queue([contactAfter])
    queue([])
    queue([])

    await req('PATCH', '/api/contacts/2', { dnt: true })

    const updateCall = calls.find(c => c.sql?.startsWith('UPDATE contacts'))
    expect(updateCall?.sql).toMatch(/RETURNING.*dnt/)
  })
})
