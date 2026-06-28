// ═══════════════════════════════════════════════════════════════════════════
//  AM-F3 — BFF contract for the SUPERSET shape of GET /api/replies/stats.
//
//  The legacy contract (English keys) is locked by
//  `bff-replies-stats.contract.test.ts`. This file pins the AM-F3 Czech-key
//  superset emitted by `src/server-routes/repliesStats.js`:
//    - nezpracovane       === unhandled (both tables combined)
//    - cekaji_na_odpoved  === !handled AND <24h AND classification IS NULL
//    - zajem              === classification='positive'
//    - dotazy             === classification='question'
//    - odmitnuti          === classification='negative'
//    - dnes               === today (received in last 24h)
//
//  Why a separate contract test:
//    The existing English-key test asserts a fixed `STATS_KEYS` array and
//    `expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(['error']))`
//    which is forward-compatible (arrayContaining tolerates extra keys). But
//    we want a positive lock on the new Czech keys so any future regression
//    that drops them surfaces here, not in a silent UI render.
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

// AM-F3 handler fires 2 queries: reply_inbox aggregate then unmatched_inbound.
// pushAggregates pushes both rows in order.
function pushAggregates(reply, unmatched = {}) {
  queryQueue.push({ rows: [reply] })
  queryQueue.push({ rows: [{
    u_total: 0, u_unhandled: 0, u_today: 0, u_bounces: 0, u_real: 0, u_cekaji: 0,
    ...unmatched,
  }] })
}

const CZECH_KEYS = ['nezpracovane', 'cekaji_na_odpoved', 'zajem', 'dotazy', 'odmitnuti', 'dnes']

describe('GET /api/replies/stats — AM-F3 Czech-key superset', () => {
  it('returns the 6 Czech-key buckets alongside English keys (happy path)', async () => {
    pushAggregates({
      total: 100, unhandled: 30, positive: 12, negative: 5, auto_reply: 2, question: 4, today: 7, cekaji: 8,
      phone_unhandled: 23,
    })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect(res.status).toBe(200)
    const body = await res.json()
    // #1578 M1 — call-queue lane count surfaced to the UI badge.
    expect(body.phone_unhandled).toBe(23)
    for (const k of CZECH_KEYS) {
      expect(body, `missing ${k}`).toHaveProperty(k)
      expect(typeof body[k]).toBe('number')
      expect(Number.isInteger(body[k])).toBe(true)
    }
    expect(body.nezpracovane).toBe(30)
    expect(body.cekaji_na_odpoved).toBe(8)
    expect(body.zajem).toBe(12)
    expect(body.dotazy).toBe(4)
    expect(body.odmitnuti).toBe(5)
    expect(body.dnes).toBe(7)
  })

  it('English keys remain present for back-compat (no breaking change)', async () => {
    pushAggregates({
      total: 50, unhandled: 10, positive: 6, negative: 3, auto_reply: 1, question: 2, today: 4, cekaji: 5,
    })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json()
    expect(body).toMatchObject({
      total: 50, unhandled: 10, positive: 6, negative: 3, auto_reply: 1, today: 4,
      unmatched: 0, unmatched_real: 0, unmatched_bounces: 0,
    })
  })

  it('nezpracovane sums reply_inbox.unhandled + unmatched_inbound.u_unhandled', async () => {
    pushAggregates(
      { total: 10, unhandled: 7, positive: 0, negative: 0, auto_reply: 0, question: 0, today: 0, cekaji: 0 },
      { u_total: 5, u_unhandled: 3 },
    )
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json()
    expect(body.nezpracovane).toBe(10) // 7 + 3
  })

  it('cekaji_na_odpoved sums both tables (last-24h unhandled, classification IS NULL)', async () => {
    pushAggregates(
      { total: 20, unhandled: 10, positive: 0, negative: 0, auto_reply: 0, question: 0, today: 0, cekaji: 4 },
      { u_total: 5, u_unhandled: 2, u_cekaji: 1 },
    )
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json()
    expect(body.cekaji_na_odpoved).toBe(5) // 4 + 1
  })

  it('zajem / dotazy / odmitnuti read only reply_inbox FILTER counters', async () => {
    pushAggregates(
      { total: 20, unhandled: 0, positive: 12, negative: 4, auto_reply: 0, question: 3, today: 0, cekaji: 0 },
      { u_total: 5, u_unhandled: 0 },
    )
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json()
    expect(body.zajem).toBe(12)
    expect(body.dotazy).toBe(3)
    expect(body.odmitnuti).toBe(4)
  })

  it('dnes sums reply_inbox.today + unmatched_inbound.u_today', async () => {
    pushAggregates(
      { total: 20, unhandled: 0, positive: 0, negative: 0, auto_reply: 0, question: 0, today: 8, cekaji: 0 },
      { u_total: 5, u_today: 2 },
    )
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json()
    expect(body.dnes).toBe(10) // 8 + 2
  })

  it('all zero when both tables empty (no NaN, no undefined)', async () => {
    pushAggregates({ total: 0, unhandled: 0, positive: 0, negative: 0, auto_reply: 0, question: 0, today: 0, cekaji: 0 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const body = await res.json()
    for (const k of CZECH_KEYS) {
      expect(body[k]).toBe(0)
      expect(Number.isNaN(body[k])).toBe(false)
    }
  })

  it('SQL fires 2 queries: reply_inbox then unmatched_inbound (table order locked)', async () => {
    pushAggregates({ total: 1, unhandled: 0, positive: 1, negative: 0, auto_reply: 0, question: 0, today: 0, cekaji: 0 })
    await fetch(`${baseUrl}/api/replies/stats`)
    expect(calls.length).toBe(2)
    expect(calls[0].sql.toLowerCase()).toContain('reply_inbox')
    expect(calls[1].sql.toLowerCase()).toContain('unmatched_inbound')
  })

  it('Cache-Control is no-cache (stat strip must show fresh counts)', async () => {
    pushAggregates({ total: 1, unhandled: 1, positive: 0, negative: 0, auto_reply: 0, question: 0, today: 1, cekaji: 1 })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const cc = res.headers.get('cache-control') || ''
    expect(cc).toMatch(/no-cache|no-store/i)
    expect(cc).not.toMatch(/max-age=[1-9]/)
  })

  it('returns 500 with JSON error envelope on DB error', async () => {
    queryQueue.push(new Error('connection refused'))
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    expect(body).not.toHaveProperty('stack')
  })
})
