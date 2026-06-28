// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — D2.7 server.js meta (categories) extraction
//
//  Locks the response shape + SQL contract for the 4 routes moved from
//  server.js into src/server-routes/meta.js as part of sprint D2.7
//  (2026-05-02).
//
//  Routes covered:
//    GET /api/meta/categories
//    GET /api/meta/categories/tree
//    GET /api/meta/categories/search
//    GET /api/meta/categories/top
//
//  Strategy mirrors bff-scoring-d25-extract.contract.test.ts: pg.Pool is
//  mocked, the BFF is booted via app.listen(0), and tests exercise real
//  Express dispatch through the mounter wiring.
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
      return {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params })
          if (!queryQueue.length) return { rows: [], rowCount: 0 }
          const next = queryQueue.shift()!
          if (next instanceof Error) throw next
          return next
        },
        release: () => {},
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'EMAIL_VERIFY_SMTP']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.EMAIL_VERIFY_SMTP = '0'
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
  return { status: r.status, body: json, headers: r.headers }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/meta/categories
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/meta/categories', () => {
  it('200 with [] when no companies have category_path', async () => {
    queueRows([])
    const res = await get('/api/meta/categories')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('200 returns flat array of distinct category names sorted by count', async () => {
    queueRows([
      { cat: 'Stavebnictví', cnt: 120 },
      { cat: 'Doprava', cnt: 80 },
      { cat: 'Zemědělství', cnt: 35 },
    ])
    const res = await get('/api/meta/categories')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(['Stavebnictví', 'Doprava', 'Zemědělství'])
    // contract: SQL must split on ' > ', exclude datum_zaniku, LIMIT 30
    expect(calls[0].sql).toMatch(/split_part\(category_path,' > ',1\)/)
    expect(calls[0].sql).toMatch(/datum_zaniku IS NULL/)
    expect(calls[0].sql).toMatch(/LIMIT 30/)
  })

  it('filters out empty/null cat strings from response', async () => {
    queueRows([
      { cat: 'Stavebnictví', cnt: 5 },
      { cat: null, cnt: 3 },
      { cat: '', cnt: 1 },
    ])
    const res = await get('/api/meta/categories')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(['Stavebnictví'])
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/meta/categories')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/meta/categories/tree
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/meta/categories/tree', () => {
  it('200 with [] when no root rows; uses parent_path IS NULL branch', async () => {
    queueRows([])
    const res = await get('/api/meta/categories/tree')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
    // No parent → SQL contains "IS NULL" (not "= $1") and no params
    expect(calls[0].sql).toMatch(/parent_path IS NULL/)
    expect(calls[0].params).toEqual([])
  })

  it('200 maps rows to {name, path, cnt, hasChildren} envelope', async () => {
    queueRows([
      { path: 'Stavebnictví', name: 'Stavebnictví', cnt: '42', has_children: true },
      { path: 'Doprava', name: 'Doprava', cnt: 7, has_children: false },
    ])
    // unique parent key to bypass module-scoped 90s cache from prior tests
    const res = await get('/api/meta/categories/tree?parent=__envelope_test__')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { name: 'Stavebnictví', path: 'Stavebnictví', cnt: 42, hasChildren: true },
      { name: 'Doprava', path: 'Doprava', cnt: 7, hasChildren: false },
    ])
  })

  it('passes parent param when provided; uses = $1 SQL branch', async () => {
    queueRows([])
    const res = await get('/api/meta/categories/tree?parent=__param_branch__')
    expect(res.status).toBe(200)
    const treeCall = calls.find(c => /parent_path = \$1/.test(c.sql))
    expect(treeCall).toBeDefined()
    expect(treeCall?.params).toEqual(['__param_branch__'])
  })

  it('500 on pg throw', async () => {
    queueError('timeout')
    // unique parent to bypass any cached value from previous tests
    const res = await get('/api/meta/categories/tree?parent=__err_branch__')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/meta/categories/search
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/meta/categories/search', () => {
  it('200 with [] when q is missing (no SQL issued)', async () => {
    const before = calls.length
    const res = await get('/api/meta/categories/search')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
    expect(calls.length).toBe(before) // short-circuit before any pool.query
  })

  it('200 with [] when q is whitespace-only', async () => {
    const before = calls.length
    const res = await get('/api/meta/categories/search?q=%20%20%20')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
    expect(calls.length).toBe(before)
  })

  it('200 returns ranked envelope with parameter binding [q, q, %q%]', async () => {
    queueRows([
      { path: 'Doprava > Kamionová', name: 'Kamionová', cnt: '12', rank: 2 },
    ])
    const res = await get('/api/meta/categories/search?q=Kami')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { path: 'Doprava > Kamionová', name: 'Kamionová', cnt: 12, rank: 2 },
    ])
    const searchCall = calls.find(c => /WHERE name ILIKE \$3 OR path ILIKE \$3/.test(c.sql))
    expect(searchCall?.params).toEqual(['Kami', 'Kami', '%Kami%'])
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    // unique q to bypass the search cache
    const res = await get('/api/meta/categories/search?q=__err_q__')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/meta/categories/top
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/meta/categories/top', () => {
  it('200 with [] and base WHERE clauses when no filters provided', async () => {
    queueRows([])
    const res = await get('/api/meta/categories/top')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
    const topCall = calls[calls.length - 1]
    expect(topCall.sql).toMatch(/datum_zaniku IS NULL/)
    expect(topCall.sql).toMatch(/v_likvidaci=false/)
    expect(topCall.sql).toMatch(/v_insolvenci=false/)
    expect(topCall.sql).toMatch(/category_path IS NOT NULL/)
    expect(topCall.sql).toMatch(/LIMIT 12/)
    expect(topCall.params).toEqual([])
  })

  it('200 returns {name, cnt} envelope mapped from cat/cnt rows', async () => {
    queueRows([
      { cat: 'Stavebnictví', cnt: '88' },
      { cat: 'Doprava', cnt: 33 },
    ])
    const res = await get('/api/meta/categories/top')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { name: 'Stavebnictví', cnt: 88 },
      { name: 'Doprava', cnt: 33 },
    ])
  })

  it('appends icp / size / uncontacted filters and LIKE patterns for categories[]', async () => {
    queueRows([])
    const res = await get(
      '/api/meta/categories/top?icp=A&size=medium&uncontacted=1' +
      '&categories[]=Stavebnictv%C3%AD&categories[]=Doprava'
    )
    expect(res.status).toBe(200)
    const topCall = calls[calls.length - 1]
    expect(topCall.sql).toMatch(/icp_tier = ANY/)
    expect(topCall.sql).toMatch(/velikost_firmy = ANY/)
    expect(topCall.sql).toMatch(/last_contacted IS NULL/)
    // Two LIKE entries OR'd together for two categories[] params
    expect(topCall.sql).toMatch(/category_path LIKE \$3 OR category_path LIKE \$4/)
    expect(topCall.params).toEqual(['{A}', '{medium}', 'Stavebnictví%', 'Doprava%'])
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/meta/categories/top')
    expect(res.status).toBe(500)
  })
})
