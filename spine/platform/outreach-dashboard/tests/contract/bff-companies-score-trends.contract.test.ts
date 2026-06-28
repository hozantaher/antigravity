// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/companies/score-trends
//
// Endpoint added 2026-04-30 to fix the visual smoke regression
// (`/api/companies/score-trends → 404`). The Companies page batches up
// to ~50 IČOs per request and renders mini sparklines per row.
//
// Locks the contract:
//   - empty / malformed `icos` → 200 with empty object (UI tolerates {})
//   - hard cap at 200 IČOs (matches Companies.jsx batch slice)
//   - days clamped to [1, 365]
//   - response shape: `{ "<ico>": [{ at: ISOString, score: number }, ...] }`
//   - missing `outreach_score_history` table degrades to empty arrays (no 500)
//   - route is registered BEFORE `/api/companies/:ico` (Express order matters)
//
// Zero external deps — pg is fully stubbed.
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

describe('GET /api/companies/score-trends', () => {
  it('200 with empty object when icos missing', async () => {
    const res = await get('/api/companies/score-trends')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
    // No DB call should fire when there's nothing to query.
    expect(calls.length).toBe(0)
  })

  it('200 with empty object when icos is empty string', async () => {
    const res = await get('/api/companies/score-trends?icos=')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
    expect(calls.length).toBe(0)
  })

  it('drops non-numeric IČOs from input', async () => {
    queueRows([])
    const res = await get('/api/companies/score-trends?icos=12345678,not-an-ico,abc,99999999')
    expect(res.status).toBe(200)
    // Two valid IČOs make it through — both are present as keys (empty arrays).
    expect(res.body).toHaveProperty('12345678')
    expect(res.body).toHaveProperty('99999999')
    expect(res.body).not.toHaveProperty('not-an-ico')
    expect(res.body).not.toHaveProperty('abc')
  })

  it('returns {ico: []} for IČOs with no history rows', async () => {
    queueRows([])
    const res = await get('/api/companies/score-trends?icos=12345678')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ '12345678': [] })
  })

  it('groups rows by ico and exposes {at, score} entries', async () => {
    queueRows([
      { ico: '12345678', at: new Date('2026-04-10T10:00:00Z'), score: 0.45 },
      { ico: '12345678', at: new Date('2026-04-20T10:00:00Z'), score: 0.62 },
      { ico: '99999999', at: new Date('2026-04-15T10:00:00Z'), score: 0.30 },
    ])
    const res = await get('/api/companies/score-trends?icos=12345678,99999999')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, Array<{ at: string; score: number }>>
    expect(body['12345678']).toHaveLength(2)
    expect(body['99999999']).toHaveLength(1)
    expect(body['12345678'][0]).toMatchObject({ score: 0.45 })
    expect(typeof body['12345678'][0].at).toBe('string')
  })

  it('passes IČO array as text[] parameter to pg', async () => {
    queueRows([])
    await get('/api/companies/score-trends?icos=12345678,99999999')
    expect(calls[0].sql).toMatch(/outreach_score_history/)
    expect(calls[0].sql).toMatch(/oc\.ico\s*=\s*ANY\(\$1::text\[\]\)/)
    const params = calls[0].params as unknown[]
    expect(Array.isArray(params[0])).toBe(true)
    expect(params[0]).toEqual(['12345678', '99999999'])
  })

  it('clamps days param to a [1,365] window', async () => {
    queueRows([])
    await get('/api/companies/score-trends?icos=12345678&days=9999')
    let params = calls[0].params as unknown[]
    expect(params[1]).toBe('365')

    queueRows([])
    await get('/api/companies/score-trends?icos=12345678&days=-5')
    params = calls[1].params as unknown[]
    // Negative or 0 → clamped up to 1.
    expect(params[1]).toBe('1')

    queueRows([])
    await get('/api/companies/score-trends?icos=12345678')
    params = calls[2].params as unknown[]
    // No days → default 30.
    expect(params[1]).toBe('30')
  })

  it('caps batch input at 200 IČOs', async () => {
    queueRows([])
    const big = Array.from({ length: 350 }, (_, i) => String(10000000 + i)).join(',')
    await get('/api/companies/score-trends?icos=' + big)
    const params = calls[0].params as unknown[]
    const arr = params[0] as string[]
    expect(arr.length).toBe(200)
  })

  it('degrades to empty arrays when outreach_score_history is missing (no 500)', async () => {
    queueError('relation "outreach_score_history" does not exist')
    const res = await get('/api/companies/score-trends?icos=12345678,99999999')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ '12345678': [], '99999999': [] })
  })

  it('does not get shadowed by /api/companies/:ico — score-trends route wins', async () => {
    // If `/api/companies/:ico` matched first, the request would hit that
    // handler with `req.params.ico === 'score-trends'` and either 404 or
    // return a single-company shape. Verifying we get the trends shape
    // proves the route ordering is correct.
    queueRows([])
    const res = await get('/api/companies/score-trends?icos=12345678')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ '12345678': [] })
  })

  it('rejects letters-only IČO list as empty (200, not 500)', async () => {
    const res = await get('/api/companies/score-trends?icos=abc,def,ghi')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
    expect(calls.length).toBe(0)
  })

  it('coerces score to Number in the response payload', async () => {
    queueRows([
      { ico: '12345678', at: new Date('2026-04-10T10:00:00Z'), score: '0.55' },
    ])
    const res = await get('/api/companies/score-trends?icos=12345678')
    const body = res.body as Record<string, Array<{ at: string; score: number }>>
    expect(typeof body['12345678'][0].score).toBe('number')
    expect(body['12345678'][0].score).toBeCloseTo(0.55, 5)
  })
})
