// Contract tests for POST /api/mailboxes/bulk-set-password.
//
// Operator's morning workflow saves time by setting all 24 mailbox
// passwords in a single request instead of clicking through the per-row
// edit modal 24 times. This file locks:
//   - happy path (mix of id-based and email-based rows)
//   - per-row validation (placeholder pwds rejected, missing identifier rejected)
//   - schema gaps (mailbox not found returns ok=false for that row, not 500)
//   - the response NEVER echoes the password back

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
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    async connect() { return new PoolClient() }
    on() {} end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server

const savedEnv: Record<string, string | undefined> = {}
beforeAll(async () => {
  for (const k of ['BFF_AUTH_DISABLED', 'BFF_IMPORT_ONLY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  vi.resetModules()
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

function pushAll(...outcomes: QueryOutcome[]) { queryQueue.push(...outcomes) }
async function postBulk(rows: unknown[]) {
  return fetch(`${baseUrl}/api/mailboxes/bulk-set-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  })
}

describe('POST /api/mailboxes/bulk-set-password', () => {
  it('1: empty body → 400', async () => {
    const res = await postBulk([])
    expect(res.status).toBe(400)
  })

  it('2: 100+ rows → 400', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ id: i, password: 'StrongP@ss99' }))
    const res = await postBulk(rows)
    expect(res.status).toBe(400)
  })

  it('3: happy path — id-based update returns ok per row', async () => {
    // per row: BEGIN → UPDATE → audit INSERT → COMMIT
    pushAll(
      { rows: [] },                                  // BEGIN (row 1)
      { rows: [{ id: 1, email: 'a@x.cz' }] },       // UPDATE (row 1)
      { rows: [] },                                  // audit INSERT (row 1)
      { rows: [] },                                  // COMMIT (row 1)
      { rows: [] },                                  // BEGIN (row 2)
      { rows: [{ id: 2, email: 'b@x.cz' }] },       // UPDATE (row 2)
      { rows: [] },                                  // audit INSERT (row 2)
      { rows: [] },                                  // COMMIT (row 2)
    )
    const res = await postBulk([
      { id: 1, password: 'StrongP@ss99' },
      { id: 2, password: 'AnotherP@ss88' },
    ])
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; updated: number; total: number }
    expect(body.ok).toBe(true)
    expect(body.updated).toBe(2)
    expect(body.total).toBe(2)
  })

  it('4: happy path — email-based update', async () => {
    // BEGIN → UPDATE → audit INSERT → COMMIT
    pushAll(
      { rows: [] },                                  // BEGIN
      { rows: [{ id: 1, email: 'a@x.cz' }] },       // UPDATE
      { rows: [] },                                  // audit INSERT
      { rows: [] },                                  // COMMIT
    )
    const res = await postBulk([{ email: 'a@x.cz', password: 'StrongP@ss99' }])
    const body = await res.json() as { updated: number }
    expect(body.updated).toBe(1)
  })

  it('5: placeholder password rejected without DB write', async () => {
    const res = await postBulk([{ id: 1, password: 'xxxxxxxx' }])
    const body = await res.json() as { errors: Array<{ error: string }>; updated: number }
    expect(body.updated).toBe(0)
    expect(body.errors[0].error).toMatch(/placeholder|politiku/)
    // No SQL hit
    expect(calls.length).toBe(0)
  })

  it('6: short password (<8) rejected', async () => {
    const res = await postBulk([{ id: 1, password: 'short' }])
    const body = await res.json() as { errors: unknown[] }
    expect(body.errors.length).toBe(1)
  })

  it('7: missing identifier (no id, no email) → row error', async () => {
    const res = await postBulk([{ password: 'StrongP@ss99' }])
    const body = await res.json() as { errors: Array<{ error: string }> }
    expect(body.errors[0].error).toMatch(/id nebo email/)
  })

  it('8: mixed valid+invalid rows — partial success', async () => {
    // valid row: BEGIN → UPDATE → audit INSERT → COMMIT; invalid (placeholder) skips DB
    pushAll(
      { rows: [] },                                  // BEGIN
      { rows: [{ id: 1, email: 'a@x.cz' }] },       // UPDATE
      { rows: [] },                                  // audit INSERT
      { rows: [] },                                  // COMMIT
    )
    const res = await postBulk([
      { id: 1, password: 'StrongP@ss99' },     // valid
      { id: 2, password: 'xxxxxxxx' },          // placeholder — no DB calls
    ])
    const body = await res.json() as { updated: number; total: number; errors: unknown[] }
    expect(body.updated).toBe(1)
    expect(body.total).toBe(2)
    expect(body.errors.length).toBe(1)
  })

  it('9: mailbox not found → row ok=false (not 500)', async () => {
    // BEGIN → UPDATE (no rows) → ROLLBACK
    pushAll(
      { rows: [] },   // BEGIN
      { rows: [] },   // UPDATE returns empty → not found → ROLLBACK
    )
    const res = await postBulk([{ id: 999, password: 'StrongP@ss99' }])
    expect(res.status).toBe(200)
    const body = await res.json() as { errors: Array<{ error: string }> }
    expect(body.errors[0].error).toMatch(/nenalezena/)
  })

  it('10: response NEVER echoes the password', async () => {
    // BEGIN → UPDATE → audit INSERT → COMMIT
    pushAll(
      { rows: [] },
      { rows: [{ id: 1, email: 'a@x.cz' }] },
      { rows: [] },
      { rows: [] },
    )
    const res = await postBulk([{ id: 1, password: 'TopSecretP@ss123!' }])
    const text = await res.text()
    expect(text).not.toContain('TopSecretP@ss123!')
    expect(text).not.toMatch(/"password":/)
  })

  it('11: SQL UPDATE uses parameterized query', async () => {
    // BEGIN → UPDATE → audit INSERT → COMMIT
    pushAll(
      { rows: [] },
      { rows: [{ id: 1, email: 'a@x.cz' }] },
      { rows: [] },
      { rows: [] },
    )
    await postBulk([{ id: 1, password: 'StrongP@ss99' }])
    // calls[0]=BEGIN, calls[1]=UPDATE (the parameterized one)
    const updateCall = calls.find(c => c.sql.includes('UPDATE outreach_mailboxes'))
    expect(updateCall).toBeDefined()
    // SQL must not contain the password text inline
    expect(updateCall!.sql).not.toContain('StrongP@ss99')
    // Password must be in params
    expect(updateCall!.params).toContain('StrongP@ss99')
  })

  it('12: ok=false at top level when ANY row failed', async () => {
    // valid row: BEGIN → UPDATE → audit → COMMIT; missing-ident row: no DB
    pushAll(
      { rows: [] },
      { rows: [{ id: 1, email: 'a@x.cz' }] },
      { rows: [] },
      { rows: [] },
    )
    const res = await postBulk([
      { id: 1, password: 'StrongP@ss99' },
      { password: 'StrongP@ss99' },  // missing identifier
    ])
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  it('13: audit log INSERT fires for each successful row', async () => {
    // 2 rows → 2× (BEGIN + UPDATE + audit INSERT + COMMIT)
    pushAll(
      { rows: [] }, { rows: [{ id: 1, email: 'mb1@redacted' }] }, { rows: [] }, { rows: [] },
      { rows: [] }, { rows: [{ id: 2, email: 'mb2@redacted' }] }, { rows: [] }, { rows: [] },
    )
    await postBulk([
      { id: 1, password: 'StrongP@ss11' },
      { id: 2, password: 'StrongP@ss22' },
    ])
    const auditCalls = calls.filter(c => c.sql.includes('operator_audit_log'))
    expect(auditCalls.length).toBe(2)
  })

  it('14: audit details NEVER contain password value (PII guard)', async () => {
    pushAll(
      { rows: [] },
      { rows: [{ id: 5, email: 'mb5@redacted' }] },
      { rows: [] },
      { rows: [] },
    )
    await postBulk([{ id: 5, password: 'SecretP@ssword!' }])
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    const detail = JSON.stringify(auditCall!.params)
    expect(detail).not.toContain('SecretP@ssword!')
    expect(detail).toContain('field')
    expect(detail).toContain('rotated_at')
  })

  it('15: DB error mid-row → ROLLBACK → no audit row for that row', async () => {
    pushAll(
      { rows: [] },              // BEGIN
      new Error('db down'),      // UPDATE throws → ROLLBACK
    )
    const res = await postBulk([{ id: 1, password: 'StrongP@ss99' }])
    expect(res.status).toBe(200)  // error is per-row, not 500
    const body = await res.json() as { updated: number; errors: unknown[] }
    expect(body.updated).toBe(0)
    expect(body.errors.length).toBe(1)
    // No audit row because ROLLBACK happened
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})
