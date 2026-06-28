// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/synthetic-runs + /api/health/invariants
//
//  Locks the shapes that Observability page (M5) consumes:
//   - runs[].id, ran_at, pass_count, fail_count, duration_ms
//   - stats {total, pass_runs, fail_runs, avg_duration_ms}
//   - invariants {ok, synthetic, synthetic_age_min, stale}
//  Plus boundary behavior (limit clamp, missing table fallback).
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

const sampleRow = (id: number, fail = 0) => ({
  id,
  ran_at: new Date(Date.now() - id * 60_000).toISOString(),
  suite: 'prod-smoke',
  results: { invariants: [] },
  pass_count: 11 - fail,
  fail_count: fail,
  duration_ms: 100 + id * 10,
})

describe('GET /api/synthetic-runs', () => {
  it('T-1: returns ok=true with runs + stats envelope', async () => {
    queryQueue.push({ rows: [sampleRow(1), sampleRow(2)] })
    const res = await fetch(`${baseUrl}/api/synthetic-runs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.runs)).toBe(true)
    expect(body.stats).toBeTypeOf('object')
  })

  it('T-2: stats.total reflects rows.length', async () => {
    queryQueue.push({ rows: [sampleRow(1), sampleRow(2), sampleRow(3, 1)] })
    const res = await fetch(`${baseUrl}/api/synthetic-runs`)
    const body = (await res.json()) as { stats: { total: number; pass_runs: number; fail_runs: number } }
    expect(body.stats.total).toBe(3)
    expect(body.stats.pass_runs).toBe(2)
    expect(body.stats.fail_runs).toBe(1)
  })

  it('T-3: avg_duration_ms is rounded mean of duration_ms', async () => {
    queryQueue.push({ rows: [sampleRow(1), sampleRow(3)] }) // 110, 130 → avg 120
    const res = await fetch(`${baseUrl}/api/synthetic-runs`)
    const body = (await res.json()) as { stats: { avg_duration_ms: number } }
    expect(body.stats.avg_duration_ms).toBe(120)
  })

  it('T-4: limit clamps to max 500', async () => {
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/synthetic-runs?limit=99999`)
    const lastCall = calls[calls.length - 1]
    expect(lastCall.params?.[0]).toBe(500)
  })

  it('T-5: limit defaults to 50 when missing', async () => {
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/synthetic-runs`)
    const lastCall = calls[calls.length - 1]
    expect(lastCall.params?.[0]).toBe(50)
  })

  it('T-6: limit accepts user value within bounds', async () => {
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/synthetic-runs?limit=25`)
    const lastCall = calls[calls.length - 1]
    expect(lastCall.params?.[0]).toBe(25)
  })

  it('T-7: returns empty runs+zero stats on missing table', async () => {
    queryQueue.push(new Error('relation "synthetic_runs" does not exist'))
    const res = await fetch(`${baseUrl}/api/synthetic-runs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; runs: unknown[]; stats: { total: number } }
    expect(body.ok).toBe(true)
    expect(body.runs).toEqual([])
    expect(body.stats.total).toBe(0)
  })

  it('T-8: each run row exposes all fields Observability needs', async () => {
    queryQueue.push({ rows: [sampleRow(7, 2)] })
    const res = await fetch(`${baseUrl}/api/synthetic-runs`)
    const body = (await res.json()) as { runs: Array<Record<string, unknown>> }
    const r = body.runs[0]
    expect(r).toHaveProperty('id')
    expect(r).toHaveProperty('ran_at')
    expect(r).toHaveProperty('pass_count')
    expect(r).toHaveProperty('fail_count')
    expect(r).toHaveProperty('duration_ms')
  })
})

describe('GET /api/health/invariants', () => {
  it('T-9: returns synthetic + synthetic_age_min + stale flag', async () => {
    const ranAt = new Date(Date.now() - 2 * 60_000).toISOString()
    queryQueue.push({ rows: [{ id: 99, ran_at: ranAt, results: {}, pass_count: 11, fail_count: 0, duration_ms: 150 }] })
    const res = await fetch(`${baseUrl}/api/health/invariants`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toHaveProperty('synthetic')
    expect(body).toHaveProperty('synthetic_age_min')
    expect(body).toHaveProperty('stale')
    expect(body).toHaveProperty('ok')
  })

  it('T-10: stale=false when synthetic_age_min ≤ 5', async () => {
    const ranAt = new Date(Date.now() - 60_000).toISOString()
    queryQueue.push({ rows: [{ id: 1, ran_at: ranAt, results: {}, pass_count: 11, fail_count: 0, duration_ms: 100 }] })
    const res = await fetch(`${baseUrl}/api/health/invariants`)
    const body = (await res.json()) as { stale: boolean; synthetic_age_min: number }
    expect(body.stale).toBe(false)
    expect(body.synthetic_age_min).toBeLessThanOrEqual(5)
  })

  it('T-11: stale=true when synthetic_age_min > 5', async () => {
    const ranAt = new Date(Date.now() - 12 * 60_000).toISOString()
    queryQueue.push({ rows: [{ id: 1, ran_at: ranAt, results: {}, pass_count: 11, fail_count: 0, duration_ms: 100 }] })
    const res = await fetch(`${baseUrl}/api/health/invariants`)
    const body = (await res.json()) as { stale: boolean; synthetic_age_min: number }
    expect(body.stale).toBe(true)
    expect(body.synthetic_age_min).toBeGreaterThan(5)
  })

  it('T-12: ok=true when latest synthetic has fail_count=0', async () => {
    queryQueue.push({ rows: [{ id: 1, ran_at: new Date().toISOString(), results: {}, pass_count: 11, fail_count: 0, duration_ms: 100 }] })
    const res = await fetch(`${baseUrl}/api/health/invariants`)
    const body = (await res.json()) as { ok: boolean | null }
    expect(body.ok).toBe(true)
  })

  it('T-13: ok=false when latest synthetic has fail_count>0', async () => {
    queryQueue.push({ rows: [{ id: 1, ran_at: new Date().toISOString(), results: {}, pass_count: 8, fail_count: 3, duration_ms: 100 }] })
    const res = await fetch(`${baseUrl}/api/health/invariants`)
    const body = (await res.json()) as { ok: boolean | null }
    expect(body.ok).toBe(false)
  })

  it('T-14: ok=null + stale=false when no synthetic rows', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/health/invariants`)
    const body = (await res.json()) as { ok: boolean | null; synthetic: unknown; synthetic_age_min: number | null; stale: boolean }
    expect(body.ok).toBe(null)
    expect(body.synthetic).toBe(null)
    expect(body.synthetic_age_min).toBe(null)
    expect(body.stale).toBe(false)
  })

  it('T-15: includes generated_at ISO timestamp', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/health/invariants`)
    const body = (await res.json()) as { generated_at: string }
    expect(body.generated_at).toBeTypeOf('string')
    expect(() => new Date(body.generated_at)).not.toThrow()
  })

  it('T-16: missing synthetic_runs table → falls through cleanly', async () => {
    queryQueue.push(new Error('relation "synthetic_runs" does not exist'))
    const res = await fetch(`${baseUrl}/api/health/invariants`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean | null; synthetic: unknown }
    expect(body.synthetic).toBe(null)
  })
})
