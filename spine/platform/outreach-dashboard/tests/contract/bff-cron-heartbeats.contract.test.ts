// MVP-4 — /api/health/cron-heartbeats contract.
// Locks the response shape that Observability page consumes for stale-cron
// alerting. Verifies stale flag computation against expected interval.

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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'GIT_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'SOURCE_COMMIT', 'GITHUB_SHA']) {
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

describe('GET /api/health/cron-heartbeats', () => {
  it('T-1: returns ok=true when no heartbeats present', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/health/cron-heartbeats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.heartbeats).toEqual([])
    expect(body.stale_crons).toEqual([])
  })

  it('T-2: includes generated_at ISO timestamp', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/health/cron-heartbeats`)
    const body = (await res.json()) as { generated_at: string }
    expect(typeof body.generated_at).toBe('string')
    expect(() => new Date(body.generated_at).toISOString()).not.toThrow()
  })

  it('T-3: enriches each heartbeat with age_ms + expected_interval_ms + stale flag', async () => {
    const recentRun = new Date(Date.now() - 30_000).toISOString()
    queryQueue.push({ rows: [
      { cron_name: 'runSyntheticSmokeCron', last_run_at: recentRun, last_duration_ms: 120, last_status: 'ok', last_error: null },
    ] })
    const res = await fetch(`${baseUrl}/api/health/cron-heartbeats`)
    const body = (await res.json()) as { heartbeats: Array<Record<string, unknown>> }
    const hb = body.heartbeats[0]
    expect(hb).toHaveProperty('age_ms')
    expect(hb).toHaveProperty('expected_interval_ms')
    expect(hb).toHaveProperty('stale')
    expect(hb.expected_interval_ms).toBe(60_000)
    expect(hb.stale).toBe(false)
  })

  it('T-4: marks stale when age > 2× expected interval', async () => {
    // Synthetic cron expected every 60s; mark a 3-minute-old run as stale (>120s)
    const oldRun = new Date(Date.now() - 3 * 60_000).toISOString()
    queryQueue.push({ rows: [
      { cron_name: 'runSyntheticSmokeCron', last_run_at: oldRun, last_duration_ms: 120, last_status: 'ok', last_error: null },
    ] })
    const res = await fetch(`${baseUrl}/api/health/cron-heartbeats`)
    const body = (await res.json()) as { ok: boolean; stale_crons: string[]; heartbeats: Array<{ stale: boolean }> }
    expect(body.heartbeats[0].stale).toBe(true)
    expect(body.stale_crons).toContain('runSyntheticSmokeCron')
    expect(body.ok).toBe(false)
  })

  it('T-5: unknown cron names get null expected_interval (not stale)', async () => {
    const recentRun = new Date(Date.now() - 60_000).toISOString()
    queryQueue.push({ rows: [
      { cron_name: 'someUnknownCron', last_run_at: recentRun, last_duration_ms: 50, last_status: 'ok', last_error: null },
    ] })
    const res = await fetch(`${baseUrl}/api/health/cron-heartbeats`)
    const body = (await res.json()) as { heartbeats: Array<{ stale: boolean; expected_interval_ms: number | null }> }
    expect(body.heartbeats[0].expected_interval_ms).toBe(null)
    expect(body.heartbeats[0].stale).toBe(false)
  })

  it('T-6: handles missing table gracefully (returns empty heartbeats)', async () => {
    queryQueue.push(new Error('relation "cron_heartbeats" does not exist'))
    const res = await fetch(`${baseUrl}/api/health/cron-heartbeats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; heartbeats: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.heartbeats).toEqual([])
  })

  it('T-7: each heartbeat row preserves last_status + last_error', async () => {
    queryQueue.push({ rows: [
      { cron_name: 'runFullCheckCron', last_run_at: new Date().toISOString(), last_duration_ms: 800, last_status: 'error', last_error: 'connection refused' },
    ] })
    const res = await fetch(`${baseUrl}/api/health/cron-heartbeats`)
    const body = (await res.json()) as { heartbeats: Array<{ last_status: string; last_error: string }> }
    expect(body.heartbeats[0].last_status).toBe('error')
    expect(body.heartbeats[0].last_error).toBe('connection refused')
  })

  it('T-8: ok=true only when all crons are fresh', async () => {
    const fresh = new Date(Date.now() - 10_000).toISOString()
    queryQueue.push({ rows: [
      { cron_name: 'runSyntheticSmokeCron', last_run_at: fresh, last_duration_ms: 100, last_status: 'ok', last_error: null },
      { cron_name: 'runImapPollCron', last_run_at: fresh, last_duration_ms: 200, last_status: 'ok', last_error: null },
    ] })
    const res = await fetch(`${baseUrl}/api/health/cron-heartbeats`)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

describe('Sentry release tag (MVP-4)', () => {
  it('T-9: BFF_RELEASE export shape — bff@<sha12>', async () => {
    process.env.GIT_SHA = 'abcdef0123456789'
    // dynamic import after env set so module-level code re-evaluates
    vi.resetModules()
    const m = await import('../../sentry.server.js')
    expect(m.BFF_RELEASE).toBe('bff@abcdef012345')
  })

  it('T-10: BFF_RELEASE undefined when no SHA env present', async () => {
    delete process.env.GIT_SHA
    delete process.env.RAILWAY_GIT_COMMIT_SHA
    delete process.env.SOURCE_COMMIT
    delete process.env.GITHUB_SHA
    vi.resetModules()
    const m = await import('../../sentry.server.js')
    expect(m.BFF_RELEASE).toBeUndefined()
  })

  it('T-11: BFF_RELEASE prefers GIT_SHA over RAILWAY_GIT_COMMIT_SHA', async () => {
    process.env.GIT_SHA = 'aaaaaaaaaaaa'
    process.env.RAILWAY_GIT_COMMIT_SHA = 'bbbbbbbbbbbb'
    vi.resetModules()
    const m = await import('../../sentry.server.js')
    expect(m.BFF_RELEASE).toBe('bff@aaaaaaaaaaaa')
  })

  it('T-12: falls back through SHA env vars in order', async () => {
    delete process.env.GIT_SHA
    delete process.env.RAILWAY_GIT_COMMIT_SHA
    process.env.SOURCE_COMMIT = 'cccccccccccc'
    vi.resetModules()
    const m = await import('../../sentry.server.js')
    expect(m.BFF_RELEASE).toBe('bff@cccccccccccc')
  })
})
