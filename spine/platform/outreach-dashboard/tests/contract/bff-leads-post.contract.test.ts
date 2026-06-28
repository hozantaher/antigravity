// BFF contract tests — POST /api/leads (promote-to-lead endpoint, issue #868)
//
// Verifies: validation, happy-path INSERT, duplicate 409, audit-log write on
// source_reply_id, error responses.

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

// ── Helper: a minimal leads row returned from INSERT RETURNING * ─────────────
function leadRow(id: number, contactId: number, stage = 'qualifying') {
  return {
    id,
    contact_id: contactId,
    campaign_id: 7,
    mailbox_id: null,
    status: stage,
    source: 'thread_promote',
    notes: 'Zájem o excavátor.',
    original_message_id: '100',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

describe('POST /api/leads — validation', () => {
  it('returns 400 when contact_id missing', async () => {
    const { status, body } = await req('POST', '/api/leads', { campaign_id: 7 })
    expect(status).toBe(400)
    expect((body as Record<string, unknown>).error).toMatch(/contact_id/i)
  })

  it('returns 400 when contact_id is zero', async () => {
    const { status } = await req('POST', '/api/leads', { contact_id: 0 })
    expect(status).toBe(400)
  })

  it('returns 400 when contact_id is negative', async () => {
    const { status } = await req('POST', '/api/leads', { contact_id: -5 })
    expect(status).toBe(400)
  })

  it('returns 400 when campaign_id is negative', async () => {
    const { status } = await req('POST', '/api/leads', { contact_id: 1, campaign_id: -3 })
    expect(status).toBe(400)
  })

  it('returns 400 when stage is invalid', async () => {
    const { status, body } = await req('POST', '/api/leads', { contact_id: 1, stage: 'bogus_stage' })
    expect(status).toBe(400)
    expect((body as Record<string, unknown>).error).toMatch(/stage/i)
  })
})

describe('POST /api/leads — happy path', () => {
  it('creates lead and returns 201 with lead row', async () => {
    // No duplicate check needed when campaign_id absent
    const created = leadRow(55, 3)
    q([created]) // INSERT RETURNING *
    // audit log query (best-effort, ignored)
    q([])

    const { status, body } = await req('POST', '/api/leads', {
      contact_id: 3,
      stage: 'qualifying',
      notes: 'Zájem o excavátor.',
      source_reply_id: 42,
      source_message_id: '100',
    })
    expect(status).toBe(201)
    const b = body as Record<string, unknown>
    expect((b.lead as Record<string, unknown>).id).toBe(55)
    expect((b.lead as Record<string, unknown>).status).toBe('qualifying')
  })

  it('performs duplicate check when campaign_id is supplied', async () => {
    // duplicate check SELECT → no existing row
    q([]) // no duplicate
    // INSERT
    q([leadRow(60, 3)])
    // audit
    q([])

    const { status } = await req('POST', '/api/leads', {
      contact_id: 3,
      campaign_id: 7,
      stage: 'qualifying',
      source_reply_id: 42,
    })
    expect(status).toBe(201)
    const dupCheckCall = calls.find(c => /SELECT.*FROM leads WHERE contact_id/.test(c.sql))
    expect(dupCheckCall).toBeTruthy()
  })

  it('returns 409 when duplicate (contact_id + campaign_id) exists', async () => {
    // duplicate check SELECT → existing row
    q([{ id: 44 }])

    const { status, body } = await req('POST', '/api/leads', {
      contact_id: 3,
      campaign_id: 7,
      stage: 'qualifying',
    })
    expect(status).toBe(409)
    const b = body as Record<string, unknown>
    expect(b.error).toMatch(/existuje/i)
    expect(b.lead_id).toBe(44)
  })

  it('writes operator_audit_log when source_reply_id provided', async () => {
    q([leadRow(70, 3)])  // INSERT RETURNING *
    q([])                 // audit log INSERT

    await req('POST', '/api/leads', {
      contact_id: 3,
      stage: 'qualifying',
      source_reply_id: 42,
      source_message_id: '100',
    })

    const auditCall = calls.find(c =>
      /INSERT INTO operator_audit_log/.test(c.sql) &&
      /lead_create_from_reply/.test(c.sql)
    )
    expect(auditCall).toBeTruthy()
    // entity_id = new lead id (second param after actor)
    expect(auditCall!.params).toContain('70')
    // details JSON should contain source_reply_id
    const detailsJson = String(auditCall!.params?.[2] ?? '')
    expect(detailsJson).toContain('"source_reply_id":42')
  })

  it('does NOT write audit log when source_reply_id absent', async () => {
    q([leadRow(75, 3)])  // INSERT RETURNING *

    await req('POST', '/api/leads', {
      contact_id: 3,
      stage: 'qualifying',
    })
    const auditCall = calls.find(c => /INSERT INTO operator_audit_log/.test(c.sql))
    expect(auditCall).toBeUndefined()
  })

  it('uses "qualifying" as default stage when stage not supplied', async () => {
    q([leadRow(80, 3, 'qualifying')])
    q([])

    await req('POST', '/api/leads', { contact_id: 3, source_reply_id: 10 })
    const insertCall = calls.find(c => /INSERT INTO leads/.test(c.sql))
    expect(insertCall).toBeTruthy()
    // The 4th param is the stage (after contact_id, campaign_id, mailbox_id)
    expect(insertCall!.params?.[3]).toBe('qualifying')
  })
})

describe('POST /api/leads — error path', () => {
  it('returns 500 on unexpected DB error', async () => {
    queryQueue.push(new Error('DB connection refused'))

    const { status } = await req('POST', '/api/leads', { contact_id: 3 })
    expect(status).toBe(500)
  })
})
