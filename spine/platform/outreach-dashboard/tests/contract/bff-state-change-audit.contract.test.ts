// ═══════════════════════════════════════════════════════════════════════════
//  Issue #866 — BFF State-Change Audit Logging
//
// The BFF must audit log all state-changing operations on mailboxes and campaigns:
//   1. POST /api/mailboxes → INSERT with action='mailbox_create'
//   2. PATCH /api/mailboxes/:id (status changes) → INSERT with action='mailbox_pause' or 'mailbox_resume'
//   3. POST /api/campaigns/:id/run → INSERT with action='campaign_activate'
//   4. POST /api/campaigns/:id/pause → INSERT with action='campaign_pause'
//
// Each operation is atomic: fetch state → update → audit INSERT in one transaction.
// If audit INSERT fails, the entire transaction rolls back and the state change is NOT applied.
// Preflight failures (412) bypass transactions; audit only on success path.
//
// This test locks in the invariant so state-changing operations maintain forensic trail.
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

const API_KEY = 'test-key-state-audit'
let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.OUTREACH_API_KEY = API_KEY
  process.env.GO_SERVER_URL = '' // Disable Go service to test fallback paths
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

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/mailboxes — audit log on create
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes — mailbox_create audit', () => {
  it('successful create → 200 + audit row inserted', async () => {
    // Queue: BEGIN, INSERT new mailbox, INSERT audit, COMMIT
    queueResult([]) // BEGIN
    queueResult([
      {
        id: 1,
        email: 'new@seznam.cz',
        display_name: 'New Mailbox',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'active',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]) // INSERT mailbox RETURNING
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await fetch(`${baseUrl}/api/mailboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        email: 'new@seznam.cz',
        display_name: 'New Mailbox',
        smtp_host: 'smtp.seznam.cz',
        smtp_port: 587,
        password: 'test-password',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(1)

    // Verify audit INSERT was called
    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.sql).toContain('mailbox_create')
    expect(auditCall?.params?.[0]).toBe('1')
    const details = auditCall?.params?.[1]
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    expect(parsed.email).toBe('new@seznam.cz')
  })

  it('audit INSERT failure → 500 + transaction rolled back', async () => {
    // Queue: BEGIN, INSERT, INSERT audit (FAILS), ROLLBACK
    queueResult([]) // BEGIN
    queueResult([
      {
        id: 2,
        email: 'fail@seznam.cz',
        display_name: 'Fail Mailbox',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'active',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]) // INSERT mailbox
    queueResult(new Error('Unique constraint on operator_audit_log')) // INSERT audit fails

    const res = await fetch(`${baseUrl}/api/mailboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        email: 'fail@seznam.cz',
        smtp_host: 'smtp.seznam.cz',
        password: 'test',
      }),
    })
    expect(res.status).toBe(500)

    // Verify ROLLBACK was called
    const rollbackCall = calls.find((c) => c.sql?.includes('ROLLBACK'))
    expect(rollbackCall).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PATCH /api/mailboxes/:id — audit log on status change
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /api/mailboxes/:id — status change audit', () => {
  it('pause (active → paused) → 200 + mailbox_pause audit', async () => {
    // Queue: BEGIN, SELECT (get current), UPDATE status, INSERT audit, COMMIT
    queueResult([]) // BEGIN
    queueResult([{ id: 10, status: 'active' }]) // SELECT current state
    queueResult([
      {
        id: 10,
        email: 'test@seznam.cz',
        display_name: 'Test',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'paused',
        status_reason: 'manual pause',
        daily_limit: 100,
        total_sent: 100,
        total_bounced: 5,
        consecutive_bounces: 0,
        imap_username: 'test@seznam.cz',
        imap_host: 'imap.seznam.cz',
        imap_port: 993,
        proxy_url: null,
        last_send_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]) // UPDATE mailbox
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await fetch(`${baseUrl}/api/mailboxes/10`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ status: 'paused' }),
    })
    expect(res.status).toBe(200)

    // Verify mailbox_pause audit was inserted
    // SQL: INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
    //      VALUES ($1, 'dashboard', 'mailbox', $2, $3::jsonb)
    // params: ['mailbox_pause', '10', {...}]
    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.params?.[0]).toBe('mailbox_pause')
    expect(auditCall?.params?.[1]).toBe('10') // entity_id as string
    const details = auditCall?.params?.[2]
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    expect(parsed.prev_status).toBe('active')
    expect(parsed.new_status).toBe('paused')
  })

  it('resume (paused → active) → 200 + mailbox_resume audit', async () => {
    // Queue: BEGIN, SELECT, UPDATE, INSERT audit, COMMIT
    queueResult([]) // BEGIN
    queueResult([{ id: 11, status: 'paused' }]) // SELECT
    queueResult([
      {
        id: 11,
        email: 'resume@seznam.cz',
        display_name: 'Resume',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'active',
        status_reason: null,
        daily_limit: 100,
        total_sent: 50,
        total_bounced: 2,
        consecutive_bounces: 0,
        imap_username: 'resume@seznam.cz',
        imap_host: 'imap.seznam.cz',
        imap_port: 993,
        proxy_url: null,
        last_send_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    const res = await fetch(`${baseUrl}/api/mailboxes/11`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ status: 'active' }),
    })
    expect(res.status).toBe(200)

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.params?.[0]).toBe('mailbox_resume')
    const details = auditCall?.params?.[2]
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    expect(parsed.prev_status).toBe('paused')
    expect(parsed.new_status).toBe('active')
  })

  it('non-status update (display_name only) → no audit log', async () => {
    // Queue: BEGIN, SELECT, UPDATE, COMMIT (no audit for non-status)
    queueResult([]) // BEGIN
    queueResult([{ id: 12, status: 'active' }]) // SELECT
    queueResult([
      {
        id: 12,
        email: 'name@seznam.cz',
        display_name: 'Updated Name',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'active',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        imap_username: 'name@seznam.cz',
        imap_host: 'imap.seznam.cz',
        imap_port: 993,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]) // UPDATE
    queueResult([]) // COMMIT

    const res = await fetch(`${baseUrl}/api/mailboxes/12`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ display_name: 'Updated Name' }),
    })
    expect(res.status).toBe(200)

    // Verify NO audit log was inserted
    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('audit INSERT failure on status change → 500 + rollback', async () => {
    // Queue: BEGIN, SELECT, UPDATE, INSERT audit (FAILS)
    queueResult([]) // BEGIN
    queueResult([{ id: 13, status: 'active' }]) // SELECT
    queueResult([
      {
        id: 13,
        email: 'auditfail@seznam.cz',
        display_name: 'Audit Fail',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'paused',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        imap_username: 'auditfail@seznam.cz',
        imap_host: 'imap.seznam.cz',
        imap_port: 993,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]) // UPDATE
    queueResult(new Error('audit log permission denied')) // INSERT audit fails

    const res = await fetch(`${baseUrl}/api/mailboxes/13`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ status: 'paused' }),
    })
    expect(res.status).toBe(500)

    const rollbackCall = calls.find((c) => c.sql?.includes('ROLLBACK'))
    expect(rollbackCall).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/campaigns/:id/run — audit log on activate
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/campaigns/:id/run — campaign_activate audit', () => {
  it('campaign not found on /run → 404 or 412 (no UPDATE, no audit)', async () => {
    // Queue: BEGIN, SELECT empty (for both preflight + state fetch)
    queueResult([]) // BEGIN
    queueResult([]) // SELECT returns empty (preflight check)
    queueResult([]) // SELECT returns empty (state fetch, if reached)

    const res = await fetch(`${baseUrl}/api/campaigns/999/run`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    })
    // May be 412 (preflight failed) or 404 (campaign not found) — both OK
    expect([404, 412]).toContain(res.status)

    // Verify no UPDATE or audit was issued
    const updateCall = calls.find((c) => c.sql?.includes('UPDATE campaigns'))
    expect(updateCall).toBeUndefined()
    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('invalid campaign ID (non-numeric) → 400', async () => {
    const res = await fetch(`${baseUrl}/api/campaigns/abc/run`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    })
    expect(res.status).toBe(400)

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/campaigns/:id/pause — audit log on pause
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/campaigns/:id/pause — campaign_pause audit', () => {
  it('campaign not found on /pause → 404 (no UPDATE, no audit)', async () => {
    // Queue: BEGIN, SELECT empty
    queueResult([]) // BEGIN
    queueResult([]) // SELECT returns empty

    const res = await fetch(`${baseUrl}/api/campaigns/999/pause`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    })
    expect(res.status).toBe(404)

    // Verify no UPDATE or audit
    const updateCall = calls.find((c) => c.sql?.includes('UPDATE campaigns'))
    expect(updateCall).toBeUndefined()
    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('invalid campaign ID (non-numeric) → 400', async () => {
    const res = await fetch(`${baseUrl}/api/campaigns/xyz/pause`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    })
    expect(res.status).toBe(400)

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Audit details verification
// ═══════════════════════════════════════════════════════════════════════

describe('State-change audit — details capture', () => {
  it('mailbox_create details include email and host', async () => {
    queueResult([]) // BEGIN
    queueResult([
      {
        id: 300,
        email: 'test@example.com',
        display_name: 'Test',
        host: 'smtp.example.com',
        port: 587,
        status: 'active',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
    queueResult([])
    queueResult([])

    await fetch(`${baseUrl}/api/mailboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        email: 'test@example.com',
        smtp_host: 'smtp.example.com',
        password: 'test',
      }),
    })

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    // params: [entity_id, details_json]
    expect(auditCall).toBeDefined()
    const details = auditCall?.params?.[1]
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    expect(parsed).toBeDefined()
    expect(parsed).toHaveProperty('email', 'test@example.com')
    expect(parsed).toHaveProperty('host', 'smtp.example.com')
    expect(parsed).toHaveProperty('id', 300)
  })

  it('mailbox_pause details include prev_status and new_status', async () => {
    queueResult([]) // BEGIN
    queueResult([{ id: 400, status: 'active' }]) // SELECT
    queueResult([
      {
        id: 400,
        email: 'test@seznam.cz',
        status: 'paused',
        host: 'smtp.seznam.cz',
        port: 587,
        display_name: 'Test',
        imap_username: 'test@seznam.cz',
        imap_host: 'imap.seznam.cz',
        imap_port: 993,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]) // UPDATE
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    await fetch(`${baseUrl}/api/mailboxes/400`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ status: 'paused' }),
    })

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    // params: [action, entity_id, details]
    expect(auditCall).toBeDefined()
    const details = auditCall?.params?.[2]
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    expect(parsed).toBeDefined()
    expect(parsed).toHaveProperty('prev_status', 'active')
    expect(parsed).toHaveProperty('new_status', 'paused')
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Additional boundary + error cases
// ═══════════════════════════════════════════════════════════════════════

describe('Boundary conditions — invalid IDs and edge cases', () => {
  it('PATCH /api/mailboxes with invalid ID (non-existent) → 404 (no audit)', async () => {
    queueResult([]) // BEGIN
    queueResult([]) // SELECT returns empty

    const res = await fetch(`${baseUrl}/api/mailboxes/99999`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ status: 'paused' }),
    })
    expect(res.status).toBe(404)

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('POST /api/campaigns/:id/run with non-numeric ID → 400 (no audit)', async () => {
    const res = await fetch(`${baseUrl}/api/campaigns/abc/run`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    })
    expect(res.status).toBe(400)

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('POST /api/campaigns/:id/pause with non-numeric ID → 400 (no audit)', async () => {
    const res = await fetch(`${baseUrl}/api/campaigns/invalid/pause`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    })
    expect(res.status).toBe(400)

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Transaction consistency: actor always set to 'dashboard'
// ═══════════════════════════════════════════════════════════════════════

describe('Audit log SQL structure — hardcoded action + entity_id/details params', () => {
  it('mailbox_create audit: SQL has hardcoded action/actor/entity_type, params=[id, details]', async () => {
    queueResult([])
    queueResult([
      {
        id: 500,
        email: 'test@seznam.cz',
        display_name: 'Test',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'active',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
    queueResult([])
    queueResult([])

    await fetch(`${baseUrl}/api/mailboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        email: 'test@seznam.cz',
        smtp_host: 'smtp.seznam.cz',
        password: 'test',
      }),
    })

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall?.sql).toContain('mailbox_create') // action hardcoded in SQL
    expect(auditCall?.sql).toContain("'dashboard'") // actor hardcoded
    expect(auditCall?.sql).toContain("'mailbox'") // entity_type hardcoded
    expect(auditCall?.params?.[0]).toBe('500') // entity_id (first param $1)
    expect(typeof auditCall?.params?.[1]).toBe('string') // details JSON (second param $2)
  })

  it('mailbox_pause audit: params=[action, entity_id, details]', async () => {
    queueResult([])
    queueResult([{ id: 501, status: 'active' }])
    queueResult([
      {
        id: 501,
        email: 'test@seznam.cz',
        display_name: 'Test',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'paused',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        imap_username: 'test@seznam.cz',
        imap_host: 'imap.seznam.cz',
        imap_port: 993,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
    queueResult([])
    queueResult([])

    await fetch(`${baseUrl}/api/mailboxes/501`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ status: 'paused' }),
    })

    const auditCall = calls.find((c) => c.sql?.includes('INSERT INTO operator_audit_log'))
    expect(auditCall?.params?.[0]).toBe('mailbox_pause') // action
    expect(auditCall?.params?.[1]).toBe('501') // entity_id
    expect(typeof auditCall?.params?.[2]).toBe('string') // details JSON
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Atomicity tests: BEGIN/COMMIT present for transactions
// ═══════════════════════════════════════════════════════════════════════

describe('Transaction atomicity — BEGIN/COMMIT protocol', () => {
  it('mailbox status change wraps in transaction (BEGIN/COMMIT)', async () => {
    queueResult([]) // BEGIN
    queueResult([{ id: 510, status: 'active' }]) // SELECT
    queueResult([
      {
        id: 510,
        email: 'mb510@seznam.cz',
        display_name: 'MB510',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'paused',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        imap_username: 'mb510@seznam.cz',
        imap_host: 'imap.seznam.cz',
        imap_port: 993,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    await fetch(`${baseUrl}/api/mailboxes/510`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ status: 'paused' }),
    })

    const beginCall = calls.find((c) => c.sql?.trim() === 'BEGIN')
    const commitCall = calls.find((c) => c.sql?.trim() === 'COMMIT')
    expect(beginCall).toBeDefined()
    expect(commitCall).toBeDefined()
  })

  it('mailbox creation wraps in transaction (BEGIN/COMMIT)', async () => {
    queueResult([]) // BEGIN
    queueResult([
      {
        id: 511,
        email: 'mb511@seznam.cz',
        display_name: 'MB511',
        host: 'smtp.seznam.cz',
        port: 587,
        status: 'active',
        status_reason: null,
        daily_limit: 100,
        total_sent: 0,
        total_bounced: 0,
        consecutive_bounces: 0,
        proxy_url: null,
        last_send_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
    queueResult([]) // INSERT audit
    queueResult([]) // COMMIT

    await fetch(`${baseUrl}/api/mailboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        email: 'mb511@seznam.cz',
        smtp_host: 'smtp.seznam.cz',
        password: 'test',
      }),
    })

    const beginCall = calls.find((c) => c.sql?.trim() === 'BEGIN')
    const commitCall = calls.find((c) => c.sql?.trim() === 'COMMIT')
    expect(beginCall).toBeDefined()
    expect(commitCall).toBeDefined()
  })
})
