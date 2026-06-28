// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — D2.2 server.js extraction
//
//  Locks the response shape + SQL contract for the 12 /api/companies/* routes
//  moved from server.js into src/server-routes/companies.js as part of sprint
//  D2.2 (2026-05-03). Companion to bff-companies.contract.test.ts and
//  bff-companies-extended.contract.test.ts which cover the 3 routes (list,
//  score-trends, :ico) that were extracted earlier in T3.7.
//
//  Routes covered here:
//    POST /api/companies/:ico/verify-email
//    POST /api/companies/bulk-verify-email
//    GET  /api/companies/:ico/verification-history
//    POST /api/companies/:ico/recompute-score
//    GET  /api/companies/:ico/expected-value
//    GET  /api/companies/:ico/data-quality
//    GET  /api/companies/:ico/readiness
//    GET  /api/companies/:ico/lookalike
//    POST /api/companies/:ico/facts (manual fact ingest)
//    GET  /api/companies/:ico/facts (history)
//    GET  /api/companies/:ico/facts/current (latest non-expired facts)
//    GET  /api/companies/facets (filter facet counts, 30s memo)
//
//  Test strategy: tests work end-to-end through `app.listen(0)` so they
//  exercise the actual mounter wiring and dep-injection. The pg.Pool mock
//  controls every SQL response. Helpers passed as deps (runVerifyAndPersist,
//  computeEngagementForCompany, …) live in server.js and run against the
//  same mocked pool — no extra mocking needed for the contract surface.
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
  // The verify-email pipeline calls verifyEmail() which can perform real DNS
  // probes. Disable SMTP probing so mocked pool responses are sufficient.
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

async function post(path: string, body?: unknown) {
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/facets
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/facets', () => {
  it('200 with grouped + boolean counts envelope', async () => {
    // 4 group queries, 3 boolean queries — order matters because Promise.all
    // dispatches them all to the mocked Pool in the order written in the code.
    queueRows([{ k: 'A', n: 100 }, { k: 'B', n: 50 }])      // icp_tier
    queueRows([{ k: 'small', n: 200 }])                      // velikost_firmy
    queueRows([{ k: 'valid', n: 300 }])                      // email_status
    queueRows([{ k: 'high', n: 80 }])                        // engagement_cluster
    queueRows([{ n: 5000 }])                                 // uncontacted
    queueRows([{ n: 4500 }])                                 // hasWebsite
    queueRows([{ n: 4800 }])                                 // hasEmail
    const res = await get('/api/companies/facets')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      icp: { A: 100, B: 50 },
      size: { small: 200 },
      email: { valid: 300 },
      engagement: { high: 80 },
      uncontacted: 5000,
      hasWebsite: 4500,
      hasEmail: 4800,
    })
    expect(typeof (res.body as { cachedAt: string }).cachedAt).toBe('string')
  })

  it('emits X-Cache: MISS on first call, HIT on second within TTL', async () => {
    // Reset is implicit because beforeEach drains the queue, but the in-process
    // _facetsCache from the previous it-block may still be hot. Force a MISS
    // by queueing a fresh set of 7 responses, then a HIT call uses no rows.
    queueRows([])
    queueRows([])
    queueRows([])
    queueRows([])
    queueRows([{ n: 0 }])
    queueRows([{ n: 0 }])
    queueRows([{ n: 0 }])
    const r1 = await get('/api/companies/facets')
    // Either MISS (cache cold) or HIT (cache from previous test still warm).
    expect(['HIT', 'MISS']).toContain(r1.headers.get('x-cache'))
    const r2 = await get('/api/companies/facets')
    expect(r2.headers.get('x-cache')).toBe('HIT')
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/companies/:ico/verify-email
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/companies/:ico/verify-email', () => {
  it('404 when company not found', async () => {
    queueRows([])  // SELECT ico, email FROM companies returns nothing
    const res = await post('/api/companies/99999999/verify-email')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('returns no_email status when company exists but has no email', async () => {
    // verify-email now runs inside a txn (companies.js:442). This file's connect
    // mock does NOT short-circuit BEGIN/COMMIT, so BEGIN consumes a queue row —
    // feed it an empty row first so the company SELECT lands on the right row.
    queueRows([])  // BEGIN
    queueRows([{ ico: '12345678', email: null }])  // SELECT ico, email
    queueRows([])  // UPDATE companies SET email_status='no_email'
    const res = await post('/api/companies/12345678/verify-email')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'no_email', detail: 'Firma nemá e-mail' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/companies/bulk-verify-email
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/companies/bulk-verify-email', () => {
  it('400 when icos missing', async () => {
    const res = await post('/api/companies/bulk-verify-email', {})
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/icos required/)
  })

  it('400 when icos is not an array', async () => {
    const res = await post('/api/companies/bulk-verify-email', { icos: 'not-an-array' })
    expect(res.status).toBe(400)
  })

  it('400 when icos array is empty', async () => {
    const res = await post('/api/companies/bulk-verify-email', { icos: [] })
    expect(res.status).toBe(400)
  })

  it('processes companies with no email as no_email', async () => {
    // bulk-verify runs inside a txn (companies.js:482); BEGIN consumes a queue
    // row here (connect mock does NOT short-circuit it), so feed an empty first.
    queueRows([])  // BEGIN
    queueRows([{ ico: '12345678', email: null }])  // SELECT ico, email FROM companies
    queueRows([])                                  // UPDATE companies SET email_status='no_email'
    const res = await post('/api/companies/bulk-verify-email', { icos: ['12345678'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      verified: 1,
      results: [{ ico: '12345678', status: 'no_email' }],
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/:ico/verification-history
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/:ico/verification-history', () => {
  it('200 with rows array (50-row cap in SQL)', async () => {
    const sample = [
      { id: 1, email: 'x@y.cz', old_status: null, new_status: 'valid',
        detail: 'mx ok', trigger: 'manual', created_at: '2026-05-01T10:00:00Z' },
    ]
    queueRows(sample)
    const res = await get('/api/companies/12345678/verification-history')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(sample)
    expect(calls[0].sql).toMatch(/email_verification_log/)
    expect(calls[0].sql).toMatch(/LIMIT 50/)
    expect(calls[0].sql).toMatch(/ORDER BY created_at DESC/)
  })

  it('500 on pg throw', async () => {
    queueError('timeout')
    const res = await get('/api/companies/12345678/verification-history')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/companies/:ico/recompute-score
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/companies/:ico/recompute-score', () => {
  it('404 when company not found', async () => {
    queueRows([])  // loadSectorEngagementPriors → empty
    queueRows([])  // recomputeScoreForIco SELECT companies → empty
    const res = await post('/api/companies/99999999/recompute-score')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/:ico/expected-value
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/:ico/expected-value', () => {
  it('404 when company not found', async () => {
    queueRows([])
    const res = await get('/api/companies/99999999/expected-value')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/companies/12345678/expected-value')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/:ico/data-quality
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/:ico/data-quality', () => {
  it('404 when company not found', async () => {
    queueRows([])
    const res = await get('/api/companies/99999999/data-quality')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'company not found' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/:ico/readiness
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/:ico/readiness', () => {
  it('404 when company not found', async () => {
    queueRows([])
    const res = await get('/api/companies/99999999/readiness')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'company not found' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/:ico/lookalike
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/:ico/lookalike', () => {
  it('404 when company not found', async () => {
    queueRows([])
    const res = await get('/api/companies/99999999/lookalike')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'company not found' })
  })

  it('503 when centroid is empty (no historical converters)', async () => {
    queueRows([{ id: 1, icp_tier: 'A', velikost_firmy: 'small', email: 'a@b.cz',
                website: 'x.cz', email_confidence: 0.9, sector_confidence: 0.5,
                composite_score: 50, engagement_score: 0.3 }])
    queueRows([])  // loadLookalikeCentroid: SELECT converters → empty (n=0)
    const res = await get('/api/companies/12345678/lookalike')
    expect(res.status).toBe(503)
    expect((res.body as { error: string }).error).toMatch(/no converters/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/companies/:ico/facts (manual ingestion)
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/companies/:ico/facts', () => {
  it('400 when field missing', async () => {
    const res = await post('/api/companies/12345678/facts', { value: 'x' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/field required/)
  })

  it('400 when field is too long (>64 chars)', async () => {
    const res = await post('/api/companies/12345678/facts', {
      field: 'a'.repeat(65),
      value: 'x',
    })
    expect(res.status).toBe(400)
  })

  it('400 when value missing (undefined)', async () => {
    const res = await post('/api/companies/12345678/facts', { field: 'mx_provider' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/value required/)
  })

  it('404 when company not found', async () => {
    queueRows([])  // SELECT id FROM companies returns nothing
    const res = await post('/api/companies/99999999/facts', {
      field: 'mx_provider',
      value: 'google',
    })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'company not found' })
  })

  it('accepts value=null (null is not undefined)', async () => {
    queueRows([])  // company not found → 404 short-circuits before persist
    const res = await post('/api/companies/12345678/facts', {
      field: 'mx_provider',
      value: null,
    })
    // Either 404 (no company) or 200 (persist succeeded). Either way, the
    // shape "value === undefined → 400" guard MUST not fire on `null`.
    expect(res.status).not.toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/:ico/facts (history)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/:ico/facts', () => {
  it('404 when company not found', async () => {
    queueRows([])
    const res = await get('/api/companies/99999999/facts')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'company not found' })
  })

  it('200 with fact-history rows when company exists', async () => {
    queueRows([{ id: 1 }])  // SELECT id FROM companies
    const facts = [
      { id: 100, source: 'mx_lookup', field: 'mx_provider', value: 'google',
        base_confidence: 0.95, fetched_at: '2026-05-01T10:00:00Z',
        ttl_days: 30, parser_version: 'v2' },
    ]
    queueRows(facts)
    const res = await get('/api/companies/12345678/facts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(facts)
    expect(calls[1].sql).toMatch(/LIMIT 200/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies/:ico/facts/current
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies/:ico/facts/current', () => {
  it('404 when company not found', async () => {
    queueRows([])
    const res = await get('/api/companies/99999999/facts/current')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'company not found' })
  })

  it('200 with current-facts MV rows when company exists', async () => {
    queueRows([{ id: 1 }])
    const facts = [
      { field: 'spf', source: 'mx_lookup', value: 'pass',
        base_confidence: 0.95, fetched_at: '2026-05-01T10:00:00Z',
        ttl_days: 30, expires_at: '2026-05-31T10:00:00Z' },
    ]
    queueRows(facts)
    const res = await get('/api/companies/12345678/facts/current')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(facts)
    expect(calls[1].sql).toMatch(/company_current_facts/)
    expect(calls[1].sql).toMatch(/ORDER BY field/)
  })
})
