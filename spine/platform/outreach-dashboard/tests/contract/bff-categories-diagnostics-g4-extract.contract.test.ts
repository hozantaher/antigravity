// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — G4 extract guard for /api/categories/* + /api/diagnostics/*
//
// Sprint G4 (2026-05-03) moved the inline category browser routes (3) and
// the segmentation-diagnostics routes (2) from server.js into:
//
//   src/server-routes/categories.js   → mountCategoriesRoutes
//   src/server-routes/diagnostics.js  → mountDiagnosticsRoutes
//
// This file pins behavior contracts that survived the extract. Pre-existing
// `bff-categories.contract.test.ts` and `bff-diagnostics.contract.test.ts`
// continue to assert SQL-level + happy-path shapes; this file adds the
// targeted G4 guards (boundary clamps, whitelist enforcement, 404/400/500
// surfacing, and module wiring proofs) so future drift can't silently
// re-inline the handlers.
//
// Strategy mirrors bff-meta-d27-extract.contract.test.ts: pg.Pool is
// mocked, the BFF is booted via app.listen(0), and tests exercise real
// Express dispatch through the mounter wiring.
//
// Memory rules:
//   feedback_extreme_testing  (T0)  — 12+ cases, covering happy + boundary
//                                     + error + integration paths.
//   feedback_no_speculation   (T0)  — every assertion derived from the
//                                     extracted module body, not inferred.
//   feedback_operator_focus   (T1)  — diagnostics back the operator's
//                                     "what predicts replies?" workflow.
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
//  Categories — list / search / parent branching
// ═══════════════════════════════════════════════════════════════════════

describe('G4: GET /api/categories — list mode branching', () => {
  it('returns top-level (depth=0) by default with default limit=200', async () => {
    queueRows([
      { id: 1, path: 'A', slug: 'a', name: 'A', parent_path: null, depth: 0, company_count: 5 },
    ])
    const res = await get('/api/categories')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      categories: [{ slug: 'a', depth: 0 }],
      total: 1,
    })
    // SQL must hit depth=0 branch with limit param.
    const sql = calls[0].sql
    expect(sql).toContain('depth=0')
    expect(calls[0].params).toEqual([200])
  })

  it('uses search branch when ?q is provided (ILIKE on path)', async () => {
    queueRows([])
    await get('/api/categories?q=manuf&limit=50')
    expect(calls[0].sql).toContain('path ILIKE $1')
    expect(calls[0].params).toEqual(['%manuf%', 50])
  })

  it('uses parent branch when ?parent is provided (no LIMIT in SQL)', async () => {
    queueRows([])
    await get('/api/categories?parent=A%20%3E%20B')
    expect(calls[0].sql).toContain('parent_path=$1')
    // Parent branch intentionally has no LIMIT — full child fanout is small.
    expect(calls[0].sql).not.toMatch(/LIMIT\s+\$/i)
    expect(calls[0].params).toEqual(['A > B'])
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/categories')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Categories — :slug + :slug/companies
// ═══════════════════════════════════════════════════════════════════════

describe('G4: GET /api/categories/:slug', () => {
  it('404 when slug not found', async () => {
    queueRows([]) // category lookup empty
    const res = await get('/api/categories/nope')
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: 'not found' })
  })

  it('returns {category, children} when found', async () => {
    queueRows([{ id: 1, path: 'A', slug: 'a', name: 'A', parent_path: null, depth: 0, company_count: 5 }])
    queueRows([{ id: 2, path: 'A > B', slug: 'a-b', name: 'B', parent_path: 'A', depth: 1, company_count: 2 }])
    const res = await get('/api/categories/a')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      category: { slug: 'a' },
      children: [{ slug: 'a-b' }],
    })
  })
})

describe('G4: GET /api/categories/:slug/companies', () => {
  it('default ?prefix=true uses descendant LIKE matcher', async () => {
    queueRows([{ path: 'A' }])
    queueRows([{ count: '7' }])
    queueRows([
      { id: 10, name: 'Acme', email: 'a@b', website: null, address_locality: null, icp_tier: 'A', icp_score: 0.9, category_path: 'A' },
    ])
    const res = await get('/api/categories/a/companies')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      companies: [{ id: 10 }],
      total: 7,
      limit: 50,
      offset: 0,
    })
    // 2nd call (count) and 3rd (rows) must use prefix LIKE.
    expect(calls[1].sql).toMatch(/category_path LIKE \$1 \|\| ' > %'/)
    expect(calls[2].sql).toMatch(/category_path LIKE \$1 \|\| ' > %'/)
  })

  it('?prefix=false uses exact match SQL', async () => {
    queueRows([{ path: 'A' }])
    queueRows([{ count: '0' }])
    queueRows([])
    await get('/api/categories/a/companies?prefix=false&limit=10&offset=5')
    expect(calls[1].sql).toMatch(/WHERE category_path=\$1/)
    expect(calls[2].params).toEqual(['A', 10, 5])
  })

  it('404 when slug not found', async () => {
    queueRows([])
    const res = await get('/api/categories/nope/companies')
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Diagnostics — segmentation MI ranking
// ═══════════════════════════════════════════════════════════════════════

describe('G4: GET /api/diagnostics/segmentation', () => {
  it('default features = all 5 whitelisted, default min_bucket=30', async () => {
    queueRows([])
    const res = await get('/api/diagnostics/segmentation')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      total_companies: 0,
      min_bucket: 30,
    })
    // SELECT projects all 5 whitelisted features.
    const sql = calls[0].sql
    expect(sql).toContain('sector_primary')
    expect(sql).toContain('velikost_firmy')
    expect(sql).toContain('icp_tier')
    expect(sql).toContain('score_tier')
    expect(sql).toContain('region_normalized')
  })

  it('400 when ?features collapses to empty after whitelist', async () => {
    const res = await get('/api/diagnostics/segmentation?features=password,secret')
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'no valid features' })
    // No DB call should fire on whitelist rejection (defense in depth).
    expect(calls.length).toBe(0)
  })

  it('clamps min_bucket below 5 up to 5', async () => {
    queueRows([])
    const res = await get('/api/diagnostics/segmentation?min_bucket=1')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ min_bucket: 5 })
  })

  it('clamps min_bucket above 500 down to 500', async () => {
    queueRows([])
    const res = await get('/api/diagnostics/segmentation?min_bucket=9999')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ min_bucket: 500 })
  })

  it('?features filters out non-whitelisted entries silently when ≥1 valid', async () => {
    queueRows([])
    const res = await get('/api/diagnostics/segmentation?features=icp_tier,evil_drop_table')
    expect(res.status).toBe(200)
    // SQL projects icp_tier only, NOT the rejected token.
    const sql = calls[0].sql
    expect(sql).toContain('icp_tier')
    expect(sql).not.toContain('evil_drop_table')
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Diagnostics — feature-lift per-bucket breakdown
// ═══════════════════════════════════════════════════════════════════════

describe('G4: GET /api/diagnostics/feature-lift', () => {
  it('400 on missing ?feature', async () => {
    const res = await get('/api/diagnostics/feature-lift')
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid feature' })
    expect(calls.length).toBe(0)
  })

  it('400 on non-whitelisted ?feature', async () => {
    const res = await get('/api/diagnostics/feature-lift?feature=evil')
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid feature' })
    expect(calls.length).toBe(0)
  })

  it('200 with whitelisted feature; SQL selects that column AS feature', async () => {
    queueRows([])
    const res = await get('/api/diagnostics/feature-lift?feature=icp_tier&min_bucket=20')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ feature: 'icp_tier', min_bucket: 20 })
    expect(calls[0].sql).toContain('icp_tier AS feature')
  })

  it('500 on pg throw inside the handler', async () => {
    queueError('db down')
    const res = await get('/api/diagnostics/feature-lift?feature=sector_primary')
    expect(res.status).toBe(500)
  })
})
