// S0.2 — BFF /unsubscribe endpoint contract tests.
// Public endpoint (no x-api-key), HMAC-validated token, idempotent
// suppression insert + status flip + audit log entry.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildUnsubToken } from '../../src/lib/unsubToken.js'
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

const TEST_SECRET = 'test-unsub-secret-aaaaaaaaaaaaaaaa'

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'UNSUBSCRIBE_SECRET']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.UNSUBSCRIBE_SECRET = TEST_SECRET
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

function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

// Compute the same HMAC the runner produces by going through the canonical
// helper (features/platform/common/token/unsub.go has the matching Go-side test).
// Routing through the helper means this contract test verifies the BFF
// against the SAME formula the runner emits — drift can only happen if
// both Go and JS canonical helpers diverge, which their own tests catch.
function makeToken(campaignID: number, contactID: number, email: string, secret = TEST_SECRET) {
  return buildUnsubToken(campaignID, contactID, email, secret)
}

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  return { status: r.status, body: text, contentType: r.headers.get('content-type') }
}

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('GET /unsubscribe — happy path', () => {
  it('200 on valid token + writes suppression + status update + audit', async () => {
    q([{ email: 'jan@firma.cz' }]) // contact lookup
    q([])                          // suppression_list INSERT
    q([])                          // contacts UPDATE
    q([])                          // operator_audit_log INSERT

    const t = makeToken(42, 1001, 'jan@firma.cz')
    const r = await get(`/unsubscribe?c=42&id=1001&t=${t}`)

    expect(r.status).toBe(200)
    expect(r.contentType).toMatch(/text\/html/)
    expect(r.body).toMatch(/Odhlášení proběhlo úspěšně/)

    // Verify the writes happened in order
    const sqls = calls.map(c => c.sql)
    expect(sqls.some(s => /SELECT email FROM contacts/.test(s))).toBe(true)
    expect(sqls.some(s => /INSERT INTO suppression_list/.test(s))).toBe(true)
    expect(sqls.some(s => /UPDATE contacts SET status='unsubscribed'/.test(s))).toBe(true)
    expect(sqls.some(s => /INSERT INTO operator_audit_log/.test(s))).toBe(true)
  })

  it('idempotent: repeat with same token still succeeds', async () => {
    q([{ email: 'jan@firma.cz' }])
    q([]); q([]); q([])
    const t = makeToken(42, 1001, 'jan@firma.cz')
    const r1 = await get(`/unsubscribe?c=42&id=1001&t=${t}`)
    expect(r1.status).toBe(200)

    queryQueue.length = 0; calls.length = 0
    q([{ email: 'jan@firma.cz' }])
    q([]); q([]); q([])
    const r2 = await get(`/unsubscribe?c=42&id=1001&t=${t}`)
    expect(r2.status).toBe(200)
  })
})

// ─── Validation errors ──────────────────────────────────────────────────────

describe('GET /unsubscribe — validation', () => {
  it('400 on missing params', async () => {
    const r = await get('/unsubscribe')
    expect(r.status).toBe(400)
  })

  it('400 on non-numeric id', async () => {
    const r = await get('/unsubscribe?c=42&id=abc&t=' + 'a'.repeat(16))
    expect(r.status).toBe(400)
  })

  it('400 on token wrong length', async () => {
    const r = await get('/unsubscribe?c=42&id=1001&t=tooshort')
    expect(r.status).toBe(400)
  })

  it('400 on non-hex token chars', async () => {
    const r = await get('/unsubscribe?c=42&id=1001&t=ZZZZZZZZZZZZZZZZ')
    expect(r.status).toBe(400)
  })

  it('404 when contact not found', async () => {
    q([])
    const t = makeToken(42, 9999, 'ghost@test.cz')
    const r = await get(`/unsubscribe?c=42&id=9999&t=${t}`)
    expect(r.status).toBe(404)
  })

  it('403 when token does not match', async () => {
    q([{ email: 'jan@firma.cz' }])
    const wrongToken = makeToken(42, 1001, 'jan@firma.cz', 'wrong-secret')
    const r = await get(`/unsubscribe?c=42&id=1001&t=${wrongToken}`)
    expect(r.status).toBe(403)
    // No INSERT to suppression_list should have happened on bad token
    const inserts = calls.filter(c => /INSERT INTO suppression_list/.test(c.sql))
    expect(inserts.length).toBe(0)
  })

  it('403 when payload tampered (different campaign in URL than token bound to)', async () => {
    q([{ email: 'jan@firma.cz' }])
    // Token computed for campaign 42 but URL says 99 → HMAC mismatch
    const t = makeToken(42, 1001, 'jan@firma.cz')
    const r = await get(`/unsubscribe?c=99&id=1001&t=${t}`)
    expect(r.status).toBe(403)
  })
})

// ─── Rate limit ─────────────────────────────────────────────────────────────

describe('GET /unsubscribe — rate limit', () => {
  it('returns 429 after 10 hits per minute from same IP', async () => {
    // Each request returns 400 (no params) — but that still hits the
    // rate-limit bucket since the check fires before param validation.
    let last
    for (let i = 0; i < 12; i++) {
      last = await get('/unsubscribe')
    }
    expect(last!.status).toBe(429)
  })
})
