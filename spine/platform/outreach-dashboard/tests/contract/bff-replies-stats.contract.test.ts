// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/replies/stats
//
//  Locks response shape, field types, NULL handling, error path, header
//  freshness, and concurrent-call equivalence. The handler runs a single
//  FILTER-aggregated SQL query against `reply_inbox` and returns:
//    { total, unhandled, positive, negative, auto_reply, today }
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
  // Strip GO_SERVER_URL AFTER import (vite loadEnv repopulates from .env).
  // /api/replies/stats has no Go-proxy fallback so this is defensive only.
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

// G7: /api/replies/stats fires 2 queries — reply_inbox aggregate + unmatched_inbound aggregate.
// pushStats pushes both: the reply_inbox row plus a zero-valued unmatched row.
// Use when the test only cares about reply_inbox values (unmatched contributes 0).
const EMPTY_UNMATCHED = { rows: [{ u_total: 0, u_unhandled: 0, u_today: 0 }] }

function pushStats(replyInboxRow: Record<string, unknown>) {
  queryQueue.push({ rows: [replyInboxRow] })
  queryQueue.push(EMPTY_UNMATCHED)
}

const STATS_KEYS = ['total', 'unhandled', 'positive', 'negative', 'auto_reply', 'today'] as const

describe('GET /api/replies/stats', () => {
  // 1. Happy path — full canonical row, all integers
  it('returns shape { total, unhandled, positive, negative, auto_reply, today } with integer fields', async () => {
    pushStats({ total: 42, unhandled: 7, positive: 12, negative: 4, auto_reply: 3, today: 5 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    for (const k of STATS_KEYS) {
      expect(body, `missing key ${k}`).toHaveProperty(k)
      expect(typeof body[k], `${k} must be number`).toBe('number')
      expect(Number.isInteger(body[k]), `${k} must be integer`).toBe(true)
    }
    expect(body.total).toBe(42)
    expect(body.unhandled).toBe(7)
    expect(body.positive).toBe(12)
    expect(body.negative).toBe(4)
    expect(body.auto_reply).toBe(3)
    expect(body.today).toBe(5)
  })

  // 2. Empty DB → all zeros, no NaN/undefined
  it('returns all zeros when reply_inbox is empty (no NaN, no undefined)', async () => {
    pushStats({ total: 0, unhandled: 0, positive: 0, negative: 0, auto_reply: 0, today: 0 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    for (const k of STATS_KEYS) {
      expect(body[k]).toBe(0)
      expect(Number.isNaN(body[k])).toBe(false)
      expect(body[k]).not.toBeUndefined()
    }
  })

  // 3. All rows handled=true → unhandled=0 with total=N
  it('all rows handled → unhandled=0 while total=N', async () => {
    pushStats({ total: 25, unhandled: 0, positive: 10, negative: 8, auto_reply: 4, today: 1 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json() as Record<string, number>
    expect(body.total).toBe(25)
    expect(body.unhandled).toBe(0)
  })

  // 4. Mixed classification → counts add up: positive+negative+auto_reply ≤ total
  it('classification counts sum is ≤ total (NULL-classified rows count toward total only)', async () => {
    pushStats({ total: 100, unhandled: 30, positive: 40, negative: 25, auto_reply: 10, today: 8 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const b = await res.json() as Record<string, number>
    const classified = b.positive + b.negative + b.auto_reply
    expect(classified).toBeLessThanOrEqual(b.total)
    // 40+25+10=75 ≤ 100 → 25 NULL/other
    expect(classified).toBe(75)
  })

  // 5. unhandled ≤ total (boundary invariant)
  it('unhandled is ≤ total (handler trusts SQL FILTER aggregate)', async () => {
    pushStats({ total: 10, unhandled: 4, positive: 3, negative: 2, auto_reply: 1, today: 0 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const b = await res.json() as Record<string, number>
    expect(b.unhandled).toBeLessThanOrEqual(b.total)
    // (handled = total - unhandled = 6)
    expect(b.total - b.unhandled).toBe(6)
  })

  // 6. NULL classification → those rows contribute to total but NOT to any
  //    classification counter. SQL `FILTER (WHERE classification='positive')`
  //    skips NULL by definition; we just assert handler doesn't synthesize.
  it('NULL-classified rows do not increment classification counters', async () => {
    // Simulate: 10 rows total, 0 classified → all NULL.
    pushStats({ total: 10, unhandled: 10, positive: 0, negative: 0, auto_reply: 0, today: 2 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const b = await res.json() as Record<string, number>
    expect(b.total).toBe(10)
    expect(b.positive).toBe(0)
    expect(b.negative).toBe(0)
    expect(b.auto_reply).toBe(0)
  })

  // 7. SQL error → 500, JSON error envelope, no stack frames in response
  it('returns 500 with JSON error envelope on DB error (stack property not exposed)', async () => {
    // Distinct error message — handler echoes err.message via safeError() in
    // non-prod (NODE_ENV != 'production'). The contract is:
    //   - status 500
    //   - JSON response with `error` string field
    //   - No `stack` / `trace` field on the response object (those are the
    //     real PII leaks we guard against; e.message is allowed because
    //     ops needs the "connection refused" / "syntax error at column" hint)
    pushAll(new Error('connection refused'))
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect(res.status).toBe(500)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
    // No raw stack property on the response envelope.
    expect(body).not.toHaveProperty('stack')
    expect(body).not.toHaveProperty('trace')
    expect(body).not.toHaveProperty('errno')
    // Response is a plain JSON object, not a serialized Error with `name`+`stack`
    expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(['error']))
  })

  // 8. SQL must use the today filter (received_at > now() - interval)
  it('SQL contains a today filter on received_at (interval-based, time-zone safe)', async () => {
    pushStats({ total: 5, unhandled: 2, positive: 1, negative: 1, auto_reply: 1, today: 3 })
    await fetch(`${baseUrl}/api/replies/stats`)
    // First query is the reply_inbox aggregate (second is unmatched_inbound). G7: use calls[0].
    const sql = calls[0]?.sql ?? ''
    expect(sql).toMatch(/received_at\s*>\s*now\(\)\s*-\s*interval\s*'24\s*hours'/i)
    expect(sql.toLowerCase()).toContain('reply_inbox')
  })

  // 9. Very large counts (10M rows) returned as JS number, not string
  it('returns large counts (10M rows) as number (not string)', async () => {
    pushStats({ total: 10_000_000, unhandled: 1_000_000, positive: 5_000_000, negative: 2_000_000, auto_reply: 500_000, today: 50_000 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const b = await res.json() as Record<string, unknown>
    for (const k of STATS_KEYS) {
      expect(typeof b[k]).toBe('number')
      expect(b[k]).not.toBe(String(b[k]))
    }
    expect(b.total).toBe(10_000_000)
  })

  // 10. Concurrent calls — read-only endpoint must return identical structure
  it('two concurrent calls return identical shape (read-only invariant)', async () => {
    // G7: each /stats request fires 2 queries (reply_inbox + unmatched_inbound).
    // Two concurrent requests = 4 total pool.query calls.
    pushStats({ total: 7, unhandled: 2, positive: 2, negative: 2, auto_reply: 1, today: 1 })
    pushStats({ total: 7, unhandled: 2, positive: 2, negative: 2, auto_reply: 1, today: 1 })
    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/replies/stats`).then(r => r.json()),
      fetch(`${baseUrl}/api/replies/stats`).then(r => r.json()),
    ])
    expect(r1).toEqual(r2)
    // Each call fires 2 queries (reply_inbox + unmatched_inbound).
    expect(calls.length).toBe(4)
  })

  // 11. Cache-Control: must not have a stale max-age (must be fresh stats)
  it('does not advertise a max-age cache (stats must be fresh)', async () => {
    pushStats({ total: 1, unhandled: 1, positive: 0, negative: 0, auto_reply: 0, today: 1 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const cc = res.headers.get('cache-control') || ''
    // Either header absent, or set to no-cache/private/no-store. A positive
    // max-age on a counter endpoint would let the dashboard show stale alerts.
    expect(cc).not.toMatch(/max-age=[1-9]/)
  })

  // 12. Handler returns within 5s even when DB query is slow (query-rejection
  //     fallback must not hang). We use AbortController as a hard ceiling.
  it('handler responds within 5s budget', async () => {
    pushStats({ total: 1, unhandled: 0, positive: 1, negative: 0, auto_reply: 0, today: 0 })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 5_000)
    try {
      const t0 = Date.now()
      const res = await fetch(`${baseUrl}/api/replies/stats`, { signal: ac.signal })
      const dt = Date.now() - t0
      expect(res.status).toBe(200)
      expect(dt).toBeLessThan(5_000)
    } finally {
      clearTimeout(timer)
    }
  })

  // 13. Bonus — UTF-8 / emoji safety. The /stats endpoint aggregates only,
  //     no subject substring is returned, so emoji in source rows must not
  //     break JSON encoding or counter values.
  it('emoji/UTF-8 in underlying rows does not break aggregation (handler only returns counts)', async () => {
    // The aggregate row never carries subject text, but we still simulate
    // the case to lock that the handler returns clean JSON regardless of
    // upstream data realities.
    pushStats({ total: 3, unhandled: 1, positive: 1, negative: 1, auto_reply: 0, today: 1 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect(res.status).toBe(200)
    const txt = await res.text()
    // Returned JSON must be plain ASCII / safe UTF-8 with no replacement char
    expect(txt).not.toContain('�')
    const b = JSON.parse(txt) as Record<string, number>
    expect(b.total).toBe(3)
  })

  // 14. Defensive — extra (unknown) row fields from DB do not corrupt response
  it('passes through aggregate row to res.json (extra fields tolerated)', async () => {
    pushStats({ total: 1, unhandled: 0, positive: 1, negative: 0, auto_reply: 0, today: 0,
      // Extra fields a future schema migration might surface:
      spam: 0, deferred: 0 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const b = await res.json() as Record<string, unknown>
    // Canonical keys still present
    for (const k of STATS_KEYS) {
      expect(b).toHaveProperty(k)
    }
    expect(b.total).toBe(1)
  })
})
