// AO6 — BFF /api/mailboxes/:id/send-test relay path contract tests.
// send-test ALWAYS routes via relay /v1/submit (smtpSend AO6 migration).
// proxy_url column is deprecated and no longer used for routing.
// There is no fallback to direct SOCKS5 dial — relay is mandatory.

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

// Capture relay POST calls + control responses for testing
type RelayCall = { url: string; body: unknown; headers: Record<string, string> }
const relayCalls: RelayCall[] = []
let relayResponse: { status: number; body: string } | Error = { status: 202, body: '{"envelope_id":"env_test","status":"sealed"}' }

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL',
                   'ANTI_TRACE_URL', 'ANTI_TRACE_TOKEN',
                   'ANTI_TRACE_RELAY_URL_OVERRIDE', 'ANTI_TRACE_RELAY_TOKEN']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  // AO6: use ANTI_TRACE_RELAY_URL_OVERRIDE so getRelayBase() returns immediately
  // without a DB query (avoids consuming an unexpected queue slot).
  process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'https://relay.test'
  process.env.ANTI_TRACE_RELAY_TOKEN = 'test-relay-token'

  // Mock fetch for relay calls
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
  // AO6 note: Vite's loadEnv repopulates .env vars after import, potentially
  // overwriting ANTI_TRACE_RELAY_TOKEN with the real prod token.
  // Re-apply test token AFTER import per feedback_vite_loadenv_gotcha pattern.
  process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'https://relay.test'
  process.env.ANTI_TRACE_RELAY_TOKEN = 'test-relay-token'
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
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
  relayCalls.length = 0
  relayResponse = { status: 202, body: '{"envelope_id":"env_test","status":"sealed"}' }
})

function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

async function sendTest(mailboxId: string, body: Record<string, unknown>) {
  const r = await fetch(`${baseUrl}/api/mailboxes/${mailboxId}/send-test?force=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// Mailbox row shape returned by AO6 query (no proxy_url, has preferred_country)
const fakeMb = {
  email: 'b.maarek@email.cz', host: 'smtp.seznam.cz', port: 465,
  smtp_username: 'b.maarek@email.cz', password: 'pw123', preferred_country: 'CZ',
}

// ─── Relay happy path ───────────────────────────────────────────────────────

describe('POST /api/mailboxes/:id/send-test — relay path (AO6)', () => {
  it('T-AO6-1: routes via relay /v1/submit and returns ok + envelope_id', async () => {
    // Query sequence (AO6): (1) suppression UNION, (2) mailbox row
    // smtpSendWithFallback does NOT do an extra preferred_country query because
    // preferredCountry is passed directly from the route args.
    q([])          // suppression UNION check
    q([fakeMb])    // SELECT mailbox row

    const { status, body } = await sendTest('631', {
      to: 'test@gmail.com', subject: 'smoke', text: 'test body',
    })

    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.via).toBe('anti-trace-relay')
    // envelope_id comes from relay mock response
    expect(b.envelope_id).toBe('env_test')

    // Relay called once with correct payload
    expect(relayCalls.length).toBe(1)
    expect(relayCalls[0].url).toContain('/v1/submit')
    expect(relayCalls[0].headers.Authorization).toBe('Bearer test-relay-token')
    const payload = relayCalls[0].body as Record<string, unknown>
    expect(payload.recipient).toBe('test@gmail.com')
    expect(payload.subject).toBe('smoke')
    expect(payload.body).toBe('test body')
    expect(payload.from_address).toBe('b.maarek@email.cz')
    expect(payload.smtp_host).toBe('smtp.seznam.cz')
    expect(payload.smtp_port).toBe(465)
    expect(payload.smtp_username).toBe('b.maarek@email.cz')
    expect(payload.smtp_password).toBe('pw123')
  })

  it('T-AO6-2: mailbox_id forwarded to relay in envelope', async () => {
    q([])
    q([fakeMb])
    await sendTest('631', { to: 'test@gmail.com' })
    expect(relayCalls.length).toBe(1)
    const payload = relayCalls[0].body as Record<string, unknown>
    // mailboxId should be in payload as string
    expect(payload.mailbox_id).toBe('631')
  })

  it('T-AO6-3: preferred_country forwarded to relay when set on mailbox', async () => {
    q([])
    q([fakeMb])
    await sendTest('631', { to: 'test@gmail.com' })
    expect(relayCalls.length).toBe(1)
    const payload = relayCalls[0].body as Record<string, unknown>
    expect(payload.preferred_country).toBe('CZ')
  })

  it('T-AO6-4: 502 when relay returns non-2xx with error in body', async () => {
    relayResponse = { status: 503, body: '{"error":"relay_overloaded"}' }
    // smtpSendWithFallback retries only on ECONNREFUSED/ETIMEDOUT/fetch errors,
    // NOT on HTTP 503 relay rejections. So two relay calls at most (2 attempts).
    q([])
    q([{ ...fakeMb, preferred_country: '' }])
    const { status, body } = await sendTest('631', { to: 'test@gmail.com' })
    expect(status).toBe(502)
    const b = body as Record<string, unknown>
    expect(b.ok).toBe(false)
    expect(b.via).toBe('anti-trace-relay')
    expect(typeof b.error).toBe('string')
    expect(b.error).toMatch(/relay|overload|503/i)
  })

  it('T-AO6-5: 502 when relay unreachable (network error)', async () => {
    relayResponse = new Error('connect ECONNREFUSED 127.0.0.1:9999')
    q([])
    q([{ ...fakeMb, preferred_country: '' }])
    const { status, body } = await sendTest('631', { to: 'test@gmail.com' })
    expect(status).toBe(502)
    const b = body as Record<string, unknown>
    expect(b.ok).toBe(false)
    expect(b.via).toBe('anti-trace-relay')
    expect(b.error).toMatch(/ECONNREFUSED|relay|not configured/i)
  })

  it('T-AO6-6: uses subject default "Test" + text default "Test." when omitted', async () => {
    q([])
    q([fakeMb])
    await sendTest('631', { to: 'test@gmail.com' })
    expect(relayCalls.length).toBe(1)
    const payload = relayCalls[0].body as Record<string, unknown>
    expect(payload.subject).toBe('Test')
    expect(payload.body).toBe('Test.')
  })

  it('T-AO6-7: proxy_url not present in relay payload (deprecated AO6)', async () => {
    q([])
    q([fakeMb])
    await sendTest('631', { to: 'test@gmail.com' })
    expect(relayCalls.length).toBe(1)
    const payload = relayCalls[0].body as Record<string, unknown>
    // proxy_url must not leak into relay envelope
    expect('proxy_url' in payload).toBe(false)
  })
})

// ─── Suppression gate (already covered via UNION fix in commit caba00a)

describe('POST /api/mailboxes/:id/send-test — suppression gate', () => {
  it('400 when recipient is in suppression UNION', async () => {
    // Suppression check returns a match
    q([{ '?column?': 1 }])
    const { status, body } = await sendTest('631', { to: 'blocked@test.cz' })
    expect(status).toBe(400)
    const b = body as Record<string, unknown>
    expect(b.error).toMatch(/suppression listu/)
  })
})

// ─── Validation

describe('POST /api/mailboxes/:id/send-test — validation', () => {
  it('400 missing to address', async () => {
    const { status } = await sendTest('631', {})
    expect(status).toBe(400)
  })

  it('404 mailbox not found', async () => {
    q([])  // suppression check
    q([])  // mailbox SELECT returns empty
    const { status } = await sendTest('99999', { to: 'test@gmail.com' })
    expect(status).toBe(404)
  })
})
