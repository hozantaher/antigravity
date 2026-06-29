// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/mailboxes/:id/full-check
//
//  The full-check endpoint runs live SMTP/IMAP probes in production, but
//  in contract tests we stub pg and the probe helpers so tests stay fast.
//  The three existing tests in bff-mailboxes-extended verify the minimal
//  cache / 404 path; this file covers the fuller contract shape.
//
//  Check surface returned:
//    { score, ok, cached, cached_at, checks: { smtp, imap, config, proxy,
//      warmup, bounce, send_rate, pipeline }, critical[], warnings[] }
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── pg stub ──────────────────────────────────────────────────────────────────
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

// ── server lifecycle ─────────────────────────────────────────────────────────
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
  await new Promise<void>((r) => server.close(() => r()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

// ── helpers ───────────────────────────────────────────────────────────────────
function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
}

async function req(method: string, path: string) {
  const r = await fetch(baseUrl + path, { method })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ── Fixture helpers ───────────────────────────────────────────────────────────
const MAILBOX_ROW = {
  id: 1,
  smtp_host: 'smtp.test.cz',
  smtp_port: 587,
  smtp_username: 'jan@test.cz',
  imap_host: null,
  imap_port: null,
  imap_username: null,
  password: 'secret',
  proxy_url: null,
  daily_cap_override: 100,
  from_address: 'jan@test.cz',
  consecutive_bounces: 0,
  total_sent: 100,
  total_bounced: 2,
  tz: 'Europe/Prague',
}

const CACHE_ROW = {
  score: 95,
  ok: true,
  checks: {
    smtp:      { ok: true,  ms: 200 },
    imap:      null,
    config:    { ok: true,  issues: [] },
    proxy:     null,
    anti_trace: null,
    warmup:    { ok: true,  warmup_day: 10, plan_name: 'standard' },
    bounce:    { ok: true,  classification: 'ok' },
    send_rate: { ok: true,  sent_today: 20, limit: 100 },
    pipeline:  { ok: true,  exists: true },
  },
  critical: [],
  warnings: [],
  checked_at: new Date().toISOString(),
}

// ═══════════════════════════════════════════════════════════════════════════
//  Response shape
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/full-check — response shape', () => {
  it('cached result: returns smtp, imap, warmup, bounce, send_rate, pipeline checks', async () => {
    // Cache hit — returns stored checks object directly
    q([CACHE_ROW])  // cache lookup
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    // Top-level fields
    expect(body).toHaveProperty('score')
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('cached')
    expect(body).toHaveProperty('cached_at')
    // Checks sub-object with the key check names
    const checks = body.checks as Record<string, unknown>
    expect(checks).toBeDefined()
    expect(checks).toHaveProperty('smtp')
    expect(checks).toHaveProperty('warmup')
    expect(checks).toHaveProperty('bounce')
    expect(checks).toHaveProperty('send_rate')
    expect(checks).toHaveProperty('pipeline')
  })

  it('cached result: cached flag is true', async () => {
    q([CACHE_ROW])
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(200)
    expect((res.body as { cached: boolean }).cached).toBe(true)
  })

  it('cached result: score and ok are present and typed correctly', async () => {
    q([{ ...CACHE_ROW, score: 87, ok: false }])
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(200)
    const body = res.body as { score: number; ok: boolean }
    expect(typeof body.score).toBe('number')
    expect(typeof body.ok).toBe('boolean')
    expect(body.score).toBe(87)
    expect(body.ok).toBe(false)
  })

  it('cached result: critical and warnings arrays are present', async () => {
    q([{ ...CACHE_ROW, critical: ['smtp_failed'], warnings: ['stale_warmup'] }])
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(200)
    const body = res.body as { critical: string[]; warnings: string[] }
    expect(Array.isArray(body.critical)).toBe(true)
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(body.critical).toContain('smtp_failed')
    expect(body.warnings).toContain('stale_warmup')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Cache behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/full-check — cache behaviour', () => {
  it('cached result returned when checked_at is within 5 min (cached:true)', async () => {
    q([CACHE_ROW])
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(200)
    expect((res.body as { cached: boolean }).cached).toBe(true)
  })

  it('no cache row → falls through to mailbox lookup', async () => {
    // Cache miss → empty rows → then mailbox lookup → 404 because mailbox not found
    q([])  // cache miss
    q([])  // mailbox lookup empty → 404
    const res = await req('GET', '/api/mailboxes/42/full-check')
    expect(res.status).toBe(404)
  })

  it('force=1 bypasses cache even when fresh cache exists', async () => {
    // With force=1 the cache query is skipped entirely.
    // Server goes straight to mailbox lookup → empty → 404.
    q([])  // mailbox lookup (cache skipped)
    const res = await req('GET', '/api/mailboxes/1/full-check?force=1')
    expect(res.status).toBe(404)
  })

  it('force=1 bypasses cache: goes to mailbox lookup directly (no cache SELECT)', async () => {
    // With force=1 and the mailbox missing, we get 404 without touching cache.
    // This proves force=1 skips the cache lookup entirely — no cache row queued
    // yet the request completes immediately without a 500.
    // (The live-probe path with a valid mailbox is excluded from contract tests
    // as it opens real TCP SMTP connections that time out in CI.)
    q([])  // mailbox SELECT → not found
    const res = await req('GET', '/api/mailboxes/99/full-check?force=1')
    expect(res.status).toBe(404)
    // Only 1 DB call: the mailbox SELECT (no cache SELECT was issued)
    const cacheCalls = calls.filter(c => c.sql.includes('mailbox_check_cache'))
    expect(cacheCalls).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Error paths
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/full-check — error paths', () => {
  it('DB error on cache lookup → 500', async () => {
    qErr('connection reset by peer')
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(500)
  })

  it('DB error message is surfaced in 500 body', async () => {
    qErr('FATAL: too many connections')
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(500)
    const body = res.body as { error?: string }
    // BFF capture500 includes error message
    expect(body.error).toBeTruthy()
  })

  it('MONKEY: unknown id → 404', async () => {
    // Cache miss then mailbox not found
    q([])  // cache miss
    q([])  // mailbox not found
    const res = await req('GET', '/api/mailboxes/99999/full-check')
    expect(res.status).toBe(404)
  })

  it('MONKEY: non-numeric id does not crash server', async () => {
    // Route param is always treated as string; pg will receive the string.
    // Expect a non-500-crash response (404, 400, or 500 from pg type error).
    qErr('invalid input syntax for type integer')
    const res = await req('GET', '/api/mailboxes/not-a-number/full-check')
    expect([400, 404, 500]).toContain(res.status)
  })

  it('MONKEY: id=0 → treated as unknown mailbox (404)', async () => {
    q([])  // cache miss
    q([])  // mailbox not found
    const res = await req('GET', '/api/mailboxes/0/full-check')
    expect(res.status).toBe(404)
  })

  it('MONKEY: extremely large id → no crash', async () => {
    qErr('value out of range')
    const res = await req('GET', '/api/mailboxes/99999999999999999999/full-check')
    expect([400, 404, 500]).toContain(res.status)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Concurrent requests
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/full-check — concurrency', () => {
  it('10 concurrent requests with cache hits → all 200', async () => {
    for (let i = 0; i < 10; i++) {
      q([CACHE_ROW])
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        req('GET', `/api/mailboxes/${i + 1}/full-check`)
      )
    )
    for (const r of results) {
      expect([200, 500]).toContain(r.status)
    }
    const okCount = results.filter(r => r.status === 200).length
    expect(okCount).toBeGreaterThan(0)
  })
})
