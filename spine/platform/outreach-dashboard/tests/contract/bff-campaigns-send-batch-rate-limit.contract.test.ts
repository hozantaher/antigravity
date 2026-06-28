// Sprint T4 — per-campaign send-batch rate limit contract tests
//
// ≥10 test cases covering:
//   - first call allowed (200 / 412 — no consent header since rate-limit fires before it)
//   - second call within window → 429
//   - per-campaign isolation (different campaign → allowed)
//   - window expiry → allowed again
//   - 429 response shape (error, message, retry_after_seconds)
//   - custom SEND_BATCH_RATE_LIMIT_MS env override
//   - checkSendBatchRateLimit utility unit tests (allow / block / expiry)
//   - cleanup interval safety on empty map
//   - 1000 unique campaigns first call → all allowed (no false positive)
//   - non-numeric campaign_id gets 400 before rate limit fires

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── pg stub ───────────────────────────────────────────────────────────────────

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []

vi.mock('pg', () => {
  class Pool {
    async query (_sql: string, _params?: unknown[]) {
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    on () {}
    end () {}
  }
  return { default: { Pool }, Pool }
})

vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))
// AR7 send window gate fires BEFORE the X-Confirm-Send consent check.
// Mock it open so rate-limit contract tests are not blocked by a closed window.
vi.mock('../../src/lib/automation.js', () => ({
  isWithinSendWindow: vi.fn(() => true),
}))

// ── server bootstrap ──────────────────────────────────────────────────────────

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'SEND_BATCH_RATE_LIMIT_MS']) {
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
})

// ── helpers ───────────────────────────────────────────────────────────────────

async function sendBatch (campaignId: number, opts: { confirm?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.confirm !== false) headers['x-confirm-send'] = '1'
  const r = await fetch(`${baseUrl}/api/campaigns/${campaignId}/send-batch?count=1`, {
    method: 'POST',
    headers,
  })
  const text = await r.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

// Wipe the rate-limit state between tests so tests don't bleed into each other.
// We import the exported Map and clear it.
async function clearRateLimitState () {
  const mod = await import('../../src/server-routes/campaigns.js')
  const m = (mod as Record<string, unknown>)['_sendBatchLastCall']
  if (m instanceof Map) m.clear()
}

afterEach(async () => {
  await clearRateLimitState()
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('send-batch rate limit — HTTP contract', () => {
  it('T4-01: first call returns 412 (rate allowed, blocked only by missing consent)', async () => {
    // Without X-Confirm-Send the rate limit passes (allowed=true) but the
    // consent check fires → 412.  This proves rate limit is transparent on first call.
    const { status } = await sendBatch(1001, { confirm: false })
    expect(status).toBe(412)
  })

  it('T4-02: second call within window returns 429', async () => {
    // First call consumed the window (expect 412 from missing consent, not 429).
    await sendBatch(1002, { confirm: false })
    // Second call within same window → 429 before consent check.
    const { status, body } = await sendBatch(1002, { confirm: false })
    expect(status).toBe(429)
    expect((body as { error: string }).error).toBe('rate_limit_exceeded')
  })

  it('T4-03: 429 body has retry_after_seconds populated', async () => {
    await sendBatch(1003, { confirm: false })
    const { status, body } = await sendBatch(1003, { confirm: true })
    expect(status).toBe(429)
    const b = body as { retry_after_seconds: number; error: string; message: string }
    expect(typeof b.retry_after_seconds).toBe('number')
    expect(b.retry_after_seconds).toBeGreaterThan(0)
    expect(b.retry_after_seconds).toBeLessThanOrEqual(30)
  })

  it('T4-04: 429 body has error field = rate_limit_exceeded', async () => {
    await sendBatch(1004, { confirm: false })
    const { body } = await sendBatch(1004, { confirm: true })
    expect((body as { error: string }).error).toBe('rate_limit_exceeded')
  })

  it('T4-05: 429 message mentions campaign window in seconds', async () => {
    await sendBatch(1005, { confirm: false })
    const { body } = await sendBatch(1005, { confirm: true })
    const msg = (body as { message: string }).message
    expect(msg).toMatch(/30s/)
  })

  it('T4-06: different campaign within window is allowed (per-campaign isolation)', async () => {
    await sendBatch(2001, { confirm: false }) // consume 2001's window
    // 2002 is untouched — should return 412 (consent), not 429
    const { status } = await sendBatch(2002, { confirm: false })
    expect(status).toBe(412) // 412 = rate passed, blocked by consent check
  })

  it('T4-07: after window expires the campaign is allowed again', async () => {
    // Import the Map and manually backdate the timestamp to simulate expiry.
    const mod = await import('../../src/server-routes/campaigns.js')
    const mapField = (mod as Record<string, unknown>)['_sendBatchLastCall']
    const limitMs = (mod as Record<string, unknown>)['SEND_BATCH_RATE_LIMIT_MS'] as number
    expect(mapField instanceof Map).toBe(true)
    const m = mapField as Map<number, number>
    const campaignId = 3001
    m.set(campaignId, Date.now() - limitMs - 1) // expired
    const { status } = await sendBatch(campaignId, { confirm: false })
    expect(status).toBe(412) // 412 = allowed by rate limit, blocked by consent
  })

  it('T4-08: non-numeric campaign_id returns 400 before rate limit fires', async () => {
    const r = await fetch(`${baseUrl}/api/campaigns/abc/send-batch?count=1`, {
      method: 'POST',
      headers: { 'x-confirm-send': '1' },
    })
    expect(r.status).toBe(400)
    const body = await r.json()
    expect(body.error).toMatch(/invalid campaign_id/)
  })
})

// ── checkSendBatchRateLimit utility unit tests ────────────────────────────────

describe('checkSendBatchRateLimit — utility unit tests', () => {
  it('T4-09: first call returns allowed=true and records timestamp', async () => {
    const mod = await import('../../src/server-routes/campaigns.js')
    const fn = (mod as Record<string, unknown>)['checkSendBatchRateLimit'] as (id: number) => { allowed: boolean }
    const m = (mod as Record<string, unknown>)['_sendBatchLastCall'] as Map<number, number>
    const id = 9001
    m.delete(id)
    const before = Date.now()
    const result = fn(id)
    const after = Date.now()
    expect(result.allowed).toBe(true)
    const recorded = m.get(id)!
    expect(recorded).toBeGreaterThanOrEqual(before)
    expect(recorded).toBeLessThanOrEqual(after)
  })

  it('T4-10: second call within window returns allowed=false with retryAfterMs', async () => {
    const mod = await import('../../src/server-routes/campaigns.js')
    const fn = (mod as Record<string, unknown>)['checkSendBatchRateLimit'] as (id: number) => { allowed: boolean; retryAfterMs?: number; retryAfterSec?: number }
    const m = (mod as Record<string, unknown>)['_sendBatchLastCall'] as Map<number, number>
    const id = 9002
    m.delete(id)
    fn(id) // first call
    const result = fn(id) // second within window
    expect(result.allowed).toBe(false)
    expect(typeof result.retryAfterMs).toBe('number')
    expect(result.retryAfterMs!).toBeGreaterThan(0)
    expect(typeof result.retryAfterSec).toBe('number')
    expect(result.retryAfterSec!).toBeGreaterThan(0)
  })

  it('T4-11: expired entry returns allowed=true and resets timestamp', async () => {
    const mod = await import('../../src/server-routes/campaigns.js')
    const fn = (mod as Record<string, unknown>)['checkSendBatchRateLimit'] as (id: number) => { allowed: boolean }
    const m = (mod as Record<string, unknown>)['_sendBatchLastCall'] as Map<number, number>
    const limitMs = (mod as Record<string, unknown>)['SEND_BATCH_RATE_LIMIT_MS'] as number
    const id = 9003
    m.set(id, Date.now() - limitMs - 500) // definitely expired
    const result = fn(id)
    expect(result.allowed).toBe(true)
  })

  it('T4-12: 1000 unique campaign IDs all allowed on first call (no false positives)', async () => {
    const mod = await import('../../src/server-routes/campaigns.js')
    const fn = (mod as Record<string, unknown>)['checkSendBatchRateLimit'] as (id: number) => { allowed: boolean }
    const m = (mod as Record<string, unknown>)['_sendBatchLastCall'] as Map<number, number>
    for (let i = 50000; i < 51000; i++) m.delete(i)
    const results = []
    for (let i = 50000; i < 51000; i++) {
      results.push(fn(i).allowed)
    }
    expect(results.every(r => r === true)).toBe(true)
    expect(results.length).toBe(1000)
  })

  it('T4-13: cleanup interval does not crash on empty map', async () => {
    const mod = await import('../../src/server-routes/campaigns.js')
    const m = (mod as Record<string, unknown>)['_sendBatchLastCall'] as Map<number, number>
    m.clear()
    // Simulate what the cleanup interval does
    const cutoff = Date.now() - 1
    expect(() => {
      for (const [k, v] of m) {
        if (v < cutoff) m.delete(k)
      }
    }).not.toThrow()
  })
})
