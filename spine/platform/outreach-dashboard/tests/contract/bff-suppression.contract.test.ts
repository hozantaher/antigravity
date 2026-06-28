// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/suppression CRUD
//
// Suppression list is the GDPR/CAN-SPAM boundary — any send to a suppressed
// address = reputation damage + legal risk. Lock CRUD contract tight.
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
//  GET /api/suppression
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/suppression', () => {
  it('200 returns rows directly', async () => {
    const rows = [{ email: 'a@x.cz', reason: 'manual', suppressed_at: '2026-04-20', contact_id: 1 }]
    queueRows(rows)
    const res = await req('GET', '/api/suppression')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(rows)
  })

  it('200 with [] when no rows', async () => {
    queueRows([])
    const res = await req('GET', '/api/suppression')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('ORDER BY suppressed_at DESC (newest first)', async () => {
    queueRows([])
    await req('GET', '/api/suppression')
    expect(calls[0].sql).toMatch(/ORDER BY suppressed_at DESC/i)
  })

  it('LIMIT 500 cap', async () => {
    queueRows([])
    await req('GET', '/api/suppression')
    expect(calls[0].sql).toMatch(/LIMIT 500/)
  })

  it('500 on pg throw', async () => {
    queueError('db down')
    const res = await req('GET', '/api/suppression')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/suppression
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/suppression', () => {
  it('400 when email missing', async () => {
    const res = await req('POST', '/api/suppression', {})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'email required' })
  })

  it('400 when email is empty string', async () => {
    const res = await req('POST', '/api/suppression', { email: '' })
    expect(res.status).toBe(400)
  })

  it('200 {ok, email} on success', async () => {
    queueRows([])
    const res = await req('POST', '/api/suppression', { email: 'user@example.com', reason: 'bounce' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, email: 'user@example.com' })
  })

  it('lowercases email before insert', async () => {
    queueRows([])
    await req('POST', '/api/suppression', { email: 'USER@Example.COM' })
    const params = calls[0].params as unknown[]
    expect(params[0]).toBe('user@example.com')
  })

  it('default reason=manual when omitted', async () => {
    queueRows([])
    await req('POST', '/api/suppression', { email: 'x@y.cz' })
    const params = calls[0].params as unknown[]
    expect(params[1]).toBe('manual')
  })

  it('ON CONFLICT updates reason + suppressed_at (upsert semantics)', async () => {
    queueRows([])
    await req('POST', '/api/suppression', { email: 'x@y.cz', reason: 'complaint' })
    expect(calls[0].sql).toMatch(/ON CONFLICT\(email\) DO UPDATE/i)
    expect(calls[0].sql).toMatch(/suppressed_at=now\(\)/i)
  })

  it('500 on pg throw', async () => {
    queueError('constraint')
    const res = await req('POST', '/api/suppression', { email: 'x@y.cz' })
    expect(res.status).toBe(500)
  })

  it('400 on invalid JSON body', async () => {
    const res = await req('POST', '/api/suppression', 'not json')
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/suppression/:email
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/suppression/:email', () => {
  it('200 {ok:true} on success', async () => {
    queueRows([])
    const res = await req('DELETE', '/api/suppression/user%40example.com')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('uses ILIKE for case-insensitive match', async () => {
    queueRows([])
    await req('DELETE', '/api/suppression/x@y.cz')
    expect(calls[0].sql).toMatch(/email ILIKE/i)
  })

  it('URL-encoded @ decoded in path param', async () => {
    queueRows([])
    await req('DELETE', '/api/suppression/user%40example.com')
    const params = calls[0].params as unknown[]
    expect(params[0]).toBe('user@example.com')
  })

  it('500 on pg throw (FK constraint)', async () => {
    queueError('fk')
    const res = await req('DELETE', '/api/suppression/x@y.cz')
    expect(res.status).toBe(500)
  })
})
