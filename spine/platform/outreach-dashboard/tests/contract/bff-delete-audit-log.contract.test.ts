// ═══════════════════════════════════════════════════════════════════════════
//  Security Issue #819 — BFF DELETE endpoints with operator_audit_log
//
// The BFF must:
//   1. DELETE /api/mailboxes/:id → INSERT operator_audit_log with action='mailbox_delete'
//   2. DELETE /api/campaigns/:id → INSERT operator_audit_log with action='campaign_delete'
//   3. DELETE /api/templates/:id → INSERT operator_audit_log with action='template_delete'
//
// Each deletion is atomic: SELECT → DELETE → INSERT audit in one transaction.
// If audit INSERT fails, the entire transaction rolls back and the entity is NOT deleted.
// 404 on non-existent entity (checked before any DELETE attempt).
//
// This test locks in the invariant so destructive operations maintain forensic trail.
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

const API_KEY = 'test-key-delete-audit'
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

function queueResult(result: unknown[] | Error) {
  if (result instanceof Error) {
    queryQueue.push(result)
  } else {
    queryQueue.push({ rows: result })
  }
}

async function deleteMailbox(id: string) {
  const r = await fetch(`${baseUrl}/api/mailboxes/${id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': API_KEY },
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : null
  return { status: r.status, body: json, raw: text }
}

async function deleteCampaign(id: string) {
  const r = await fetch(`${baseUrl}/api/campaigns/${id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': API_KEY },
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : null
  return { status: r.status, body: json, raw: text }
}

async function deleteTemplate(id: string) {
  const r = await fetch(`${baseUrl}/api/templates/${id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': API_KEY },
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : null
  return { status: r.status, body: json, raw: text }
}

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/mailboxes/:id — audit log
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/mailboxes/:id — audit logging', () => {
  it('successful deletion → 200 + audit row inserted', async () => {
    // Queue: BEGIN, SELECT (find mailbox), DELETE, INSERT audit, COMMIT
    queueResult([]) // BEGIN
    queueResult([
      { id: 1, email: 'test@seznam.cz', from_address: 'test@seznam.cz' },
    ]) // SELECT mailbox
    queueResult([]) // DELETE
    queueResult([]) // INSERT operator_audit_log
    queueResult([]) // COMMIT

    const res = await deleteMailbox('1')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    // Verify the audit INSERT was called with correct action and entity_type
    const auditCall = calls.find((c) => c.sql.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.sql).toContain('mailbox_delete')
    expect(auditCall?.sql).toContain('mailbox')
    expect(auditCall?.params?.[0]).toBe('1')
  })

  it('non-existent mailbox → 404 (no deletion)', async () => {
    // Queue: BEGIN, SELECT (empty), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([]) // SELECT returns empty

    const res = await deleteMailbox('999')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'mailbox_not_found' })

    // Verify ROLLBACK was called
    const rollbackCall = calls.find((c) => c.sql?.includes('ROLLBACK'))
    expect(rollbackCall).toBeDefined()

    // Verify no DELETE was issued
    const deleteCall = calls.find((c) => c.sql?.includes('DELETE FROM outreach_mailboxes'))
    expect(deleteCall).toBeUndefined()
  })

  it('audit INSERT failure → 500 + transaction rolled back', async () => {
    // Queue: BEGIN, SELECT (find), DELETE, INSERT audit (FAILS), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([
      { id: 2, email: 'audit@seznam.cz', from_address: 'audit@seznam.cz' },
    ]) // SELECT mailbox
    queueResult([]) // DELETE
    queueResult(new Error('Unique constraint violation on operator_audit_log')) // INSERT audit fails

    const res = await deleteMailbox('2')
    expect(res.status).toBe(500)

    // Verify ROLLBACK was called after the error
    const rollbackCall = calls.find((c) => c.sql?.includes('ROLLBACK'))
    expect(rollbackCall).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/campaigns/:id — audit log
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/campaigns/:id — audit logging', () => {
  it('successful deletion → 200 + audit row inserted', async () => {
    // Queue: BEGIN, SELECT (find campaign), DELETE, INSERT audit, COMMIT
    queueResult([]) // BEGIN
    queueResult([
      { id: 42, name: 'Winter Campaign', subject: 'Special Offer' },
    ]) // SELECT campaign
    queueResult([]) // DELETE
    queueResult([]) // INSERT operator_audit_log
    queueResult([]) // COMMIT

    const res = await deleteCampaign('42')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    // Verify the audit INSERT was called with correct action and entity_type
    const auditCall = calls.find((c) => c.sql.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.sql).toContain('campaign_delete')
    expect(auditCall?.sql).toContain('campaign')
    expect(auditCall?.params?.[0]).toBe('42')
  })

  it('non-existent campaign → 404 (no deletion)', async () => {
    // Queue: BEGIN, SELECT (empty), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([]) // SELECT returns empty

    const res = await deleteCampaign('999')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Campaign not found' })

    // Verify no DELETE was issued
    const deleteCall = calls.find((c) => c.sql?.includes('DELETE FROM campaigns'))
    expect(deleteCall).toBeUndefined()
  })

  it('audit INSERT failure → 500 + transaction rolled back', async () => {
    // Queue: BEGIN, SELECT (find), DELETE, INSERT audit (FAILS), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([
      { id: 43, name: 'Spring Campaign', subject: 'New Season' },
    ]) // SELECT campaign
    queueResult([]) // DELETE
    queueResult(new Error('Database connection lost')) // INSERT audit fails

    const res = await deleteCampaign('43')
    expect(res.status).toBe(500)

    // Verify ROLLBACK was called
    const rollbackCall = calls.find((c) => c.sql?.includes('ROLLBACK'))
    expect(rollbackCall).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/templates/:id — audit log
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/templates/:id — audit logging', () => {
  it('successful deletion → 200 + audit row inserted', async () => {
    // Queue: BEGIN, SELECT (find template), DELETE, INSERT audit, COMMIT
    queueResult([]) // BEGIN
    queueResult([
      { id: 10, name: 'Welcome Template', subject: 'Welcome to {{company}}' },
    ]) // SELECT template
    queueResult([]) // DELETE
    queueResult([]) // INSERT operator_audit_log
    queueResult([]) // COMMIT

    const res = await deleteTemplate('10')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    // Verify the audit INSERT was called with correct action and entity_type
    const auditCall = calls.find((c) => c.sql.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.sql).toContain('template_delete')
    expect(auditCall?.sql).toContain('template')
    expect(auditCall?.params?.[0]).toBe('10')
  })

  it('non-existent template → 404 (no deletion)', async () => {
    // Queue: BEGIN, SELECT (empty), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([]) // SELECT returns empty

    const res = await deleteTemplate('999')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Template not found' })

    // Verify no DELETE was issued
    const deleteCall = calls.find((c) => c.sql?.includes('DELETE FROM email_templates'))
    expect(deleteCall).toBeUndefined()
  })

  it('audit INSERT failure → 500 + transaction rolled back', async () => {
    // Queue: BEGIN, SELECT (find), DELETE, INSERT audit (FAILS), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([
      { id: 11, name: 'Followup Template', subject: 'Following up...' },
    ]) // SELECT template
    queueResult([]) // DELETE
    queueResult(new Error('Permission denied on operator_audit_log')) // INSERT audit fails

    const res = await deleteTemplate('11')
    expect(res.status).toBe(500)

    // Verify ROLLBACK was called
    const rollbackCall = calls.find((c) => c.sql?.includes('ROLLBACK'))
    expect(rollbackCall).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Audit details capture
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE endpoints — audit details capture', () => {
  it('mailbox audit includes email and from_address', async () => {
    queueResult([]) // BEGIN
    queueResult([
      {
        id: 5,
        email: 'sender@company.cz',
        from_address: 'noreply@company.cz',
      },
    ]) // SELECT
    queueResult([]) // DELETE
    queueResult([]) // INSERT
    queueResult([]) // COMMIT

    await deleteMailbox('5')

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    const details = auditCall?.params?.[1]
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    expect(parsed).toEqual({
      id: 5,
      email: 'sender@company.cz',
      from_address: 'noreply@company.cz',
    })
  })

  it('campaign audit includes name and subject', async () => {
    queueResult([]) // BEGIN
    queueResult([
      {
        id: 77,
        name: 'Q2 Outreach',
        subject: 'Ready for Q2?',
      },
    ]) // SELECT
    queueResult([]) // DELETE
    queueResult([]) // INSERT
    queueResult([]) // COMMIT

    await deleteCampaign('77')

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    const details = auditCall?.params?.[1]
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    expect(parsed).toEqual({
      id: 77,
      name: 'Q2 Outreach',
      subject: 'Ready for Q2?',
    })
  })

  it('template audit includes name and subject', async () => {
    queueResult([]) // BEGIN
    queueResult([
      {
        id: 33,
        name: 'Discount Offer',
        subject: '20% Off This Week',
      },
    ]) // SELECT
    queueResult([]) // DELETE
    queueResult([]) // INSERT
    queueResult([]) // COMMIT

    await deleteTemplate('33')

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    const details = auditCall?.params?.[1]
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    expect(parsed).toEqual({
      id: 33,
      name: 'Discount Offer',
      subject: '20% Off This Week',
    })
  })
})
