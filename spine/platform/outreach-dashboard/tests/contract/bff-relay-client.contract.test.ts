// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — relay client retry behaviour + /api/mailboxes/:id/smtp-check
//
//  Tests the BFF HTTP surface exposed by relaySmtpCheck (via /v1/probe with
//  retry on socks5 failures). The relay service is stubbed with vi.mock so no
//  real SMTP/SOCKS network calls are made.
//
//  Coverage:
//    1. GET /api/mailboxes/:id/smtp-check — happy path (relay ok=true)
//    2. GET /api/mailboxes/:id/smtp-check — relay returns socks5 fail (ok=false, steps)
//    3. GET /api/mailboxes/:id/smtp-check — mailbox not found → 404
//    4. GET /api/mailboxes/:id/smtp-check — mailbox has no password → ok=false
//    5. GET /api/mailboxes/:id/smtp-check — relay unreachable (relay_not_configured) → ok=false
//    6. MONKEY: concurrent GET /smtp-check calls — server never crashes
//    7. MONKEY: non-numeric mailbox ID → graceful response (no 500)
//    8. MONKEY: relay returns null body → ok=false, never throws
//    9. MONKEY: timeout AbortSignal from relay → ok=false, graceful response
//   10. BFF survives relay error and next request succeeds
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── Controlled relay client mock ──────────────────────────────────────────────
type SmtpCheckResult = { ok: boolean; ms: number; steps: unknown[] }
let smtpCheckImpl: () => Promise<SmtpCheckResult> = async () => ({ ok: true, ms: 50, steps: [] })

vi.mock('../../src/lib/relayClient.js', () => ({
  getRelayBase: vi.fn(async () => 'http://relay.stub'),
  relayFetch: vi.fn(async () => ({ ok: true, status: 200, body: {}, error: null })),
  relaySmtpCheck: vi.fn(async () => smtpCheckImpl()),
  relaySmtpAuthProbe: vi.fn(async () => ({ ok: true, ms: 50 })),
  relaySocks5Probe: vi.fn(async () => ({ ok: true, ms: 30 })),
  relayProxyPool: vi.fn(async () => ({ working: [], cz_working: 0, eu_working: 0, neighbour_working: 0, cached_at: new Date().toISOString(), total_candidates: 0, probed: 0 })),
}))

// ── Controlled pg pool ────────────────────────────────────────────────────────
type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []

vi.mock('pg', () => {
  class Pool {
    async query(_sql: string, _params?: unknown[]) {
      // RC1c — the smtp-check route calls checkOpRateLimit (AP3 per-op limiter,
      // src/lib/mailboxOpRateLimit.js) which runs FOR UPDATE + count + INSERT
      // against mailbox_op_rate_log inside a pool.connect() txn. This file does
      // NOT test the limiter, so short-circuit it to the ALLOWED path WITHOUT
      // consuming the business queryQueue (otherwise the FOR UPDATE eats the
      // queued MAILBOX_ROW and the count's rows[0] is undefined → 500).
      const s = typeof _sql === 'string' ? _sql : ''
      if (/FROM outreach_mailboxes WHERE id=\$1 FOR UPDATE/i.test(s)) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (/FROM mailbox_op_rate_log/i.test(s)) return { rows: [{ used: 0, oldest_in_window: null }], rowCount: 1 }
      if (/INSERT INTO mailbox_op_rate_log/i.test(s)) return { rows: [], rowCount: 1 }
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

// ── Server setup ──────────────────────────────────────────────────────────────
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
  smtpCheckImpl = async () => ({ ok: true, ms: 50, steps: [] })
})

function queueRows(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// Minimal mailbox row shape that smtp-check needs.
const MAILBOX_ROW = {
  smtp_host: 'smtp.seznam.cz',
  smtp_port: 587,
  smtp_username: 'test@seznam.cz',
  password: 'secret123',
  proxy_url: null,
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Happy path — relay returns ok=true
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/smtp-check — happy path', () => {
  it('200 with ok=true when relay probe succeeds', async () => {
    queueRows([MAILBOX_ROW])
    smtpCheckImpl = async () => ({ ok: true, ms: 120, steps: [{ name: 'socks_dial', ok: true, ms: 30 }] })

    const res = await get('/api/mailboxes/1/smtp-check')

    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(true)
    expect(typeof (res.body as any).ms).toBe('number')
  })

  it('200 response includes steps array', async () => {
    queueRows([MAILBOX_ROW])
    smtpCheckImpl = async () => ({
      ok: true,
      ms: 80,
      steps: [{ name: 'socks_dial', ok: true, ms: 20 }, { name: 'smtp_auth', ok: true, ms: 60 }],
    })

    const res = await get('/api/mailboxes/1/smtp-check')

    expect(res.status).toBe(200)
    expect(Array.isArray((res.body as any).steps)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Relay returns socks5 fail
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/smtp-check — socks5 fail', () => {
  it('200 with ok=false when relay socks5 dial fails', async () => {
    queueRows([MAILBOX_ROW])
    smtpCheckImpl = async () => ({
      ok: false,
      ms: 5000,
      steps: [{ name: 'socks_dial', ok: false, ms: 5000, msg: 'socks5 connection refused' }],
    })

    const res = await get('/api/mailboxes/1/smtp-check')

    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(false)
    const steps = (res.body as any).steps as any[]
    const socksFail = steps.find((s: any) => s.name === 'socks_dial')
    expect(socksFail?.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Mailbox not found → 404
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/smtp-check — not found', () => {
  it('404 when mailbox ID does not exist', async () => {
    queueRows([]) // empty result

    const res = await get('/api/mailboxes/999999/smtp-check')

    expect(res.status).toBe(404)
    expect((res.body as any).error).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Mailbox has no password configured
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/smtp-check — no credentials', () => {
  it('200 with ok=false when mailbox has no password', async () => {
    queueRows([{ ...MAILBOX_ROW, password: null }])

    const res = await get('/api/mailboxes/1/smtp-check')

    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(false)
    const steps = (res.body as any).steps as any[]
    const authGuard = steps.find((s: any) => s.name === 'auth_guard')
    expect(authGuard).toBeDefined()
    expect(authGuard.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Relay not configured (relaySmtpCheck returns relay_not_configured)
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/smtp-check — relay not configured', () => {
  it('200 with ok=false when relay is unreachable', async () => {
    queueRows([MAILBOX_ROW])
    smtpCheckImpl = async () => ({
      ok: false,
      ms: 0,
      steps: [{ name: 'relay', ok: false, ms: 0, msg: 'relay_not_configured' }],
    })

    const res = await get('/api/mailboxes/1/smtp-check')

    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6–10. MONKEY tests
// ═══════════════════════════════════════════════════════════════════════════

describe('MONKEY: GET /api/mailboxes/:id/smtp-check — edge inputs', () => {
  it('M6: concurrent 10 smtp-check calls — server stays alive', async () => {
    // Each concurrent request needs its own DB row queued.
    for (let i = 0; i < 10; i++) queueRows([MAILBOX_ROW])

    const results = await Promise.all(
      Array.from({ length: 10 }, () => get('/api/mailboxes/1/smtp-check'))
    )

    // All must return a valid 2xx or 4xx — no crash (5xx or unhandled throw).
    for (const r of results) {
      expect([200, 400, 404, 429]).toContain(r.status)
    }
  })

  it('M7: non-numeric mailbox ID → graceful response, no 500', async () => {
    const res = await get('/api/mailboxes/not-a-number/smtp-check')
    expect([200, 404, 400]).toContain(res.status)
  })

  it('M8: relay returns null body (monkey response) → 200 with ok=false, no crash', async () => {
    queueRows([MAILBOX_ROW])
    smtpCheckImpl = async () => ({
      ok: false,
      ms: 0,
      // Simulate what relaySmtpCheck returns on null response (after our fix)
      steps: [],
    })

    const res = await get('/api/mailboxes/1/smtp-check')

    expect([200]).toContain(res.status)
    expect((res.body as any).ok).toBe(false)
  })

  it('M9: relay throws (AbortError timeout) → 500 with error envelope, no unhandled crash', async () => {
    queueRows([MAILBOX_ROW])
    smtpCheckImpl = async () => { throw new Error('AbortError: The operation was aborted') }

    const res = await get('/api/mailboxes/1/smtp-check')

    expect([500]).toContain(res.status)
    expect((res.body as any).error).toBeTruthy()
  })

  it('M10: server recovers after relay error — next request returns 200', async () => {
    // First: relay throws
    queueRows([MAILBOX_ROW])
    smtpCheckImpl = async () => { throw new Error('relay exploded') }
    await get('/api/mailboxes/1/smtp-check')

    // Second: relay is healthy again
    queueRows([MAILBOX_ROW])
    smtpCheckImpl = async () => ({ ok: true, ms: 50, steps: [] })
    const res = await get('/api/mailboxes/1/smtp-check')

    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(true)
  })
})
