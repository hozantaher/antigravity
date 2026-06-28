// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/contacts PATCH (suppress/unsuppress) + DELETE
//  with operator_audit_log mutation tracking (#864)
//
// Verifies audit trail for contact state changes per GDPR Art. 30 record-keeping.
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) {
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

function queueResult(result: unknown[] | Error) {
  if (result instanceof Error) {
    queryQueue.push(result)
  } else {
    queryQueue.push({ rows: result })
  }
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PATCH /api/contacts/:id (suppress/unsuppress)
// ═══════════════════════════════════════════════════════════════════════════

describe('PATCH /api/contacts/:id with audit log', () => {
  it('200 contact_suppress: status=active → suppressed with audit', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active' }
    const contactAfter = { id: 42, email: 'john@example.com', first_name: null, last_name: null, company_name: null, status: 'suppressed' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT current state
    queueResult([contactAfter]) // UPDATE query RETURNING
    queueResult([]) // INSERT audit log
    queueResult([]) // COMMIT

    const res = await req('PATCH', '/api/contacts/42', { status: 'suppressed' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 42,
      email: 'john@example.com',
      status: 'suppressed',
    })

    // Verify audit INSERT was called
    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.params?.[0]).toBe('contact_suppress')
    expect(auditCall?.params?.[1]).toBe('dashboard')
    expect(auditCall?.params?.[2]).toBe('contact')
    expect(auditCall?.params?.[3]).toBe('42')
    const auditDetails = JSON.parse(auditCall?.params?.[4] as string)
    expect(auditDetails.prev_status).toBe('active')
    expect(auditDetails.new_status).toBe('suppressed')
    expect(auditDetails.email_redacted).toBe('j***@example.com')

    // Verify COMMIT
    const commitCall = calls.find(c => c.sql === 'COMMIT')
    expect(commitCall).toBeDefined()
  })

  it('200 contact_unsuppress: status=suppressed → active with audit', async () => {
    const contactBefore = { id: 99, email: 'jane@test.com', status: 'suppressed' }
    const contactAfter = { id: 99, email: 'jane@test.com', first_name: null, last_name: null, company_name: null, status: 'active' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([contactAfter]) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await req('PATCH', '/api/contacts/99', { status: 'active' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 99,
      email: 'jane@test.com',
      status: 'active',
    })

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall?.params?.[0]).toBe('contact_unsuppress')
    const auditDetails = JSON.parse(auditCall?.params?.[4] as string)
    expect(auditDetails.prev_status).toBe('suppressed')
    expect(auditDetails.new_status).toBe('active')
    expect(auditDetails.email_redacted).toBe('j***@test.com')
  })

  it('200 non-status PATCH: no audit log when only first_name changed', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active' }
    const contactAfter = { id: 42, email: 'john@example.com', first_name: 'Johnny', last_name: null, company_name: null, status: 'active' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([contactAfter]) // UPDATE
    queueResult([]) // COMMIT (no audit insert)

    const res = await req('PATCH', '/api/contacts/42', { first_name: 'Johnny' })

    expect(res.status).toBe(200)

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('404 PATCH non-existent contact: ROLLBACK + no audit', async () => {
    queueResult([]) // BEGIN
    queueResult([]) // SELECT (no rows)

    const res = await req('PATCH', '/api/contacts/999', { status: 'suppressed' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()

    const rollbackCall = calls.find(c => c.sql === 'ROLLBACK')
    expect(rollbackCall).toBeDefined()
  })

  it('400 PATCH: nothing to update + ROLLBACK + no audit', async () => {
    queueResult([]) // BEGIN
    queueResult([{ id: 42, email: 'john@example.com', status: 'active' }]) // SELECT
    // (no UPDATE since nothing to update)

    const res = await req('PATCH', '/api/contacts/42', {})

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'nothing to update' })

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()

    const rollbackCall = calls.find(c => c.sql === 'ROLLBACK')
    expect(rollbackCall).toBeDefined()
  })

  it('500 PATCH: audit INSERT fails → ROLLBACK on error', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active' }
    const contactAfter = { id: 42, email: 'john@example.com', first_name: null, last_name: null, company_name: null, status: 'suppressed' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([contactAfter]) // UPDATE
    queueResult(new Error('audit db error')) // INSERT audit FAILS

    const res = await req('PATCH', '/api/contacts/42', { status: 'suppressed' })

    expect(res.status).toBe(500)

    const rollbackCall = calls.find(c => c.sql === 'ROLLBACK')
    expect(rollbackCall).toBeDefined()
  })

  it('200 PATCH idempotent re-suppress: no audit when status already suppressed', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'suppressed' }
    const contactAfter = { id: 42, email: 'john@example.com', first_name: null, last_name: null, company_name: null, status: 'suppressed' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([contactAfter]) // UPDATE
    queueResult([]) // COMMIT (no audit since status unchanged)

    const res = await req('PATCH', '/api/contacts/42', { status: 'suppressed' })

    expect(res.status).toBe(200)

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('200 PATCH email redaction: truncates middle of email', async () => {
    const contactBefore = { id: 100, email: 'very.long.email.name@example.com', status: 'active' }
    const contactAfter = { id: 100, email: 'very.long.email.name@example.com', first_name: null, last_name: null, company_name: null, status: 'suppressed' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([contactAfter]) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    await req('PATCH', '/api/contacts/100', { status: 'suppressed' })

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    const auditDetails = JSON.parse(auditCall?.params?.[4] as string)
    expect(auditDetails.email_redacted).toBe('v***@example.com')
  })

  it('200 PATCH null email: handles missing email gracefully', async () => {
    const contactBefore = { id: 42, email: null, status: 'active' }
    const contactAfter = { id: 42, email: null, first_name: null, last_name: null, company_name: null, status: 'suppressed' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([contactAfter]) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await req('PATCH', '/api/contacts/42', { status: 'suppressed' })

    expect(res.status).toBe(200)

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    const auditDetails = JSON.parse(auditCall?.params?.[4] as string)
    expect(auditDetails.email_redacted).toBe('unknown')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  DELETE /api/contacts/:id
// ═══════════════════════════════════════════════════════════════════════════

describe('DELETE /api/contacts/:id with audit log', () => {
  it('200 contact_delete: DELETE + audit log recorded', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([{ id: 42 }]) // DELETE RETURNING
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await req('DELETE', '/api/contacts/42')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    // Verify INSERT audit log
    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.params?.[0]).toBe('contact_delete')
    expect(auditCall?.params?.[1]).toBe('dashboard')
    expect(auditCall?.params?.[2]).toBe('contact')
    expect(auditCall?.params?.[3]).toBe('42')
    const auditDetails = JSON.parse(auditCall?.params?.[4] as string)
    expect(auditDetails.email_redacted).toBe('j***@example.com')
    expect(auditDetails.deleted_at).toBeDefined()

    // Verify COMMIT
    const commitCall = calls.find(c => c.sql === 'COMMIT')
    expect(commitCall).toBeDefined()
  })

  it('404 DELETE non-existent contact: ROLLBACK + no audit', async () => {
    queueResult([]) // BEGIN
    queueResult([]) // SELECT (no rows)

    const res = await req('DELETE', '/api/contacts/999')

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()

    const rollbackCall = calls.find(c => c.sql === 'ROLLBACK')
    expect(rollbackCall).toBeDefined()
  })

  it('500 DELETE: audit INSERT fails → ROLLBACK on error', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([{ id: 42 }]) // DELETE
    queueResult(new Error('audit insert failed')) // INSERT audit FAILS

    const res = await req('DELETE', '/api/contacts/42')

    expect(res.status).toBe(500)

    const rollbackCall = calls.find(c => c.sql === 'ROLLBACK')
    expect(rollbackCall).toBeDefined()
  })

  it('200 DELETE email redaction: preserves email domain privacy', async () => {
    const contactBefore = { id: 100, email: 'jane.doe@internal.company.com', status: 'active' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([{ id: 100 }]) // DELETE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await req('DELETE', '/api/contacts/100')

    expect(res.status).toBe(200)

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    const auditDetails = JSON.parse(auditCall?.params?.[4] as string)
    expect(auditDetails.email_redacted).toBe('j***@internal.company.com')
  })

  it('200 DELETE null email: handles missing email gracefully', async () => {
    const contactBefore = { id: 42, email: null, status: 'active' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([{ id: 42 }]) // DELETE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await req('DELETE', '/api/contacts/42')

    expect(res.status).toBe(200)

    const auditCall = calls.find(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    const auditDetails = JSON.parse(auditCall?.params?.[4] as string)
    expect(auditDetails.email_redacted).toBe('unknown')
  })

  it('200 DELETE idempotent: second DELETE 404 + no second audit', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active' }

    // First DELETE
    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([{ id: 42 }]) // DELETE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    // Second DELETE (contact already gone)
    queueResult([]) // BEGIN
    queueResult([]) // SELECT (no rows)

    const res1 = await req('DELETE', '/api/contacts/42')
    expect(res1.status).toBe(200)

    const auditCalls1 = calls.filter(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCalls1.length).toBe(1)

    const res2 = await req('DELETE', '/api/contacts/42')
    expect(res2.status).toBe(404)

    const auditCalls2 = calls.filter(c => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCalls2.length).toBe(1) // Still only one from first DELETE
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Edge cases: transaction isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('transaction isolation for contact mutations', () => {
  it('PATCH: all operations rollback together on any error', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active' }
    const contactAfter = { id: 42, email: 'john@example.com', first_name: null, last_name: null, company_name: null, status: 'suppressed' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([contactAfter]) // UPDATE
    queueResult(new Error('constraint violation on audit insert')) // INSERT audit fails

    const res = await req('PATCH', '/api/contacts/42', { status: 'suppressed' })

    expect(res.status).toBe(500)

    // Verify rollback was called before returning error
    const rollbackIdx = calls.findIndex(c => c.sql === 'ROLLBACK')
    const commitIdx = calls.findIndex(c => c.sql === 'COMMIT')
    expect(rollbackIdx).toBeGreaterThan(-1)
    expect(commitIdx).toBe(-1) // No commit after rollback
  })

  it('DELETE: all operations rollback together on any error', async () => {
    const contactBefore = { id: 42, email: 'john@example.com', status: 'active' }

    queueResult([]) // BEGIN
    queueResult([contactBefore]) // SELECT
    queueResult([{ id: 42 }]) // DELETE
    queueResult(new Error('audit table full')) // INSERT audit fails

    const res = await req('DELETE', '/api/contacts/42')

    expect(res.status).toBe(500)

    const rollbackIdx = calls.findIndex(c => c.sql === 'ROLLBACK')
    const commitIdx = calls.findIndex(c => c.sql === 'COMMIT')
    expect(rollbackIdx).toBeGreaterThan(-1)
    expect(commitIdx).toBe(-1)
  })
})
