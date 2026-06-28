// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/dedup-guard/* (#824)
//
//  Locks the request/response shape for all three dedup-guard operator routes:
//    GET /api/dedup-guard/stats
//    GET /api/dedup-guard/segment-funnel?id=N
//    GET /api/dedup-guard/recent-skips?limit=N
//
//  Handler lives in: features/platform/outreach-dashboard/src/server-routes/dedupGuard.js
//  Mounted via:      mountDedupGuardRoutes(app, { pool, ... })
//
//  Issue: #824
//
//  Tests (21):
//    stats (7):
//      1.  Auth missing → 401
//      2.  Happy path → 200 + all 8 axes present with correct counts
//      3.  Zero state (all axes 0) → 200 + total_skipped=0
//      4.  DB error → 500 + error message
//      5.  Single-axis dominating → only that axis non-zero
//      6.  All 8 axis keys always present in response (even zero)
//      7.  total_skipped = sum of all axis counts
//
//    segment-funnel (7):
//      8.  Auth missing → 401
//      9.  Missing id param → 400
//     10.  Non-numeric id param → 400
//     11.  Happy path → 200 + correct funnel shape with all steps
//     12.  Segment with all contacts eligible → eligible = total
//     13.  Segment where all contacts hit DNT (funnel drops at step 1)
//     14.  DB error → 500 + error message
//
//    recent-skips (7):
//     15.  Auth missing → 401
//     16.  Happy path default limit → 200 + correct shape
//     17.  Empty result set → 200 + count=0, skips=[]
//     18.  limit param respected in SQL call
//     19.  limit > 500 clamped to 500
//     20.  limit=0 falls back to default 100 (parseInt('0') falsy → || 100)
//     21.  DB error → 500 + error message
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

const API_KEY = 'test-dedup-guard-api-key-xxx'
let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY', 'BFF_AUTH_DISABLED']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.OUTREACH_API_KEY = API_KEY
  vi.resetModules()
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
  // Re-enable auth per-test (individual tests that test 401 will delete it)
  process.env.OUTREACH_API_KEY = API_KEY
  delete process.env.BFF_AUTH_DISABLED
})

/** Enqueue a successful query result */
function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

/** Enqueue a DB error for the next pool.query() call */
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
}

/** GET helper — sends request with valid API key by default */
async function get(path: string, opts: { withAuth?: boolean } = { withAuth: true }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.withAuth) headers['x-api-key'] = API_KEY
  const r = await fetch(baseUrl + path, { method: 'GET', headers })
  const text = await r.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

// ─── Helpers to build mock stats rows ────────────────────────────────────────

/** Returns a stats query row with the given per-axis counts */
function statsRow(overrides: Record<string, number> = {}) {
  return {
    dnt: 0,
    lifetime_exhausted: 0,
    cross_campaign_cooldown: 0,
    per_domain_cooldown: 0,
    bounce_cluster: 0,
    region_rate_limit: 0,
    engagement_decay: 0,
    crm_active_client: 0,
    ...overrides,
  }
}

const ALL_8_AXES = [
  'dnt',
  'lifetime_exhausted',
  'cross_campaign_cooldown',
  'per_domain_cooldown',
  'bounce_cluster',
  'region_rate_limit',
  'engagement_decay',
  'crm_active_client',
] as const

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/dedup-guard/stats
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/dedup-guard/stats', () => {

  // ── 1. Auth missing ───────────────────────────────────────────────────────
  it('1: no X-API-Key → 401', async () => {
    const { status } = await get('/api/dedup-guard/stats', { withAuth: false })
    expect(status).toBe(401)
  })

  // ── 2. Happy path — multi-axis counts ────────────────────────────────────
  it('2: happy path → 200 + all 8 axes with correct counts', async () => {
    q([statsRow({
      dnt: 12,
      lifetime_exhausted: 5,
      cross_campaign_cooldown: 3,
      per_domain_cooldown: 7,
      bounce_cluster: 2,
      region_rate_limit: 0,
      engagement_decay: 4,
      crm_active_client: 1,
    })])
    const { status, body } = await get('/api/dedup-guard/stats')
    expect(status).toBe(200)
    const b = body as { axes: Record<string, number>; total_skipped: number }
    expect(b.axes.dnt).toBe(12)
    expect(b.axes.lifetime_exhausted).toBe(5)
    expect(b.axes.cross_campaign_cooldown).toBe(3)
    expect(b.axes.per_domain_cooldown).toBe(7)
    expect(b.axes.bounce_cluster).toBe(2)
    expect(b.axes.region_rate_limit).toBe(0)
    expect(b.axes.engagement_decay).toBe(4)
    expect(b.axes.crm_active_client).toBe(1)
    // total_skipped must be the sum
    expect(b.total_skipped).toBe(12 + 5 + 3 + 7 + 2 + 0 + 4 + 1)
  })

  // ── 3. Zero state — no skips anywhere ────────────────────────────────────
  it('3: zero state → 200 + all axes 0 + total_skipped=0', async () => {
    q([statsRow()])
    const { status, body } = await get('/api/dedup-guard/stats')
    expect(status).toBe(200)
    const b = body as { axes: Record<string, number>; total_skipped: number }
    for (const axis of ALL_8_AXES) {
      expect(b.axes[axis]).toBe(0)
    }
    expect(b.total_skipped).toBe(0)
  })

  // ── 4. DB error → 500 ────────────────────────────────────────────────────
  it('4: pool.query throws → 500 + error field', async () => {
    qErr('stats db connection error')
    const { status, body } = await get('/api/dedup-guard/stats')
    expect(status).toBe(500)
    expect((body as { error: string }).error).toBeTruthy()
  })

  // ── 5. Single-axis dominating ─────────────────────────────────────────────
  it('5: only bounce_cluster non-zero → all other axes 0', async () => {
    q([statsRow({ bounce_cluster: 99 })])
    const { status, body } = await get('/api/dedup-guard/stats')
    expect(status).toBe(200)
    const b = body as { axes: Record<string, number>; total_skipped: number }
    expect(b.axes.bounce_cluster).toBe(99)
    expect(b.total_skipped).toBe(99)
    // All other axes must be 0
    for (const axis of ALL_8_AXES.filter(a => a !== 'bounce_cluster')) {
      expect(b.axes[axis]).toBe(0)
    }
  })

  // ── 6. All 8 axis keys always present in response ─────────────────────────
  it('6: all 8 axis keys always present even with partial data', async () => {
    // Return only some columns set — handler should still have all 8 keys
    q([{ dnt: 5 }])
    const { status, body } = await get('/api/dedup-guard/stats')
    expect(status).toBe(200)
    const b = body as { axes: Record<string, number> }
    for (const axis of ALL_8_AXES) {
      expect(b.axes).toHaveProperty(axis)
      expect(typeof b.axes[axis]).toBe('number')
    }
  })

  // ── 7. total_skipped equals sum of axes ───────────────────────────────────
  it('7: total_skipped equals arithmetic sum of all axis counts', async () => {
    const counts = { dnt: 3, lifetime_exhausted: 2, cross_campaign_cooldown: 1,
      per_domain_cooldown: 0, bounce_cluster: 10, region_rate_limit: 5,
      engagement_decay: 0, crm_active_client: 7 }
    q([statsRow(counts)])
    const { status, body } = await get('/api/dedup-guard/stats')
    expect(status).toBe(200)
    const b = body as { total_skipped: number }
    const expected = Object.values(counts).reduce((a, c) => a + c, 0)
    expect(b.total_skipped).toBe(expected)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/dedup-guard/segment-funnel
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/dedup-guard/segment-funnel', () => {

  // ── 8. Auth missing ───────────────────────────────────────────────────────
  it('8: no X-API-Key → 401', async () => {
    const { status } = await get('/api/dedup-guard/segment-funnel?id=1', { withAuth: false })
    expect(status).toBe(401)
  })

  // ── 9. Missing id param → 400 ─────────────────────────────────────────────
  it('9: missing id param → 400 + error mentions segment id', async () => {
    const { status, body } = await get('/api/dedup-guard/segment-funnel')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/segment/i)
  })

  // ── 10. Non-numeric id → 400 ──────────────────────────────────────────────
  it('10: non-numeric id → 400', async () => {
    const { status, body } = await get('/api/dedup-guard/segment-funnel?id=abc')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/segment/i)
  })

  // ── 11. Happy path ────────────────────────────────────────────────────────
  it('11: happy path → 200 + correct funnel shape with all steps', async () => {
    q([{
      total: '500',
      after_dnt: '450',
      after_lifetime: '420',
      after_cooldown: '400',
      after_crm: '380',
    }])
    const { status, body } = await get('/api/dedup-guard/segment-funnel?id=7')
    expect(status).toBe(200)
    const b = body as {
      segment_id: number
      total: number
      after_dnt_filter: number
      after_lifetime_filter: number
      after_cooldown_filters: number
      after_crm_filters: number
      eligible: number
    }
    expect(b.segment_id).toBe(7)
    expect(b.total).toBe(500)
    expect(b.after_dnt_filter).toBe(450)
    expect(b.after_lifetime_filter).toBe(420)
    expect(b.after_cooldown_filters).toBe(400)
    expect(b.after_crm_filters).toBe(380)
    expect(b.eligible).toBe(380)
    // Verify SQL was called with the segment ID
    const funnelCall = calls.find(c => c.sql.includes('seg_contacts'))
    expect(funnelCall).toBeDefined()
    expect(funnelCall?.params?.[0]).toBe(7)
  })

  // ── 12. All contacts eligible ──────────────────────────────────────────────
  it('12: segment with all contacts eligible → eligible = total', async () => {
    q([{
      total: '200',
      after_dnt: '200',
      after_lifetime: '200',
      after_cooldown: '200',
      after_crm: '200',
    }])
    const { status, body } = await get('/api/dedup-guard/segment-funnel?id=3')
    expect(status).toBe(200)
    const b = body as { total: number; eligible: number }
    expect(b.total).toBe(200)
    expect(b.eligible).toBe(200)
  })

  // ── 13. All contacts hit DNT — funnel drops at step 1 ─────────────────────
  it('13: all contacts hit DNT → after_dnt_filter=0, eligible=0', async () => {
    q([{
      total: '100',
      after_dnt: '0',
      after_lifetime: '0',
      after_cooldown: '0',
      after_crm: '0',
    }])
    const { status, body } = await get('/api/dedup-guard/segment-funnel?id=5')
    expect(status).toBe(200)
    const b = body as {
      total: number
      after_dnt_filter: number
      after_lifetime_filter: number
      after_cooldown_filters: number
      after_crm_filters: number
      eligible: number
    }
    expect(b.total).toBe(100)
    expect(b.after_dnt_filter).toBe(0)
    expect(b.after_lifetime_filter).toBe(0)
    expect(b.after_cooldown_filters).toBe(0)
    expect(b.after_crm_filters).toBe(0)
    expect(b.eligible).toBe(0)
  })

  // ── 14. DB error → 500 ───────────────────────────────────────────────────
  it('14: pool.query throws → 500 + error field', async () => {
    qErr('segment funnel db error')
    const { status, body } = await get('/api/dedup-guard/segment-funnel?id=99')
    expect(status).toBe(500)
    expect((body as { error: string }).error).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/dedup-guard/recent-skips
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/dedup-guard/recent-skips', () => {

  const SKIP_ROW = (overrides: Record<string, unknown> = {}) => ({
    contact_skip_id: 1,
    campaign_id: 10,
    contact_id: 42,
    status: 'skipped',
    skip_reason: 'dnt_set',
    skipped_at: '2026-05-05T12:00:00.000Z',
    ...overrides,
  })

  // ── 15. Auth missing ──────────────────────────────────────────────────────
  it('15: no X-API-Key → 401', async () => {
    const { status } = await get('/api/dedup-guard/recent-skips', { withAuth: false })
    expect(status).toBe(401)
  })

  // ── 16. Happy path with default limit ────────────────────────────────────
  it('16: happy path → 200 + correct response shape', async () => {
    const rows = [
      SKIP_ROW({ contact_skip_id: 1, campaign_id: 5, skip_reason: 'dnt_set' }),
      SKIP_ROW({ contact_skip_id: 2, campaign_id: 6, skip_reason: 'bounce_cluster' }),
    ]
    q(rows)
    const { status, body } = await get('/api/dedup-guard/recent-skips')
    expect(status).toBe(200)
    const b = body as {
      limit: number
      count: number
      skips: Array<{
        id: unknown
        campaign_id: unknown
        contact_id: unknown
        reason: string
        skipped_at: unknown
      }>
    }
    expect(b.count).toBe(2)
    expect(Array.isArray(b.skips)).toBe(true)
    expect(b.skips).toHaveLength(2)
    expect(b.skips[0].reason).toBe('dnt_set')
    expect(b.skips[1].reason).toBe('bounce_cluster')
    // PII check: no email field on skip items
    for (const skip of b.skips) {
      expect(skip).not.toHaveProperty('email')
    }
  })

  // ── 17. Empty result set ──────────────────────────────────────────────────
  it('17: no skips in DB → 200 + count=0, skips=[]', async () => {
    q([])
    const { status, body } = await get('/api/dedup-guard/recent-skips')
    expect(status).toBe(200)
    const b = body as { count: number; skips: unknown[] }
    expect(b.count).toBe(0)
    expect(b.skips).toEqual([])
  })

  // ── 18. limit param is forwarded to SQL ───────────────────────────────────
  it('18: explicit limit param is passed to SQL query', async () => {
    q([SKIP_ROW()])
    await get('/api/dedup-guard/recent-skips?limit=20')
    const skipCall = calls.find(c => c.sql.includes('campaign_contacts'))
    expect(skipCall).toBeDefined()
    expect(skipCall?.params?.[0]).toBe(20)
  })

  // ── 19. limit > 500 clamped to 500 ───────────────────────────────────────
  it('19: limit=9999 → clamped to 500 in SQL', async () => {
    q([])
    const { status, body } = await get('/api/dedup-guard/recent-skips?limit=9999')
    expect(status).toBe(200)
    const b = body as { limit: number }
    expect(b.limit).toBe(500)
    const skipCall = calls.find(c => c.sql.includes('campaign_contacts'))
    expect(skipCall?.params?.[0]).toBe(500)
  })

  // ── 20. limit=0 falls back to default 100 ────────────────────────────────
  //
  // NOTE: The handler uses `parseInt(req.query.limit) || 100` before clamping.
  // parseInt('0') === 0 which is falsy, so || 100 kicks in → effective limit=100.
  // This is a known handler quirk: limit=0 is treated as "not provided".
  // TODO(#824): Consider whether limit=0 should explicitly return 400 or clamp to 1;
  //             for now we lock the current behaviour so regressions are caught.
  it('20: limit=0 → handler treats as unset → defaults to 100', async () => {
    q([])
    const { status, body } = await get('/api/dedup-guard/recent-skips?limit=0')
    expect(status).toBe(200)
    const b = body as { limit: number }
    // parseInt('0') is falsy → || 100 applies → clamp(100, 1, 500) = 100
    expect(b.limit).toBe(100)
    const skipCall = calls.find(c => c.sql.includes('campaign_contacts'))
    expect(skipCall?.params?.[0]).toBe(100)
  })

  // ── 21. DB error → 500 ───────────────────────────────────────────────────
  it('21: pool.query throws → 500 + error field', async () => {
    qErr('recent-skips db timeout')
    const { status, body } = await get('/api/dedup-guard/recent-skips')
    expect(status).toBe(500)
    expect((body as { error: string }).error).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/dedup-guard/stats?window= (hardening 2026-05-05)
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/dedup-guard/stats — time-window filter', () => {

  // ── 22. Default (no window param) returns window="all" in response ────────
  it('22: no window param → response includes window="all"', async () => {
    q([{ dnt: 5, lifetime_exhausted: 0, cross_campaign_cooldown: 0,
         per_domain_cooldown: 0, bounce_cluster: 0, region_rate_limit: 0,
         engagement_decay: 0, crm_active_client: 0 }])
    const { status, body } = await get('/api/dedup-guard/stats')
    expect(status).toBe(200)
    const b = body as { window: string }
    expect(b.window).toBe('all')
  })

  // ── 23. Invalid window param → 400 ───────────────────────────────────────
  it('23: invalid window param → 400 + error message', async () => {
    const { status, body } = await get('/api/dedup-guard/stats?window=invalid')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/window/)
  })

  // ── 24. window=24h → response includes window="24h" ──────────────────────
  it('24: window=24h → response includes window="24h"', async () => {
    q([{ dnt: 2, lifetime_exhausted: 0, cross_campaign_cooldown: 0,
         per_domain_cooldown: 0, bounce_cluster: 0, region_rate_limit: 0,
         engagement_decay: 0, crm_active_client: 0 }])
    const { status, body } = await get('/api/dedup-guard/stats?window=24h')
    expect(status).toBe(200)
    const b = body as { window: string }
    expect(b.window).toBe('24h')
  })

  // ── 25. window=7d → response includes window="7d" ────────────────────────
  it('25: window=7d → response includes window="7d"', async () => {
    q([{ dnt: 0, lifetime_exhausted: 0, cross_campaign_cooldown: 0,
         per_domain_cooldown: 0, bounce_cluster: 0, region_rate_limit: 0,
         engagement_decay: 0, crm_active_client: 0 }])
    const { status, body } = await get('/api/dedup-guard/stats?window=7d')
    expect(status).toBe(200)
    const b = body as { window: string }
    expect(b.window).toBe('7d')
  })

  // ── 26. window=30d → valid response ──────────────────────────────────────
  it('26: window=30d → 200 + valid response', async () => {
    q([{ dnt: 100, lifetime_exhausted: 0, cross_campaign_cooldown: 0,
         per_domain_cooldown: 0, bounce_cluster: 0, region_rate_limit: 0,
         engagement_decay: 0, crm_active_client: 0 }])
    const { status, body } = await get('/api/dedup-guard/stats?window=30d')
    expect(status).toBe(200)
    const b = body as { axes: Record<string, number>; window: string }
    expect(b.window).toBe('30d')
    expect(b.axes.dnt).toBe(100)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/dedup-guard/contact-block-reason (hardening 2026-05-05)
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/dedup-guard/contact-block-reason', () => {

  const SKIP_ROW_FULL = (overrides: Record<string, unknown> = {}) => ({
    campaign_id: 10,
    skip_reason: 'dnt_set',
    skipped_at: '2026-05-05T12:00:00.000Z',
    company_name: 'TestFirma s.r.o.',
    domain: 'testfirma.cz',
    ...overrides,
  })

  const SUPPRESSION_ROW = (overrides: Record<string, unknown> = {}) => ({
    suppression_type: 'dnt',
    expires_at: null,
    created_at: '2026-05-01T10:00:00.000Z',
    ...overrides,
  })

  // ── 27. Auth missing → 401 ───────────────────────────────────────────────
  it('27: no X-API-Key → 401', async () => {
    const { status } = await get('/api/dedup-guard/contact-block-reason?id=42', { withAuth: false })
    expect(status).toBe(401)
  })

  // ── 28. Missing id → 400 ─────────────────────────────────────────────────
  it('28: missing id param → 400', async () => {
    const { status, body } = await get('/api/dedup-guard/contact-block-reason')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/contact id/)
  })

  // ── 29. id=0 → 400 (not a valid positive integer) ────────────────────────
  it('29: id=0 → 400', async () => {
    const { status } = await get('/api/dedup-guard/contact-block-reason?id=0')
    expect(status).toBe(400)
  })

  // ── 30. id=-1 → 400 ──────────────────────────────────────────────────────
  it('30: id=-1 → 400', async () => {
    const { status } = await get('/api/dedup-guard/contact-block-reason?id=-1')
    expect(status).toBe(400)
  })

  // ── 31. Non-numeric id → 400 ─────────────────────────────────────────────
  it('31: non-numeric id → 400', async () => {
    const { status } = await get('/api/dedup-guard/contact-block-reason?id=abc')
    expect(status).toBe(400)
  })

  // ── 32. Happy path → 200 + correct shape ─────────────────────────────────
  it('32: happy path → 200 + correct response shape', async () => {
    q([SKIP_ROW_FULL()])    // skip_history query
    q([SUPPRESSION_ROW()])  // active_suppressions query
    const { status, body } = await get('/api/dedup-guard/contact-block-reason?id=42')
    expect(status).toBe(200)
    const b = body as {
      contact_id: number
      company_name: string
      domain: string
      skip_history: Array<{ campaign_id: number; reason: string; skipped_at: string }>
      active_suppressions: Array<{ type: string; expires_at: unknown; created_at: string }>
    }
    expect(b.contact_id).toBe(42)
    expect(b.company_name).toBe('TestFirma s.r.o.')
    expect(b.domain).toBe('testfirma.cz')
    expect(Array.isArray(b.skip_history)).toBe(true)
    expect(Array.isArray(b.active_suppressions)).toBe(true)
    expect(b.skip_history[0].campaign_id).toBe(10)
    expect(b.skip_history[0].reason).toBe('dnt_set')
    expect(b.active_suppressions[0].type).toBe('dnt')
    // PII check: no email in response
    expect(JSON.stringify(b)).not.toMatch(/@/)
  })

  // ── 33. Contact with no blocks → empty arrays ─────────────────────────────
  it('33: contact with no skip records → empty skip_history + empty active_suppressions', async () => {
    q([])   // skip_history empty
    q([])   // active_suppressions empty
    const { status, body } = await get('/api/dedup-guard/contact-block-reason?id=99')
    expect(status).toBe(200)
    const b = body as {
      contact_id: number
      skip_history: unknown[]
      active_suppressions: unknown[]
    }
    expect(b.contact_id).toBe(99)
    expect(b.skip_history).toEqual([])
    expect(b.active_suppressions).toEqual([])
    expect(b.company_name).toBeNull()
  })

  // ── 34. DB error → 500 ───────────────────────────────────────────────────
  it('34: pool.query throws → 500 + error field', async () => {
    qErr('block-reason db timeout')
    const { status, body } = await get('/api/dedup-guard/contact-block-reason?id=1')
    expect(status).toBe(500)
    expect((body as { error: string }).error).toBeTruthy()
  })
})
