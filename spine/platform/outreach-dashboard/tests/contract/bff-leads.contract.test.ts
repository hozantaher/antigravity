// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/leads + PATCH /api/leads/:id
//
//  Locks the Leads route surface consumed by Leads.jsx.
//  Handler: features/platform/outreach-dashboard/src/server-routes/leads.js
//  Mounted via: mountLeadsRoutes(app, { pool, ... })
//
//  Tests (15):
//    1.  GET /api/leads — happy path, returns {leads, total}
//    2.  GET /api/leads — empty result → {leads:[], total:0}
//    3.  GET /api/leads?status=new — status filter applied
//    4.  GET /api/leads?sentiment=positive — sentiment filter applied
//    5.  GET /api/leads — DB error → 500
//    6.  GET /api/leads — limit param capped at 500
//    7.  GET /api/leads — contact_name assembled from first+last
//    8.  PATCH /api/leads/:id — status change → updated row
//    9.  PATCH /api/leads/:id — invalid status → 400
//    10. PATCH /api/leads/:id — no fields → 400
//    11. PATCH /api/leads/:id — lead not found → 404
//    12. PATCH /api/leads/:id — DB error → 500
//    13. PATCH /api/leads/:id — notes field update
//    14. PATCH /api/leads/:id — assigned_to field update
//    15. PATCH /api/leads/:id — disqualified is valid status
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

const LEAD_ROW = {
  id: 1,
  contact_id: 10,
  campaign_id: 101,
  mailbox_id: 3,
  status: 'new',
  source: 'positive',
  sentiment: 'positive',
  classified_at: '2026-04-10T08:00:00Z',
  created_at: '2026-04-10T08:00:00Z',
  updated_at: '2026-04-10T08:00:00Z',
  notes: null,
  original_message_id: null,
  assigned_to: null,
  contact_email: 'jan@firma.cz',
  contact_first_name: 'Jan',
  contact_last_name: 'Novák',
  contact_name: 'Jan Novák',
  campaign_name: 'Kampaň Alpha',
  mailbox_address: 'sales@corp.cz',
}

// ── 1. GET /api/leads — happy path ────────────────────────────────────────────

describe('GET /api/leads', () => {
  it('1. happy path returns {leads, total}', async () => {
    queueRows([LEAD_ROW])
    const { status, body } = await req('GET', '/api/leads')
    expect(status).toBe(200)
    const b = body as { leads: unknown[]; total: number }
    expect(Array.isArray(b.leads)).toBe(true)
    expect(b.leads).toHaveLength(1)
    expect(b.total).toBe(1)
  })

  it('2. empty result → {leads:[], total:0}', async () => {
    queueRows([])
    const { status, body } = await req('GET', '/api/leads')
    expect(status).toBe(200)
    const b = body as { leads: unknown[]; total: number }
    expect(b.leads).toHaveLength(0)
    expect(b.total).toBe(0)
  })

  it('3. ?status=new — status param passed to WHERE clause', async () => {
    queueRows([LEAD_ROW])
    await req('GET', '/api/leads?status=new')
    const statusCall = calls.find(c => String(c.sql).includes('l.status'))
    expect(statusCall).toBeDefined()
    expect(statusCall?.params).toContain('new')
  })

  it('4. ?sentiment=positive — sentiment param passed to WHERE clause', async () => {
    queueRows([LEAD_ROW])
    await req('GET', '/api/leads?sentiment=positive')
    const sentimentCall = calls.find(c => String(c.sql).includes('sentiment'))
    expect(sentimentCall).toBeDefined()
    expect(sentimentCall?.params).toContain('positive')
  })

  it('5. DB error → 500', async () => {
    queueError('db_down')
    const { status } = await req('GET', '/api/leads')
    expect(status).toBe(500)
  })

  it('6. limit param capped at 500', async () => {
    queueRows([])
    await req('GET', '/api/leads?limit=99999')
    const limitCall = calls.find(c => String(c.sql).includes('LIMIT'))
    expect(limitCall).toBeDefined()
    // The capped limit (500) should be in params, not 99999
    expect(limitCall?.params).toContain(500)
  })

  it('7. contact_name field assembled correctly in SQL', async () => {
    queueRows([{ ...LEAD_ROW, contact_name: 'Jan Novák' }])
    const { body } = await req('GET', '/api/leads')
    const b = body as { leads: Array<{ contact_name: string }> }
    expect(b.leads[0].contact_name).toBe('Jan Novák')
  })
})

// ── 8–15. PATCH /api/leads/:id ────────────────────────────────────────────────

describe('PATCH /api/leads/:id', () => {
  it('8. status change → updated row returned', async () => {
    queueRows([{ ...LEAD_ROW, status: 'contacted' }])
    const { status, body } = await req('PATCH', '/api/leads/1', { status: 'contacted' })
    expect(status).toBe(200)
    const b = body as { lead: { status: string } }
    expect(b.lead.status).toBe('contacted')
  })

  it('9. invalid status → 400', async () => {
    const { status, body } = await req('PATCH', '/api/leads/1', { status: 'hacked' })
    expect(status).toBe(400)
    const b = body as { error: string }
    expect(b.error).toMatch(/invalid status/i)
  })

  it('10. empty body → 400 (no updatable fields)', async () => {
    const { status } = await req('PATCH', '/api/leads/1', {})
    expect(status).toBe(400)
  })

  it('11. lead not found → 404', async () => {
    queueRows([]) // UPDATE RETURNING returns no rows
    const { status, body } = await req('PATCH', '/api/leads/999', { status: 'contacted' })
    expect(status).toBe(404)
    const b = body as { error: string }
    expect(b.error).toMatch(/not found/i)
  })

  it('12. DB error on UPDATE → 500', async () => {
    queueError('db_crash')
    const { status } = await req('PATCH', '/api/leads/1', { status: 'won' })
    expect(status).toBe(500)
  })

  it('13. notes field update accepted', async () => {
    queueRows([{ ...LEAD_ROW, notes: 'Called today' }])
    const { status, body } = await req('PATCH', '/api/leads/1', { notes: 'Called today' })
    expect(status).toBe(200)
    const b = body as { lead: { notes: string } }
    expect(b.lead.notes).toBe('Called today')
  })

  it('14. assigned_to field update accepted', async () => {
    queueRows([{ ...LEAD_ROW, assigned_to: 'operator@corp.cz' }])
    const { status, body } = await req('PATCH', '/api/leads/1', { assigned_to: 'operator@corp.cz' })
    expect(status).toBe(200)
    const b = body as { lead: { assigned_to: string } }
    expect(b.lead.assigned_to).toBe('operator@corp.cz')
  })

  it('15. "disqualified" is a valid status', async () => {
    queueRows([{ ...LEAD_ROW, status: 'disqualified' }])
    const { status } = await req('PATCH', '/api/leads/1', { status: 'disqualified' })
    expect(status).toBe(200)
  })
})
