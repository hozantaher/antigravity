// ═══════════════════════════════════════════════════════════════════════════
//  Anonymity latest — BFF contract tests (S5)
//
//  Coverage:
//   1.  GET /api/anonymity/latest?mailbox_id=1   — 200 + expected shape
//   2.  Missing mailbox_id → 400
//   3.  Mailbox with no scored runs              → last_run_id=null + "Žádný test"
//   4.  Avg score >= 85 (both)                   → recommendation includes "připravena"
//   5.  Avg score 70..84                         → recommendation includes "drobné nedostatky"
//   6.  Avg score < 70                           → recommendation includes "NENÍ připravena"
//   7.  Top leaks aggregation: same rule in 3 rows → count=3
//   8.  top_leaks limited to 5 entries
//   9.  Last-7-days filter: older messages excluded
//  10.  GET /api/anonymity/all returns one entry per active mailbox
//  11.  POST /api/anonymity/run within 1h → 429 rate_limited
//  12.  POST /api/anonymity/run after rate window → 200 with run_id
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
        on() {} end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// Mock child_process.exec so the binary chain doesn't run in tests
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: Function) => { cb(null, '', '') }),
}))

let baseUrl = ''
let server: import('http').Server

const savedEnv: Record<string, string | undefined> = {}
beforeAll(async () => {
  for (const k of ['BFF_AUTH_DISABLED', 'BFF_IMPORT_ONLY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
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

beforeEach(async () => {
  queryQueue.length = 0
  calls.length = 0
  // Reset rate-limit state between tests
  const mod = await import('../../src/server-routes/anonymityLatest.js')
  ;(mod as any)._resetRateLimit()
})

// ── helper: push mailbox row for `outreach_mailboxes` lookup ─────────────────

function pushMailbox(id = 1, email = 'test@firma.cz', status = 'active') {
  queryQueue.push({ rows: [{ id, email, status }] })
}

// ── scored row factory ────────────────────────────────────────────────────────

function scoredRow(opts: {
  test_run_id?: string
  anonymity_score?: number
  humanlike_score?: number
  anonymity_leaks?: unknown[]
  humanlike_telltales?: unknown[]
  harvested_at?: string
} = {}) {
  const now = new Date().toISOString()
  return {
    test_run_id: opts.test_run_id ?? '00000000-0000-0000-0000-000000000001',
    anonymity_score: opts.anonymity_score ?? 90,
    humanlike_score: opts.humanlike_score ?? 88,
    anonymity_leaks: opts.anonymity_leaks ?? [],
    humanlike_telltales: opts.humanlike_telltales ?? [],
    harvested_at: opts.harvested_at ?? now,
  }
}

// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/anonymity/latest', () => {
  it('1: returns 200 with expected shape for a scored mailbox', async () => {
    pushMailbox(1)
    queryQueue.push({ rows: [scoredRow({ anonymity_score: 88, humanlike_score: 86 })] })
    const res = await fetch(`${baseUrl}/api/anonymity/latest?mailbox_id=1`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.mailbox_id).toBe(1)
    expect(typeof body.email).toBe('string')
    expect(typeof body.last_run_id).toBe('string')
    expect(typeof body.last_run_at).toBe('string')
    expect(body.anonymity).toBeTruthy()
    expect(body.humanlike).toBeTruthy()
    const anon = body.anonymity as Record<string, unknown>
    expect(typeof anon.avg_score).toBe('number')
    expect(typeof anon.min_score).toBe('number')
    expect(typeof anon.messages).toBe('number')
    expect(Array.isArray(anon.top_leaks)).toBe(true)
    expect(typeof body.recommendation).toBe('string')
    expect(typeof body.last_7_days_runs).toBe('number')
  })

  it('2: missing mailbox_id → 400', async () => {
    const res = await fetch(`${baseUrl}/api/anonymity/latest`)
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
  })

  it('3: mailbox with no scored runs → last_run_id=null + recommendation mentions žádný test', async () => {
    pushMailbox(2)
    // scored rows query returns empty
    queryQueue.push({ rows: [] })
    // fallback any-run query also empty
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/anonymity/latest?mailbox_id=2`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.last_run_id).toBeNull()
    expect(String(body.recommendation).toLowerCase()).toMatch(/žádný test|spusť test/)
  })

  it('4: avg_score >= 85 (both) → recommendation includes "připravena"', async () => {
    pushMailbox(3)
    queryQueue.push({ rows: [
      scoredRow({ anonymity_score: 90, humanlike_score: 88 }),
      scoredRow({ anonymity_score: 92, humanlike_score: 86 }),
    ]})
    const res = await fetch(`${baseUrl}/api/anonymity/latest?mailbox_id=3`)
    const body = await res.json() as Record<string, unknown>
    expect(String(body.recommendation)).toMatch(/připravena/)
  })

  it('5: avg_score in 70..84 → recommendation includes "drobné nedostatky"', async () => {
    pushMailbox(4)
    queryQueue.push({ rows: [
      scoredRow({ anonymity_score: 75, humanlike_score: 72 }),
      scoredRow({ anonymity_score: 78, humanlike_score: 74 }),
    ]})
    const res = await fetch(`${baseUrl}/api/anonymity/latest?mailbox_id=4`)
    const body = await res.json() as Record<string, unknown>
    expect(String(body.recommendation)).toMatch(/drobné nedostatky/)
  })

  it('6: avg_score < 70 → recommendation includes "NENÍ připravena"', async () => {
    pushMailbox(5)
    queryQueue.push({ rows: [
      scoredRow({ anonymity_score: 60, humanlike_score: 55 }),
      scoredRow({ anonymity_score: 65, humanlike_score: 62 }),
    ]})
    const res = await fetch(`${baseUrl}/api/anonymity/latest?mailbox_id=5`)
    const body = await res.json() as Record<string, unknown>
    expect(String(body.recommendation)).toMatch(/NENÍ připravena/)
  })

  it('7: top_leaks aggregation — same rule in 3 rows yields count=3', async () => {
    const leak = { rule: 'L1_external_ip', severity: 'warn', evidence: '1.2.3.4' }
    pushMailbox(6)
    queryQueue.push({ rows: [
      scoredRow({ anonymity_score: 80, humanlike_score: 78, anonymity_leaks: [leak] }),
      scoredRow({ anonymity_score: 82, humanlike_score: 76, anonymity_leaks: [leak] }),
      scoredRow({ anonymity_score: 84, humanlike_score: 74, anonymity_leaks: [leak] }),
    ]})
    const res = await fetch(`${baseUrl}/api/anonymity/latest?mailbox_id=6`)
    const body = await res.json() as Record<string, unknown>
    const anon = body.anonymity as Record<string, unknown>
    const leaks = anon.top_leaks as Array<Record<string, unknown>>
    const l1 = leaks.find(l => l.rule === 'L1_external_ip')
    expect(l1).toBeTruthy()
    expect(l1!.count).toBe(3)
  })

  it('8: top_leaks limited to 5 entries', async () => {
    // 6 distinct rules → only top 5 returned
    const leaks = [
      { rule: 'R1', severity: 'warn', evidence: '' },
      { rule: 'R2', severity: 'warn', evidence: '' },
      { rule: 'R3', severity: 'warn', evidence: '' },
      { rule: 'R4', severity: 'warn', evidence: '' },
      { rule: 'R5', severity: 'warn', evidence: '' },
      { rule: 'R6', severity: 'warn', evidence: '' },
    ]
    pushMailbox(7)
    queryQueue.push({ rows: [
      scoredRow({ anonymity_score: 75, humanlike_score: 74, anonymity_leaks: leaks }),
    ]})
    const res = await fetch(`${baseUrl}/api/anonymity/latest?mailbox_id=7`)
    const body = await res.json() as Record<string, unknown>
    const anon = body.anonymity as Record<string, unknown>
    const topLeaks = anon.top_leaks as unknown[]
    expect(topLeaks.length).toBeLessThanOrEqual(5)
  })

  it('9: last-7-days filter — older messages excluded (checked via query params)', async () => {
    // We verify the query passes a "since" param by checking the SQL params
    // include a recent timestamp. The pg mock just checks queryQueue.
    pushMailbox(8)
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/anonymity/latest?mailbox_id=8`)
    // The scored-rows query is the second call (index 1, after the mailbox lookup).
    // Its params[1] should be a recent ISO timestamp (within 8 days).
    const scoredCall = calls.find(c => c.sql.includes('anonymity_test_messages') && c.sql.includes('$2'))
    expect(scoredCall).toBeTruthy()
    const sinceParam = scoredCall!.params?.[1] as string
    const sinceDate = new Date(sinceParam)
    const ageMs = Date.now() - sinceDate.getTime()
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    // The since param should be approximately 7 days ago (within 1 day tolerance)
    expect(ageMs).toBeGreaterThan(sevenDaysMs - 24 * 60 * 60 * 1000)
    expect(ageMs).toBeLessThan(sevenDaysMs + 24 * 60 * 60 * 1000)
  })
})

describe('GET /api/anonymity/all', () => {
  it('10: returns one entry per active mailbox (batch path)', async () => {
    // Batch path (hardening 2026-05-05):
    // 1. active mailboxes list (now includes email column)
    queryQueue.push({ rows: [
      { id: 1, email: 'a@firm.cz', status: 'active' },
      { id: 2, email: 'b@firm.cz', status: 'active' },
    ]})
    // 2. batch scored rows — mailbox 1 has scored rows, mailbox 2 does not
    queryQueue.push({ rows: [
      { sender_mailbox_id: 1, ...scoredRow({ anonymity_score: 88, humanlike_score: 86 }) },
    ]})
    // 3. mailbox 2 individual fallback: mailbox lookup
    queryQueue.push({ rows: [{ id: 2, email: 'b@firm.cz', status: 'active' }] })
    // 4. mailbox 2 scored rows (empty)
    queryQueue.push({ rows: [] })
    // 5. mailbox 2 fallback any-run query (also empty)
    queryQueue.push({ rows: [] })

    const res = await fetch(`${baseUrl}/api/anonymity/all`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.mailboxes)).toBe(true)
    expect((body.mailboxes as unknown[]).length).toBe(2)
  })
})

describe('GET /api/anonymity/all — batch optimisation (hardening 2026-05-05)', () => {
  it('10b: batch path — 2 mailboxes, 1 with scored rows, 1 without', async () => {
    // 1. active mailboxes list (with email now included)
    queryQueue.push({ rows: [
      { id: 1, email: 'a@firm.cz', status: 'active' },
      { id: 2, email: 'b@firm.cz', status: 'active' },
    ]})
    // 2. batch scored rows query — only mailbox 1 has rows
    queryQueue.push({ rows: [
      { sender_mailbox_id: 1, ...scoredRow({ anonymity_score: 88, humanlike_score: 86 }) },
    ]})
    // 3. mailbox 2 fallback: individual lookup
    queryQueue.push({ rows: [{ id: 2, email: 'b@firm.cz', status: 'active' }] })
    // 4. mailbox 2 scored rows (empty)
    queryQueue.push({ rows: [] })
    // 5. mailbox 2 fallback any-run query (also empty)
    queryQueue.push({ rows: [] })

    const res = await fetch(`${baseUrl}/api/anonymity/all`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.mailboxes)).toBe(true)
    const mailboxes = body.mailboxes as Array<Record<string, unknown>>
    expect(mailboxes.length).toBe(2)
    // Mailbox 1 has scored data
    const mb1 = mailboxes.find(m => m.mailbox_id === 1)
    expect(mb1).toBeTruthy()
    expect(mb1!.anonymity).toBeTruthy()
    // Mailbox 2 has no scored data
    const mb2 = mailboxes.find(m => m.mailbox_id === 2)
    expect(mb2).toBeTruthy()
    expect(mb2!.anonymity).toBeNull()
  })

  it('10c: batch path — buildAggregateFromRows computes avg correctly', async () => {
    queryQueue.push({ rows: [{ id: 3, email: 'c@firm.cz', status: 'active' }] })
    queryQueue.push({ rows: [
      { sender_mailbox_id: 3, ...scoredRow({ anonymity_score: 80, humanlike_score: 70 }) },
      { sender_mailbox_id: 3, ...scoredRow({ anonymity_score: 90, humanlike_score: 80 }) },
    ]})
    const res = await fetch(`${baseUrl}/api/anonymity/all`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    const mailboxes = body.mailboxes as Array<Record<string, unknown>>
    const mb = mailboxes.find(m => m.mailbox_id === 3)
    expect(mb).toBeTruthy()
    const anon = mb!.anonymity as Record<string, unknown>
    // avg = Math.round((80+90)/2) = 85
    expect(anon.avg_score).toBe(85)
    // min = 80
    expect(anon.min_score).toBe(80)
    expect(anon.messages).toBe(2)
  })
})

describe('POST /api/anonymity/run', () => {
  it('11: within 1h of last run → 429 rate_limited', async () => {
    // Manually set last run timestamp to 30 minutes ago
    const mod = await import('../../src/server-routes/anonymityLatest.js')
    ;(mod as any)._setLastRunAt(Date.now() - 30 * 60 * 1000)

    const res = await fetch(`${baseUrl}/api/anonymity/run`, { method: 'POST' })
    expect(res.status).toBe(429)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe('rate_limited')
    expect(body.run_id).toBeNull()
  })

  it('12: after rate window → 200 with run_id', async () => {
    // Rate limit reset in beforeEach, so _lastRunAt is null
    const res = await fetch(`${baseUrl}/api/anonymity/run`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe('running')
    expect(typeof body.run_id).toBe('string')
    expect(body.run_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof body.started_at).toBe('string')
  })
})
