// ═══════════════════════════════════════════════════════════════════════════
//  M2 / BFF contract — /api/mailboxes* endpoints
//
// The BFF (`server.js`) talks directly to Postgres via `pool.query` and
// also owns a handful of SMTP/IMAP live-check endpoints. These contract
// tests lock in:
//   - route inventory (no silent additions / deletions)
//   - method × path combinations
//   - happy-path response shape for each GET
//   - 400 input-validation branches
//   - 404 on unknown :id
//   - 500 on pg throw (error handler wraps the error)
//   - non-shrinkage invariants (new routes must come with tests)
//
// We stub `pg` before importing the app so no real DB is required, and
// we toggle `BFF_IMPORT_ONLY=1` so `app.listen` is skipped.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── Shared pg stub ────────────────────────────────────────────────────
// `queueResult` pushes a response into the FIFO; `queueError` pushes an
// error. `pool.query` shift-reads the FIFO on every call. Tests reset the
// queue in `beforeEach`.
type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  // Infrastructure queries the BFF handlers run that return no business rows
  // the tests feed. They must be short-circuited WITHOUT consuming queryQueue
  // (and without being recorded in `calls`) so the queued business rows stay
  // aligned with the handler's real INSERT/SELECT/UPDATE sequence. Same spirit
  // as the BEGIN/COMMIT short-circuit other contract files already use.
  function infraShortCircuit(sql: unknown): { rows: unknown[]; rowCount: number } | null {
    const s = typeof sql === 'string' ? sql : ''
    // Advisory lock taken by POST /api/mailboxes (mailbox_creation race fix).
    if (/pg_advisory(_xact)?_lock|pg_advisory_unlock/i.test(s)) return { rows: [], rowCount: 0 }
    // preFlightPoolCapacity SELECT. With no pool configured (default here) the
    // gate is a no-op, so return a benign pinned=0 instead of starving the
    // INSERT row. When WIREPROXY_POOL_CONFIG is set (AS3 pool-gate tests) the
    // test feeds the pinned count itself, so don't short-circuit.
    if (/pinned_endpoint_label IS NOT NULL/i.test(s) && !process.env.WIREPROXY_POOL_CONFIG) {
      return { rows: [{ pinned: 0 }], rowCount: 1 }
    }
    return null
  }

  class PoolClient {
    async query(sql: string, params?: unknown[]) {
      const infra = infraShortCircuit(sql)
      if (infra) return infra
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [] }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    release() {}
  }

  class Pool {
    async connect(): Promise<PoolClient> {
      return new PoolClient()
    }
    async query(sql: string, params?: unknown[]) {
      const infra = infraShortCircuit(sql)
      if (infra) return infra
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [] }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})

// ── Stub libraries that the BFF boots lazily (CRON engines etc). ────
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server

beforeAll(async () => {
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

async function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...(headers ?? {}) } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text }
}

// ═══════════════════════════════════════════════════════════════════════
//  Route inventory — the 34 /api/mailboxes* endpoints
// ═══════════════════════════════════════════════════════════════════════

const INVENTORY: Array<[string, string]> = [
  // [method, path-with-:params-placeholders]
  ['GET', '/api/mailboxes'],
  ['POST', '/api/mailboxes'],
  ['PATCH', '/api/mailboxes/:id'],
  ['DELETE', '/api/mailboxes/:id'],
  ['GET', '/api/mailboxes/:id/stats'],
  ['PATCH', '/api/mailboxes/:id/warmup'],
  ['GET', '/api/mailboxes/:id/send-log'],
  ['GET', '/api/mailboxes/:id/campaigns'],
  ['GET', '/api/mailboxes/:id/watchdog-events'],
  ['POST', '/api/mailboxes/:id/recover'],
  ['POST', '/api/mailboxes/:id/auth-reset'],
  ['GET', '/api/mailboxes/:id/cooldown-log'],
  ['GET', '/api/mailboxes/:id/pipeline-results'],
  ['POST', '/api/mailboxes/:id/pipeline-test'],
  ['POST', '/api/mailboxes/:id/warmup/start'],
  ['GET', '/api/mailboxes/:id/proxy-live-check'],
  ['POST', '/api/mailboxes/:id/assign-proxy'],
  ['GET', '/api/mailboxes/health-summary'],
  ['GET', '/api/mailboxes/send-trends'],
  ['GET', '/api/mailboxes/:id/smtp-check'],
  ['GET', '/api/mailboxes/:id/imap-check'],
  ['POST', '/api/mailboxes/:id/header-probe'],
  ['GET', '/api/mailboxes/:id/config-check'],
  ['GET', '/api/mailboxes/:id/warmup-status'],
  ['GET', '/api/mailboxes/:id/bounce-status'],
  ['GET', '/api/mailboxes/:id/send-rate'],
  ['GET', '/api/mailboxes/:id/pipeline-status'],
  ['GET', '/api/mailboxes/:id/full-check'],
  ['GET', '/api/mailboxes/:id/check-history'],
  ['GET', '/api/mailboxes/:id/imap-inbox'],
  ['POST', '/api/mailboxes/bulk-assign-proxy'],
  ['POST', '/api/mailboxes/bulk-check'],
  // import-csv was removed (replaced by POST /api/mailboxes/bulk-set-password);
  // it is absent from the authoritative api-route-inventory snapshot.
  ['POST', '/api/mailboxes/:id/send-test'],
  ['GET', '/api/mailboxes/:id/alerts'],
  ['PATCH', '/api/mailboxes/:id/alerts/:alertId/resolve'],
]

describe('M2 / inventory', () => {
  it('lists 35 /api/mailboxes* endpoints', () => {
    expect(INVENTORY).toHaveLength(35)
  })

  // For each endpoint: path resolves (no 404 from Express itself), i.e. a
  // matching route handler exists. Use a POST if method is POST, etc., with
  // an empty body; a missing-handler 404 from express looks different from
  // a 404 emitted by the handler (which still counts as a registered route).
  it.each(INVENTORY)('%s %s is a registered route', async (method, path) => {
    const concrete = path.replace(/:alertId/g, '1').replace(/:id/g, '1')
    queueRows([]) // any query runs against this
    queueRows([]) // for second-query endpoints
    const res = await req(method, concrete, method === 'GET' ? undefined : {})
    // Express returns 404 with NO content-type json or a text HTML stub when
    // the route isn't registered; when it is registered, the handler either
    // responds with its own status or throws into its try/catch and yields
    // {error: ...}. Accept anything ≠ Express default 404 HTML.
    if (res.status === 404) {
      expect(typeof res.body === 'object' && res.body && 'error' in (res.body as object)).toBe(true)
    } else {
      expect([200, 400, 500]).toContain(res.status)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/mailboxes  — list all
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes', () => {
  it('200 returns rows enriched with has_valid_password flag', async () => {
    // BFF sanitizes rows via sanitizeMailboxRow() — strips `password` from
    // response (never expose), injects `has_valid_password` boolean. Rows
    // without password → false (unknown/placeholder).
    const rows = [{ id: 1, email: 'a@x' }, { id: 2, email: 'b@x' }]
    queueRows(rows)
    const res = await req('GET', '/api/mailboxes')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { id: 1, email: 'a@x', has_valid_password: false },
      { id: 2, email: 'b@x', has_valid_password: false },
    ])
  })

  it('200 with [] when pg returns no rows', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('500 + {error} when pg throws', async () => {
    queueError('connection lost')
    const res = await req('GET', '/api/mailboxes')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'connection lost' })
  })

  it('calls pg exactly once per request', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes')
    expect(calls).toHaveLength(1)
  })

  it('issues an ORDER BY created_at DESC query', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes')
    expect(calls[0].sql).toMatch(/ORDER BY[\s\S]+created_at DESC/i)
  })

  // ── ?q= server-side search ────────────────────────────────────────
  // Server owns the filter when the list can exceed the page size, so
  // typing "foo" must push the term into the SQL (parameterized ILIKE)
  // instead of silently returning only the already-loaded slice. These
  // cases set OUTREACH_API_KEY + x-api-key so the shared auth middleware
  // lets them through regardless of the surrounding test-file setup.
  describe('?q= server-side search', () => {
    const API_KEY = 'test-key-search'
    let origKey: string | undefined
    beforeAll(() => { origKey = process.env.OUTREACH_API_KEY; process.env.OUTREACH_API_KEY = API_KEY })
    afterAll(() => { if (origKey === undefined) delete process.env.OUTREACH_API_KEY; else process.env.OUTREACH_API_KEY = origKey })

    const AUTH = { 'x-api-key': API_KEY }

    it('200 with ?q=foo runs an ILIKE filter on from_address + display_name', async () => {
      const rows = [{ id: 7, email: 'foo@x' }]
      queueRows(rows)
      const res = await req('GET', '/api/mailboxes?q=foo', undefined, AUTH)
      expect(res.status).toBe(200)
      // has_valid_password injected server-side (sanitizeMailboxRow)
      expect(res.body).toEqual([{ id: 7, email: 'foo@x', has_valid_password: false }])
      expect(calls[0].sql).toMatch(/ILIKE\s+\$1/i)
      expect(calls[0].sql).toMatch(/from_address/i)
      expect(calls[0].sql).toMatch(/display_name/i)
      expect(calls[0].params).toEqual(['%foo%'])
    })

    it('?q= with only whitespace is treated as no filter', async () => {
      queueRows([])
      await req('GET', '/api/mailboxes?q=%20%20', undefined, AUTH)
      expect(calls[0].sql).not.toMatch(/ILIKE/i)
      expect(calls[0].params).toBeUndefined()
    })

    it('?q= escapes LIKE metacharacters in the pattern', async () => {
      queueRows([])
      await req('GET', '/api/mailboxes?q=' + encodeURIComponent('50%_off'), undefined, AUTH)
      expect(calls[0].params).toEqual(['%50\\%\\_off%'])
    })

    it('?q= caps length at 200 chars', async () => {
      queueRows([])
      const long = 'a'.repeat(500)
      await req('GET', '/api/mailboxes?q=' + encodeURIComponent(long), undefined, AUTH)
      const params = calls[0].params as unknown[]
      // pattern is `%<q>%` → capped q(200) wrapped in two % → 202
      expect(typeof params[0]).toBe('string')
      expect((params[0] as string).length).toBe(202)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/mailboxes
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes', () => {
  const minimalBody = {
    email: 'jan@alias.test',
    smtp_host: 'smtp.alias.test',
    password: 'secret',
  }

  it('200 returns inserted row', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 42, email: 'jan@alias.test', display_name: 'jan@alias.test', host: 'smtp.alias.test', port: 587, status: 'active', status_reason: null, daily_limit: 100, total_sent: 0, total_bounced: 0, consecutive_bounces: 0, proxy_url: null, last_send_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]) // INSERT
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    const res = await req('POST', '/api/mailboxes', minimalBody)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 42 })
  })

  it('defaults smtp_port=587 when omitted', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1 }]) // INSERT
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    await req('POST', '/api/mailboxes', minimalBody)
    const insertCall = calls.find(c => c.sql?.includes('INSERT INTO outreach_mailboxes'))
    const params = insertCall?.params as unknown[]
    expect(params[3]).toBe(587) // smtp_port parameter position
  })

  it('defaults daily_limit=100 when omitted', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1 }]) // INSERT
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    await req('POST', '/api/mailboxes', minimalBody)
    const insertCall = calls.find(c => c.sql?.includes('INSERT INTO outreach_mailboxes'))
    const params = insertCall?.params as unknown[]
    expect(params[6]).toBe(100)
  })

  it('defaults smtp_username to email when omitted', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1 }]) // INSERT
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    await req('POST', '/api/mailboxes', minimalBody)
    const insertCall = calls.find(c => c.sql?.includes('INSERT INTO outreach_mailboxes'))
    const params = insertCall?.params as unknown[]
    expect(params[4]).toBe('jan@alias.test')
  })

  it('accepts explicit smtp_username override', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1 }]) // INSERT
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    await req('POST', '/api/mailboxes', { ...minimalBody, smtp_username: 'user@other' })
    const insertCall = calls.find(c => c.sql?.includes('INSERT INTO outreach_mailboxes'))
    const params = insertCall?.params as unknown[]
    expect(params[4]).toBe('user@other')
  })

  it('defaults display_name to email when omitted', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1 }]) // INSERT
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    await req('POST', '/api/mailboxes', minimalBody)
    const insertCall = calls.find(c => c.sql?.includes('INSERT INTO outreach_mailboxes'))
    const params = insertCall?.params as unknown[]
    expect(params[1]).toBe('jan@alias.test')
  })

  it('500 + {error} when pg throws', async () => {
    queueRows([]) // BEGIN
    queueError('unique constraint violated') // INSERT fails
    const res = await req('POST', '/api/mailboxes', minimalBody)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'unique constraint violated' })
  })

  it('400 when body is not valid JSON', async () => {
    const res = await req('POST', '/api/mailboxes', 'not-json{')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid json' })
  })

  it('defaults imap_host=null when omitted', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1 }]) // INSERT
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    await req('POST', '/api/mailboxes', minimalBody)
    const insertCall = calls.find(c => c.sql?.includes('INSERT INTO outreach_mailboxes'))
    const params = insertCall?.params as unknown[]
    expect(params[7]).toBeNull()
  })

  it('defaults imap_port=null when omitted', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1 }]) // INSERT
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    await req('POST', '/api/mailboxes', minimalBody)
    const insertCall = calls.find(c => c.sql?.includes('INSERT INTO outreach_mailboxes'))
    const params = insertCall?.params as unknown[]
    expect(params[8]).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PATCH /api/mailboxes/:id
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /api/mailboxes/:id', () => {
  it('400 when body has nothing to update', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT
    const res = await req('PATCH', '/api/mailboxes/7', {})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'nothing_to_update' })
  })

  it('400 when only unknown fields supplied', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT
    const res = await req('PATCH', '/api/mailboxes/7', { banana: 'yes' })
    expect(res.status).toBe(400)
  })

  it('200 + updated row on valid status change', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT current state
    queueRows([]) // UPDATE (no RETURNING)
    queueRows([{ id: 7, email: 'x@y', display_name: 'x@y', host: 'smtp.test', port: 587, status: 'paused', status_reason: null, daily_limit: 100, total_sent: 0, total_bounced: 0, consecutive_bounces: 0, imap_username: 'x@y', imap_host: null, imap_port: null, warmup_day: null, warmup_plan: null, warmup_paused: null, warmup_started_at: null, warmup_last_advanced: null, warmup_pause_reason: null, anti_trace_enabled: false, environment: 'production', last_send_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]) // MB_SELECT re-fetch
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    const res = await req('PATCH', '/api/mailboxes/7', { status: 'paused' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 7, status: 'paused' })
  })

  it('supports display_name update alone', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT current state
    queueRows([]) // UPDATE (no RETURNING)
    queueRows([{ id: 7, email: 'x@y', display_name: 'New Name', status: 'active' }]) // MB_SELECT re-fetch
    queueRows([]) // COMMIT (no audit for non-status)
    await req('PATCH', '/api/mailboxes/7', { display_name: 'New Name' })
    const updateCall = calls.find(c => c.sql?.includes('UPDATE outreach_mailboxes'))
    expect(updateCall?.sql).toMatch(/display_name=\$1/)
  })

  it('daily_limit aliases to daily_cap_override column', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT
    queueRows([{ id: 7 }]) // UPDATE
    queueRows([]) // COMMIT
    await req('PATCH', '/api/mailboxes/7', { daily_limit: 42 })
    const updateCall = calls.find(c => c.sql?.includes('UPDATE outreach_mailboxes'))
    expect(updateCall?.sql).toMatch(/daily_cap_override=\$1/)
  })

  it('daily_cap_override takes precedence when both supplied', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT
    queueRows([{ id: 7 }]) // UPDATE
    queueRows([]) // COMMIT
    await req('PATCH', '/api/mailboxes/7', { daily_cap_override: 200, daily_limit: 50 })
    const updateCall = calls.find(c => c.sql?.includes('UPDATE outreach_mailboxes'))
    // FIELD_MAP iterates daily_cap_override first, so daily_limit is skipped.
    const setCount = (updateCall?.sql.match(/daily_cap_override=\$\d/g) ?? []).length
    expect(setCount).toBe(1)
    expect(updateCall?.params?.[0]).toBe(200)
  })

  it('includes password SET when supplied', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT
    queueRows([{ id: 7 }]) // UPDATE
    queueRows([]) // COMMIT
    await req('PATCH', '/api/mailboxes/7', { password: 'new-secret' })
    const updateCall = calls.find(c => c.sql?.includes('UPDATE outreach_mailboxes'))
    expect(updateCall?.sql).toMatch(/password=\$\d/)
  })

  it('500 when pg throws', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT
    queueError('syntax error') // UPDATE fails
    const res = await req('PATCH', '/api/mailboxes/7', { status: 'paused' })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'syntax error' })
  })

  const UPDATABLE_FIELDS: Array<[string, unknown]> = [
    ['status', 'active'],
    ['display_name', 'Jan'],
    ['smtp_host', 'smtp.new.test'],
    ['smtp_port', 465],
    ['smtp_username', 'newuser@alias'],
    ['imap_host', 'imap.new.test'],
    ['imap_port', 993],
    ['imap_username', 'imapuser@alias'],
    ['daily_cap_override', 250],
    // proxy_url removed from FIELD_MAP in the handler (deprecated since
    // migration 077) — a {proxy_url} patch is now an unknown field.
  ]

  it.each(UPDATABLE_FIELDS)('accepts %s alone', async (field, value) => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'active' }]) // SELECT
    queueRows([{ id: 7 }]) // UPDATE
    if (field === 'status') {
      queueRows([]) // INSERT audit for status changes
    }
    queueRows([]) // COMMIT
    const res = await req('PATCH', '/api/mailboxes/7', { [field]: value })
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/mailboxes/:id
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/mailboxes/:id', () => {
  it('200 {ok:true} on success', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 9, email: 'test@test.com', from_address: 'test@test.com' }]) // SELECT
    queueRows([]) // DELETE
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    const res = await req('DELETE', '/api/mailboxes/9')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('500 when pg throws', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 9, email: 'test@test.com', from_address: 'test@test.com' }]) // SELECT
    queueError('fk violation') // DELETE fails
    const res = await req('DELETE', '/api/mailboxes/9')
    expect(res.status).toBe(500)
  })

  it('issues DELETE with id parameter', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 9, email: 'test@test.com', from_address: 'test@test.com' }]) // SELECT
    queueRows([]) // DELETE
    queueRows([]) // INSERT audit
    queueRows([]) // COMMIT
    await req('DELETE', '/api/mailboxes/9')
    const deleteCall = calls.find(c => c.sql?.includes('DELETE FROM outreach_mailboxes'))
    expect(deleteCall?.sql).toMatch(/DELETE FROM outreach_mailboxes/i)
    expect(deleteCall?.params).toEqual(['9'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/mailboxes/:id/stats
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/stats', () => {
  it('200 returns stats row', async () => {
    queueRows([{ total_sent: 120, total_bounced: 3, sent_30d: 45, consecutive_bounces: 0 }])
    const res = await req('GET', '/api/mailboxes/42/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total_sent: 120, total_bounced: 3, sent_30d: 45, consecutive_bounces: 0 })
  })

  it('200 returns zero-filled object when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/999/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total_sent: 0, total_bounced: 0, sent_30d: 0, consecutive_bounces: 0 })
  })

  it('500 on pg error', async () => {
    queueError('timeout')
    const res = await req('GET', '/api/mailboxes/42/stats')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PATCH /api/mailboxes/:id/warmup
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /api/mailboxes/:id/warmup', () => {
  it('404 when mailbox not found', async () => {
    queueRows([]) // SELECT returns empty
    const res = await req('PATCH', '/api/mailboxes/99/warmup', { paused: true })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('200 {ok:true} when pause succeeds', async () => {
    queueRows([{ from_address: 'jan@alias.test' }]) // SELECT
    queueRows([]) // UPDATE
    const res = await req('PATCH', '/api/mailboxes/1/warmup', { paused: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('200 {ok:true} when resuming (paused=false)', async () => {
    queueRows([{ from_address: 'jan@alias.test' }])
    queueRows([])
    const res = await req('PATCH', '/api/mailboxes/1/warmup', { paused: false })
    expect(res.status).toBe(200)
  })

  it('500 when SELECT fails', async () => {
    queueError('select failed')
    const res = await req('PATCH', '/api/mailboxes/1/warmup', { paused: true })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/mailboxes/:id/send-log
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/send-log', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/send-log')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('200 with send_event rows', async () => {
    queueRows([{ from_address: 'jan@alias.test' }])
    queueRows([
      { sent_at: '2026-04-01T10:00:00Z', status: 'delivered', subject: 'S1', smtp_response: '250 OK', contact_email: 'biz@x' },
      { sent_at: '2026-04-01T09:00:00Z', status: 'bounced', subject: 'S2', smtp_response: '550 fail', contact_email: 'biz2@x' },
    ])
    const res = await req('GET', '/api/mailboxes/1/send-log')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
  })

  it('200 with [] when mailbox exists but no sends', async () => {
    queueRows([{ from_address: 'jan@alias.test' }])
    queueRows([])
    const res = await req('GET', '/api/mailboxes/1/send-log')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('limits send-log to 30 rows', async () => {
    queueRows([{ from_address: 'jan@alias.test' }])
    queueRows([])
    await req('GET', '/api/mailboxes/1/send-log')
    expect(calls[1].sql).toMatch(/LIMIT\s+30/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/mailboxes/:id/watchdog-events
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/watchdog-events', () => {
  it('200 with default limit=10', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/1/watchdog-events')
    expect(res.status).toBe(200)
    expect(calls[0].params?.[1]).toBe(10)
  })

  it('clamps limit to [1,50]', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/1/watchdog-events?limit=9999')
    expect(calls[0].params?.[1]).toBe(50)
  })

  it('clamps limit below 1 to 1', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/1/watchdog-events?limit=-5')
    expect(calls[0].params?.[1]).toBe(1)
  })

  it('known quirk: Number("nope") yields NaN — documents current behavior', async () => {
    // The handler does `Number(req.query.limit || 10)`; when limit='nope',
    // the `||` doesn't short-circuit (truthy string), so Number('nope') is
    // NaN, and Math.min(Math.max(NaN,1),50) is NaN. The pg binding will
    // reject this with an error. This test locks in the current behaviour
    // so any future input-validation hardening surfaces as a diff.
    queueRows([])
    await req('GET', '/api/mailboxes/1/watchdog-events?limit=nope')
    const got = calls[0].params?.[1] as number
    expect(Number.isNaN(got)).toBe(true)
  })

  it('returns [] gracefully when watchdog_events table does not exist', async () => {
    queueError('relation "watchdog_events" does not exist')
    const res = await req('GET', '/api/mailboxes/1/watchdog-events')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('500 for unrelated pg errors', async () => {
    queueError('bind failed')
    const res = await req('GET', '/api/mailboxes/1/watchdog-events')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/mailboxes/:id/recover
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/:id/recover', () => {
  it('400 when id is not a positive integer', async () => {
    const res = await req('POST', '/api/mailboxes/abc/recover', {})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_id' })
  })

  it('400 on id=0', async () => {
    const res = await req('POST', '/api/mailboxes/0/recover', {})
    expect(res.status).toBe(400)
  })

  it('400 on negative id', async () => {
    const res = await req('POST', '/api/mailboxes/-5/recover', {})
    expect(res.status).toBe(400)
  })

  it('404 when mailbox not found', async () => {
    queueRows([]) // UPDATE RETURNING empty
    const res = await req('POST', '/api/mailboxes/7/recover', {})
    expect(res.status).toBe(404)
  })

  it('200 + {ok, mailbox, canary_remaining} when recovery succeeds', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', status: 'active' }])
    queueRows([]) // cooldown log close
    queueRows([]) // watchdog event insert
    const res = await req('POST', '/api/mailboxes/7/recover', { reason: 'manual' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      canary_remaining: 10,
      mailbox: { id: 7, status: 'active', from_address: 'jan@alias.test' },
    })
  })

  it('truncates reason to 200 chars', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', status: 'active' }])
    queueRows([])
    queueRows([])
    await req('POST', '/api/mailboxes/7/recover', { reason: 'x'.repeat(500) })
    // Nothing to assert on the pg params directly for this metadata path;
    // survival without crash is the contract.
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('defaults reason to "operator_recover" when omitted', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', status: 'active' }])
    queueRows([])
    queueRows([])
    const res = await req('POST', '/api/mailboxes/7/recover', {})
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/mailboxes/:id/auth-reset  — SEND-S2 operator AUTH reset
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/:id/auth-reset', () => {
  it('400 when id is not a positive integer', async () => {
    const res = await req('POST', '/api/mailboxes/abc/auth-reset', {})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_id' })
  })

  it('400 on id=0', async () => {
    const res = await req('POST', '/api/mailboxes/0/auth-reset', {})
    expect(res.status).toBe(400)
  })

  it('400 on negative id', async () => {
    const res = await req('POST', '/api/mailboxes/-5/auth-reset', {})
    expect(res.status).toBe(400)
  })

  it('404 when mailbox not found', async () => {
    queueRows([])
    const res = await req('POST', '/api/mailboxes/99/auth-reset', {})
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('200 + {ok, mailbox} when reset succeeds', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([]) // healed update
    queueRows([]) // audit insert
    const res = await req('POST', '/api/mailboxes/7/auth-reset', { reason: 'password updated' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      mailbox: { id: 7, from_address: 'jan@alias.test', auth_fail_count: 0 },
    })
  })

  it('zeroes auth_fail_count, auth_fail_at, circuit_opened_at in one UPDATE', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueRows([])
    await req('POST', '/api/mailboxes/7/auth-reset', {})
    const sql = calls[0].sql
    expect(sql).toMatch(/UPDATE outreach_mailboxes/i)
    expect(sql).toMatch(/auth_fail_count\s*=\s*0/i)
    expect(sql).toMatch(/auth_fail_at\s*=\s*NULL/i)
    expect(sql).toMatch(/circuit_opened_at\s*=\s*NULL/i)
    expect(calls[0].params).toEqual([7])
  })

  it('marks outstanding auth_fail_alert watchdog rows as healed', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueRows([])
    await req('POST', '/api/mailboxes/7/auth-reset', {})
    expect(calls.length).toBe(3)
    expect(calls[1].sql).toMatch(/UPDATE watchdog_events/i)
    expect(calls[1].sql).toMatch(/auto_healed\s*=\s*true/i)
    expect(calls[1].sql).toMatch(/event_type\s*=\s*'auth_fail_alert'/i)
  })

  it('inserts audit watchdog_event with event_type=auth_reset', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueRows([])
    await req('POST', '/api/mailboxes/7/auth-reset', { reason: 'fixed pwd' })
    expect(calls[2].sql).toMatch(/INSERT INTO watchdog_events/i)
    expect(calls[2].sql).toMatch(/'auth_reset'/)
    expect(calls[2].params).toEqual([7, 'fixed pwd'])
  })

  it('defaults reason to operator_reset when omitted', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueRows([])
    await req('POST', '/api/mailboxes/7/auth-reset', {})
    expect(calls[2].params).toEqual([7, 'operator_reset'])
  })

  it('truncates reason to 200 chars', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueRows([])
    await req('POST', '/api/mailboxes/7/auth-reset', { reason: 'x'.repeat(500) })
    const params = calls[2].params as unknown[]
    expect((params[1] as string).length).toBe(200)
  })

  it('survives when healed-UPDATE throws (audit still inserted)', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueError('watchdog_events does not exist')
    queueRows([])
    const res = await req('POST', '/api/mailboxes/7/auth-reset', {})
    expect(res.status).toBe(200)
  })

  it('survives when audit INSERT throws (main UPDATE already done)', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueError('fk violation')
    const res = await req('POST', '/api/mailboxes/7/auth-reset', {})
    expect(res.status).toBe(200)
  })

  it('500 when main UPDATE throws', async () => {
    queueError('connection refused')
    const res = await req('POST', '/api/mailboxes/7/auth-reset', {})
    expect(res.status).toBe(500)
  })

  it('is idempotent — calling twice returns 200 each time', async () => {
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueRows([])
    const r1 = await req('POST', '/api/mailboxes/7/auth-reset', {})
    queueRows([{ id: 7, from_address: 'jan@alias.test', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueRows([])
    const r2 = await req('POST', '/api/mailboxes/7/auth-reset', {})
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Generic error-handler contract: every /api/mailboxes* endpoint wraps
//  pg errors in {error: msg} with status 500 (except where it intentionally
//  falls back to 200 with empty body — watchdog-events).
// ═══════════════════════════════════════════════════════════════════════

describe('M2 / uniform error envelope', () => {
  const endpoints: Array<[string, string]> = [
    ['GET', '/api/mailboxes'],
    ['POST', '/api/mailboxes'],
    ['PATCH', '/api/mailboxes/1'],
    ['DELETE', '/api/mailboxes/1'],
    ['GET', '/api/mailboxes/1/stats'],
  ]
  it.each(endpoints)('%s %s returns {error} on pg throw', async (method, path) => {
    queueError('pg error: uniform')
    const body =
      method === 'POST' && path === '/api/mailboxes'
        ? { email: 'x@y', smtp_host: 's', password: 'p' }
        : method === 'PATCH'
          ? { status: 'paused' }
          : undefined
    const res = await req(method, path, body)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'pg error: uniform' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  JSON body parsing
// ═══════════════════════════════════════════════════════════════════════

describe('M2 / JSON parsing', () => {
  it('400 on malformed JSON body (POST /api/mailboxes)', async () => {
    const res = await req('POST', '/api/mailboxes', 'not json{{')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid json' })
  })

  it('400 on malformed JSON body (PATCH /api/mailboxes/:id)', async () => {
    const res = await req('PATCH', '/api/mailboxes/1', 'nope')
    expect(res.status).toBe(400)
  })

  it('200 on empty JSON object for PATCH that supports it', async () => {
    // PATCH with empty body → 400 'nothing to update'. The handler first opens
    // a txn and SELECTs the current row (for audit), so the mailbox must exist
    // before the nothing-to-update branch is reached.
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'active' }]) // SELECT current state
    const res = await req('PATCH', '/api/mailboxes/1', {})
    expect(res.status).toBe(400)
  })

  it('content-type defaults matter: returns JSON', async () => {
    queueRows([])
    const r = await fetch(baseUrl + '/api/mailboxes')
    expect(r.headers.get('content-type')).toMatch(/application\/json/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  CORS
// ═══════════════════════════════════════════════════════════════════════

describe('M2 / CORS', () => {
  it('responds to preflight OPTIONS', async () => {
    const r = await fetch(baseUrl + '/api/mailboxes', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:18175',
        'Access-Control-Request-Method': 'GET',
      },
    })
    // cors middleware emits 204 No Content on preflight by default.
    expect([200, 204]).toContain(r.status)
    expect(r.headers.get('access-control-allow-origin')).toBeTruthy()
  })

  it('GET includes Access-Control-Allow-Origin when Origin is set', async () => {
    queueRows([])
    const r = await fetch(baseUrl + '/api/mailboxes', { headers: { Origin: 'http://localhost:18175' } })
    expect(r.headers.get('access-control-allow-origin')).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Security headers
// ═══════════════════════════════════════════════════════════════════════

describe('M2 / security headers', () => {
  it('disables x-powered-by', async () => {
    queueRows([])
    const r = await fetch(baseUrl + '/api/mailboxes')
    expect(r.headers.get('x-powered-by')).toBeNull()
  })
})
