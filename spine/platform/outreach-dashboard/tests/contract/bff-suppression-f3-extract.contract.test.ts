// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — F3 extract guard for /api/suppression*
//
// Sprint F3 (2026-05-03) moved the four /api/suppression* handlers from
// server.js into ./src/server-routes/suppression.js. This file pins the
// behavior contract that survived the extract:
//
//   * UNION discipline (memory `project_two_suppression_tables` T1) —
//     reads MUST union both `suppression_list` and `outreach_suppressions`.
//     Writes go to `suppression_list` only. Tests assert either side of
//     the UNION produces a hit, and that overlap doesn't dedup-drop rows.
//   * Email normalization (lowercase + trim) at every write boundary so
//     `Test@Example.COM ` collapses onto `test@example.com`.
//   * Closed enum on POST /api/suppressions reasons.
//   * Response shape preserved verbatim.
//
// Companion to bff-suppression.contract.test.ts (which covers the
// pre-extract HTTP contract). Together they prove the extract is byte-
// equivalent.
// ═══════════════════════════════════════════════════════════════════════════

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

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  UNION discipline — memory `project_two_suppression_tables` T1
// ═══════════════════════════════════════════════════════════════════════

describe('F3: UNION discipline (suppression_list + outreach_suppressions)', () => {
  it('GET issues a single SQL containing UNION ALL across both tables', async () => {
    queueRows([])
    await req('GET', '/api/suppression')
    expect(calls).toHaveLength(1)
    const sql = calls[0].sql
    expect(sql).toMatch(/FROM\s+suppression_list/i)
    expect(sql).toMatch(/FROM\s+outreach_suppressions/i)
    expect(sql).toMatch(/UNION ALL/i)
  })

  it('hit only in suppression_list surfaces in response', async () => {
    queueRows([
      { email: 'manual@example.cz', reason: 'manual', suppressed_at: '2026-04-20', contact_id: 1, source: 'manual' },
    ])
    const res = await req('GET', '/api/suppression')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { email: 'manual@example.cz', reason: 'manual', suppressed_at: '2026-04-20', contact_id: 1, source: 'manual' },
    ])
  })

  it('hit only in outreach_suppressions surfaces in response (source=auto, suppressed_at=null)', async () => {
    queueRows([
      { email: 'auto@example.cz', reason: 'bounce_hard', suppressed_at: null, contact_id: null, source: 'auto' },
    ])
    const res = await req('GET', '/api/suppression')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { email: 'auto@example.cz', reason: 'bounce_hard', suppressed_at: null, contact_id: null, source: 'auto' },
    ])
  })

  it('overlapping email in BOTH tables returns both rows (UNION ALL, not UNION)', async () => {
    // Postgres UNION ALL preserves duplicates — the BFF expects the DB to
    // return both rows so the operator can see provenance from each side.
    // De-dup, if any, happens at the read layer per-feature, NOT here.
    queueRows([
      { email: 'dual@example.cz', reason: 'manual', suppressed_at: '2026-04-20', contact_id: 7, source: 'manual' },
      { email: 'dual@example.cz', reason: 'bounce_hard', suppressed_at: null, contact_id: null, source: 'auto' },
    ])
    const res = await req('GET', '/api/suppression')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect((res.body as unknown[]).length).toBe(2)
  })

  it('writes target suppression_list ONLY (UI/BFF write side)', async () => {
    queueRows([])
    await req('POST', '/api/suppression', { email: 'x@y.cz', reason: 'manual' })
    expect(calls[0].sql).toMatch(/INSERT INTO suppression_list/i)
    expect(calls[0].sql).not.toMatch(/INSERT INTO outreach_suppressions/i)
  })

  it('plural POST /api/suppressions also writes to suppression_list ONLY', async () => {
    queueRows([])
    await req('POST', '/api/suppressions', { email: 'x@y.cz', reason: 'unsubscribe_reply' })
    expect(calls[0].sql).toMatch(/INSERT INTO suppression_list/i)
    expect(calls[0].sql).not.toMatch(/INSERT INTO outreach_suppressions/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Email normalization (lowercase + trim) — UNION-table consistency
// ═══════════════════════════════════════════════════════════════════════

describe('F3: email normalization on writes', () => {
  it('singular POST lowercases mixed-case email before insert', async () => {
    queueRows([])
    await req('POST', '/api/suppression', { email: 'Test@Example.COM' })
    const params = calls[0].params as unknown[]
    expect(params[0]).toBe('test@example.com')
  })

  it('plural POST lowercases AND trims whitespace before insert', async () => {
    queueRows([])
    await req('POST', '/api/suppressions', {
      email: '  Test@Example.COM  ',
      reason: 'manual',
    })
    const params = calls[0].params as unknown[]
    expect(params[0]).toBe('test@example.com')
  })

  it('plural POST normalized email is also echoed back in response', async () => {
    queueRows([])
    const res = await req('POST', '/api/suppressions', {
      email: '  USER@DOMAIN.CZ  ',
      reason: 'bounce_hard',
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, email: 'user@domain.cz' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Closed enum on plural POST + audit fields
// ═══════════════════════════════════════════════════════════════════════

describe('F3: POST /api/suppressions closed enum + audit', () => {
  it('400 when reason is not in {unsubscribe_reply, bounce_hard, manual}', async () => {
    const res = await req('POST', '/api/suppressions', { email: 'x@y.cz', reason: 'whatever' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      error: 'invalid reason',
      allowed: expect.arrayContaining(['unsubscribe_reply', 'bounce_hard', 'manual']),
    })
  })

  it('200 when reason=unsubscribe_reply (operator clicked Unsubscribe in ThreadDetail)', async () => {
    queueRows([])
    const res = await req('POST', '/api/suppressions', {
      email: 'reply@example.cz',
      reason: 'unsubscribe_reply',
      campaign_id: 42,
      source: 'thread_detail',
    })
    expect(res.status).toBe(200)
    const params = calls[0].params as unknown[]
    expect(params[0]).toBe('reply@example.cz')
    expect(params[1]).toBe('unsubscribe_reply')
    expect(params[2]).toBe(42)
    expect(params[3]).toBe('thread_detail')
  })

  it('idempotent: second POST with same email upserts (ON CONFLICT DO UPDATE)', async () => {
    queueRows([])
    queueRows([])
    const r1 = await req('POST', '/api/suppressions', { email: 'dup@example.cz', reason: 'manual' })
    const r2 = await req('POST', '/api/suppressions', { email: 'dup@example.cz', reason: 'manual' })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(calls[0].sql).toMatch(/ON CONFLICT\(email\) DO UPDATE/i)
    expect(calls[1].sql).toMatch(/ON CONFLICT\(email\) DO UPDATE/i)
  })

  it('source defaults to "manual" when not provided', async () => {
    queueRows([])
    await req('POST', '/api/suppressions', { email: 'x@y.cz', reason: 'manual' })
    const params = calls[0].params as unknown[]
    expect(params[3]).toBe('manual')
  })

  it('campaign_id null when omitted', async () => {
    queueRows([])
    await req('POST', '/api/suppressions', { email: 'x@y.cz', reason: 'manual' })
    const params = calls[0].params as unknown[]
    expect(params[2]).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Failure paths preserved
// ═══════════════════════════════════════════════════════════════════════

describe('F3: failure paths after extract', () => {
  it('GET 500 on pg throw routes through capture500 (not silenced)', async () => {
    queueError('db down')
    const res = await req('GET', '/api/suppression')
    expect(res.status).toBe(500)
  })

  it('plural POST 400 when email is empty string', async () => {
    const res = await req('POST', '/api/suppressions', { email: '', reason: 'manual' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'email required' })
  })

  it('plural POST 400 when email is whitespace-only', async () => {
    const res = await req('POST', '/api/suppressions', { email: '   ', reason: 'manual' })
    expect(res.status).toBe(400)
  })

  it('singular DELETE preserves ILIKE case-insensitive match contract', async () => {
    queueRows([])
    await req('DELETE', '/api/suppression/User%40Example.COM')
    expect(calls[0].sql).toMatch(/email ILIKE/i)
    const params = calls[0].params as unknown[]
    expect(params[0]).toBe('User@Example.COM')
  })
})
