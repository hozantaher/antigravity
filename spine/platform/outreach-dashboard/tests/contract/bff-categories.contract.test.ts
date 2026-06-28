// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/categories + /api/categories/:slug + :slug/companies
//
// Locks:
//   - route inventory (3 endpoints on BFF today)
//   - query-param parsing (q, parent, limit, offset, prefix)
//   - happy-path response shape
//   - 404 on unknown slug
//   - 500 on pg throw
//
// Companion to the Go-side tests in features/acquisition/contacts/web/categories_test.go.
// The BFF owns its own direct-DB category routes (see server.js ~L5366);
// this file pins the BFF contract so a BFF rewrite can't drift silently.
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

function queueRows(rows: unknown[]) {
  queryQueue.push({ rows })
}
function queueError(msg: string) {
  queryQueue.push(new Error(msg))
}

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/categories
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/categories', () => {
  it('200 returns {categories, total} with empty array when no rows', async () => {
    queueRows([])
    const res = await get('/api/categories')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ categories: [], total: 0 })
  })

  it('200 with roots when no q or parent param', async () => {
    const rows = [
      { id: 1, path: 'Remesla', slug: 'remesla', name: 'Řemesla', parent_path: null, depth: 0, company_count: 1200 },
    ]
    queueRows(rows)
    const res = await get('/api/categories')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ categories: rows, total: 1 })
    // Default roots query uses depth=0 and default limit.
    expect(calls[0].sql).toMatch(/depth=0/)
  })

  it('?q=foo runs ILIKE search with 200 limit default', async () => {
    queueRows([])
    await get('/api/categories?q=stavebni')
    expect(calls[0].sql).toMatch(/ILIKE/)
    expect(calls[0].params).toEqual(['%stavebni%', 200])
  })

  it('?parent=Remesla runs child query without search', async () => {
    queueRows([])
    await get('/api/categories?parent=Remesla')
    expect(calls[0].sql).toMatch(/parent_path=\$1/)
    expect(calls[0].params).toEqual(['Remesla'])
  })

  it('?limit override propagates to query', async () => {
    queueRows([])
    await get('/api/categories?limit=50')
    // Roots query uses limit param.
    expect(calls[0].params).toEqual([50])
  })

  it('500 on pg throw', async () => {
    queueError('db down')
    const res = await get('/api/categories')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'db down' })
  })

  it('q takes precedence over parent when both provided', async () => {
    queueRows([])
    await get('/api/categories?q=foo&parent=Remesla')
    // q branch runs ILIKE; parent branch would not.
    expect(calls[0].sql).toMatch(/ILIKE/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/categories/:slug/companies
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/categories/:slug/companies', () => {
  it('404 when slug not found', async () => {
    queueRows([]) // category lookup returns empty
    const res = await get('/api/categories/nonexistent/companies')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('200 with companies + total when slug found', async () => {
    queueRows([{ path: 'Remesla-a-sluzby > Stavebni-sluzby' }]) // FindBySlug
    queueRows([{ count: 42 }]) // count query
    queueRows([{ id: 1, name: 'Alpha s.r.o.', email: 'a@x', website: 'https://x', address_locality: 'Praha', icp_tier: 'A', icp_score: 0.9, category_path: 'Remesla-a-sluzby > Stavebni-sluzby' }])
    const res = await get('/api/categories/stavebni/companies')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 42, limit: 50, offset: 0 })
    expect((res.body as any).companies).toHaveLength(1)
  })

  it('prefix=false narrows to exact path match', async () => {
    queueRows([{ path: 'Remesla' }])
    queueRows([{ count: 5 }])
    queueRows([])
    await get('/api/categories/remesla/companies?prefix=false')
    // 3rd call (data) should use exact path predicate.
    const dataSql = calls[2].sql
    expect(dataSql).not.toMatch(/LIKE \$1 \|\|/)
    expect(dataSql).toMatch(/category_path=\$1/)
  })

  it('prefix=true (default) matches by LIKE prefix', async () => {
    queueRows([{ path: 'Remesla' }])
    queueRows([{ count: 10 }])
    queueRows([])
    await get('/api/categories/remesla/companies')
    expect(calls[1].sql).toMatch(/LIKE \$1 \|\|/)
  })

  it('limit + offset propagate', async () => {
    queueRows([{ path: 'Remesla' }])
    queueRows([{ count: 200 }])
    queueRows([])
    await get('/api/categories/remesla/companies?limit=25&offset=50')
    const dataParams = calls[2].params as unknown[]
    expect(dataParams[1]).toBe(25)
    expect(dataParams[2]).toBe(50)
  })

  it('500 on pg throw', async () => {
    queueError('syntax error')
    const res = await get('/api/categories/x/companies')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Contract stability — neither route accepts POST/PUT/DELETE
// ═══════════════════════════════════════════════════════════════════════

describe('method routing', () => {
  it('POST /api/categories → 404 (not registered)', async () => {
    const r = await fetch(baseUrl + '/api/categories', { method: 'POST' })
    // Express returns a 404 with HTML body when a method/path has no handler.
    expect([404, 405]).toContain(r.status)
  })

  it('DELETE /api/categories/:slug → 404', async () => {
    const r = await fetch(baseUrl + '/api/categories/foo', { method: 'DELETE' })
    expect([404, 405]).toContain(r.status)
  })
})
