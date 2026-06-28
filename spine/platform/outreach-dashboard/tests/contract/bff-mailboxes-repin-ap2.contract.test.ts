// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — AP2 mailbox egress repin
//
//  Sprint AP2 (2026-05-08): forced operator repin with audit trail.
//
//  Route: POST /api/mailboxes/:id/repin
//  Body:  { new_endpoint_label: string, reason: string }
//
//  Covers:
//    1. Happy path — returns 200 with old_label/new_label/reason/actor
//    2. Missing reason → 400
//    3. Empty reason string → 400
//    4. Missing new_endpoint_label → 400
//    5. Mailbox not found → 404
//    6. Audit row INSERT is executed
//    7. UPDATE to outreach_mailboxes is executed
//    8. actor defaults to 'operator' when X-Operator-Id header absent
//    9. actor uses X-Operator-Id header value when provided
//   10. DB error during audit INSERT → 500 (rollback)
//   11. DB error during UPDATE → 500 (rollback)
//   12. Invalid (non-numeric) mailbox id → 400
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ─── pool mock ──────────────────────────────────────────────────────────────
type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

let connectClientQueryQueue: QueryOutcome[] = []
let connectClientReleased = false

vi.mock('pg', () => {
  class Client {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!connectClientQueryQueue.length) return { rows: [], rowCount: 0 }
      const next = connectClientQueryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    release() { connectClientReleased = true }
  }

  class Pool {
    async connect() {
      connectClientReleased = false
      return new Client()
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
  connectClientQueryQueue = []
  connectClientReleased = false
})

function queueClientRows(rows: unknown[], rowCount?: number) {
  connectClientQueryQueue.push({ rows, rowCount: rowCount ?? rows.length })
}
function queueClientError(msg: string) {
  connectClientQueryQueue.push(new Error(msg))
}

async function req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders }
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// Stub DB: BEGIN, SELECT mailbox, INSERT audit, UPDATE pin, COMMIT
function queueHappyPath(oldLabel: string | null = 'cz5') {
  queueClientRows([])                       // BEGIN
  queueClientRows([{ id: 42, from_address: 'mb@example.cz', pinned_endpoint_label: oldLabel }]) // SELECT
  queueClientRows([], 1)                    // INSERT audit
  queueClientRows([], 1)                    // UPDATE pin
  queueClientRows([])                       // COMMIT
}

describe('POST /api/mailboxes/:id/repin', () => {
  it('1. happy path — 200 with correct fields', async () => {
    queueHappyPath('cz5')
    const { status, body } = await req('POST', '/api/mailboxes/42/repin', {
      new_endpoint_label: 'cz3',
      reason: 'cz5 decommissioned by Mullvad',
    })
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.mailbox_id).toBe(42)
    expect(b.old_label).toBe('cz5')
    expect(b.new_label).toBe('cz3')
    expect(b.reason).toBe('cz5 decommissioned by Mullvad')
  })

  it('2. missing reason → 400', async () => {
    const { status, body } = await req('POST', '/api/mailboxes/42/repin', {
      new_endpoint_label: 'cz3',
    })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/reason/)
  })

  it('3. empty reason string → 400', async () => {
    const { status } = await req('POST', '/api/mailboxes/42/repin', {
      new_endpoint_label: 'cz3',
      reason: '   ',
    })
    expect(status).toBe(400)
  })

  it('4. missing new_endpoint_label → 400', async () => {
    const { status, body } = await req('POST', '/api/mailboxes/42/repin', {
      reason: 'test',
    })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/new_endpoint_label/)
  })

  it('5. mailbox not found → 404', async () => {
    queueClientRows([])   // BEGIN
    queueClientRows([])   // SELECT returns no rows
    // ROLLBACK is queued implicitly (empty queue → empty result)
    const { status } = await req('POST', '/api/mailboxes/999/repin', {
      new_endpoint_label: 'cz3',
      reason: 'test reason',
    })
    expect(status).toBe(404)
  })

  it('6. INSERT audit row SQL is executed', async () => {
    queueHappyPath('cz5')
    await req('POST', '/api/mailboxes/42/repin', {
      new_endpoint_label: 'cz3',
      reason: 'test',
    })
    const auditInsert = calls.find(c => /INSERT.*mailbox_egress_repin_audit/i.test(c.sql))
    expect(auditInsert).toBeTruthy()
    expect(auditInsert?.params).toContain('cz3')
    expect(auditInsert?.params).toContain('cz5')
  })

  it('7. UPDATE outreach_mailboxes pinned_endpoint_label is executed', async () => {
    queueHappyPath('cz5')
    await req('POST', '/api/mailboxes/42/repin', {
      new_endpoint_label: 'cz3',
      reason: 'test',
    })
    const update = calls.find(c => /UPDATE.*outreach_mailboxes/i.test(c.sql) && /pinned_endpoint_label/i.test(c.sql))
    expect(update).toBeTruthy()
    expect(update?.params).toContain('cz3')
  })

  it('8. actor defaults to "operator" when X-Operator-Id absent', async () => {
    queueHappyPath()
    const { body } = await req('POST', '/api/mailboxes/42/repin', {
      new_endpoint_label: 'cz3',
      reason: 'test',
    })
    expect((body as { actor: string }).actor).toBe('operator')
  })

  it('9. actor uses X-Operator-Id header value', async () => {
    queueHappyPath()
    const { body } = await req('POST', '/api/mailboxes/42/repin',
      { new_endpoint_label: 'cz3', reason: 'test' },
      { 'x-operator-id': 'tomas' }
    )
    expect((body as { actor: string }).actor).toBe('tomas')
  })

  it('10. DB error during audit INSERT → 500', async () => {
    queueClientRows([])   // BEGIN
    queueClientRows([{ id: 42, from_address: 'mb@example.cz', pinned_endpoint_label: 'cz5' }]) // SELECT
    queueClientError('unique constraint violation') // INSERT audit fails
    const { status } = await req('POST', '/api/mailboxes/42/repin', {
      new_endpoint_label: 'cz3',
      reason: 'test',
    })
    expect(status).toBe(500)
  })

  it('11. DB error during UPDATE → 500', async () => {
    queueClientRows([])   // BEGIN
    queueClientRows([{ id: 42, from_address: 'mb@example.cz', pinned_endpoint_label: null }]) // SELECT
    queueClientRows([], 1) // INSERT audit OK
    queueClientError('deadlock detected') // UPDATE fails
    const { status } = await req('POST', '/api/mailboxes/42/repin', {
      new_endpoint_label: 'cz3',
      reason: 'test',
    })
    expect(status).toBe(500)
  })

  it('12. invalid (non-numeric) mailbox id → 400', async () => {
    const { status } = await req('POST', '/api/mailboxes/abc/repin', {
      new_endpoint_label: 'cz3',
      reason: 'test',
    })
    expect(status).toBe(400)
  })
})
