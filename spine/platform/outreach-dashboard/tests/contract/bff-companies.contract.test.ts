// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/companies + /api/companies/stats + /api/companies/regions + /sectors
//
// Locks the companies read surface consumed by Companies.jsx (full-text search,
// facet filters, detail drawer). Write operations (bulk-verify-email) have
// separate contract tests.
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

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/stats
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/stats', () => {
  it('200 with total from pg_class (reltuples estimate)', async () => {
    queueRows([{ total: '150000' }])
    const res = await get('/api/companies/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total: 150000 })
  })

  it('200 with total=0 when pg_class returns no row', async () => {
    queueRows([])
    const res = await get('/api/companies/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total: 0 })
  })

  it('500 on pg throw', async () => {
    queueError('relation does not exist')
    const res = await get('/api/companies/stats')
    expect(res.status).toBe(500)
  })

  it('uses reltuples (fast estimate, not COUNT(*))', async () => {
    queueRows([])
    await get('/api/companies/stats')
    expect(calls[0].sql).toMatch(/reltuples/i)
    expect(calls[0].sql).not.toMatch(/COUNT\(\*\)/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/regions + /sectors (autocomplete)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/regions (autocomplete)', () => {
  it('200 with {rows:[]} shape when no q', async () => {
    queueRows([{ value: 'Praha', n: 12345 }, { value: 'Brno', n: 8000 }])
    const res = await get('/api/companies/regions')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ rows: [{ value: 'Praha', n: 12345 }, { value: 'Brno', n: 8000 }] })
  })

  it('filters datum_zaniku IS NULL (alive only)', async () => {
    queueRows([])
    await get('/api/companies/regions')
    expect(calls[0].sql).toMatch(/datum_zaniku IS NULL/)
  })

  it('excludes NULL + empty string values', async () => {
    queueRows([])
    await get('/api/companies/regions')
    expect(calls[0].sql).toMatch(/IS NOT NULL/)
    expect(calls[0].sql).toMatch(/<> ''/)
  })

  it('ranks by count DESC then name ASC', async () => {
    queueRows([])
    await get('/api/companies/regions')
    expect(calls[0].sql).toMatch(/ORDER BY n DESC, value ASC/)
  })

  it('?q=prefix applies lower(col) LIKE prefix', async () => {
    queueRows([])
    await get('/api/companies/regions?q=Pra')
    expect(calls[0].sql).toMatch(/lower\(region_normalized\) LIKE lower\(\$1\)/)
    expect(calls[0].params).toEqual(['Pra%'])
  })

  it('whitespace-only q is treated as no filter', async () => {
    queueRows([])
    await get('/api/companies/regions?q=%20%20')
    expect(calls[0].params).toEqual([])
  })

  it('caps results at 20 (LIMIT 20)', async () => {
    queueRows([])
    await get('/api/companies/regions')
    expect(calls[0].sql).toMatch(/LIMIT 20/)
  })

  it('500 on pg throw', async () => {
    queueError('timeout')
    const res = await get('/api/companies/regions')
    expect(res.status).toBe(500)
  })
})

describe('GET /api/companies/sectors (shares autocomplete handler)', () => {
  it('200 with rows filtered on sector_primary column', async () => {
    queueRows([{ value: 'Stavebnictví', n: 5000 }])
    const res = await get('/api/companies/sectors?q=Sta')
    expect(res.status).toBe(200)
    expect(calls[0].sql).toMatch(/lower\(sector_primary\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies (list)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies', () => {
  it('200 with {rows, total}', async () => {
    queueRows([{ ico: '12345678', name: 'Alpha s.r.o.', best_targeting_score: 0.85 }])
    queueRows([{ total: 1 }])
    const res = await get('/api/companies')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ rows: [{ ico: '12345678', name: 'Alpha s.r.o.' }], total: 1 })
  })

  it('default sort=score dir=desc (best_targeting_score)', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    await get('/api/companies')
    const listSql = calls[0].sql
    expect(listSql).toMatch(/best_targeting_score/)
    expect(listSql).toMatch(/DESC NULLS LAST/)
  })

  it('default limit=50 offset=0', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    await get('/api/companies')
    const params = calls[0].params as unknown[]
    // Last 2 params are limit + offset
    const limit = params[params.length - 2]
    const offset = params[params.length - 1]
    expect(limit).toBe(50)
    expect(offset).toBe(0)
  })

  it('?dir=asc applies ASC NULLS LAST', async () => {
    queueRows([])
    queueRows([{ total: 0 }])
    await get('/api/companies?dir=asc')
    expect(calls[0].sql).toMatch(/ASC NULLS LAST/)
  })

  it('500 on pg throw', async () => {
    queueError('timeout')
    const res = await get('/api/companies')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/:ico (detail)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/:ico', () => {
  it('404 when company not found', async () => {
    queueRows([])
    const res = await get('/api/companies/99999999')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('500 on pg throw', async () => {
    queueError('db down')
    const res = await get('/api/companies/12345678')
    expect(res.status).toBe(500)
  })
})
