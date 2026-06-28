// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — D2.5 server.js scoring extraction
//
//  Locks the response shape + SQL contract for the 8 routes moved from
//  server.js into src/server-routes/scoring.js as part of sprint D2.5
//  (2026-05-02).
//
//  Routes covered:
//    GET  /api/dual-axis
//    GET  /api/lookalike/centroid
//    GET  /api/scoring/config
//    PUT  /api/scoring/config
//    POST /api/scoring/preview
//    POST /api/scoring/recompute-all
//    POST /api/scoring/learn
//    GET  /api/scoring/stats
//
//  Strategy mirrors bff-companies-d22-extract.contract.test.ts: pg.Pool is
//  mocked, the BFF is booted via app.listen(0), and tests exercise real
//  Express dispatch through the mounter wiring. Helpers passed as deps
//  (loadSectorEngagementPriors, computeEngagementForCompanies, etc.) live
//  in server.js and run against the same mocked pool.
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

async function send(method: 'POST' | 'PUT', path: string, body?: unknown) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/dual-axis
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/dual-axis', () => {
  it('200 with empty items when no companies match', async () => {
    queueRows([])  // first SELECT companies
    const res = await get('/api/dual-axis')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ count: 0, items: [] })
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/dual-axis')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/lookalike/centroid
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/lookalike/centroid', () => {
  it('200 with envelope { converters, built_at, centroid }', async () => {
    // loadLookalikeCentroid: SELECT converters → empty (n=0 → vec=null)
    queueRows([])
    const res = await get('/api/lookalike/centroid')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ converters: 0, centroid: null })
    expect(typeof (res.body as { built_at: string }).built_at).toBe('string')
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/scoring/config
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/scoring/config', () => {
  it('200 with DEFAULT_WEIGHTS + version=0 when no row in scoring_config', async () => {
    queueRows([])  // SELECT weights returns nothing
    const res = await get('/api/scoring/config')
    expect(res.status).toBe(200)
    const body = res.body as { weights: Record<string, number>; version: number }
    expect(body.version).toBe(0)
    expect(body.weights).toBeTypeOf('object')
    expect(Object.keys(body.weights).length).toBeGreaterThan(0)
  })

  it('200 with stored weights when row exists', async () => {
    const stored = {
      weights: { icp_weight: 50 },
      version: 7,
      updated_at: '2026-05-01T10:00:00Z',
      updated_by: 'ui',
    }
    queueRows([stored])
    const res = await get('/api/scoring/config')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(stored)
  })

  it('500 on pg throw', async () => {
    queueError('timeout')
    const res = await get('/api/scoring/config')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PUT /api/scoring/config
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/scoring/config', () => {
  it('400 when body has no weights', async () => {
    const res = await send('PUT', '/api/scoring/config', {})
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/weights required/)
  })

  it('400 when weights is not an object', async () => {
    const res = await send('PUT', '/api/scoring/config', { weights: 'not-an-object' })
    expect(res.status).toBe(400)
  })

  it('400 when an incoming weight is non-numeric', async () => {
    const res = await send('PUT', '/api/scoring/config', { weights: { icp_weight: 'abc' } })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/invalid weight/)
  })

  it('400 when an incoming weight exceeds 1000', async () => {
    const res = await send('PUT', '/api/scoring/config', { weights: { icp_weight: 9999 } })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/invalid weight/)
  })

  it('400 when an incoming weight is negative', async () => {
    const res = await send('PUT', '/api/scoring/config', { weights: { icp_weight: -1 } })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/scoring/preview
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/scoring/preview', () => {
  it('200 with sample/distribution envelope when companies query returns empty', async () => {
    queueRows([])  // loadSectorEngagementPriors
    queueRows([])  // primary SELECT companies → no rows
    const res = await send('POST', '/api/scoring/preview', {})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      sample: [],
      distribution: { S: 0, A: 0, B: 0, C: 0, D: 0 },
      sample_size: 0,
    })
  })

  it('falls back to degraded query when primary throws and surfaces degraded=true', async () => {
    queueRows([])           // loadSectorEngagementPriors
    queueError('column does not exist')  // primary fails
    queueRows([])           // fallback succeeds with empty rows
    const res = await send('POST', '/api/scoring/preview', {})
    expect(res.status).toBe(200)
    const body = res.body as { degraded?: boolean; sample_size: number }
    expect(body.degraded).toBe(true)
    expect(body.sample_size).toBe(0)
  })

  it('500 when both primary and fallback queries fail', async () => {
    queueRows([])           // loadSectorEngagementPriors
    queueError('boom-1')    // primary fails
    queueError('boom-2')    // fallback fails too
    const res = await send('POST', '/api/scoring/preview', {})
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/scoring/recompute-all
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/scoring/recompute-all', () => {
  it('200 with { scored, total_attempted } when no companies returned', async () => {
    queueRows([])  // getScoringWeights SELECT scoring_config (empty → DEFAULT_WEIGHTS)
    queueRows([])  // loadSectorEngagementPriors
    queueRows([])  // SELECT ico FROM companies → empty
    const res = await send('POST', '/api/scoring/recompute-all', {})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ scored: 0, total_attempted: 0 })
  })

  it('honors body.limit cap (10000)', async () => {
    queueRows([])
    queueRows([])
    queueRows([])
    const res = await send('POST', '/api/scoring/recompute-all', { limit: 999999 })
    expect(res.status).toBe(200)
    // Find the companies query (third call) and check param is clamped
    const companiesCall = calls.find(c => /SELECT ico FROM companies WHERE datum_zaniku/.test(c.sql))
    expect(companiesCall?.params?.[0]).toBe(10000)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/scoring/learn
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/scoring/learn', () => {
  it('returns gate_failed when zero samples (insufficient data gate)', async () => {
    queueRows([])  // SELECT score_components → no samples
    const res = await send('POST', '/api/scoring/learn', {})
    // With 0 samples the trainLogistic gate refuses → 400 gate_failed envelope
    expect(res.status).toBe(400)
    const body = res.body as { error: string; gate?: unknown; limits?: unknown }
    expect(body.error).toBe('gate_failed')
    expect(body).toHaveProperty('limits')
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await send('POST', '/api/scoring/learn', {})
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/scoring/stats
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/scoring/stats', () => {
  it('200 with { tiers, stale } when no companies', async () => {
    queueRows([])              // tier aggregate
    queueRows([{ cnt: 0 }])    // stale count
    const res = await get('/api/scoring/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tiers: [], stale: 0 })
  })

  it('200 returns tier rows + stale count', async () => {
    const tiers = [
      { score_tier: 'A', cnt: 10, avg_score: '85.50' },
      { score_tier: 'B', cnt: 25, avg_score: '60.00' },
    ]
    queueRows(tiers)
    queueRows([{ cnt: 7 }])
    const res = await get('/api/scoring/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tiers, stale: 7 })
    // First call: GROUP BY score_tier; second: scored_at > 7 days
    expect(calls[0].sql).toMatch(/GROUP BY score_tier/)
    expect(calls[1].sql).toMatch(/INTERVAL '7 days'/)
  })

  it('500 on pg throw', async () => {
    queueError('timeout')
    const res = await get('/api/scoring/stats')
    expect(res.status).toBe(500)
  })
})
