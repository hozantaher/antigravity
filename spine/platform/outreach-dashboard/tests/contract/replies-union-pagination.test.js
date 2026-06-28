// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/replies UNION ALL pagination (AS-F1, 2026-05-19)
//
//  Locks the AS-F1 server-side UNION ALL rewrite. Pre-AS-F1 the handler
//  did two SELECTs (reply_inbox + unmatched_inbound) and merged client-
//  side, so:
//    - orphans were only included when offset===0 (page 2+ was empty)
//    - total only counted reply_inbox (mismatch with what list returned)
//
//  After AS-F1 the handler issues a single CTE-based UNION ALL query
//  with one ORDER BY + LIMIT/OFFSET, and total comes from a window
//  function (count(*) over the same all_replies CTE).
//
//  Schema verified 2026-05-19 via psql \d on PROD reply_inbox + unmatched_inbound.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const queryQueue = []
const calls = []

vi.mock('pg', () => {
  class Pool {
    async query(sql, params) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()
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
let server
const savedEnv = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  delete process.env.GO_SERVER_URL
  const { app } = mod
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

// Find the UNION/CTE query (or single-arm CTE when matched-only filters
// are active). Distinguishable by the WITH all_replies prefix.
function findMainQuery() {
  return calls.find((c) => /WITH\s+all_replies/i.test(c.sql)) || null
}

function makeRow(i, total) {
  return {
    id: i,
    send_event_id: null,
    campaign_id: null,
    contact_id: null,
    mailbox_id: null,
    from_email: `op${i}@example.com`,
    subject: `Subject ${i}`,
    classification: null,
    body_preview: null,
    received_at: '2026-05-18T12:00:00Z',
    handled: false,
    handled_at: null,
    campaign_name: 'Test',
    contact_name: '',
    crm_client_id: null,
    source: 'reply_inbox',
    total_count: total,
  }
}

describe('GET /api/replies — AS-F1 UNION ALL pagination', () => {
  it('offset=0 returns first page rows + total from window function', async () => {
    // Seed 30 rows, total_count=45 (15 more available on next page).
    const rows = Array.from({ length: 30 }, (_, i) => makeRow(i + 1, 45))
    queryQueue.push({ rows })
    const res = await fetch(`${baseUrl}/api/replies?handled=false&offset=0&limit=30`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows.length).toBe(30)
    expect(body.total).toBe(45)
    // total_count must not leak to the wire.
    for (const r of body.rows) {
      expect(r).not.toHaveProperty('total_count')
    }
  })

  it('offset=N (mid-list) returns next slice with same total — orphans present on page 2+', async () => {
    // Before AS-F1: offset=30 returned 0 rows because the JS merge only
    // included unmatched_inbound when offset===0. After AS-F1 the UNION
    // is paginated server-side and orphans ride along on every page.
    const page2 = Array.from({ length: 15 }, (_, i) => makeRow(i + 31, 45))
    queryQueue.push({ rows: page2 })
    const res = await fetch(`${baseUrl}/api/replies?handled=false&offset=30&limit=30`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows.length).toBe(15)
    expect(body.total).toBe(45)
  })

  it('offset > total returns 0 rows but still emits the canonical total via fallback count', async () => {
    // Main query returns empty (offset past total). Handler must fall
    // back to a COUNT-only re-query so the wire shape keeps total
    // truthful for the operator's UI pagination math.
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 45 }] })
    const res = await fetch(`${baseUrl}/api/replies?handled=false&offset=60&limit=30`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows.length).toBe(0)
    expect(body.total).toBe(45)
    // Two pool calls: main (empty) + count fallback.
    expect(calls.length).toBe(2)
  })

  it('main query uses WITH all_replies CTE + count window for total', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 0 }] })
    await fetch(`${baseUrl}/api/replies?handled=false`)
    const q = findMainQuery()
    expect(q).toBeTruthy()
    expect(q.sql).toMatch(/WITH\s+all_replies\s+AS/i)
    expect(q.sql).toMatch(/SELECT\s+count\(\*\)\s+FROM\s+all_replies/i)
    // Both arms are present in the default (no campaign_id) case.
    expect(q.sql).toMatch(/FROM\s+reply_inbox\s+r/i)
    expect(q.sql).toMatch(/FROM\s+unmatched_inbound\s+u/i)
    // ORDER BY + LIMIT + OFFSET applied OUTSIDE the CTE (single pagination).
    expect(q.sql).toMatch(/FROM\s+all_replies\s+ORDER\s+BY/i)
    expect(q.sql).toMatch(/LIMIT\s+\$\d+\s+OFFSET\s+\$\d+/i)
  })

  it('campaign_id filter skips the unmatched_inbound arm (matched-only)', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 0 }] })
    await fetch(`${baseUrl}/api/replies?campaign_id=42`)
    const q = findMainQuery()
    expect(q).toBeTruthy()
    expect(q.sql).toMatch(/FROM\s+reply_inbox\s+r/i)
    // Orphan arm absent.
    expect(q.sql).not.toMatch(/FROM\s+unmatched_inbound/i)
    // campaign_id param honored on reply arm.
    expect(q.sql).toMatch(/r\.campaign_id\s*=\s*\$\d+/i)
    // 42 lives in the params array.
    expect((q.params || []).some((p) => p === 42)).toBe(true)
  })

  it('company_icos filter also skips the unmatched arm (matched-only)', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 0 }] })
    await fetch(`${baseUrl}/api/replies?company_icos=12345678,87654321`)
    const q = findMainQuery()
    expect(q).toBeTruthy()
    expect(q.sql).not.toMatch(/FROM\s+unmatched_inbound/i)
    expect(q.sql).toMatch(/ct\.ico\s*=\s*ANY\(\$\d+\)/i)
  })

  it('include_bounces=true lifts the bounce filter from BOTH arms', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 0 }] })
    await fetch(`${baseUrl}/api/replies?include_bounces=true`)
    const q = findMainQuery()
    expect(q).toBeTruthy()
    // Neither arm should carry the default-view exclusion.
    expect(q.sql).not.toMatch(/NOT\s+IN\s*\(\s*'bounce'\s*,\s*'corrupted_charset'\s*\)/i)
    // Both arms still present (not a matched-only filter).
    expect(q.sql).toMatch(/FROM\s+reply_inbox\s+r/i)
    expect(q.sql).toMatch(/FROM\s+unmatched_inbound\s+u/i)
  })

  it('text search q applies to both arms with their native columns', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 0 }] })
    await fetch(`${baseUrl}/api/replies?q=traktor`)
    const q = findMainQuery()
    expect(q).toBeTruthy()
    // Reply arm uses r.subject / r.from_email; unmatched arm uses
    // u.subject / u.from_address.
    expect(q.sql).toMatch(/r\.subject\s+ILIKE/i)
    expect(q.sql).toMatch(/r\.from_email\s+ILIKE/i)
    expect(q.sql).toMatch(/u\.subject\s+ILIKE/i)
    expect(q.sql).toMatch(/u\.from_address\s+ILIKE/i)
  })

  it('response shape preserves { rows, total } contract — no extra keys', async () => {
    queryQueue.push({ rows: [makeRow(1, 1)] })
    const res = await fetch(`${baseUrl}/api/replies`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['rows', 'total'])
  })

  it('has_phone=true filters the reply arm on mined->phones, FALSE on unmatched (#1578 M1)', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 0 }] })
    await fetch(`${baseUrl}/api/replies?has_phone=true`)
    const q = findMainQuery()
    expect(q).toBeTruthy()
    // Reply arm: jsonb_array_length on the persisted mined.phones bundle.
    expect(q.sql).toMatch(/jsonb_array_length\(r\.mined->'phones'\)\s*>\s*0/i)
    // Both arms still present (not a matched-only filter), but the unmatched
    // arm can never satisfy a mined filter → narrowed to FALSE.
    expect(q.sql).toMatch(/FROM\s+reply_inbox\s+r/i)
    expect(q.sql).toMatch(/FROM\s+unmatched_inbound\s+u/i)
  })

  it('callback=true / urgent=true filter the reply arm on mined intent flags (#1578 M1)', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 0 }] })
    await fetch(`${baseUrl}/api/replies?callback=true&urgent=true`)
    const q = findMainQuery()
    expect(q).toBeTruthy()
    expect(q.sql).toMatch(/\(r\.mined->>'callback'\)::bool\s+IS\s+TRUE/i)
    expect(q.sql).toMatch(/\(r\.mined->>'urgent'\)::bool\s+IS\s+TRUE/i)
  })

  it('mined column is selected in BOTH arms (r.mined + NULL::jsonb) (#1578 M1)', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ total: 0 }] })
    await fetch(`${baseUrl}/api/replies?handled=false`)
    const q = findMainQuery()
    expect(q).toBeTruthy()
    expect(q.sql).toMatch(/r\.mined/i)
    expect(q.sql).toMatch(/NULL::jsonb\s+AS\s+mined/i)
  })

  it('sort=received|sender|campaign|classification maps to canonical CTE columns', async () => {
    for (const k of ['received', 'sender', 'campaign', 'classification']) {
      queryQueue.length = 0
      calls.length = 0
      queryQueue.push({ rows: [] })
      queryQueue.push({ rows: [{ total: 0 }] })
      // eslint-disable-next-line no-await-in-loop
      await fetch(`${baseUrl}/api/replies?sort=${k}&dir=asc`)
      const q = findMainQuery()
      expect(q, `missing main query for sort=${k}`).toBeTruthy()
      expect(q.sql).toMatch(/FROM\s+all_replies\s+ORDER\s+BY/i)
      expect(q.sql).toMatch(/\bASC\b/)
    }
  })
})
