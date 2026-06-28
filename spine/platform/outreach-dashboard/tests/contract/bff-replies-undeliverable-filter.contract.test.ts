// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — undeliverable / NDR signature guard (2026-06-24).
//
//  Some real bounces land in reply_inbox with classification=NULL (seznam.cz
//  postmaster NDRs that carry no RFC 3464 "Status:" line, so the Go
//  DetectBounce gate misses them). They leaked into the operator's Odpovědi
//  queue as fake replies. undeliverableFilter.js adds a structural-signature
//  guard (bounce sender OR NDR subject) to the DEFAULT view + stat strip, on
//  BOTH the reply_inbox and unmatched_inbound arms, gated by the SAME
//  include_bounces escape hatch as the existing classification filter.
//
//  These assertions verify the SQL WIRING (the guard is present by default,
//  absent under include_bounces, on both arms + stats). Row-level behaviour
//  (exactly the 42 PROD bounce rows hidden, id 381 kept) is proven separately
//  against PROD and by tests/unit/lib/undeliverableFilter.test.js.
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
  queryQueue.push({ rows: [] })
  queryQueue.push({ rows: [{ total: 0 }] })
})

function findUnionQuery(): string | null {
  const c = calls.find(c => /FROM\s+unmatched_inbound/i.test(c.sql) && /from_address/i.test(c.sql))
  return c ? c.sql : null
}

const SENDER_PATTERN = 'mailer-daemon|postmaster|mail-daemon'

describe('GET /api/replies — undeliverable-signature guard', () => {
  it('default view applies the guard on the reply_inbox arm (r.from_email/r.subject)', async () => {
    await fetch(`${baseUrl}/api/replies`)
    const sql = findUnionQuery()!
    expect(sql).toMatch(/NOT\s*\(COALESCE\(r\.from_email,''\)\s*~\*/i)
    expect(sql).toContain(SENDER_PATTERN)
  })

  it('default view applies the guard on the unmatched_inbound arm (u.from_address/u.subject)', async () => {
    await fetch(`${baseUrl}/api/replies`)
    const sql = findUnionQuery()!
    expect(sql).toMatch(/NOT\s*\(COALESCE\(u\.from_address,''\)\s*~\*/i)
  })

  it('does NOT treat "noreply" as undeliverable (id 381 false-positive guard)', async () => {
    await fetch(`${baseUrl}/api/replies`)
    const sql = findUnionQuery()!
    expect(sql).not.toMatch(/no-?reply/i)
  })

  it('include_bounces=true lifts the undeliverable guard too', async () => {
    await fetch(`${baseUrl}/api/replies?include_bounces=true`)
    const sql = findUnionQuery()!
    expect(sql).not.toContain(SENDER_PATTERN)
  })

  it('include_bounces=1 lifts the undeliverable guard too', async () => {
    await fetch(`${baseUrl}/api/replies?include_bounces=1`)
    const sql = findUnionQuery()!
    expect(sql).not.toContain(SENDER_PATTERN)
  })
})

describe('GET /api/replies/stats — undeliverable-signature guard', () => {
  it('stat aggregates apply the guard on BOTH tables (so chip counts match the list)', async () => {
    await fetch(`${baseUrl}/api/replies/stats`)
    const riAgg = calls.find(c => /FROM\s+reply_inbox/i.test(c.sql) && /AS\s+total/i.test(c.sql))
    const umAgg = calls.find(c => /FROM\s+unmatched_inbound/i.test(c.sql) && /u_total\b/i.test(c.sql))
    expect(riAgg?.sql).toMatch(/NOT\s*\(COALESCE\(from_email,''\)\s*~\*/i)
    expect(umAgg?.sql).toMatch(/NOT\s*\(COALESCE\(from_address,''\)\s*~\*/i)
  })
})
