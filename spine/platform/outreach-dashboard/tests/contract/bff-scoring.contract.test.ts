// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/scoring/config + /preview + /stats
//
// Locks the ICP scoring surface consumed by Scoring.jsx — weight sliders,
// live preview, and distribution counts.
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
//  GET /api/scoring/config
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/scoring/config', () => {
  it('200 with row when scoring_config exists', async () => {
    const weights = { icp_tier: 30, email_confidence: 25 }
    queueRows([{ weights, version: 3, updated_at: '2026-04-20', updated_by: 'admin' }])
    const res = await req('GET', '/api/scoring/config')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ weights, version: 3, updated_by: 'admin' })
  })

  it('200 with DEFAULT_WEIGHTS + version=0 when table empty', async () => {
    queueRows([])
    const res = await req('GET', '/api/scoring/config')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('weights')
    expect((res.body as any).version).toBe(0)
    // Default weights should be a non-empty object
    expect(Object.keys((res.body as any).weights).length).toBeGreaterThan(0)
  })

  it('500 on pg throw', async () => {
    queueError('db down')
    const res = await req('GET', '/api/scoring/config')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PUT /api/scoring/config
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/scoring/config', () => {
  it('400 when body.weights is missing', async () => {
    const res = await req('PUT', '/api/scoring/config', {})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'weights required' })
  })

  it('400 when weights is not an object', async () => {
    const res = await req('PUT', '/api/scoring/config', { weights: 'not-object' })
    expect(res.status).toBe(400)
  })

  it('400 when any weight is negative', async () => {
    const res = await req('PUT', '/api/scoring/config', { weights: { icp_tier: -5 } })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toContain('icp_tier')
  })

  it('400 when any weight exceeds 1000', async () => {
    const res = await req('PUT', '/api/scoring/config', { weights: { icp_tier: 1001 } })
    expect(res.status).toBe(400)
  })

  it('400 when weight is non-finite (NaN/Infinity stringified)', async () => {
    // JSON can't carry NaN/Infinity directly; null stringifies them. Test with bad string.
    const res = await req('PUT', '/api/scoring/config', { weights: { icp_tier: 'bad' } })
    expect(res.status).toBe(400)
  })

  it('200 + updated row on valid weights', async () => {
    queueRows([])  // UPDATE result
    queueRows([{ weights: { icp_tier: 40 }, version: 4, updated_at: '2026-04-21' }])
    const res = await req('PUT', '/api/scoring/config', {
      weights: { icp_tier: 40, email_confidence: 20 },
      updated_by: 'test',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ version: 4 })
  })

  it('UPDATE increments version (version = version+1)', async () => {
    queueRows([])
    queueRows([{ weights: {}, version: 5 }])
    await req('PUT', '/api/scoring/config', { weights: { icp_tier: 25 } })
    expect(calls[0].sql).toMatch(/version\s*=\s*version\s*\+\s*1/)
  })

  it('UPDATE passes updated_by param (default "ui" when omitted)', async () => {
    queueRows([])
    queueRows([{ weights: {}, version: 5 }])
    await req('PUT', '/api/scoring/config', { weights: { icp_tier: 25 } })
    const params = calls[0].params as unknown[]
    expect(params[1]).toBe('ui')
  })

  it('500 on pg throw', async () => {
    queueError('lock timeout')
    const res = await req('PUT', '/api/scoring/config', { weights: { icp_tier: 30 } })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/scoring/preview
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/scoring/preview', () => {
  it('200 returns {sample, distribution, sample_size}', async () => {
    queueRows([]) // sectorPriors
    queueRows([
      { ico: '123', name: 'Alpha', icp_tier: 'A', sector_primary: 'mfg' },
    ])
    const res = await req('POST', '/api/scoring/preview', {})
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('sample')
    expect(res.body).toHaveProperty('distribution')
    expect(res.body).toHaveProperty('sample_size')
    const dist = (res.body as any).distribution
    // Distribution has S/A/B/C/D tiers
    for (const tier of ['S', 'A', 'B', 'C', 'D']) {
      expect(dist).toHaveProperty(tier)
    }
  })

  it('default sample limit = 200', async () => {
    queueRows([])
    queueRows([])
    await req('POST', '/api/scoring/preview', {})
    // Second call has limit in first param
    const params = calls[1].params as unknown[]
    expect(params[0]).toBe(200)
  })

  it('caps limit at 1000', async () => {
    queueRows([])
    queueRows([])
    await req('POST', '/api/scoring/preview', { limit: 9999 })
    const params = calls[1].params as unknown[]
    expect(params[0]).toBe(1000)
  })

  it('filters alive companies (datum_zaniku IS NULL)', async () => {
    queueRows([])
    queueRows([])
    await req('POST', '/api/scoring/preview', {})
    expect(calls[1].sql).toMatch(/datum_zaniku IS NULL/)
  })

  it('falls back to minimal column set when primary query fails (engagement_score / send_events drift)', async () => {
    // Caught by 2026-04-30 visual smoke. Primary throws (e.g. column
    // `c.engagement_score` missing), handler retries with a slimmer
    // SELECT and returns `{ degraded: true }`.
    queueRows([])           // sectorPriors
    queueError('column "engagement_score" does not exist') // primary
    queueRows([
      { ico: '111', name: 'Beta', icp_tier: 'B', sector_primary: 'mfg' },
    ])                      // fallback
    const res = await req('POST', '/api/scoring/preview', {})
    expect(res.status).toBe(200)
    expect((res.body as any).degraded).toBe(true)
    expect(Array.isArray((res.body as any).sample)).toBe(true)
    expect((res.body as any).sample_size).toBe(1)
  })

  it('500 only when both primary and fallback queries fail', async () => {
    queueRows([])           // sectorPriors
    queueError('timeout')   // primary
    queueError('timeout')   // fallback
    const res = await req('POST', '/api/scoring/preview', {})
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/scoring/stats
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/scoring/stats', () => {
  it('route registered — returns 200 or 5xx (not Express 404)', async () => {
    const res = await req('GET', '/api/scoring/stats')
    expect([200, 500]).toContain(res.status)
  })
})
