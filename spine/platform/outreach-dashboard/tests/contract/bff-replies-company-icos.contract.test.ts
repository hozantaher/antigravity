// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/replies?company_icos=…  (Sprint F-S1)
//
//  Locks the new company-icos filter on the replies endpoint. The handler
//  joins replies → contacts and filters by `ct.ico = ANY($n)` so the
//  /companies → /replies deep-link can pass a CSV list of ICOs and get
//  back only replies from contacts in those companies.
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
  // Pre-fill with two empty result rows: one for the SELECT, one for the
  // count query. Both endpoints fire two queries.
  queryQueue.push({ rows: [] })
  queryQueue.push({ rows: [{ total: 0 }] })
})

describe('GET /api/replies?company_icos=…', () => {
  it('honors a single ICO and forwards as a Postgres array param', async () => {
    const res = await fetch(`${baseUrl}/api/replies?company_icos=12345678`)
    expect(res.status).toBe(200)
    // The list query is the first call.
    const sql = calls[0].sql
    expect(sql).toMatch(/ct\.ico\s*=\s*ANY/i)
    // ANY() takes an array — params should include ['12345678'] somewhere.
    // toContain on outer array uses === equality which doesn't match
    // nested arrays, so search via find().
    const arrayParam = (calls[0].params as unknown[])
      .find(p => Array.isArray(p) && (p as string[]).includes('12345678'))
    expect(arrayParam).toBeTruthy()
  })

  it('honors a CSV of multiple ICOs', async () => {
    const res = await fetch(`${baseUrl}/api/replies?company_icos=12345678,87654321,11111111`)
    expect(res.status).toBe(200)
    const arrayParam = (calls[0].params as unknown[])
      .find(p => Array.isArray(p)) as string[] | undefined
    expect(arrayParam).toEqual(['12345678', '87654321', '11111111'])
  })

  it('combines company_icos with handled=false (compound filter)', async () => {
    const res = await fetch(`${baseUrl}/api/replies?company_icos=12345678&handled=false`)
    expect(res.status).toBe(200)
    const sql = calls[0].sql
    expect(sql).toMatch(/r\.handled\s*=\s*FALSE/i)
    expect(sql).toMatch(/ct\.ico\s*=\s*ANY/i)
  })

  it('count query also applies the same ICO filter (so total is correct)', async () => {
    await fetch(`${baseUrl}/api/replies?company_icos=12345678`)
    // Second call is the count query.
    const sql = calls[1].sql
    expect(sql).toMatch(/COUNT\(\*\)/i)
    expect(sql).toMatch(/ct\.ico\s*=\s*ANY/i)
  })

  it('ignores empty company_icos values', async () => {
    await fetch(`${baseUrl}/api/replies?company_icos=`)
    const sql = calls[0].sql
    expect(sql).not.toMatch(/ct\.ico\s*=\s*ANY/i)
  })

  it('trims whitespace + drops empty entries from the CSV', async () => {
    await fetch(`${baseUrl}/api/replies?company_icos=12345678,%20,87654321`)
    const arrayParam = (calls[0].params as unknown[])
      .find(p => Array.isArray(p)) as string[] | undefined
    expect(arrayParam).toEqual(['12345678', '87654321'])
  })
})
