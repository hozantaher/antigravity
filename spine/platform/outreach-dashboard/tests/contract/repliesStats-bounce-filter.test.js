// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/replies/stats `nezpracovane` consistency
//  (AS-F1, 2026-05-19)
//
//  Pre-AS-F1 the canonical /api/replies/stats handler (repliesStats.js)
//  counted `unhandled` as `COUNT(*) FILTER (WHERE NOT handled)` across the
//  raw reply_inbox + unmatched_inbound rows — including bounces. The
//  default /api/replies list view, meanwhile, excludes bounces +
//  corrupted_charset rows, so operator saw nezpracovane=166 while the
//  list reported total=45.
//
//  This contract test pins that `nezpracovane` (and the underlying
//  English `unhandled` key) now apply the SAME bounce filter the default
//  list view uses. The canonical handler is `mountRepliesStatsRoute`
//  registered FIRST in server.js (AM-F3) so it wins over the fallback
//  in replies.js.
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

describe('GET /api/replies/stats — AS-F1 bounce filter parity', () => {
  it('reply_inbox aggregate uses bounce + corrupted_charset filter on unhandled/total/today', async () => {
    queryQueue.push({ rows: [{ total: 5, unhandled: 3, positive: 1, negative: 0, auto_reply: 0, question: 0, today: 1, cekaji: 0 }] })
    queryQueue.push({ rows: [{ u_total: 0, u_unhandled: 0, u_today: 0, u_bounces: 0, u_real: 0, u_total_all: 0, u_cekaji: 0 }] })
    await fetch(`${baseUrl}/api/replies/stats`)
    const replySql = (calls[0]?.sql || '').toLowerCase()
    expect(replySql).toContain('reply_inbox')
    // unhandled filter must include the bounce + corrupted_charset exclusion
    expect(calls[0].sql).toMatch(/where\s+not\s+handled\s+and\s+\(classification\s+is\s+null\s+or\s+classification\s+not\s+in\s*\(\s*'bounce'\s*,\s*'corrupted_charset'\s*\)\s*\)/is)
    // total + today also gated by the same predicate
    expect(calls[0].sql).toMatch(/AS\s+total/i)
    expect(calls[0].sql).toMatch(/AS\s+today/i)
  })

  it('unmatched_inbound aggregate uses bounce + corrupted_charset filter on u_unhandled/u_total/u_today', async () => {
    queryQueue.push({ rows: [{ total: 0, unhandled: 0, positive: 0, negative: 0, auto_reply: 0, question: 0, today: 0, cekaji: 0 }] })
    queryQueue.push({ rows: [{ u_total: 0, u_unhandled: 0, u_today: 0, u_bounces: 0, u_real: 0, u_total_all: 0, u_cekaji: 0 }] })
    await fetch(`${baseUrl}/api/replies/stats`)
    const umSql = calls[1]?.sql || ''
    expect(umSql.toLowerCase()).toContain('unmatched_inbound')
    expect(umSql).toMatch(/where\s+not\s+reviewed\s+and\s+\(classification\s+is\s+null\s+or\s+classification\s+not\s+in\s*\(\s*'bounce'\s*,\s*'corrupted_charset'\s*\)\s*\)/is)
  })

  it('nezpracovane = reply_inbox.unhandled + unmatched_inbound.u_unhandled (both bounce-filtered)', async () => {
    // Simulate the real PROD scenario that drove AS-F1: reply_inbox has 45
    // real unhandled rows, unmatched_inbound has 121 bounces + 0 real. The
    // stats endpoint must report nezpracovane=45 (matches list view), NOT 166.
    queryQueue.push({ rows: [{ total: 45, unhandled: 45, positive: 0, negative: 0, auto_reply: 0, question: 0, today: 12, cekaji: 0 }] })
    queryQueue.push({ rows: [{
      u_total: 0,        // non-bounce unmatched = 0
      u_total_all: 121,  // raw COUNT = 121
      u_unhandled: 0,    // unhandled non-bounce = 0
      u_today: 0,
      u_bounces: 121,
      u_real: 0,
      u_cekaji: 0,
    }] })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unhandled).toBe(45)
    expect(body.nezpracovane).toBe(45)
    // unmatched keeps raw all-rows meaning for Bounces chip consumer.
    expect(body.unmatched).toBe(121)
    expect(body.unmatched_bounces).toBe(121)
    expect(body.unmatched_real).toBe(0)
  })

  it('cekaji_na_odpoved keeps its strict <24h + classification IS NULL filter (no bounce exclusion needed)', async () => {
    // cekaji predicate (`classification IS NULL`) is already strictly
    // tighter than "not bounce" — NULL classifications cannot be bounces,
    // so the filter stays identical to pre-AS-F1.
    queryQueue.push({ rows: [{ total: 50, unhandled: 30, positive: 0, negative: 0, auto_reply: 0, question: 0, today: 0, cekaji: 8 }] })
    queryQueue.push({ rows: [{ u_total: 0, u_unhandled: 0, u_today: 0, u_bounces: 0, u_real: 0, u_total_all: 0, u_cekaji: 2 }] })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json()
    expect(body.cekaji_na_odpoved).toBe(10)
  })

  it('zajem/dotazy/odmitnuti unaffected (already classification-specific)', async () => {
    queryQueue.push({ rows: [{ total: 100, unhandled: 0, positive: 12, negative: 4, auto_reply: 1, question: 3, today: 0, cekaji: 0 }] })
    queryQueue.push({ rows: [{ u_total: 0, u_unhandled: 0, u_today: 0, u_bounces: 0, u_real: 0, u_total_all: 0, u_cekaji: 0 }] })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json()
    expect(body.zajem).toBe(12)
    expect(body.odmitnuti).toBe(4)
    expect(body.dotazy).toBe(3)
  })
})
