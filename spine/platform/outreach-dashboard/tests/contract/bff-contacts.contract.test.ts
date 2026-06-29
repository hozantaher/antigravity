// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/contacts list + detail + PATCH + DELETE
//
// Locks the contacts domain surface consumed by Contacts.jsx (list + drawer)
// and the campaign contacts tab.
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
//  GET /api/contacts
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/contacts', () => {
  it('200 {rows, total}', async () => {
    queueRows([{ total: 1 }])     // count query
    queueRows([{ id: 1, email: 'a@x', first_name: 'Jan', last_name: 'N', status: 'active' }])
    const res = await req('GET', '/api/contacts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ rows: [{ id: 1, email: 'a@x', first_name: 'Jan', last_name: 'N', status: 'active' }], total: 1 })
  })

  it('200 with empty rows + total=0 when no matches', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    const res = await req('GET', '/api/contacts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ rows: [], total: 0 })
  })

  it('?search=foo applies ILIKE across email/name/company', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await req('GET', '/api/contacts?search=jan')
    const sql = calls[0].sql
    expect(sql).toMatch(/c\.email ILIKE/)
    expect(sql).toMatch(/c\.first_name ILIKE/)
    expect(sql).toMatch(/c\.last_name ILIKE/)
    expect(sql).toMatch(/c\.company_name ILIKE/)
    expect(sql).toMatch(/c\.phone ILIKE/)   // #1586 — find a seller by their saved phone (výkup closes by phone)
    expect(calls[0].params?.[0]).toBe('%jan%')
  })

  it('?status=active filters by status', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await req('GET', '/api/contacts?status=active')
    const sql = calls[0].sql
    expect(sql).toMatch(/c\.status=/)
    expect(calls[0].params).toContain('active')
  })

  it('?company_ico filters contacts by company IČO (firma→kontakty edge, #1586)', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await req('GET', '/api/contacts?company_ico=63674505')
    const sql = calls[0].sql
    expect(sql).toMatch(/c\.ico=/)
    expect(calls[0].params).toContain('63674505')
  })

  it('default limit=100 offset=0', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await req('GET', '/api/contacts')
    // Second call has [limit, offset] at the end
    const params = calls[1].params as unknown[]
    expect(params[params.length - 2]).toBe(100)
    expect(params[params.length - 1]).toBe(0)
  })

  it('ORDER BY last_contact_at DESC NULLS LAST, then id DESC', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await req('GET', '/api/contacts')
    expect(calls[1].sql).toMatch(/ORDER BY last_contact_at DESC NULLS LAST/)
    expect(calls[1].sql).toMatch(/c\.id DESC/)
  })

  it('500 on pg throw in count query', async () => {
    queueError('timeout')
    const res = await req('GET', '/api/contacts')
    expect(res.status).toBe(500)
  })

  it('derives total from rows length when count row is empty', async () => {
    queueRows([])               // empty count result
    queueRows([{ id: 1 }, { id: 2 }])
    const res = await req('GET', '/api/contacts')
    expect((res.body as any).total).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/contacts/:id
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/contacts/:id', () => {
  it('404 when not found', async () => {
    queueRows([])
    const res = await req('GET', '/api/contacts/999')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('200 returns contact + send_history[]', async () => {
    queueRows([{ id: 7, email: 'a@x', first_name: 'Jan', status: 'active' }])
    queueRows([
      { sent_at: '2026-04-20', status: 'sent', subject: 'S1', smtp_response: '250 OK' },
    ])
    const res = await req('GET', '/api/contacts/7')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 7, email: 'a@x' })
    expect((res.body as any).send_history).toHaveLength(1)
  })

  it('send_history limited to 20 rows', async () => {
    queueRows([{ id: 7, email: 'a@x' }])
    queueRows([])
    await req('GET', '/api/contacts/7')
    expect(calls[1].sql).toMatch(/LIMIT 20/)
  })

  it('500 on pg throw', async () => {
    queueError('db')
    const res = await req('GET', '/api/contacts/7')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PATCH /api/contacts/:id
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /api/contacts/:id', () => {
  it('400 when body has nothing to update', async () => {
    const res = await req('PATCH', '/api/contacts/7', {})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'nothing to update' })
  })

  it('400 when only unknown fields', async () => {
    const res = await req('PATCH', '/api/contacts/7', { unknown_field: 'x' })
    expect(res.status).toBe(400)
  })

  it('200 + updated row on status change', async () => {
    queueRows([{ id: 7, email: 'a@x', status: 'unsubscribed' }])
    const res = await req('PATCH', '/api/contacts/7', { status: 'unsubscribed' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 7, status: 'unsubscribed' })
  })

  const allowed = ['status', 'first_name', 'last_name', 'company_name']
  for (const field of allowed) {
    it(`accepts ${field} alone`, async () => {
      queueRows([{ id: 7 }])
      const res = await req('PATCH', '/api/contacts/7', { [field]: 'test' })
      expect(res.status).toBe(200)
      expect(calls[0].sql).toMatch(new RegExp(field))
    })
  }

  it('404 when id not in DB', async () => {
    queueRows([])
    const res = await req('PATCH', '/api/contacts/999', { status: 'active' })
    expect(res.status).toBe(404)
  })

  it('500 on pg throw', async () => {
    queueError('syntax')
    const res = await req('PATCH', '/api/contacts/7', { status: 'active' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/contacts/:id
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/contacts/:id', () => {
  it('registered (non-200 only means DB fails expected)', async () => {
    queueError('mock')
    const res = await req('DELETE', '/api/contacts/7')
    // Route exists; handler will attempt DB
    expect([200, 500]).toContain(res.status)
  })
})
