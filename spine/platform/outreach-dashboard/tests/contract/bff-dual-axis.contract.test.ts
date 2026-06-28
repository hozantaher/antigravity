// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/dual-axis
//
//  P-1 (perf-15s): Locks the rule that this endpoint issues ONE aggregate
//  per pool, not one per company. Prior shape was a serial loop calling
//  computeEngagementForCompany(coId) for each row in the candidate pool —
//  with default pool=200 and ~70 ms RTT to Railway, it took 13–15 s.
//
//  The test goes RED if anyone reverts the batched aggregate to the
//  per-company loop: assertion #1 counts SELECT FROM send_events queries
//  with `company_id =` (singular) vs `company_id = ANY` (batched).
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
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  delete process.env.GO_SERVER_URL
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

function pushAll(...outcomes: QueryOutcome[]) {
  queryQueue.push(...outcomes)
}

// Build N candidate-companies rows. Every company has exclusion_status='pass'
// and email set so it survives the WHERE filter.
function fakeCompanies(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    ico: String(11110000 + i),
    name: `Firma ${i + 1}`,
    icp_tier: 'Ideal',
    email_confidence: 0.9,
    sector_confidence: 0.8,
    velikost_firmy: '20-49',
    email: `kontakt@firma${i + 1}.test`,
    email_status: 'verified',
    exclusion_status: 'pass',
    website: `firma${i + 1}.test`,
    sector_primary: 'industry',
    last_contacted: null,
    total_sent: 5,
    total_replied: 1,
    total_opened: 3,
    total_bounced: 0,
    datum_zaniku: null,
    v_likvidaci: false,
    v_insolvenci: false,
    composite_score: 80,
    score_tier: 'A',
  }))
}

describe('GET /api/dual-axis — P-1 batched aggregate', () => {
  it('1: issues exactly ONE per-company-id aggregate query for a pool, not N (regression lock)', async () => {
    const cos = fakeCompanies(50)
    pushAll(
      { rows: cos },                              // 1: candidate pool
      { rows: [] },                               // 2: company_current_facts
      { rows: [] },                               // 3: loadSectorEngagementPriors
      { rows: cos.map(c => ({                     // 4: BATCHED engagement aggregate
        company_id: c.id, sent: 10, replied: 2, opened: 5, bounced: 0, sent_60d: 3,
      })) },
    )
    const res = await fetch(`${baseUrl}/api/dual-axis?limit=10&pool=50`)
    expect(res.status).toBe(200)

    const aggCalls = calls.filter(c =>
      /FROM send_events/i.test(c.sql) && /company_id\s*=\s*ANY/i.test(c.sql),
    )
    const singleCallSites = calls.filter(c =>
      /FROM send_events/i.test(c.sql) && /company_id\s*=\s*\$1\b/i.test(c.sql),
    )
    expect(aggCalls.length, 'should issue 1 batched ANY($1) GROUP BY aggregate').toBe(1)
    expect(singleCallSites.length, 'must NOT issue per-company singular WHERE company_id = $1').toBe(0)
  })

  it('2: companies with no send_events get engagement_score=0 (no crash, no NaN)', async () => {
    const cos = fakeCompanies(3)
    pushAll(
      { rows: cos },
      { rows: [] },
      { rows: [] },
      { rows: [] },                                // batched aggregate returns no rows
    )
    const res = await fetch(`${baseUrl}/api/dual-axis?limit=10&pool=10`)
    expect(res.status).toBe(200)
    const body = await res.json() as { count: number; items: Array<Record<string, unknown>> }
    expect(body.count).toBe(3)
    for (const it of body.items) {
      expect(typeof it.dual_axis).toBe('number')
      expect(Number.isFinite(it.dual_axis as number)).toBe(true)
    }
  })

  it('3: pool > limit → response.items length ≤ limit', async () => {
    const cos = fakeCompanies(20)
    pushAll(
      { rows: cos },
      { rows: [] },
      { rows: [] },
      { rows: cos.map(c => ({
        company_id: c.id, sent: 10, replied: 2, opened: 5, bounced: 0, sent_60d: 2,
      })) },
    )
    const res = await fetch(`${baseUrl}/api/dual-axis?limit=5&pool=20`)
    expect(res.status).toBe(200)
    const body = await res.json() as { count: number; items: unknown[] }
    expect(body.items.length).toBe(5)
    expect(body.count).toBe(20)
  })

  it('4: empty candidate pool → { count: 0, items: [] } without further queries', async () => {
    pushAll({ rows: [] })                           // candidate pool empty
    const res = await fetch(`${baseUrl}/api/dual-axis`)
    expect(res.status).toBe(200)
    const body = await res.json() as { count: number; items: unknown[] }
    expect(body.count).toBe(0)
    expect(body.items).toEqual([])
    expect(calls.length).toBe(1)                    // no facts/priors/aggregate query
  })

  it('5: batched aggregate query parameter is the array of candidate ids', async () => {
    const cos = fakeCompanies(4)
    pushAll(
      { rows: cos },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    )
    const res = await fetch(`${baseUrl}/api/dual-axis?pool=4&limit=4`)
    expect(res.status).toBe(200)
    const aggCall = calls.find(c =>
      /FROM send_events/i.test(c.sql) && /company_id\s*=\s*ANY/i.test(c.sql),
    )
    expect(aggCall).toBeDefined()
    expect(aggCall!.params?.[0]).toEqual(cos.map(c => c.id))
  })

  it('6: per-company facts query and engagement aggregate are issued in parallel (single-flight check)', async () => {
    // The handler awaits a Promise.all over (sectorPriors, engagementById)
    // after the facts query. Verify both end up in the call log even when
    // sector priors return empty.
    const cos = fakeCompanies(3)
    pushAll(
      { rows: cos },
      { rows: [{ company_id: 1, field: 'spf', value: 'pass' }] },  // facts present
      { rows: [] },                                                  // sector priors empty
      { rows: cos.map(c => ({                                        // engagement
        company_id: c.id, sent: 4, replied: 1, opened: 2, bounced: 0, sent_60d: 1,
      })) },
    )
    const res = await fetch(`${baseUrl}/api/dual-axis?pool=3&limit=3`)
    expect(res.status).toBe(200)
    const factsCall = calls.find(c => /FROM company_current_facts/i.test(c.sql))
    const engCall = calls.find(c =>
      /FROM send_events/i.test(c.sql) && /company_id\s*=\s*ANY/i.test(c.sql),
    )
    expect(factsCall).toBeDefined()
    expect(engCall).toBeDefined()
  })

  it('7: limit clamped to 500 (max), pool clamped to 500 (max)', async () => {
    pushAll({ rows: [] })                           // empty pool short-circuits
    const res = await fetch(`${baseUrl}/api/dual-axis?limit=99999&pool=99999`)
    expect(res.status).toBe(200)
    // First call is the candidate query; the LIMIT bind value is param $1.
    expect(calls[0].params?.[0]).toBe(500)
  })

  it('8: limit defaults to 50, pool defaults to 200', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/dual-axis`)
    expect(res.status).toBe(200)
    expect(calls[0].params?.[0]).toBe(200)
  })

  it('9: handler swallows aggregate-query failure → all companies get engagement_score=0', async () => {
    const cos = fakeCompanies(2)
    pushAll(
      { rows: cos },
      { rows: [] },
      { rows: [] },
      new Error('connection reset'),                // batched aggregate fails
    )
    const res = await fetch(`${baseUrl}/api/dual-axis?pool=2&limit=2`)
    expect(res.status).toBe(200)                    // must not 500
    const body = await res.json() as { items: Array<Record<string, unknown>> }
    expect(body.items.length).toBe(2)
    for (const it of body.items) {
      expect(Number.isFinite(it.dual_axis as number)).toBe(true)
    }
  })

  it('10: response items carry the locked shape', async () => {
    const cos = fakeCompanies(1)
    pushAll(
      { rows: cos },
      { rows: [] },
      { rows: [] },
      { rows: [{ company_id: 1, sent: 10, replied: 3, opened: 6, bounced: 1, sent_60d: 2 }] },
    )
    const res = await fetch(`${baseUrl}/api/dual-axis?pool=1&limit=1`)
    const body = await res.json() as { items: Array<Record<string, unknown>> }
    const item = body.items[0]
    for (const k of ['ico', 'name', 'sector', 'ev_score', 'propensity', 'size_proxy', 'readiness_score', 'dual_axis']) {
      expect(item, `missing ${k}`).toHaveProperty(k)
    }
  })
})
