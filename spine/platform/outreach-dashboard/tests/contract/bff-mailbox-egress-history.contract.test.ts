// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/mailboxes/:id/egress-history
//
//  Sprint AO6 — ≥10 test cases per feedback_extreme_testing HARD RULE.
//
//  Covers:
//    1. Happy path 24h — returns observations + aggregates
//    2. Empty mailbox — no observations → empty arrays
//    3. ?hours param out of range → 400
//    4. ?hours=1 — narrow window filter respected
//    5. Mailbox not found → 404
//    6. Invalid mailbox id → 400
//    7. Chaos detected flag — true when >1 distinct country
//    8. No chaos flag — single country → false
//    9. Graceful degradation when relation does not exist
//   10. country_counts aggregation correct
//   11. hour_country_matrix shape — entries have hour_offset + country + count
//   12. quarantine_status reflects auth_locked status
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [] }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    on() {}
    end() {}
    connect() { return Promise.resolve(this) }
    release() {}
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

function queueRows(rows: unknown[]) {
  queryQueue.push({ rows })
}
function queueError(msg: string) {
  queryQueue.push(new Error(msg))
}

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// Mailbox row returned for quarantine state check
function mailboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    status: 'active',
    status_reason: null,
    auth_locked_at: null,
    ...overrides,
  }
}

// Sample observation rows
function obsRow(country: string, op = 'send') {
  return { id: 1, egress_country: country, egress_endpoint_label: 'cz-prg-1', op_type: op, observed_at: '2026-05-08T10:00:00Z' }
}

// ── 1. Happy path 24h ──────────────────────────────────────────────────
describe('GET /api/mailboxes/:id/egress-history — happy path', () => {
  it('returns observations, summary, and quarantine_status', async () => {
    // Queue: mailbox check, raw obs, country agg, matrix
    queueRows([mailboxRow()])
    queueRows([obsRow('CZ'), obsRow('CZ')])
    queueRows([{ egress_country: 'CZ', cnt: 2 }])
    queueRows([{ hour_offset: 0, egress_country: 'CZ', count: 2 }])

    const { status, body } = await get('/api/mailboxes/42/egress-history?hours=24')
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.mailbox_id).toBe(42)
    expect(b.hours).toBe(24)
    expect(Array.isArray(b.observations)).toBe(true)
    expect((b.observations as unknown[]).length).toBe(2)
    expect(b.summary).toBeTruthy()
    expect(b.quarantine_status).toBeTruthy()
  })
})

// ── 2. Empty mailbox — no observations ────────────────────────────────
describe('GET /api/mailboxes/:id/egress-history — empty', () => {
  it('returns empty arrays when no observations exist', async () => {
    queueRows([mailboxRow()])
    queueRows([])         // no observations
    queueRows([])         // no country agg
    queueRows([])         // no matrix

    const { status, body } = await get('/api/mailboxes/42/egress-history')
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    const summary = b.summary as Record<string, unknown>
    expect((b.observations as unknown[]).length).toBe(0)
    expect((summary.distinct_countries as unknown[]).length).toBe(0)
    expect(summary.chaos_detected).toBe(false)
  })
})

// ── 3. hours param out of range → 400 ──────────────────────────────
describe('GET /api/mailboxes/:id/egress-history — param validation', () => {
  it('hours=0 → 400', async () => {
    const { status } = await get('/api/mailboxes/42/egress-history?hours=0')
    expect(status).toBe(400)
  })

  it('hours=999 → 400', async () => {
    const { status } = await get('/api/mailboxes/42/egress-history?hours=999')
    expect(status).toBe(400)
  })
})

// ── 4. hours=1 narrow window ───────────────────────────────────────
describe('GET /api/mailboxes/:id/egress-history — narrow window', () => {
  it('hours=1 is accepted and propagated to response', async () => {
    queueRows([mailboxRow()])
    queueRows([obsRow('DE')])
    queueRows([{ egress_country: 'DE', cnt: 1 }])
    queueRows([{ hour_offset: 0, egress_country: 'DE', count: 1 }])

    const { status, body } = await get('/api/mailboxes/42/egress-history?hours=1')
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.hours).toBe(1)
  })
})

// ── 5. Mailbox not found → 404 ─────────────────────────────────────
describe('GET /api/mailboxes/:id/egress-history — not found', () => {
  it('returns 404 when mailbox missing', async () => {
    queueRows([])  // empty mailbox query

    const { status, body } = await get('/api/mailboxes/9999/egress-history')
    expect(status).toBe(404)
    const b = body as Record<string, unknown>
    expect(b.error).toMatch(/not found/i)
  })
})

// ── 6. Invalid mailbox id → 400 ────────────────────────────────────
describe('GET /api/mailboxes/:id/egress-history — invalid id', () => {
  it('returns 400 for non-numeric id', async () => {
    const { status } = await get('/api/mailboxes/abc/egress-history')
    expect(status).toBe(400)
  })

  it('returns 400 for id=0', async () => {
    const { status } = await get('/api/mailboxes/0/egress-history')
    expect(status).toBe(400)
  })
})

// ── 7. Chaos detected flag — multiple countries ─────────────────────
describe('GET /api/mailboxes/:id/egress-history — chaos flag', () => {
  it('chaos_detected=true when multiple distinct countries seen', async () => {
    queueRows([mailboxRow()])
    queueRows([obsRow('CZ'), obsRow('DE')])
    queueRows([
      { egress_country: 'CZ', cnt: 1 },
      { egress_country: 'DE', cnt: 1 },
    ])
    queueRows([
      { hour_offset: 0, egress_country: 'CZ', count: 1 },
      { hour_offset: 0, egress_country: 'DE', count: 1 },
    ])

    const { body } = await get('/api/mailboxes/42/egress-history')
    const b = body as Record<string, unknown>
    const summary = b.summary as Record<string, unknown>
    expect(summary.chaos_detected).toBe(true)
    expect((summary.distinct_countries as string[]).sort()).toEqual(['CZ', 'DE'])
  })
})

// ── 8. No chaos — single country ──────────────────────────────────
describe('GET /api/mailboxes/:id/egress-history — no chaos', () => {
  it('chaos_detected=false when only one country', async () => {
    queueRows([mailboxRow()])
    queueRows([obsRow('CZ'), obsRow('CZ'), obsRow('CZ')])
    queueRows([{ egress_country: 'CZ', cnt: 3 }])
    queueRows([{ hour_offset: 0, egress_country: 'CZ', count: 3 }])

    const { body } = await get('/api/mailboxes/42/egress-history')
    const b = body as Record<string, unknown>
    const summary = b.summary as Record<string, unknown>
    expect(summary.chaos_detected).toBe(false)
    expect((summary.distinct_countries as string[]).length).toBe(1)
  })
})

// ── 9. Graceful degradation — relation does not exist ──────────────
describe('GET /api/mailboxes/:id/egress-history — missing table', () => {
  it('returns 200 with empty data when migration 075 not applied', async () => {
    queueRows([mailboxRow()])
    queryQueue.push(new Error('relation "mailbox_egress_observation" does not exist'))

    const { status, body } = await get('/api/mailboxes/42/egress-history')
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect((b.observations as unknown[]).length).toBe(0)
    const summary = b.summary as Record<string, unknown>
    expect(summary.chaos_detected).toBe(false)
  })
})

// ── 10. country_counts aggregation correct ─────────────────────────
describe('GET /api/mailboxes/:id/egress-history — aggregation', () => {
  it('country_counts maps country → count correctly', async () => {
    queueRows([mailboxRow()])
    queueRows([obsRow('CZ'), obsRow('SK'), obsRow('CZ')])
    queueRows([
      { egress_country: 'CZ', cnt: 2 },
      { egress_country: 'SK', cnt: 1 },
    ])
    queueRows([])

    const { body } = await get('/api/mailboxes/42/egress-history')
    const b = body as Record<string, unknown>
    const summary = b.summary as Record<string, unknown>
    const counts = summary.country_counts as Record<string, number>
    expect(counts['CZ']).toBe(2)
    expect(counts['SK']).toBe(1)
  })
})

// ── 11. hour_country_matrix shape ──────────────────────────────────
describe('GET /api/mailboxes/:id/egress-history — matrix shape', () => {
  it('matrix entries have hour_offset, country, count', async () => {
    queueRows([mailboxRow()])
    queueRows([])
    queueRows([])
    queueRows([
      { hour_offset: 0, egress_country: 'CZ', count: 3 },
      { hour_offset: 1, egress_country: 'CZ', count: 1 },
    ])

    const { body } = await get('/api/mailboxes/42/egress-history')
    const b = body as Record<string, unknown>
    const summary = b.summary as Record<string, unknown>
    const matrix = summary.hour_country_matrix as Array<Record<string, unknown>>
    expect(matrix.length).toBeGreaterThan(0)
    const first = matrix[0]
    expect(typeof first.hour_offset).toBe('number')
    expect(typeof first.country).toBe('string')
    expect(typeof first.count).toBe('number')
  })
})

// ── 12. quarantine_status reflects auth_locked ─────────────────────
describe('GET /api/mailboxes/:id/egress-history — quarantine status', () => {
  it('quarantine_status shows auth_locked state and timestamp', async () => {
    queueRows([mailboxRow({
      status: 'auth_locked',
      status_reason: 'too_many_auth_failures',
      auth_locked_at: '2026-05-08T09:00:00Z',
    })])
    queueRows([])
    queueRows([])
    queueRows([])

    const { body } = await get('/api/mailboxes/42/egress-history')
    const b = body as Record<string, unknown>
    const qs = b.quarantine_status as Record<string, unknown>
    expect(qs.status).toBe('auth_locked')
    expect(qs.status_reason).toBe('too_many_auth_failures')
    expect(qs.auth_locked_at).toBe('2026-05-08T09:00:00Z')
  })
})
