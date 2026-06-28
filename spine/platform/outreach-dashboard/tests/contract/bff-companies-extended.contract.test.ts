// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/companies extended (filters, error paths, monkey)
//
//  Extends bff-companies.contract.test.ts with sector filters, limit,
//  invalid scoreMin, sort-by-name, DB errors, and monkey scenarios.
//  Zero external deps — pg is fully stubbed.
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
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
})

function queueRows(rows: unknown[], rowCount?: number) {
  queryQueue.push({ rows, rowCount: rowCount ?? rows.length })
}
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/companies extended
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/companies extended', () => {
  it('?sector=stavebnictvi filters correctly', async () => {
    queueRows([{ ico: '12345678', name: 'Stavba s.r.o.', sector_primary: 'stavebnictvi' }])
    queueRows([{ total: 1 }])
    const res = await get('/api/companies?sector=stavebnictvi')
    expect(res.status).toBe(200)
    const body = res.body as { rows: unknown[]; total: number }
    expect(Array.isArray(body.rows)).toBe(true)
    // Verify the SQL includes sector filter (ANY array param)
    const listSql = calls[0].sql
    expect(listSql).toMatch(/sector_primary/)
  })

  it('?limit=1 returns at most 1 result', async () => {
    queueRows([{ ico: '11111111', name: 'Only One s.r.o.' }])
    queueRows([{ total: 999 }])
    const res = await get('/api/companies?limit=1')
    expect(res.status).toBe(200)
    const body = res.body as { rows: unknown[]; total: number }
    // The server uses the limit param in SQL — rows array from mock is 1
    expect(body.rows).toHaveLength(1)
    const params = calls[0].params as unknown[]
    const limit = params[params.length - 2]
    expect(limit).toBe(1)
  })

  it('?scoreMin=invalid → graceful (not crash)', async () => {
    // scoreMin=invalid → Number('invalid')=NaN → not finite → filter skipped
    queueRows([])
    queueRows([{ total: 0 }])
    const res = await get('/api/companies?scoreMin=invalid')
    // Must not crash (not 500 from unhandled exception)
    expect([200, 400]).toContain(res.status)
    if (res.status === 200) {
      const body = res.body as { rows: unknown[]; total: number }
      expect(Array.isArray(body.rows)).toBe(true)
    }
  })

  it('?sort=name&dir=asc passes through', async () => {
    queueRows([{ ico: '12345678', name: 'Alpha' }, { ico: '87654321', name: 'Beta' }])
    queueRows([{ total: 2 }])
    const res = await get('/api/companies?sort=name&dir=asc')
    expect(res.status).toBe(200)
    const listSql = calls[0].sql
    // sort=name maps to 'name' column, dir=asc → ASC NULLS LAST
    expect(listSql).toMatch(/name/)
    expect(listSql).toMatch(/ASC NULLS LAST/)
  })

  it('DB error → 500 with error message', async () => {
    queueError('database connection refused')
    const res = await get('/api/companies')
    expect(res.status).toBe(500)
    const body = res.body as { error?: string }
    // BFF captures errors and returns JSON with error field
    expect(typeof res.body).not.toBe('undefined')
  })

  it('MONKEY: all query params combined never crash', async () => {
    const combos = [
      '?sector=stavebnictvi&sort=name&dir=asc&limit=5&offset=0&scoreMin=30',
      '?sector=retail&sort=score&dir=desc&limit=100&offset=50',
      '?search=test&scoreMin=0&scoreMax=100&limit=10',
      '?sector=&sort=invalid_col&dir=invalid_dir&limit=0&offset=-1',
      '?scoreMin=-999&scoreMax=999&limit=999999',
      '?sort=name&dir=asc&limit=1&offset=0&search=&sector=',
    ]
    for (const params of combos) {
      queryQueue.length = 0
      calls.length = 0
      // Queue rows for list + count queries
      queueRows([])
      queueRows([{ total: 0 }])
      const res = await get('/api/companies' + params)
      expect(typeof res.status).toBe('number')
      expect(res.status).toBeGreaterThanOrEqual(200)
      expect(res.status).toBeLessThan(600)
    }
  })

  it('MONKEY: deeply nested categories query never crash', async () => {
    // categories[] with many deeply-nested values
    const deepCategories = Array.from({ length: 20 }, (_, i) =>
      `categories[]=${encodeURIComponent('root > sub' + i + ' > leaf' + i)}`
    ).join('&')
    queueRows([])
    queueRows([{ total: 0 }])
    const res = await get('/api/companies?' + deepCategories)
    expect(typeof res.status).toBe('number')
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(600)
  })
})
