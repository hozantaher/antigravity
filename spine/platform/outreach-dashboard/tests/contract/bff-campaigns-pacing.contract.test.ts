// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — PUT /api/campaigns/:id/pacing  (Sprint C2)
//
//  Tests: validation rules, successful update, audit log INSERT, 404 on
//  missing campaign, and the extended GET /api/campaigns/:id shape
//  (pacing_audit array included in response).
//
//  Pool mock uses a simple queue strategy: each query() call pops the
//  next entry from queryQueue. Default (empty queue) returns {rows:[],rowCount:0}.
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
  delete process.env.GO_SERVER_URL
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
function queueError(msg: string)    { queryQueue.push(new Error(msg)) }

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
//  PUT /api/campaigns/:id/pacing — success path
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/campaigns/:id/pacing — success', () => {
  it('200 {ok:true} when spacing and cap are valid', async () => {
    // Queue: SELECT before row, UPDATE (empty), INSERT audit (empty)
    queueRows([{ id: 5, mailbox_min_spacing_seconds: 60, mailbox_daily_cap_override: null }])
    const res = await req('PUT', '/api/campaigns/5/pacing', {
      mailbox_min_spacing_seconds: 120,
      mailbox_daily_cap_override: 50,
    })
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })

  it('response includes new spacing and cap values', async () => {
    queueRows([{ id: 5, mailbox_min_spacing_seconds: 60, mailbox_daily_cap_override: null }])
    const res = await req('PUT', '/api/campaigns/5/pacing', {
      mailbox_min_spacing_seconds: 300,
      mailbox_daily_cap_override: 20,
    })
    const b = res.body as Record<string, unknown>
    expect(b.mailbox_min_spacing_seconds).toBe(300)
    expect(b.mailbox_daily_cap_override).toBe(20)
  })

  it('issues UPDATE campaigns SET on success', async () => {
    queueRows([{ id: 5, mailbox_min_spacing_seconds: null, mailbox_daily_cap_override: null }])
    await req('PUT', '/api/campaigns/5/pacing', { mailbox_min_spacing_seconds: 90, mailbox_daily_cap_override: 30 })
    const updateCall = calls.find(c => /UPDATE campaigns\s+SET mailbox_min_spacing_seconds/i.test(c.sql))
    expect(updateCall).toBeDefined()
    expect(updateCall!.params).toEqual([90, 30, '5'])
  })

  it('inserts operator_audit_log entry with action=campaign_pacing_changed', async () => {
    queueRows([{ id: 5, mailbox_min_spacing_seconds: 60, mailbox_daily_cap_override: null }])
    await req('PUT', '/api/campaigns/5/pacing', { mailbox_min_spacing_seconds: 120, mailbox_daily_cap_override: 10 })
    const auditCall = calls.find(c => /INSERT INTO operator_audit_log/i.test(c.sql))
    expect(auditCall).toBeDefined()
    expect((auditCall!.params as unknown[])[0]).toBe('5')
    const details = JSON.parse((auditCall!.params as string[])[1])
    expect(details.prev.mailbox_min_spacing_seconds).toBe(60)
    expect(details.next.mailbox_min_spacing_seconds).toBe(120)
  })

  it('accepts null spacing to clear the override', async () => {
    queueRows([{ id: 7, mailbox_min_spacing_seconds: 120, mailbox_daily_cap_override: 50 }])
    const res = await req('PUT', '/api/campaigns/7/pacing', { mailbox_min_spacing_seconds: null })
    expect(res.status).toBe(200)
    const updateCall = calls.find(c => /UPDATE campaigns\s+SET mailbox_min_spacing_seconds/i.test(c.sql))
    expect(updateCall!.params![0]).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PUT /api/campaigns/:id/pacing — validation failures
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/campaigns/:id/pacing — validation', () => {
  it('400 when spacing is below 30', async () => {
    const res = await req('PUT', '/api/campaigns/5/pacing', { mailbox_min_spacing_seconds: 10 })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('validation_failed')
    expect((res.body as { field: string }).field).toBe('mailbox_min_spacing_seconds')
  })

  it('400 when spacing is above 3600', async () => {
    const res = await req('PUT', '/api/campaigns/5/pacing', { mailbox_min_spacing_seconds: 9999 })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('validation_failed')
  })

  it('400 when spacing is not an integer', async () => {
    const res = await req('PUT', '/api/campaigns/5/pacing', { mailbox_min_spacing_seconds: 1.5 })
    expect(res.status).toBe(400)
  })

  it('400 when daily cap is negative', async () => {
    const res = await req('PUT', '/api/campaigns/5/pacing', { mailbox_daily_cap_override: -1 })
    expect(res.status).toBe(400)
    expect((res.body as { field: string }).field).toBe('mailbox_daily_cap_override')
  })

  it('400 when daily cap exceeds 5000', async () => {
    const res = await req('PUT', '/api/campaigns/5/pacing', { mailbox_daily_cap_override: 6000 })
    expect(res.status).toBe(400)
  })

  it('400 when daily cap is not an integer', async () => {
    const res = await req('PUT', '/api/campaigns/5/pacing', { mailbox_daily_cap_override: 3.7 })
    expect(res.status).toBe(400)
  })

  it('400 on non-numeric campaign id', async () => {
    const res = await req('PUT', '/api/campaigns/abc/pacing', { mailbox_min_spacing_seconds: 60 })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PUT /api/campaigns/:id/pacing — 404 when campaign missing
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/campaigns/:id/pacing — not found', () => {
  it('404 when SELECT returns empty', async () => {
    // Default empty queue → SELECT returns {rows:[]}
    const res = await req('PUT', '/api/campaigns/9999/pacing', { mailbox_min_spacing_seconds: 60 })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PUT /api/campaigns/:id/pacing — DB error → 500
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/campaigns/:id/pacing — DB error', () => {
  it('500 when pool.query throws on SELECT', async () => {
    queueError('connection lost')
    const res = await req('PUT', '/api/campaigns/5/pacing', { mailbox_min_spacing_seconds: 60 })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/campaigns/:id — pacing_audit array present in response
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/campaigns/:id — pacing_audit in response (C2)', () => {
  it('response includes pacing_audit array', async () => {
    // Queue: campaign row, send_events stats, pacing_audit rows
    queueRows([{
      id: 5, name: 'Test', description: '', status: 'active',
      category_paths: [], sequence_config: [], category_match: 'prefix',
      created_at: new Date().toISOString(), updated_at: null,
      mailbox_min_spacing_seconds: 120, mailbox_daily_cap_override: null,
    }])
    queueRows([]) // send_events stats
    queueRows([]) // pacing_audit empty
    const res = await req('GET', '/api/campaigns/5')
    expect(res.status).toBe(200)
    const b = res.body as { campaign: Record<string, unknown>; pacing_audit: unknown[] }
    expect(Array.isArray(b.pacing_audit)).toBe(true)
  })

  it('campaign row includes mailbox_min_spacing_seconds', async () => {
    queueRows([{
      id: 5, name: 'Test', description: '', status: 'active',
      category_paths: [], sequence_config: [], category_match: 'prefix',
      created_at: new Date().toISOString(), updated_at: null,
      mailbox_min_spacing_seconds: 90, mailbox_daily_cap_override: 100,
    }])
    queueRows([])
    queueRows([])
    const res = await req('GET', '/api/campaigns/5')
    const b = res.body as { campaign: Record<string, unknown> }
    expect(b.campaign.mailbox_min_spacing_seconds).toBe(90)
    expect(b.campaign.mailbox_daily_cap_override).toBe(100)
  })

  it('pacing_audit entries populated when audit log has rows', async () => {
    const auditEntry = {
      id: 1, action: 'campaign_pacing_changed', actor: 'dashboard_user',
      details: { prev: { mailbox_min_spacing_seconds: 60 }, next: { mailbox_min_spacing_seconds: 120 } },
      created_at: new Date().toISOString(),
    }
    queueRows([{
      id: 5, name: 'Test', description: '', status: 'active',
      category_paths: [], sequence_config: [], category_match: 'prefix',
      created_at: new Date().toISOString(), updated_at: null,
      mailbox_min_spacing_seconds: 120, mailbox_daily_cap_override: null,
    }])
    queueRows([])
    queueRows([auditEntry])
    const res = await req('GET', '/api/campaigns/5')
    const b = res.body as { pacing_audit: typeof auditEntry[] }
    expect(b.pacing_audit).toHaveLength(1)
    expect(b.pacing_audit[0].action).toBe('campaign_pacing_changed')
  })
})
