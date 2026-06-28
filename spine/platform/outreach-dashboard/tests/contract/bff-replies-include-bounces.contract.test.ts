// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/replies?include_bounces=…  (AJ-bounce 2026-05-18,
//  updated 2026-05-19 for AS-F1 server-side UNION ALL)
//
//  Default behaviour: hide unmatched_inbound rows with
//  classification IN ('bounce','corrupted_charset') from the operator's
//  /replies view. Opt-in: ?include_bounces=true (or =1) lifts the filter.
//
//  After AS-F1 the handler issues a SINGLE UNION ALL query (CTE
//  all_replies) wrapping both reply_inbox + unmatched_inbound arms, so
//  the row-shape regex now matches against one combined SQL blob — not
//  two separate queries. The count is a window-function inside the
//  outer SELECT (no second COUNT round-trip on hits; an extra count
//  fallback fires only when rows.length === 0).
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
  // AS-F1: /api/replies issues a single UNION ALL query. With rows.length===0
  // the handler also fires a count fallback. Pre-seed both with empty results
  // so the handler completes cleanly. Extra queued results are ignored.
  queryQueue.push({ rows: [] })
  queryQueue.push({ rows: [{ total: 0 }] })
})

// AS-F1 — find the single UNION ALL query containing the unmatched_inbound
// arm. After the rewrite there's exactly one /api/replies SQL call per
// request that references FROM unmatched_inbound (inside a CTE).
function findUnionQuery(): string | null {
  const c = calls.find(c =>
    /FROM\s+unmatched_inbound/i.test(c.sql) && /from_address/i.test(c.sql)
  )
  return c ? c.sql : null
}

describe('GET /api/replies?include_bounces=…', () => {
  it('default (no include_bounces): unmatched arm hides bounce + corrupted_charset', async () => {
    const res = await fetch(`${baseUrl}/api/replies`)
    expect(res.status).toBe(200)
    const sql = findUnionQuery()
    expect(sql).toBeTruthy()
    // AS-F1 default-view predicate hides BOTH bounce and corrupted_charset.
    expect(sql!).toMatch(/(?:u\.)?classification\s+IS\s+NULL\s+OR\s+(?:u\.)?classification\s+NOT\s+IN\s*\(\s*'bounce'\s*,\s*'corrupted_charset'\s*\)/i)
  })

  it('default: total derived from UNION ALL count window (matches list view)', async () => {
    await fetch(`${baseUrl}/api/replies`)
    const sql = findUnionQuery()
    expect(sql).toBeTruthy()
    // The outer SELECT exposes total_count from the same all_replies CTE.
    expect(sql!).toMatch(/WITH\s+all_replies/i)
    expect(sql!).toMatch(/SELECT\s+count\(\*\)\s+FROM\s+all_replies/i)
  })

  it('include_bounces=true: row query does NOT add the bounce filter', async () => {
    const res = await fetch(`${baseUrl}/api/replies?include_bounces=true`)
    expect(res.status).toBe(200)
    const sql = findUnionQuery()
    expect(sql).toBeTruthy()
    expect(sql!).not.toMatch(/NOT\s+IN\s*\(\s*'bounce'\s*,\s*'corrupted_charset'\s*\)/i)
  })

  it('include_bounces=1: same opt-in semantics as =true', async () => {
    const res = await fetch(`${baseUrl}/api/replies?include_bounces=1`)
    expect(res.status).toBe(200)
    const sql = findUnionQuery()
    expect(sql).toBeTruthy()
    expect(sql!).not.toMatch(/NOT\s+IN\s*\(\s*'bounce'\s*,\s*'corrupted_charset'\s*\)/i)
  })

  it('default + handled=false: both predicates appear in unmatched arm', async () => {
    await fetch(`${baseUrl}/api/replies?handled=false`)
    const sql = findUnionQuery()
    expect(sql).toBeTruthy()
    expect(sql!).toMatch(/u\.reviewed\s*=\s*FALSE/i)
    expect(sql!).toMatch(/(?:u\.)?classification\s+IS\s+NULL\s+OR\s+(?:u\.)?classification\s+NOT\s+IN\s*\(\s*'bounce'\s*,\s*'corrupted_charset'\s*\)/i)
  })

  it('row query selects classification column for UI use', async () => {
    await fetch(`${baseUrl}/api/replies`)
    const sql = findUnionQuery()
    expect(sql).toBeTruthy()
    expect(sql!).toMatch(/COALESCE\(u\.classification,\s*'unmatched'\)/i)
  })
})

describe('GET /api/replies/stats — AJ-bounce surface', () => {
  beforeEach(() => {
    // The stats endpoint fires two queries (reply_inbox + unmatched_inbound).
    // AS-F1 (2026-05-19) — unmatched_inbound aggregate now exposes
    //   u_total          → COUNT excluding bounce + corrupted_charset
    //   u_total_all      → raw COUNT(*) — backs the legacy `unmatched` key
    //   u_unhandled      → unhandled, excluding bounce + corrupted_charset
    //   u_today          → today, excluding bounce + corrupted_charset
    // The historical seed used `u_total` as the all-rows count; we now
    // explicitly seed both so the test stays unambiguous.
    queryQueue.length = 0
    calls.length = 0
    queryQueue.push({
      rows: [{
        total: 5, unhandled: 3, positive: 1, negative: 0,
        auto_reply: 0, today: 2,
      }],
    })
    queryQueue.push({
      rows: [{
        u_total: 26, u_total_all: 144,
        u_unhandled: 2, u_today: 26,
        u_bounces: 118, u_real: 26,
      }],
    })
  })

  it('exposes unmatched_real + unmatched_bounces alongside legacy unmatched', async () => {
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, number>
    // `unmatched` keeps its raw-count meaning (Bounces chip consumer).
    expect(body.unmatched).toBe(144)
    expect(body.unmatched_real).toBe(26)
    expect(body.unmatched_bounces).toBe(118)
    // AS-F1 — nezpracovane now excludes bounces so list+stats match.
    expect(body.nezpracovane).toBe(3 + 2)
  })
})
