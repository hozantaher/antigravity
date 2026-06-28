// ═══════════════════════════════════════════════════════════════════════════
//  S-C1 — /unsubscribe HMAC fail-closed
//
//  Prior shape: `secret = UNSUBSCRIBE_SECRET || OUTREACH_API_KEY || ''`. When
//  both env vars were unset, the handler signed/verified with an empty key,
//  meaning anyone could craft a token and unsubscribe arbitrary contacts
//  from the entire campaign list.
//
//  This test goes RED if anyone reverts the fail-closed behavior. With
//  neither secret env var set, the handler must:
//   - return 503 (not 200, not 403)
//   - never reach the suppression INSERT
//   - never reach the contacts UPDATE
//   - log to Sentry (operator alert)
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []
const sentryCaptures: Array<{ err: Error; ctx?: unknown }> = []

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
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: (err: Error, ctx?: unknown) => { sentryCaptures.push({ err, ctx }) },
  setTag: vi.fn(), setUser: vi.fn(), setContext: vi.fn(),
  startSpan: vi.fn((_o, fn) => fn?.()),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn((fn) => fn?.({ setTag: vi.fn(), setContext: vi.fn(), setUser: vi.fn() })),
}))
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'UNSUBSCRIBE_SECRET', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  // Critical: make sure NEITHER secret env var is set for these tests.
  delete process.env.UNSUBSCRIBE_SECRET
  delete process.env.OUTREACH_API_KEY
  // server.js reads .env on import — strip after import to be safe.
  vi.resetModules()
  const mod = await import('../../server.js')
  delete process.env.UNSUBSCRIBE_SECRET
  delete process.env.OUTREACH_API_KEY
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
  sentryCaptures.length = 0
})

function pushAll(...outcomes: QueryOutcome[]) { queryQueue.push(...outcomes) }

// Build a token using the ALGORITHM the handler expects, but with empty
// key — this is exactly what an attacker would compute if the empty-key
// fallback shipped. The test asserts the handler refuses to verify
// against an empty key in the first place, so even a "correct" forged
// token still fails closed.
function forgedTokenWithEmptyKey(c: number, id: number, email: string) {
  return createHmac('sha256', '').update(`${c}|${id}|${email}`).digest('hex').slice(0, 16)
}

describe('GET /unsubscribe — S-C1 fail-closed when no secret env vars', () => {
  it('1: returns 503 (not 200/403) when both UNSUBSCRIBE_SECRET and OUTREACH_API_KEY are unset', async () => {
    pushAll({ rows: [] }, { rows: [{ email: 'jan@firma.test' }] }) // brand_label pre-SELECT, then contact lookup
    const t = forgedTokenWithEmptyKey(42, 1001, 'jan@firma.test')
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${t}`)
    expect(res.status).toBe(503)
  })

  it('2: response is HTML and tells the user to contact support', async () => {
    pushAll({ rows: [] }, { rows: [{ email: 'jan@firma.test' }] }) // brand_label pre-SELECT, then contact lookup
    const t = forgedTokenWithEmptyKey(42, 1001, 'jan@firma.test')
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${t}`)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const body = await res.text()
    expect(body).toMatch(/dočasně nedostupná|Kontaktujte podporu/)
  })

  it('3: NO suppression INSERT when secret missing (regression: empty-key fallback would have inserted)', async () => {
    pushAll({ rows: [] }, { rows: [{ email: 'jan@firma.test' }] }) // brand_label pre-SELECT, then contact lookup
    const t = forgedTokenWithEmptyKey(42, 1001, 'jan@firma.test')
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${t}`)
    const inserts = calls.filter(c => /INSERT INTO suppression_list/i.test(c.sql))
    expect(inserts.length).toBe(0)
  })

  it('4: NO contacts UPDATE when secret missing', async () => {
    pushAll({ rows: [] }, { rows: [{ email: 'jan@firma.test' }] }) // brand_label pre-SELECT, then contact lookup
    const t = forgedTokenWithEmptyKey(42, 1001, 'jan@firma.test')
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${t}`)
    const updates = calls.filter(c => /UPDATE contacts SET status/i.test(c.sql))
    expect(updates.length).toBe(0)
  })

  it('5: NO outreach_suppressions write when secret missing', async () => {
    pushAll({ rows: [] }, { rows: [{ email: 'jan@firma.test' }] }) // brand_label pre-SELECT, then contact lookup
    const t = forgedTokenWithEmptyKey(42, 1001, 'jan@firma.test')
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${t}`)
    const inserts = calls.filter(c => /INSERT INTO outreach_suppressions/i.test(c.sql))
    expect(inserts.length).toBe(0)
  })

  it('6: NO operator_audit_log entry when secret missing', async () => {
    pushAll({ rows: [] }, { rows: [{ email: 'jan@firma.test' }] }) // brand_label pre-SELECT, then contact lookup
    const t = forgedTokenWithEmptyKey(42, 1001, 'jan@firma.test')
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${t}`)
    const inserts = calls.filter(c => /INSERT INTO operator_audit_log/i.test(c.sql))
    expect(inserts.length).toBe(0)
  })

  it('7: Sentry captures the misconfig event with route + code tags', async () => {
    pushAll({ rows: [] }, { rows: [{ email: 'jan@firma.test' }] }) // brand_label pre-SELECT, then contact lookup
    const t = forgedTokenWithEmptyKey(42, 1001, 'jan@firma.test')
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${t}`)
    expect(sentryCaptures.length).toBeGreaterThanOrEqual(1)
    const lastErr = sentryCaptures[sentryCaptures.length - 1]
    expect(lastErr.err.message).toMatch(/UNSUBSCRIBE_SECRET|OUTREACH_API_KEY/)
    const ctx = lastErr.ctx as { tags?: { route?: string; code?: string } }
    expect(ctx.tags?.route).toBe('/unsubscribe')
    expect(ctx.tags?.code).toBe('secret_missing')
  })

  it('8: even with a "valid-looking" empty-key forged token, returns 503 (handler never invokes HMAC compare)', async () => {
    pushAll({ rows: [] }, { rows: [{ email: 'jan@firma.test' }] }) // brand_label pre-SELECT, then contact lookup
    // Compute the exact token the old buggy code would have accepted.
    const forged = forgedTokenWithEmptyKey(42, 1001, 'jan@firma.test')
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${forged}`)
    expect(res.status).toBe(503)
    expect(res.status).not.toBe(200)
    expect(res.status).not.toBe(403)
  })

  it('9: 503 fires AFTER contact lookup (i.e. 404 for unknown contact still wins, info-leak parity)', async () => {
    pushAll({ rows: [] }, { rows: [] })  // brand_label pre-SELECT, then contact not found
    const t = forgedTokenWithEmptyKey(42, 9999, 'ghost@test.cz')
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=9999&t=${t}`)
    expect(res.status).toBe(404)
    expect(sentryCaptures.length).toBe(0)  // no Sentry alert if 404 short-circuits first
  })

  it('10: same handler, malformed params still return 400 (validation precedes secret check)', async () => {
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=abc&t=tooshort`)
    expect(res.status).toBe(400)
  })
})
