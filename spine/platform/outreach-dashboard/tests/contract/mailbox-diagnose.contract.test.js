// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — POST /api/mailboxes/:id/diagnose  (F3)
//
//  Locks the request/response shape for the per-mailbox live liveness probe
//  that runs SMTP + IMAP (via relay) + DNS concurrently.
//
//  Handler lives in: features/platform/outreach-dashboard/src/server-routes/mailboxes.js
//  Mounted via:      mountMailboxRoutes(app, { pool, ... })
//
//  Hard rules verified:
//    - feedback_no_pii_in_commands: password is fetched but NEVER echoed in response
//    - feedback_no_direct_smtp: all probing goes via relay /v1/probe, never direct dial
//    - Rate limit: 1 diagnose / 2 min (diagnose op_type, max=1 windowSec=120)
//
//  Tests (12):
//    1.  Invalid mailbox ID (non-numeric)                    → 400
//    2.  Mailbox not found                                   → 404
//    3.  Rate limit exceeded                                 → 429 + Retry-After header
//    4.  Relay not configured — smtpHost present             → 200 with relay_not_configured error
//    5.  Happy path — relay ok, imap ok, dns ok              → 200 { ok: true, smtp, imap, dns }
//    6.  SMTP auth failed                                    → 200 { ok: false, smtp.auth_ok: false }
//    7.  IMAP not configured (no imap_host)                  → 200 imap.error: 'imap_host not configured'
//    8.  Response never includes raw password                → password absent from response body
//    9.  Audit log INSERT fires on success                   → operator_audit_log row inserted
//   10.  ran_at + duration_ms present in all responses       → shape completeness
//   11.  DNS ok shape (mx_records, spf_record, dkim_record, dmarc_record fields) → present
//   12.  Pool query uses mailbox id correctly                → correct SQL param binding
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import supertest from 'supertest'

// ─── Pool mock ────────────────────────────────────────────────────────────────
const queryQueue = []
const calls = []

vi.mock('pg', () => {
  // Skip transaction control statements (BEGIN, COMMIT, ROLLBACK) so the
  // queryQueue only needs entries for real data queries.
  function isTxnControl(sql) {
    const s = (sql || '').trim().toUpperCase()
    return s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK'
  }
  class Client {
    async query(sql, params) {
      calls.push({ sql, params, client: true })
      if (isTxnControl(sql)) return { rows: [], rowCount: 0 }
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()
      if (next instanceof Error) throw next
      return next
    }
    async release() {}
  }
  class Pool {
    async connect() { return new Client() }
    async query(sql, params) {
      calls.push({ sql, params })
      if (isTxnControl(sql)) return { rows: [], rowCount: 0 }
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()
      if (next instanceof Error) throw next
      return next
    }
    on() {}
    end() {}
  }
  return { default: { Pool, Client }, Pool, Client }
})

// ─── Relay mock (fetch) ───────────────────────────────────────────────────────
// We intercept the global fetch so relay calls never go to the network.
const fetchResponses = []
const fetchCalls = []

vi.stubGlobal('fetch', async (url, opts) => {
  fetchCalls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null })
  if (!fetchResponses.length) {
    return { ok: false, status: 503, text: async () => '{"error":"stub_not_configured"}' }
  }
  const resp = fetchResponses.shift()
  if (resp instanceof Error) throw resp
  return resp
})

// ─── DNS mock ────────────────────────────────────────────────────────────────
vi.mock('node:dns', () => ({
  promises: {
    resolveMx:  async () => [{ priority: 10, exchange: 'mx.firma.cz' }],
    resolveTxt: async (host) => {
      if (host.startsWith('_dmarc.')) return [['v=DMARC1; p=quarantine']]
      if (host.startsWith('default._domainkey.')) return [['v=DKIM1; k=rsa; p=MIIB...']]
      return [['v=spf1 include:firma.cz ~all']]
    },
  },
}))

vi.mock('../../staleGuard.js',  () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// ─── Server lifecycle ─────────────────────────────────────────────────────────
let app
let request

beforeAll(async () => {
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL      = 'postgres://stub/stub'
  process.env.OUTREACH_API_KEY  = 'test-diagnose-key'
  vi.resetModules()
  const mod = await import('../../server.js')
  delete process.env.GO_SERVER_URL
  app = mod.app
  request = supertest(app)
})

afterAll(async () => {
  delete process.env.BFF_AUTH_DISABLED
  delete process.env.DATABASE_URL
  delete process.env.OUTREACH_API_KEY
  vi.unstubAllGlobals()
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
  fetchCalls.length = 0
  fetchResponses.length = 0
})

// ─── Helper: relay success response shape ─────────────────────────────────────
function relayConfigRow() {
  return { rows: [{ value: 'http://relay.internal' }], rowCount: 1 }
}

function mailboxRow(overrides = {}) {
  return {
    rows: [{
      id: 42,
      from_address: 'mb42@...redacted',
      smtp_host:     'smtp.firma.cz',
      smtp_port:     587,
      smtp_username: 'mb42',
      password:      'secretPassword123!',
      imap_host:     'imap.firma.cz',
      imap_port:     993,
      imap_username: null,
      environment:   'production',
      ...overrides,
    }],
    rowCount: 1,
  }
}

function rateAllowed() {
  // checkAndRecord uses pool.connect() → client queries
  return [
    { rows: [{ id: 42 }], rowCount: 1 },   // SELECT 1 FROM outreach_mailboxes FOR UPDATE
    { rows: [{ used: 0, oldest_in_window: null }], rowCount: 1 }, // COUNT ops
    { rows: [], rowCount: 0 },              // INSERT op log row
  ]
}

function makeRelayProbeResponse(smtpOk = true, imapOk = true) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: smtpOk && imapOk,
      checks: {
        smtp: {
          ok:    smtpOk,
          ms:    120,
          steps: [
            { name: 'tls',     ok: smtpOk, ms: 30, msg: 'TLSv1.3' },
            { name: 'banner',  ok: smtpOk, ms: 10, msg: '220 smtp.firma.cz ESMTP' },
            { name: 'auth',    ok: smtpOk, ms: 40, msg: smtpOk ? null : 'AUTH failed' },
          ],
        },
        imap: {
          ok:    imapOk,
          ms:    80,
          steps: [
            { name: 'tls',        ok: imapOk, ms: 20, msg: 'TLSv1.3' },
            { name: 'capability', ok: true,   ms: 10, msg: 'IMAP4rev1 LOGIN AUTH=PLAIN' },
            { name: 'auth',       ok: imapOk, ms: 30, msg: imapOk ? null : 'IMAP LOGIN failed' },
          ],
        },
      },
    }),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/:id/diagnose — contract (F3)', () => {
  // Test 1: invalid id
  it('T1: returns 400 for non-numeric mailbox id', async () => {
    const res = await request.post('/api/mailboxes/not-a-number/diagnose')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_id')
  })

  // Test 2: mailbox not found
  it('T2: returns 404 when mailbox does not exist', async () => {
    queryQueue.push({ rows: [], rowCount: 0 })  // SELECT mailbox → not found
    const res = await request.post('/api/mailboxes/99/diagnose')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })

  // Test 3: rate limit exceeded
  it('T3: returns 429 + Retry-After when rate limit exceeded', async () => {
    // SELECT mailbox → found
    queryQueue.push(mailboxRow())
    // checkAndRecord: SELECT FOR UPDATE → found; COUNT → used=1 (at cap)
    queryQueue.push({ rows: [{ id: 42 }], rowCount: 1 })  // FOR UPDATE
    queryQueue.push({ rows: [{ used: 1, oldest_in_window: new Date(Date.now() - 30_000).toISOString() }], rowCount: 1 }) // COUNT at cap
    // checkAndRecord issues COMMIT (no INSERT since refused)
    const res = await request.post('/api/mailboxes/42/diagnose')
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('rate_limit')
    expect(res.body.op).toBe('diagnose')
    expect(res.headers['retry-after']).toBeTruthy()
  })

  // Test 4: relay not configured
  it('T4: returns 200 with relay_not_configured when relay URL missing', async () => {
    queryQueue.push(mailboxRow())
    // rateAllowed: 3 client queries
    for (const r of rateAllowed()) queryQueue.push(r)
    // outreach_config query (getRelayBase) → empty
    queryQueue.push({ rows: [], rowCount: 0 })
    // operator_audit_log insert
    queryQueue.push({ rows: [], rowCount: 0 })

    // no relay URL env
    const savedEnv = process.env.ANTI_TRACE_RELAY_URL
    delete process.env.ANTI_TRACE_RELAY_URL
    delete process.env.ANTI_TRACE_RELAY_URL_OVERRIDE

    const res = await request.post('/api/mailboxes/42/diagnose')

    process.env.ANTI_TRACE_RELAY_URL = savedEnv

    expect(res.status).toBe(200)
    expect(res.body.smtp.error).toBe('relay_not_configured')
    expect(res.body.imap.error).toBe('relay_not_configured')
    expect(res.body.dns).toBeTruthy()
    expect(res.body.ran_at).toBeTruthy()
  })

  // Test 5: happy path — all ok
  it('T5: returns 200 with ok:true when relay+imap+dns all pass', async () => {
    queryQueue.push(mailboxRow())
    for (const r of rateAllowed()) queryQueue.push(r)
    queryQueue.push(relayConfigRow())  // getRelayBase DB lookup
    queryQueue.push({ rows: [], rowCount: 0 })  // audit log insert

    // relay /v1/probe call
    fetchResponses.push(makeRelayProbeResponse(true, true))

    const res = await request.post('/api/mailboxes/42/diagnose')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.smtp.ok).toBe(true)
    expect(res.body.smtp.auth_ok).toBe(true)
    expect(res.body.imap.ok).toBe(true)
    expect(res.body.imap.login_ok).toBe(true)
    expect(res.body.dns.ok).toBe(true)
    expect(Array.isArray(res.body.dns.mx_records)).toBe(true)
    expect(res.body.duration_ms).toBeGreaterThanOrEqual(0)
    expect(res.body.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  // Test 6: SMTP auth failed
  it('T6: returns 200 with smtp.auth_ok:false when SMTP auth fails', async () => {
    queryQueue.push(mailboxRow())
    for (const r of rateAllowed()) queryQueue.push(r)
    queryQueue.push(relayConfigRow())
    queryQueue.push({ rows: [], rowCount: 0 })  // audit log

    fetchResponses.push(makeRelayProbeResponse(false, true))

    const res = await request.post('/api/mailboxes/42/diagnose')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.smtp.ok).toBe(false)
    expect(res.body.smtp.auth_ok).toBe(false)
  })

  // Test 7: IMAP not configured (no imap_host)
  it('T7: imap.error includes imap_host when no imap_host set', async () => {
    queryQueue.push(mailboxRow({ imap_host: null, imap_port: null }))
    for (const r of rateAllowed()) queryQueue.push(r)
    queryQueue.push(relayConfigRow())
    queryQueue.push({ rows: [], rowCount: 0 })  // audit log

    // relay response without imap section (imap_host not sent)
    fetchResponses.push({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        checks: {
          smtp: { ok: true, ms: 100, steps: [{ name: 'auth', ok: true, ms: 40 }] },
          // no imap section
        },
      }),
    })

    const res = await request.post('/api/mailboxes/42/diagnose')
    expect(res.status).toBe(200)
    expect(res.body.imap.ok).toBe(false)
    expect(res.body.imap.error).toMatch(/imap_host/)
  })

  // Test 8: response never includes raw password
  it('T8: password is never echoed in the response body', async () => {
    queryQueue.push(mailboxRow())
    for (const r of rateAllowed()) queryQueue.push(r)
    queryQueue.push(relayConfigRow())
    queryQueue.push({ rows: [], rowCount: 0 })
    fetchResponses.push(makeRelayProbeResponse(true, true))

    const res = await request.post('/api/mailboxes/42/diagnose')
    const responseText = JSON.stringify(res.body)
    expect(responseText).not.toContain('secretPassword123!')
    expect(responseText).not.toContain('password')
  })

  // Test 9: operator_audit_log INSERT fires
  it('T9: operator_audit_log INSERT fires with mailbox_diagnose action', async () => {
    queryQueue.push(mailboxRow())
    for (const r of rateAllowed()) queryQueue.push(r)
    queryQueue.push(relayConfigRow())
    queryQueue.push({ rows: [], rowCount: 0 })
    fetchResponses.push(makeRelayProbeResponse(true, true))

    await request.post('/api/mailboxes/42/diagnose')
    // Wait a tick for the best-effort async audit insert
    await new Promise(r => setTimeout(r, 20))

    const auditCall = calls.find(c =>
      typeof c.sql === 'string' &&
      c.sql.includes('operator_audit_log') &&
      c.sql.includes('mailbox_diagnose')
    )
    expect(auditCall).toBeTruthy()
    expect(auditCall.params[0]).toBe('42')
  })

  // Test 10: ran_at + duration_ms present
  it('T10: ran_at and duration_ms are present in all 200 responses', async () => {
    queryQueue.push(mailboxRow())
    for (const r of rateAllowed()) queryQueue.push(r)
    // no relay config → relay_not_configured path
    queryQueue.push({ rows: [], rowCount: 0 })
    queryQueue.push({ rows: [], rowCount: 0 })

    const savedEnv = process.env.ANTI_TRACE_RELAY_URL
    delete process.env.ANTI_TRACE_RELAY_URL
    delete process.env.ANTI_TRACE_RELAY_URL_OVERRIDE

    const res = await request.post('/api/mailboxes/42/diagnose')

    process.env.ANTI_TRACE_RELAY_URL = savedEnv

    expect(res.status).toBe(200)
    expect(typeof res.body.ran_at).toBe('string')
    expect(typeof res.body.duration_ms).toBe('number')
  })

  // Test 11: DNS shape completeness
  it('T11: dns section includes mx_records, spf_record, dkim_record, dmarc_record', async () => {
    queryQueue.push(mailboxRow())
    for (const r of rateAllowed()) queryQueue.push(r)
    queryQueue.push(relayConfigRow())
    queryQueue.push({ rows: [], rowCount: 0 })
    fetchResponses.push(makeRelayProbeResponse(true, true))

    const res = await request.post('/api/mailboxes/42/diagnose')
    expect(res.status).toBe(200)
    const { dns } = res.body
    expect(dns).toHaveProperty('mx_records')
    expect(dns).toHaveProperty('spf_record')
    expect(dns).toHaveProperty('dkim_record')
    expect(dns).toHaveProperty('dmarc_record')
    expect(dns).toHaveProperty('mx_ok')
    expect(dns).toHaveProperty('spf_ok')
    expect(Array.isArray(dns.mx_records)).toBe(true)
  })

  // Test 12: relay /v1/probe called with mailbox_id (not email/password in BFF log)
  it('T12: relay /v1/probe is called with mailbox_id param', async () => {
    queryQueue.push(mailboxRow())
    for (const r of rateAllowed()) queryQueue.push(r)
    queryQueue.push(relayConfigRow())
    queryQueue.push({ rows: [], rowCount: 0 })
    fetchResponses.push(makeRelayProbeResponse(true, true))

    await request.post('/api/mailboxes/42/diagnose')
    const probeCall = fetchCalls.find(c => c.url.includes('/v1/probe'))
    expect(probeCall).toBeTruthy()
    expect(probeCall.body.mailbox_id).toBe('42')
    expect(probeCall.body.smtp_host).toBe('smtp.firma.cz')
  })
})
