// S3 — BFF /api/dsr/access + /api/dsr/erase contract tests.
// GDPR čl. 15 (access) and čl. 17 (erasure) endpoints.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    async connect() {
      // For DSR erase, returns transactional client. Reuse pool's
      // query() so tests can queue results in order.
      const self = this
      return {
        async query(sql: string, params?: unknown[]) {
          return self.query(sql, params)
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
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
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

function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ─── /api/dsr/access ─────────────────────────────────────────────────────────

describe('GET /api/dsr/access', () => {
  it('400 missing email parameter', async () => {
    const { status } = await req('GET', '/api/dsr/access')
    expect(status).toBe(400)
  })

  it('400 invalid email (no @)', async () => {
    const { status } = await req('GET', '/api/dsr/access?email=notanemail')
    expect(status).toBe(400)
  })

  it('aggregates all 8 PII tables — checks SQL fired against each', async () => {
    // Queue 8 successful results for the 8 parallel queries (Promise.all)
    for (let i = 0; i < 8; i++) q([])
    q([]) // operator_audit_log INSERT after parallel queries

    const { status, body } = await req('GET', '/api/dsr/access?email=jan@firma.cz')
    expect(status).toBe(200)

    // Verify queries hit each expected table
    const sqls = calls.map(c => c.sql)
    const expectedTables = [
      /FROM contacts/,
      /FROM outreach_contacts/,
      /FROM send_events/,
      /FROM reply_inbox/,
      /FROM tracking_events/,
      /FROM suppression_list/,
      /FROM outreach_suppressions/,
      /FROM operator_audit_log/,
    ]
    for (const re of expectedTables) {
      expect(sqls.some(s => re.test(s)), `expected query against ${re}`).toBe(true)
    }

    // Verify response shape
    const b = body as Record<string, unknown>
    expect(b.email).toBe('jan@firma.cz')
    expect(b).toHaveProperty('contacts')
    expect(b).toHaveProperty('outreach_contacts')
    expect(b).toHaveProperty('send_events')
    expect(b).toHaveProperty('reply_inbox')
    expect(b).toHaveProperty('tracking_events')
    expect(b).toHaveProperty('suppression_list')
    expect(b).toHaveProperty('outreach_suppressions')
    expect(b).toHaveProperty('audit_log')
    expect(b).toHaveProperty('found_total')
    expect(b).toHaveProperty('generated_at')
  })

  it('found_total reflects actual count across tables', async () => {
    q([{ id: 1, email: 'jan@firma.cz' }])  // contacts: 1
    q([{ id: 2, email: 'jan@firma.cz' }])  // outreach_contacts: 1
    q([{ id: 3 }, { id: 4 }])              // send_events: 2
    q([])                                  // reply_inbox: 0
    q([])                                  // tracking_events: 0
    q([])                                  // suppression_list: 0
    q([])                                  // outreach_suppressions: 0
    q([])                                  // audit_log: 0
    q([])                                  // audit insert
    const { body } = await req('GET', '/api/dsr/access?email=jan@firma.cz')
    expect((body as { found_total: number }).found_total).toBe(4)
  })

  it('writes dsr_access audit log entry', async () => {
    for (let i = 0; i < 8; i++) q([])
    q([]) // audit
    await req('GET', '/api/dsr/access?email=test@test.cz')
    const auditCall = calls.find(c => /INSERT INTO operator_audit_log/.test(c.sql) && /dsr_access/.test(c.sql))
    expect(auditCall).toBeTruthy()
  })

  it('lowercase + trim email parameter (case-insensitive lookup)', async () => {
    for (let i = 0; i < 8; i++) q([])
    q([])
    const { body } = await req('GET', '/api/dsr/access?email=  JAN@FIRMA.CZ  ')
    expect((body as { email: string }).email).toBe('jan@firma.cz')
  })
})

// ─── /api/dsr/erase ─────────────────────────────────────────────────────────

describe('POST /api/dsr/erase', () => {
  it('400 missing email', async () => {
    const { status } = await req('POST', '/api/dsr/erase')
    expect(status).toBe(400)
  })

  it('400 invalid email shape', async () => {
    const { status } = await req('POST', '/api/dsr/erase?email=invalid')
    expect(status).toBe(400)
  })

  it('cascade deletes across 5 tables; suppression preserved', async () => {
    // Transaction sequence:
    // 1. BEGIN
    q([])
    // 2. SELECT contacts ids
    q([{ id: 100 }, { id: 101 }])
    // 3. DELETE tracking_events (rowCount: 5)
    q([], 5)
    // 4. DELETE reply_inbox (rowCount: 2)
    q([], 2)
    // 5. DELETE send_events (rowCount: 10)
    q([], 10)
    // 6. DELETE outreach_contacts (rowCount: 1)
    q([], 1)
    // 7. DELETE contacts (rowCount: 2)
    q([], 2)
    // 8. INSERT into suppression_list (proof of opt-out)
    q([])
    // 9. INSERT operator_audit_log
    q([])
    // 10. COMMIT
    q([])

    const { status, body } = await req('POST', '/api/dsr/erase?email=ghost@test.cz')
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.suppression_kept).toBe(true)
    expect(b.deleted).toMatchObject({
      tracking_events: 5,
      reply_inbox: 2,
      send_events: 10,
      outreach_contacts: 1,
      contacts: 2,
    })
  })

  it('writes dsr_erase audit log entry', async () => {
    q([])  // BEGIN
    q([{ id: 200 }])  // contact ids
    q([], 0); q([], 0); q([], 0); q([], 0); q([], 1)  // 5 deletes
    q([])  // suppression_list insert
    q([])  // audit log insert
    q([])  // COMMIT
    await req('POST', '/api/dsr/erase?email=erase@test.cz')
    const auditCall = calls.find(c => /INSERT INTO operator_audit_log/.test(c.sql) && /dsr_erase/.test(c.sql))
    expect(auditCall).toBeTruthy()
  })

  it('contact not found returns ok with zero deletes (idempotent)', async () => {
    q([])  // BEGIN
    q([])  // SELECT returns empty
    q([])  // suppression_list insert
    q([])  // audit log
    q([])  // COMMIT
    const { status, body } = await req('POST', '/api/dsr/erase?email=neverhad@test.cz')
    expect(status).toBe(200)
    expect((body as { deleted: { contacts: number } }).deleted.contacts).toBe(0)
    // Suppression still added even if no contact existed — belt-and-suspenders
    // for any future ETL re-import.
    const suppressionInsert = calls.find(c => /INSERT INTO suppression_list/.test(c.sql))
    expect(suppressionInsert).toBeTruthy()
  })

  it('BF-D1: rate-limit bypassed when BFF_AUTH_DISABLED=1 (test env)', async () => {
    // Confirms tests can hammer the endpoint without 429. Production
    // path is rate-limited 10/min/IP — covered by code review of
    // _dsrAllow + production deploy lacks BFF_AUTH_DISABLED.
    for (let i = 0; i < 15; i++) {
      q([])  // BEGIN
      q([])  // SELECT contacts (empty)
      q([])  // suppression_list insert
      q([])  // audit
      q([])  // COMMIT
      const { status } = await req('POST', '/api/dsr/erase?email=rate@test.cz')
      expect(status).toBe(200)  // not 429
    }
  })

  it('email parameter accepted in body OR query', async () => {
    q([])  // BEGIN
    q([])  // SELECT contacts
    q([])  // suppression_list insert
    q([])  // audit
    q([])  // COMMIT
    const { status } = await req('POST', '/api/dsr/erase', { email: 'body@test.cz' })
    expect(status).toBe(200)
    // SELECT query parameters should contain the body email
    const select = calls.find(c => /SELECT id FROM contacts WHERE/.test(c.sql))
    expect(select?.params).toContain('body@test.cz')
  })
})
