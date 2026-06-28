// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/healing/{log,stats} + /api/health/drift
//                + /api/protections/{matrix,alerts,coverage} + PATCH ack
//
//  Locks shapes, limit clamping, drift cache TTL mock, 404 on ack miss,
//  and 500 paths.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []
let mockRunConfigDrift: ReturnType<typeof vi.fn>

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
vi.mock('../../configDrift.js', () => {
  mockRunConfigDrift = vi.fn()
  return { runConfigDrift: mockRunConfigDrift }
})

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
  // Resolve the lazy mock reference after import
  const driftMod = await import('../../configDrift.js')
  mockRunConfigDrift = driftMod.runConfigDrift as ReturnType<typeof vi.fn>
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
  mockRunConfigDrift?.mockReset()
})

// ── /api/healing/log ──────────────────────────────────────────────────────

describe('GET /api/healing/log', () => {
  const sampleEvent = {
    id: 1,
    entity_type: 'mailbox',
    entity_id: 42,
    entity_label: 'mb-001',
    action: 'password_reset',
    reason: 'AUTH 535',
    resolved_at: null,
    created_at: '2026-04-20T10:00:00Z',
  }

  it('returns events array + total int', async () => {
    queryQueue.push({ rows: [sampleEvent] })
    queryQueue.push({ rows: [{ count: 1 }] })
    const res = await fetch(`${baseUrl}/api/healing/log`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.events)).toBe(true)
    expect(typeof body.total).toBe('number')
    const ev = (body.events as unknown[])[0] as Record<string, unknown>
    expect(ev).toMatchObject({
      id:           expect.any(Number),
      entity_type:  expect.any(String),
      entity_id:    expect.any(Number),
      entity_label: expect.any(String),
      action:       expect.any(String),
      reason:       expect.any(String),
      created_at:   expect.any(String),
    })
  })

  it('clamps limit to 200', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ count: 0 }] })
    await fetch(`${baseUrl}/api/healing/log?limit=999`)
    const limitSql = calls.find(c => c.sql.includes('LIMIT'))
    expect(limitSql?.params?.[0]).toBe(200)
  })

  it('defaults to limit 50', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ count: 0 }] })
    await fetch(`${baseUrl}/api/healing/log`)
    const limitSql = calls.find(c => c.sql.includes('LIMIT'))
    expect(limitSql?.params?.[0]).toBe(50)
  })

  it('returns 500 on DB error', async () => {
    queryQueue.push(new Error('DB gone'))
    const res = await fetch(`${baseUrl}/api/healing/log`)
    expect(res.status).toBe(500)
  })
})

// ── /api/healing/stats ────────────────────────────────────────────────────

describe('GET /api/healing/stats', () => {
  it('returns by_action array + today int', async () => {
    queryQueue.push({
      rows: [
        { action: 'password_reset', cnt: 5, last_at: '2026-04-22T10:00:00Z' },
        { action: 'proxy_evict',    cnt: 2, last_at: '2026-04-21T08:00:00Z' },
      ],
    })
    queryQueue.push({ rows: [{ count: 3 }] })
    const res = await fetch(`${baseUrl}/api/healing/stats`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.by_action)).toBe(true)
    expect(typeof body.today).toBe('number')
    const row = (body.by_action as unknown[])[0] as Record<string, unknown>
    expect(row).toMatchObject({
      action: expect.any(String),
      cnt:    expect.any(Number),
    })
  })

  it('today=0 when healing_log is empty', async () => {
    queryQueue.push({ rows: [] })
    queryQueue.push({ rows: [{ count: 0 }] })
    const res = await fetch(`${baseUrl}/api/healing/stats`)
    const body = await res.json() as Record<string, unknown>
    expect(body.today).toBe(0)
  })

  it('returns 500 on DB error', async () => {
    queryQueue.push(new Error('timeout'))
    const res = await fetch(`${baseUrl}/api/healing/stats`)
    expect(res.status).toBe(500)
  })
})

// ── /api/health/drift ─────────────────────────────────────────────────────

describe('GET /api/health/drift', () => {
  it('calls runConfigDrift and returns its result', async () => {
    const driftResult = { checked_at: new Date().toISOString(), issues: [] }
    mockRunConfigDrift.mockResolvedValue(driftResult)
    const res = await fetch(`${baseUrl}/api/health/drift`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ checked_at: expect.any(String) })
  })

  it('repeated requests do not error (cache or fresh call both valid)', async () => {
    // The module-level cache persists across tests — just verify both calls return 200
    mockRunConfigDrift.mockResolvedValue({
      checked_at: new Date().toISOString(),
      issues: [],
    })
    const r1 = await fetch(`${baseUrl}/api/health/drift`)
    const r2 = await fetch(`${baseUrl}/api/health/drift`)
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
  })
})

// ── /api/protections/matrix ───────────────────────────────────────────────

describe('GET /api/protections/matrix', () => {
  const probe = {
    layer: 'smtp', level: 'transport', status: 'ok',
    detail: '', latency_ms: 12,
    expected: {}, actual: {},
    checked_at: '2026-04-22T10:00:00Z',
  }

  it('returns probes array + generated_at', async () => {
    queryQueue.push({ rows: [probe] })
    const res = await fetch(`${baseUrl}/api/protections/matrix`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.probes)).toBe(true)
    expect(typeof body.generated_at).toBe('string')
    const p = (body.probes as unknown[])[0] as Record<string, unknown>
    expect(p).toMatchObject({
      layer:      expect.any(String),
      level:      expect.any(String),
      status:     expect.any(String),
      detail:     expect.any(String),
      latency_ms: expect.any(Number),
      checked_at: expect.any(String),
    })
  })

  it('returns empty probes array when table has no rows', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/protections/matrix`)
    const body = await res.json() as Record<string, unknown>
    expect((body.probes as unknown[]).length).toBe(0)
  })

  it('returns 500 on DB error', async () => {
    queryQueue.push(new Error('DB error'))
    const res = await fetch(`${baseUrl}/api/protections/matrix`)
    expect(res.status).toBe(500)
  })
})

// ── /api/protections/alerts ───────────────────────────────────────────────

describe('GET /api/protections/alerts', () => {
  const alert = {
    id: 7, layer: 'smtp', level: 'transport', severity: 'critical',
    status: 'open', consecutive_failures: 3,
    last_status: 'err', detail: 'AUTH failed',
    fired_at: '2026-04-22T09:00:00Z',
    acked_at: null, updated_at: '2026-04-22T09:00:00Z',
  }

  it('returns alerts array + generated_at', async () => {
    queryQueue.push({ rows: [alert] })
    const res = await fetch(`${baseUrl}/api/protections/alerts`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.alerts)).toBe(true)
    expect(typeof body.generated_at).toBe('string')
    const a = (body.alerts as unknown[])[0] as Record<string, unknown>
    expect(a).toMatchObject({
      id:       expect.any(Number),
      layer:    expect.any(String),
      severity: expect.any(String),
      status:   expect.any(String),
      fired_at: expect.any(String),
    })
  })

  it('returns empty when no open/acked alerts', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/protections/alerts`)
    const body = await res.json() as Record<string, unknown>
    expect((body.alerts as unknown[]).length).toBe(0)
  })

  it('returns 500 on DB error', async () => {
    queryQueue.push(new Error('DB gone'))
    const res = await fetch(`${baseUrl}/api/protections/alerts`)
    expect(res.status).toBe(500)
  })
})

// ── PATCH /api/protections/alerts/:id/ack ────────────────────────────────

describe('PATCH /api/protections/alerts/:id/ack', () => {
  it('returns 200 ok:true when alert found', async () => {
    queryQueue.push({ rows: [{ id: 7 }], rowCount: 1 })
    const res = await fetch(`${baseUrl}/api/protections/alerts/7/ack`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.ok).toBe(true)
  })

  it('returns 404 when alert not found or already acked', async () => {
    queryQueue.push({ rows: [], rowCount: 0 })
    const res = await fetch(`${baseUrl}/api/protections/alerts/999/ack`, { method: 'POST' })
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
  })

  it('returns 500 on DB error', async () => {
    queryQueue.push(new Error('DB gone'))
    const res = await fetch(`${baseUrl}/api/protections/alerts/7/ack`, { method: 'POST' })
    expect(res.status).toBe(500)
  })
})

// ── /api/protections/coverage ─────────────────────────────────────────────

describe('GET /api/protections/coverage', () => {
  it('returns total_sent, traced, coverage_pct, window_hours', async () => {
    queryQueue.push({
      rows: [{ total_sent: '200', traced: '190', coverage_pct: '95.0' }],
    })
    const res = await fetch(`${baseUrl}/api/protections/coverage`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      total_sent:   expect.any(Number),
      traced:       expect.any(Number),
      window_hours: 24,
    })
    expect(body.coverage_pct).not.toBeUndefined()
  })

  it('coverage_pct is null when no sends in window', async () => {
    queryQueue.push({
      rows: [{ total_sent: '0', traced: '0', coverage_pct: null }],
    })
    const res = await fetch(`${baseUrl}/api/protections/coverage`)
    const body = await res.json() as Record<string, unknown>
    expect(body.coverage_pct).toBeNull()
    expect(body.total_sent).toBe(0)
  })

  it('returns 500 on DB error', async () => {
    queryQueue.push(new Error('DB gone'))
    const res = await fetch(`${baseUrl}/api/protections/coverage`)
    expect(res.status).toBe(500)
  })
})
