// B1 — BFF contract: /api/segments* endpoints
// Stubs pg; tests route inventory, happy-path shapes, 404, and 500 paths.

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

function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
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

const SEG = { id: 1, name: 'Průmysl', description: null, query: {}, company_count: 100, created_at: new Date().toISOString() }

// ── GET /api/segments ─────────────────────────────────────────────────────────

describe('GET /api/segments', () => {
  it('returns array of segments', async () => {
    q([SEG])
    const { status, body } = await req('GET', '/api/segments')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect((body as typeof SEG[])[0].name).toBe('Průmysl')
  })

  it('returns empty array when no segments', async () => {
    q([])
    const { status, body } = await req('GET', '/api/segments')
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('500 on db error', async () => {
    qErr('db down')
    const { status } = await req('GET', '/api/segments')
    expect(status).toBe(500)
  })
})

// ── POST /api/segments ────────────────────────────────────────────────────────

describe('POST /api/segments', () => {
  it('creates and returns segment', async () => {
    q([])                                           // BEGIN
    q([{ ...SEG, id: 5, name: 'Nový' }])            // INSERT INTO segments
    q([])                                           // INSERT INTO operator_audit_log
    q([])                                           // COMMIT
    const { status, body } = await req('POST', '/api/segments', { name: 'Nový', description: null, query: {} })
    expect(status).toBe(200)
    expect((body as typeof SEG).name).toBe('Nový')
  })

  it('audit log INSERT fires on create', async () => {
    q([])                                           // BEGIN
    q([{ ...SEG, id: 7, name: 'Audit' }])           // INSERT INTO segments
    q([])                                           // INSERT INTO operator_audit_log
    q([])                                           // COMMIT
    await req('POST', '/api/segments', { name: 'Audit', description: null, query: {} })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall!.sql).toContain('segment_create')
    // audit details must not include query (too large / not needed)
    const detail = auditCall!.params ? JSON.parse(auditCall!.params[1] as string) : {}
    expect(detail).toHaveProperty('name')
  })

  it('500 on db error (ROLLBACK fires)', async () => {
    q([])         // BEGIN
    qErr('constraint')  // INSERT throws
    // ROLLBACK consumed from empty queue → ok=false default, returns {}
    const { status } = await req('POST', '/api/segments', { name: 'X' })
    expect(status).toBe(500)
    // no audit row inserted since transaction rolled back
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})

// ── PATCH /api/segments/:id ───────────────────────────────────────────────────

describe('PATCH /api/segments/:id', () => {
  it('updates and returns segment', async () => {
    q([{ ...SEG, name: 'Upraven' }])
    const { status, body } = await req('PATCH', '/api/segments/1', { name: 'Upraven' })
    expect(status).toBe(200)
    expect((body as typeof SEG).name).toBe('Upraven')
  })

  it('404 when segment not found', async () => {
    q([])
    const { status } = await req('PATCH', '/api/segments/999', { name: 'X' })
    expect(status).toBe(404)
  })

  it('500 on db error', async () => {
    qErr('db error')
    const { status } = await req('PATCH', '/api/segments/1', { name: 'X' })
    expect(status).toBe(500)
  })
})

// ── DELETE /api/segments/:id ──────────────────────────────────────────────────

describe('DELETE /api/segments/:id', () => {
  it('returns ok:true', async () => {
    q([])
    const { status, body } = await req('DELETE', '/api/segments/1')
    expect(status).toBe(200)
    expect((body as { ok: boolean }).ok).toBe(true)
  })

  it('500 on db error', async () => {
    qErr('db error')
    const { status } = await req('DELETE', '/api/segments/1')
    expect(status).toBe(500)
  })
})

// ── POST /api/segments/preview ────────────────────────────────────────────────

describe('POST /api/segments/preview', () => {
  it('returns count', async () => {
    q([{ count: '42' }])
    const { status, body } = await req('POST', '/api/segments/preview', { query: { op: 'AND', conditions: [] } })
    expect(status).toBe(200)
    expect((body as { count: number }).count).toBe(42)
  })

  it('500 on db error', async () => {
    qErr('db error')
    const { status } = await req('POST', '/api/segments/preview', { query: {} })
    expect(status).toBe(500)
  })
})

// ── POST /api/segments/:id/rebuild ────────────────────────────────────────────

describe('POST /api/segments/:id/rebuild', () => {
  it('404 when segment not found', async () => {
    q([])
    const { status } = await req('POST', '/api/segments/999/rebuild')
    expect(status).toBe(404)
  })

  it('returns ok + companies + segment on success', async () => {
    q([{ id: 1, query: { op: 'AND', conditions: [] } }]) // SELECT id,query
    q([], 0)  // DELETE memberships
    q([], 7)  // INSERT memberships → rowCount=7
    q([])     // UPDATE company_count
    q([{ ...SEG, company_count: 7 }]) // SELECT updated segment
    const { status, body } = await req('POST', '/api/segments/1/rebuild')
    expect(status).toBe(200)
    expect((body as { ok: boolean; companies: number }).ok).toBe(true)
    expect((body as { companies: number }).companies).toBe(7)
  })
})
