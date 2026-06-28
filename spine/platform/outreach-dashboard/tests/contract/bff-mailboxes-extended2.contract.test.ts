// ═══════════════════════════════════════════════════════════════════════
//  BFF contract — mailboxes CRUD extended
//
//  Covers:
//    PATCH /api/mailboxes/:id  — field updates, unknown fields, large
//                                payload monkey, concurrent requests
//    POST  /api/mailboxes      — create, missing required fields, DB
//                                error, monkey all-field-types
//    DELETE /api/mailboxes/:id — existing, nonexistent, DB error
// ═══════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  // POST /api/mailboxes takes an advisory lock + a pool-capacity pre-flight
  // SELECT before the INSERT. Short-circuit those infra queries WITHOUT
  // consuming queryQueue so the queued INSERT/audit rows stay aligned.
  function infraShortCircuit(sql: unknown): { rows: unknown[]; rowCount: number } | null {
    const s = typeof sql === 'string' ? sql : ''
    if (/pg_advisory(_xact)?_lock|pg_advisory_unlock/i.test(s)) return { rows: [], rowCount: 0 }
    if (/pinned_endpoint_label IS NOT NULL/i.test(s) && !process.env.WIREPROXY_POOL_CONFIG) {
      return { rows: [{ pinned: 0 }], rowCount: 1 }
    }
    return null
  }
  class Pool {
    async query(sql: string, params?: unknown[]) {
      const infra = infraShortCircuit(sql)
      if (infra) return infra
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
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
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

// ═══════════════════════════════════════════════════════════════════════
//  PATCH /api/mailboxes/:id extended
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /api/mailboxes/:id extended', () => {
  it('updates smtp_host successfully', async () => {
    const row = {
      id: 1, email: 'jan@test.cz', display_name: 'Jan', host: 'new-smtp.cz', port: 587,
      smtp_username: 'jan@test.cz', imap_host: null, imap_port: null, imap_username: null,
      status: 'active', status_reason: null, daily_limit: 100, total_sent: 0,
      total_bounced: 0, consecutive_bounces: 0, proxy_url: null, last_send_at: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }
    // PATCH now opens a txn and SELECTs the current row (for audit) before the
    // UPDATE, then re-fetches the full MB_SELECT shape it returns. Queue those.
    queueRows([{ id: 1, status: 'active' }]) // pre-SELECT current state
    queueRows([]) // UPDATE (no RETURNING)
    queueRows([row]) // MB_SELECT re-fetch (the row the handler returns)
    const res = await req('PATCH', '/api/mailboxes/1', { smtp_host: 'new-smtp.cz' })
    expect(res.status).toBe(200)
    const body = res.body as { host: string }
    expect(body.host).toBe('new-smtp.cz')
    // Verify the UPDATE SQL was issued (calls[0] is now the pre-SELECT)
    const updateCall = calls.find(c => c.sql?.includes('UPDATE outreach_mailboxes'))
    expect(updateCall?.sql).toMatch(/UPDATE outreach_mailboxes/i)
    expect(updateCall?.sql).toMatch(/smtp_host/i)
  })

  it('unknown field → ignored (not crash)', async () => {
    // When only unknown fields are sent, server returns 400 "nothing to update".
    // The handler first opens a txn + SELECTs the row (for audit), so the
    // mailbox must exist; the contract is that NO write (UPDATE) is issued.
    queueRows([{ id: 1, status: 'active' }]) // pre-SELECT current state
    const res = await req('PATCH', '/api/mailboxes/1', {
      totally_unknown_field: 'value',
      another_unknown: 42,
      nested: { deep: true },
    })
    // Must not be 500 — 400 (nothing to update)
    expect(res.status).not.toBe(500)
    expect(calls.find(c => c.sql?.includes('UPDATE outreach_mailboxes'))).toBeUndefined()
  })

  it('MONKEY: large payload → graceful', async () => {
    // 50 KB+ body — server must not crash. display_name is a valid field, so
    // with the txn pre-SELECT + UPDATE + re-fetch it resolves to 200.
    const hugeString = 'x'.repeat(50_000)
    queueRows([{ id: 1, status: 'active' }]) // pre-SELECT current state
    queueRows([]) // UPDATE
    queueRows([{ id: 1, display_name: hugeString }]) // MB_SELECT re-fetch
    const res = await req('PATCH', '/api/mailboxes/1', {
      display_name: hugeString,
    })
    // 200 (updated) or 400; NOT 500
    expect([200, 400]).toContain(res.status)
  })

  it('concurrent PATCH requests → server survives', async () => {
    // Queue enough rows for all concurrent requests that reach DB
    for (let i = 0; i < 10; i++) {
      queueRows([{
        id: i + 1, email: `m${i}@test.cz`, host: 's', port: 587,
        smtp_username: 'u', status: 'active', daily_limit: 100,
        total_sent: 0, total_bounced: 0, consecutive_bounces: 0,
      }])
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        req('PATCH', `/api/mailboxes/${i + 1}`, { status: 'active' })
      )
    )
    // All responses must be non-500 server errors (some might 400 due to queue race)
    for (const r of results) {
      expect(r.status).not.toBe(500)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/mailboxes (create)
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes (create)', () => {
  it('valid body → 200 with created mailbox row', async () => {
    const created = {
      id: 99, email: 'new@test.cz', display_name: 'New', host: 'smtp.test.cz', port: 587,
      smtp_username: 'new@test.cz', imap_host: null, imap_port: null,
      status: 'active', status_reason: null, daily_limit: 100,
      total_sent: 0, total_bounced: 0, consecutive_bounces: 0,
      proxy_url: null, last_send_at: null,
      created_at: '2026-04-24T00:00:00Z', updated_at: '2026-04-24T00:00:00Z',
    }
    queueRows([created])
    const res = await req('POST', '/api/mailboxes', {
      email: 'new@test.cz',
      smtp_host: 'smtp.test.cz',
      smtp_port: 587,
      password: 'secret123',
    })
    // BFF returns the first row from RETURNING — 200 (Express default)
    expect([200, 201]).toContain(res.status)
    const body = res.body as { id: number }
    expect(body.id).toBe(99)
  })

  it('missing required field (email) → DB error propagated as 500', async () => {
    // BFF passes req.body.email directly into INSERT — null email causes pg NOT NULL
    // violation which propagates as 500 via capture500
    queueError('null value in column "from_address" violates not-null constraint')
    const res = await req('POST', '/api/mailboxes', {
      smtp_host: 'smtp.test.cz',
      password: 'secret123',
      // email intentionally omitted → b.email = undefined → null in INSERT
    })
    expect(res.status).toBe(500)
  })

  it('DB error → 500', async () => {
    queueError('connection timeout')
    const res = await req('POST', '/api/mailboxes', {
      email: 'err@test.cz',
      smtp_host: 'smtp.err.cz',
      password: 'pass',
    })
    expect(res.status).toBe(500)
  })

  it('MONKEY: all field types never crash (string, number, bool, null, array, object)', async () => {
    // BFF does not validate body types — it passes values directly to pg.
    // The handler must not throw an uncaught exception (it may 500 from pg).
    const monkeyBodies = [
      { email: 42, smtp_host: true, password: null },
      { email: [], smtp_host: {}, password: undefined },
      { email: '', smtp_host: '', password: '' },
      { email: 'a@b.cz', smtp_host: 'h', password: 'p', smtp_port: 'not-a-number' },
      { email: 'a@b.cz', smtp_host: 'h', password: 'p', daily_limit: -999 },
      null,
      '',
    ]
    for (const body of monkeyBodies) {
      // Queue a pg error so handler always returns 500 rather than hang
      queueError('monkey pg error')
      const res = await req('POST', '/api/mailboxes', body ?? {})
      // Must never crash the server — only valid HTTP statuses
      expect([200, 201, 400, 500]).toContain(res.status)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/mailboxes/:id
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/mailboxes/:id', () => {
  it('existing mailbox → 200 {ok:true}', async () => {
    // DELETE now opens a txn → SELECT id,email,from_address (for audit) →
    // DELETE → INSERT operator_audit_log → COMMIT. Queue the pre-SELECT row so
    // the mailbox is found, then the DELETE + audit succeed.
    queueRows([{ id: 1, email: 'x@test.cz', from_address: 'x@test.cz' }]) // pre-SELECT
    queueRows([]) // DELETE
    queueRows([]) // INSERT audit
    const res = await req('DELETE', '/api/mailboxes/1')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('nonexistent id → 404 mailbox_not_found', async () => {
    // Behavior change: the DELETE handler now SELECTs the row for an audit log
    // and returns 404 when it does not exist (src/server-routes/mailboxes.js
    // ~line 431: `if (!mailbox) { ROLLBACK; return 404 mailbox_not_found }`).
    queueRows([]) // pre-SELECT returns no row
    const res = await req('DELETE', '/api/mailboxes/99999')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'mailbox_not_found' })
  })

  it('DB error → 500', async () => {
    queueError('relation "outreach_mailboxes" does not exist')
    const res = await req('DELETE', '/api/mailboxes/1')
    expect(res.status).toBe(500)
  })

  it('DELETE SQL targets correct id', async () => {
    queueRows([{ id: 42, email: 'x@test.cz', from_address: 'x@test.cz' }]) // pre-SELECT
    queueRows([]) // DELETE
    queueRows([]) // INSERT audit
    await req('DELETE', '/api/mailboxes/42')
    const deleteCall = calls.find(c => c.sql?.includes('DELETE FROM outreach_mailboxes'))
    expect(deleteCall?.sql).toMatch(/DELETE FROM outreach_mailboxes/i)
    expect(deleteCall?.params).toContain('42')
  })

  it('DELETE with string id (route param is always string)', async () => {
    queueRows([{ id: 7, email: 'x@test.cz', from_address: 'x@test.cz' }]) // pre-SELECT
    queueRows([]) // DELETE
    queueRows([]) // INSERT audit
    const res = await req('DELETE', '/api/mailboxes/7')
    expect(res.status).toBe(200)
    const deleteCall = calls.find(c => c.sql?.includes('DELETE FROM outreach_mailboxes'))
    expect(typeof deleteCall?.params?.[0]).toBe('string')
  })
})
