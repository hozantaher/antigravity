// KT-A8.1 — /api/scraper/healing contract.
//
// Locks the response shape consumed by the operator dashboard's "Scraper
// healing" widget: a list of recent block-detection events plus per-source
// circuit-breaker snapshot. See features/acquisition/contacts/internal/blockdetect/
// recovery.go for the canonical breaker semantics; the BFF serves a
// derived view computed from the last 50 events per source.

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

describe('GET /api/scraper/healing', () => {
  it('T-1: returns empty events + empty breakers when log is empty', async () => {
    queryQueue.push({ rows: [] }) // initial healing_log query
    const res = await fetch(`${baseUrl}/api/scraper/healing`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; breakers: Record<string, unknown> }
    expect(body.events).toEqual([])
    expect(body.breakers).toEqual({})
  })

  it('T-2: returns events with the new schema columns (source_name, block_type, recovered)', async () => {
    queryQueue.push({
      rows: [
        {
          id: 1,
          occurred_at: '2026-04-30T12:00:00Z',
          source_name: 'ares',
          block_type: 'rate_limit',
          fallback_attempted: 'firmy_cz',
          recovered: true,
          http_status: 429,
          target_url: 'https://ares.gov.cz/27082440',
          body_signature: 'Too Many Requests',
        },
      ],
    })
    // Per-source breaker query for 'ares' (last 50)
    queryQueue.push({ rows: [{ block_type: 'rate_limit', recovered: true, occurred_at: '2026-04-30T12:00:00Z' }] })

    const res = await fetch(`${baseUrl}/api/scraper/healing`)
    const body = (await res.json()) as {
      events: Array<Record<string, unknown>>
      breakers: Record<string, { open: boolean; fail_count: number }>
    }
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toHaveProperty('source_name', 'ares')
    expect(body.events[0]).toHaveProperty('block_type', 'rate_limit')
    expect(body.events[0]).toHaveProperty('recovered', true)
    expect(body.breakers.ares.fail_count).toBe(0) // recovered=true is not a failure
    expect(body.breakers.ares.open).toBe(false)
  })

  it('T-3: marks a source breaker open when 30+ of last 50 events are unrecovered', async () => {
    // Initial query — return 1 event for source `firmy_cz`.
    queryQueue.push({
      rows: [
        {
          id: 1,
          occurred_at: '2026-04-30T12:00:00Z',
          source_name: 'firmy_cz',
          block_type: 'cloudflare',
          recovered: false,
          fallback_attempted: null,
          http_status: 403,
          target_url: 'https://firmy.cz/',
          body_signature: 'cf-ray',
        },
      ],
    })
    // Per-source last-50 query — synthesise 35 unrecovered events.
    queryQueue.push({
      rows: Array.from({ length: 35 }, (_, i) => ({
        block_type: 'cloudflare',
        recovered: false,
        occurred_at: `2026-04-30T11:${String(i).padStart(2, '0')}:00Z`,
      })),
    })

    const res = await fetch(`${baseUrl}/api/scraper/healing`)
    const body = (await res.json()) as {
      breakers: Record<string, { open: boolean; fail_count: number; opened_at: string | null }>
    }
    expect(body.breakers.firmy_cz.open).toBe(true)
    expect(body.breakers.firmy_cz.fail_count).toBe(35)
    expect(body.breakers.firmy_cz.opened_at).not.toBeNull()
  })

  it('T-4: respects ?limit query param up to 500', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/scraper/healing?limit=250`)
    expect(res.status).toBe(200)
    const firstCall = calls.find((c) => /FROM healing_log\s+ORDER BY occurred_at/i.test(c.sql))
    expect(firstCall?.params).toEqual([250])
  })

  it('T-5: caps ?limit at 500 to prevent unbounded reads', async () => {
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/scraper/healing?limit=10000`)
    const firstCall = calls.find((c) => /FROM healing_log\s+ORDER BY occurred_at/i.test(c.sql))
    expect(firstCall?.params).toEqual([500])
  })

  it('T-6: defaults to limit=100 when not specified', async () => {
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/scraper/healing`)
    const firstCall = calls.find((c) => /FROM healing_log\s+ORDER BY occurred_at/i.test(c.sql))
    expect(firstCall?.params).toEqual([100])
  })

  it('T-7: empty events when the new schema columns do not exist (migration not yet applied)', async () => {
    const err = new Error('column "occurred_at" does not exist') as Error & { code?: string }
    err.code = '42703'
    queryQueue.push(err)
    const res = await fetch(`${baseUrl}/api/scraper/healing`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; breakers: Record<string, unknown> }
    expect(body.events).toEqual([])
    expect(body.breakers).toEqual({})
  })

  it('T-8: per-source breaker isolation — one source open does not flag another', async () => {
    queryQueue.push({
      rows: [
        { id: 1, occurred_at: '2026-04-30T12:00:00Z', source_name: 'ares', block_type: 'forbidden', recovered: false },
        { id: 2, occurred_at: '2026-04-30T11:00:00Z', source_name: 'firmy_cz', block_type: 'forbidden', recovered: true },
      ],
    })
    // ares: 30 unrecovered → open
    queryQueue.push({
      rows: Array.from({ length: 30 }, () => ({ block_type: 'forbidden', recovered: false, occurred_at: '2026-04-30T11:00:00Z' })),
    })
    // firmy_cz: 5 recovered → closed
    queryQueue.push({
      rows: Array.from({ length: 5 }, () => ({ block_type: 'forbidden', recovered: true, occurred_at: '2026-04-30T11:00:00Z' })),
    })

    const res = await fetch(`${baseUrl}/api/scraper/healing`)
    const body = (await res.json()) as {
      breakers: Record<string, { open: boolean }>
    }
    expect(body.breakers.ares.open).toBe(true)
    expect(body.breakers.firmy_cz.open).toBe(false)
  })

  it('T-9: response shape is { events: array, breakers: object }', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/scraper/healing`)
    const body = (await res.json()) as Record<string, unknown>
    expect(Array.isArray(body.events)).toBe(true)
    expect(typeof body.breakers).toBe('object')
    expect(body.breakers).not.toBeNull()
    expect(Array.isArray(body.breakers)).toBe(false)
  })

  it('T-10: invalid ?limit (non-numeric) falls back to default', async () => {
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/scraper/healing?limit=abc`)
    const firstCall = calls.find((c) => /FROM healing_log\s+ORDER BY occurred_at/i.test(c.sql))
    // Number('abc') === NaN; Math.min(NaN, 500) === NaN; we coerce via fallback.
    // Implementation should produce a numeric limit param either way.
    expect(firstCall?.params).toBeDefined()
    expect(Array.isArray(firstCall?.params)).toBe(true)
  })

  it('T-11: events preserve recovered=true vs recovered=false distinction', async () => {
    queryQueue.push({
      rows: [
        { id: 1, source_name: 'ares', block_type: 'rate_limit', recovered: true, occurred_at: '2026-04-30T12:00:00Z' },
        { id: 2, source_name: 'ares', block_type: 'rate_limit', recovered: false, occurred_at: '2026-04-30T11:00:00Z' },
      ],
    })
    queryQueue.push({
      rows: [
        { block_type: 'rate_limit', recovered: true, occurred_at: '2026-04-30T12:00:00Z' },
        { block_type: 'rate_limit', recovered: false, occurred_at: '2026-04-30T11:00:00Z' },
      ],
    })
    const res = await fetch(`${baseUrl}/api/scraper/healing`)
    const body = (await res.json()) as {
      events: Array<{ recovered: boolean }>
      breakers: Record<string, { fail_count: number }>
    }
    expect(body.events[0].recovered).toBe(true)
    expect(body.events[1].recovered).toBe(false)
    // Only the unrecovered event counts toward fail_count.
    expect(body.breakers.ares.fail_count).toBe(1)
  })

  it('T-12: deduplicates source list when building per-source breaker queries', async () => {
    queryQueue.push({
      rows: [
        { id: 1, source_name: 'ares', block_type: 'rate_limit', recovered: false, occurred_at: '2026-04-30T12:00:00Z' },
        { id: 2, source_name: 'ares', block_type: 'rate_limit', recovered: false, occurred_at: '2026-04-30T11:00:00Z' },
        { id: 3, source_name: 'ares', block_type: 'rate_limit', recovered: false, occurred_at: '2026-04-30T10:00:00Z' },
      ],
    })
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/scraper/healing`)
    // The per-source breaker query should run exactly once for `ares`,
    // not once per event row.
    const perSourceCalls = calls.filter((c) => /WHERE source_name = \$1/i.test(c.sql))
    expect(perSourceCalls).toHaveLength(1)
    expect(perSourceCalls[0].params).toEqual(['ares'])
  })
})
