// KT-A5 — POST /api/campaigns/:id/send-test contract tests.
//
// The endpoint is the operator-driven "send to one inbox" path that
// the staircase playbook (docs/playbooks/first-campaign-launch.md)
// uses for step 1. It MUST go through the anti-trace-relay; no direct
// SMTP fallback (HARD RULE feedback_no_direct_transport).
//
// Coverage targets (memory feedback_extreme_testing — ≥ 10 cases):
//   - happy path returns 200 + envelope_id + via:'anti-trace-relay'
//   - relay payload contains the campaign-derived subject + body defaults
//   - 400 missing `to`
//   - 400 missing `mailbox_id`
//   - 400 invalid campaign id (non-numeric)
//   - 400 recipient on suppression UNION
//   - 404 campaign not found
//   - 404 mailbox not found
//   - 400 mailbox without password
//   - 425 outside send window (no force flag)
//   - 503 anti-trace-relay not configured
//   - 502 relay returns non-2xx
//   - 502 relay unreachable
//   - audit row written on success

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

type RelayCall = { url: string; body: unknown; headers: Record<string, string> }
const relayCalls: RelayCall[] = []
let relayResponse: { status: number; body: string } | Error = {
  status: 202,
  body: '{"envelope_id":"env_kt_a5","status":"sealed"}',
}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'ANTI_TRACE_URL', 'ANTI_TRACE_TOKEN']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.ANTI_TRACE_URL = 'https://relay.test'
  process.env.ANTI_TRACE_TOKEN = 'kt-a5-token'

  const originalFetch = global.fetch
  global.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr.includes('relay.test')) {
      relayCalls.push({
        url: urlStr,
        body: init?.body ? JSON.parse(init.body as string) : null,
        headers: init?.headers as Record<string, string>,
      })
      if (relayResponse instanceof Error) throw relayResponse
      return new Response(relayResponse.body, { status: relayResponse.status })
    }
    return originalFetch(url, init)
  }) as typeof fetch

  const mod = await import('../../server.js')
  // Vite's loadEnv repopulates vars from .env during the import above
  // (memory: feedback_vite_loadenv_gotcha). Re-apply test values AFTER
  // the import so the handler sees relay.test, not the production relay URL.
  process.env.ANTI_TRACE_URL = 'https://relay.test'
  process.env.ANTI_TRACE_TOKEN = 'kt-a5-token'
  delete process.env.ANTI_TRACE_RELAY_URL
  delete process.env.ANTI_TRACE_RELAY_TOKEN
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
  relayCalls.length = 0
  relayResponse = { status: 202, body: '{"envelope_id":"env_kt_a5","status":"sealed"}' }
})

function q(rows: unknown[]) { queryQueue.push({ rows }) }
function qErr(msg: string) { queryQueue.push(new Error(msg)) }

async function send(
  campaignId: string,
  body: Record<string, unknown>,
  opts: { force?: boolean } = {},
) {
  const path = `/api/campaigns/${campaignId}/send-test${opts.force ? '?force=1' : ''}`
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// Standard happy-path query queue: suppression empty, campaign found,
// mailbox found, audit insert.
function queueHappy() {
  q([])                                                // suppression UNION → no match
  q([{ id: 42, name: 'Soft Launch 001', status: 'draft' }]) // campaign
  q([{                                                 // mailbox
    id: 7, email: 'sender@dealer.cz', host: 'smtp.seznam.cz',
    port: 465, smtp_username: 'sender@dealer.cz', password: 'pw',
  }])
  q([])                                                // audit insert (best-effort)
}

// ─── Happy path ───────────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/send-test — happy path', () => {
  it('200 + envelope_id when relay accepts', async () => {
    queueHappy()
    const { status, body } = await send('42', { to: 'tester@example.com', mailbox_id: 7 }, { force: true })
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.via).toBe('anti-trace-relay')
    expect(b.envelope_id).toBe('env_kt_a5')
    expect(b.campaign_id).toBe(42)
    expect(b.mailbox_id).toBe(7)
  })

  it('builds default subject + body from campaign name when omitted', async () => {
    queueHappy()
    await send('42', { to: 'tester@example.com', mailbox_id: 7 }, { force: true })
    expect(relayCalls.length).toBe(1)
    const payload = relayCalls[0].body as Record<string, unknown>
    expect(payload.subject).toMatch(/Test kampaně #42/)
    expect(String(payload.body)).toContain('Soft Launch 001')
    expect(payload.recipient).toBe('tester@example.com')
    expect(payload.from_address).toBe('sender@dealer.cz')
    expect(payload.smtp_password).toBe('pw')
  })

  it('writes operator audit row on success', async () => {
    queueHappy()
    await send('42', { to: 'tester@example.com', mailbox_id: 7 }, { force: true })
    const auditCall = calls.find((c) => /operator_audit_log/i.test(c.sql))
    expect(auditCall).toBeDefined()
  })
})

// ─── Validation ───────────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/send-test — validation', () => {
  it('400 invalid campaign id (non-numeric)', async () => {
    const { status, body } = await send('abc', { to: 'x@y.test', mailbox_id: 1 }, { force: true })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/invalid campaign id/)
  })

  it('400 missing to', async () => {
    const { status, body } = await send('42', { mailbox_id: 7 }, { force: true })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/missing to/)
  })

  it('400 missing mailbox_id', async () => {
    const { status, body } = await send('42', { to: 'x@y.test' }, { force: true })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/missing mailbox_id/)
  })

  it('400 invalid mailbox_id (negative)', async () => {
    const { status } = await send('42', { to: 'x@y.test', mailbox_id: -3 }, { force: true })
    expect(status).toBe(400)
  })
})

// ─── Send-window guard ────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/send-test — send window', () => {
  it('425 outside Po–Pá 8–17 without force flag', async () => {
    // Pin the BFF clock to a Sunday at 03:00 Prague — outside window.
    const realDate = Date
    const fakeNow = new Date('2026-04-26T03:00:00Z') // Sunday
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.Date = class extends realDate {
      constructor(...args: ConstructorParameters<DateConstructor>) {
        if (args.length === 0) {
          super(fakeNow.getTime())
          return
        }
        super(...args)
      }
      static now() { return fakeNow.getTime() }
    } as DateConstructor

    try {
      const { status, body } = await send('42', { to: 'x@y.test', mailbox_id: 7 })
      expect(status).toBe(425)
      expect((body as { error: string }).error).toMatch(/Mimo send window/)
    } finally {
      global.Date = realDate
    }
  })
})

// ─── Suppression gate ─────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/send-test — suppression', () => {
  it('400 when recipient is on suppression UNION', async () => {
    q([{ '?column?': 1 }]) // suppression matches
    const { status, body } = await send('42', { to: 'blocked@y.test', mailbox_id: 7 }, { force: true })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/suppression listu/)
  })
})

// ─── Resource lookups ────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/send-test — resource lookups', () => {
  it('404 when campaign not found', async () => {
    q([])  // suppression
    q([])  // campaign empty
    const { status } = await send('42', { to: 'x@y.test', mailbox_id: 7 }, { force: true })
    expect(status).toBe(404)
  })

  it('404 when mailbox not found', async () => {
    q([])                                                // suppression
    q([{ id: 42, name: 'X', status: 'draft' }])          // campaign
    q([])                                                // mailbox empty
    const { status } = await send('42', { to: 'x@y.test', mailbox_id: 99 }, { force: true })
    expect(status).toBe(404)
  })

  it('400 when mailbox has empty password', async () => {
    q([])
    q([{ id: 42, name: 'X', status: 'draft' }])
    q([{ id: 7, email: 'sender@dealer.cz', host: 'smtp.seznam.cz', port: 465, smtp_username: 'sender@dealer.cz', password: '' }])
    const { status, body } = await send('42', { to: 'x@y.test', mailbox_id: 7 }, { force: true })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/heslo/)
  })
})

// ─── Relay outcomes ──────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/send-test — relay', () => {
  it('502 when relay returns non-2xx', async () => {
    relayResponse = { status: 500, body: '{"error":"internal"}' }
    queueHappy()
    const { status, body } = await send('42', { to: 'x@y.test', mailbox_id: 7 }, { force: true })
    expect(status).toBe(502)
    expect((body as { error: string }).error).toMatch(/relay rejected/)
  })

  it('502 when relay unreachable (network error)', async () => {
    relayResponse = new Error('ECONNREFUSED')
    queueHappy()
    const { status, body } = await send('42', { to: 'x@y.test', mailbox_id: 7 }, { force: true })
    expect(status).toBe(502)
    expect((body as { error: string }).error).toMatch(/relay unreachable/)
  })
})

// ─── Configuration boundary ──────────────────────────────────────────────

describe('POST /api/campaigns/:id/send-test — relay configuration', () => {
  it('503 when ANTI_TRACE_URL not configured', async () => {
    // Handler returns 503 (Service Unavailable) when relay env is missing —
    // the BFF itself cannot fulfil the request because configuration is
    // absent. 502 (Bad Gateway) is reserved for cases where the relay
    // exists but returned a bad response (covered separately).
    // Per server-routes/campaigns.js send-test path:
    //   if (!relayURL || !relayToken) return res.status(503).json(...)
    const origUrl = process.env.ANTI_TRACE_URL
    const origRelayUrl = process.env.ANTI_TRACE_RELAY_URL
    const origToken = process.env.ANTI_TRACE_TOKEN
    const origRelayToken = process.env.ANTI_TRACE_RELAY_TOKEN
    delete process.env.ANTI_TRACE_URL
    delete process.env.ANTI_TRACE_RELAY_URL
    delete process.env.ANTI_TRACE_TOKEN
    delete process.env.ANTI_TRACE_RELAY_TOKEN
    try {
      q([])  // suppression
      q([{ id: 42, name: 'X', status: 'draft' }])
      q([{ id: 7, email: 'sender@dealer.cz', host: 'smtp.seznam.cz', port: 465, smtp_username: 'sender@dealer.cz', password: 'pw' }])
      // outreach_config fallback lookup also returns empty
      q([])
      const { status } = await send('42', { to: 'x@y.test', mailbox_id: 7 }, { force: true })
      expect(status).toBe(503)
    } finally {
      process.env.ANTI_TRACE_URL = origUrl
      process.env.ANTI_TRACE_RELAY_URL = origRelayUrl
      process.env.ANTI_TRACE_TOKEN = origToken
      process.env.ANTI_TRACE_RELAY_TOKEN = origRelayToken
    }
  })
})

// ─── Defensive — DB error doesn't crash ──────────────────────────────────

describe('POST /api/campaigns/:id/send-test — error surfaces', () => {
  it('5xx on suppression DB error', async () => {
    qErr('connection refused')
    const { status } = await send('42', { to: 'x@y.test', mailbox_id: 7 }, { force: true })
    expect(status).toBeGreaterThanOrEqual(500)
  })
})
