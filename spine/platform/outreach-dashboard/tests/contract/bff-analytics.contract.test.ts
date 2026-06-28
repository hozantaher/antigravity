// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/analytics/{overview,timeline,campaigns}
//
//  Locks response shape, field types, boundary clamping, and 500 paths.
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

// ── Helpers ───────────────────────────────────────────────────────────────

function pushAll(...outcomes: QueryOutcome[]) {
  queryQueue.push(...outcomes)
}

// ── /api/analytics/overview ───────────────────────────────────────────────

describe('GET /api/analytics/overview', () => {
  it('returns correct shape with all int fields', async () => {
    pushAll(
      // 1) send_events aggregate (sends/bounces; opens always 0 — tracking off)
      { rows: [{ total_sent: 120, total_opened: 0, total_bounced: 5, sent_7d: 20 }] },
      // 2) reply_inbox aggregate (replies are the source of truth, not send_events.status='replied')
      { rows: [{ total_replied: 10, replied_7d: 3 }] },
      // 3) campaigns active count
      { rows: [{ active: 4 }] },
    )
    const res = await fetch(`${baseUrl}/api/analytics/overview`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      total_sent:    expect.any(Number),
      total_replied: expect.any(Number),
      total_opened:  expect.any(Number),
      total_bounced: expect.any(Number),
      sent_7d:       expect.any(Number),
      replied_7d:    expect.any(Number),
      active_campaigns: expect.any(Number),
    })
    expect(body.total_sent).toBe(120)
    expect(body.active_campaigns).toBe(4)
  })

  it('returns zeros when send_events empty', async () => {
    pushAll(
      { rows: [{ total_sent: 0, total_opened: 0, total_bounced: 0, sent_7d: 0 }] },
      { rows: [{ total_replied: 0, replied_7d: 0 }] },
      { rows: [{ active: 0 }] },
    )
    const res = await fetch(`${baseUrl}/api/analytics/overview`)
    const body = await res.json() as Record<string, unknown>
    expect(body.total_sent).toBe(0)
    expect(body.active_campaigns).toBe(0)
  })

  it('returns 500 on DB error', async () => {
    pushAll(new Error('connection refused'))
    const res = await fetch(`${baseUrl}/api/analytics/overview`)
    expect(res.status).toBe(500)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
  })
})

// ── /api/analytics/timeline ───────────────────────────────────────────────

describe('GET /api/analytics/timeline', () => {
  it('returns array with correct day shape', async () => {
    pushAll({
      rows: [
        { day: '2026-04-20', sent: 10, replied: 2, opened: 5 },
        { day: '2026-04-21', sent: 8,  replied: 1, opened: 3 },
      ],
    })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?days=30`)
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(30)
    const sample = body[0] as Record<string, unknown>
    expect(typeof sample.day).toBe('string')
    expect(sample.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(typeof sample.sent).toBe('number')
    expect(typeof sample.replied).toBe('number')
    expect(typeof sample.opened).toBe('number')
  })

  it('zero-fills missing days', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?days=7`)
    const body = await res.json() as unknown[]
    expect(body.length).toBe(7)
    const first = body[0] as Record<string, unknown>
    expect(first.sent).toBe(0)
    expect(first.replied).toBe(0)
    expect(first.opened).toBe(0)
  })

  it('days=0 returns empty array (0 days window)', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?days=0`)
    const body = await res.json() as unknown[]
    // "0" is truthy string → Math.min(0, 90) = 0 → loop runs 0 times
    expect(body.length).toBe(0)
  })

  it('clamps days=200 to 90', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?days=200`)
    const body = await res.json() as unknown[]
    expect(body.length).toBe(90)
    const last = calls.at(-1)
    expect(last?.params?.[0]).toBe(90)
  })

  it('defaults to 30 days when days param absent', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/analytics/timeline`)
    const body = await res.json() as unknown[]
    expect(body.length).toBe(30)
  })

  it('returns 500 on DB error', async () => {
    pushAll(new Error('timeout'))
    const res = await fetch(`${baseUrl}/api/analytics/timeline`)
    expect(res.status).toBe(500)
  })
})

// ── /api/analytics/timeline — custom date range (Q302 fix) ───────────────

describe('GET /api/analytics/timeline custom date range', () => {
  it('uses explicit FROM/TO timestamps when from+to provided', async () => {
    pushAll({
      rows: [
        { day: '2026-04-01', sent: 5, replied: 1, opened: 2 },
        { day: '2026-04-02', sent: 7, replied: 0, opened: 1 },
        { day: '2026-04-03', sent: 3, replied: 2, opened: 3 },
      ],
    })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?from=2026-04-01&to=2026-04-03`)
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
    // Span = 3 days (01, 02, 03)
    expect(body.length).toBe(3)
    const last = calls.at(-1)
    // Should use parameterized query with timestamps, NOT the days interval
    expect(last?.sql).toContain('sent_at >= $1')
    expect(last?.sql).toContain('sent_at <= $2')
    expect(last?.params?.length).toBe(2)
  })

  it('returns day shape for custom range rows', async () => {
    pushAll({
      rows: [
        { day: '2026-04-10', sent: 12, replied: 3, opened: 6 },
      ],
    })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?from=2026-04-10&to=2026-04-10`)
    const body = await res.json() as unknown[]
    const d = body[0] as Record<string, unknown>
    expect(d.day).toBe('2026-04-10')
    expect(typeof d.sent).toBe('number')
    expect(typeof d.replied).toBe('number')
    expect(typeof d.opened).toBe('number')
  })

  it('zero-fills missing days in custom range', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?from=2026-04-01&to=2026-04-07`)
    const body = await res.json() as unknown[]
    expect(body.length).toBe(7)
    const first = body[0] as Record<string, unknown>
    expect(first.sent).toBe(0)
  })

  it('caps custom range at 366 days', async () => {
    pushAll({ rows: [] })
    const from = '2025-01-01'
    const to   = '2026-12-31'  // >366 days
    const res = await fetch(`${baseUrl}/api/analytics/timeline?from=${from}&to=${to}`)
    const body = await res.json() as unknown[]
    expect(body.length).toBeLessThanOrEqual(366)
  })

  it('falls back to days mode when only one date provided', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?from=2026-04-01`)
    // Missing 'to' → falls back to 30-day mode
    const body = await res.json() as unknown[]
    expect(body.length).toBe(30)
    const last = calls.at(-1)
    expect(last?.sql).toContain('now() -')
  })

  it('rejects from > to with HTTP 400 (invalid range — iter56 defensive guard)', async () => {
    // The endpoint intentionally rejects an inverted range before touching the
    // DB (the frontend already guards it; a direct curl/URL bypass must be
    // caught too). Stale assertion previously expected a silent fall-back to
    // days mode — the iter56 behaviour is an explicit 400.
    const res = await fetch(`${baseUrl}/api/analytics/timeline?from=2026-04-10&to=2026-04-01`)
    expect(res.status).toBe(400)
    const body = await res.json() as { error?: string }
    expect(body.error).toBe('invalid_date_range')
  })

  it('falls back to days mode when dates are not ISO YYYY-MM-DD', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/analytics/timeline?from=april&to=may`)
    const body = await res.json() as unknown[]
    expect(body.length).toBe(30)
  })
})

// ── /api/analytics/campaigns ──────────────────────────────────────────────

describe('GET /api/analytics/campaigns', () => {
  it('returns array of campaign stats with correct shape', async () => {
    pushAll({
      rows: [
        {
          id: 1, name: 'Kampaň A', status: 'active',
          sent: 50, replied: 5, opened: 15, bounced: 2,
          first_sent: '2026-04-01T10:00:00Z',
          last_sent: '2026-04-20T15:00:00Z',
        },
      ],
    })
    const res = await fetch(`${baseUrl}/api/analytics/campaigns`)
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
    const c = body[0] as Record<string, unknown>
    expect(c).toMatchObject({
      id:     expect.any(Number),
      name:   expect.any(String),
      status: expect.any(String),
      sent:   expect.any(Number),
      replied: expect.any(Number),
      opened: expect.any(Number),
      bounced: expect.any(Number),
    })
  })

  it('returns empty array when no campaigns', async () => {
    pushAll({ rows: [] })
    const res = await fetch(`${baseUrl}/api/analytics/campaigns`)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('LIMIT 30 present in query', async () => {
    pushAll({ rows: [] })
    await fetch(`${baseUrl}/api/analytics/campaigns`)
    const sql = calls.at(-1)?.sql ?? ''
    expect(sql.toUpperCase()).toContain('LIMIT 30')
  })

  it('returns 500 on DB error', async () => {
    pushAll(new Error('DB gone'))
    const res = await fetch(`${baseUrl}/api/analytics/campaigns`)
    expect(res.status).toBe(500)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
  })
})
