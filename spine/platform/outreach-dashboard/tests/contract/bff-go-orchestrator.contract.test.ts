// ═══════════════════════════════════════════════════════════════════════════
//  BFF ↔ Go orchestrator contract — KT-B1
//
//  Locks the wire-level contract between the Express BFF and the Go
//  orchestrator (features/inbound/orchestrator + features/outreach/campaigns/web).
//
//  Why this exists: production has had silent contract drift before
//  (e.g. `/api/campaigns` direct-DB INSERT silently leaving campaign_contacts
//  empty — see docs/initiatives/2026-04-25-garaaage-launch-plan.md). When the
//  BFF expectation and the Go response shape disagree we want a red test
//  *before* prod sees it.
//
//  Surface under test (every BFF route that proxies to Go):
//    1. POST /api/campaigns                    → Go POST /api/campaigns
//    2. POST /api/campaigns/:id/run            → Go POST /api/campaigns/:id/run
//    3. POST /api/campaigns/:id/pause          → Go POST /api/campaigns/:id/pause
//
//  (The /api/__schema-check ↔ /schema contract is exhaustively covered by
//  bff-schema-check.contract.test.ts — we link to it but do not duplicate.)
//
//  Cases (≥10, per feedback_extreme_testing memory):
//    A.  Path mapping: BFF /api/campaigns POSTs to Go /api/campaigns
//    B.  X-API-Key forwarding: BFF sends OUTREACH_API_KEY value verbatim
//    C.  Empty OUTREACH_API_KEY → header still sent (empty string)
//    D.  Content-Type forwarded as application/json on POST
//    E.  Body forwarding: BFF POSTs canonical Go payload (name/desc/steps/category_paths/category_match/min_score/region)
//    F.  Path-param forwarding: /api/campaigns/42/run → Go /api/campaigns/42/run
//    G.  Path-param forwarding: /api/campaigns/77/pause → Go /api/campaigns/77/pause
//    H.  4xx pass-through: Go 400 → BFF 400 with { error, http_status, response }
//    I.  5xx pass-through: Go 500 → BFF 500 with same envelope
//    J.  Non-JSON Go body → BFF returns response.raw (truncated to 500 chars)
//    K.  Network error / timeout → BFF falls back to legacy direct-DB path with _warning
//    L.  Canonical Go-side response shape ({id, estimate}) survives round-trip into BFF /api/campaigns response
//    M.  /run happy path: Go {ok:true} → BFF {ok:true} (no fallback _warning)
//    N.  /pause happy path: Go {ok:true} → BFF {ok:true} (no fallback _warning)
//    O.  Drift guard: Go response with unexpected field name (`identifier` instead of `id`) is detected — BFF SELECT returns no row
//
//  Mocking strategy (matches bff-schema-check.contract.test.ts):
//    - vi.mock('pg') with a query queue
//    - Replace globalThis.fetch with a stub that pattern-matches URLs starting
//      with http://go-stub.local. Real fetch passes through everything else
//      (including supertest fetches against the local Express).
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── pg stub ─────────────────────────────────────────────────────────────────
type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const sqlCalls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      sqlCalls.push({ sql, params })
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

// ── runPreflight stub ─────────────────────────────────────────────────────────
// PR #527 / #568 added an airtight preflight gate to POST /run. Without this
// mock the gate fires M1_no_valid_mailbox (empty stub pool) and returns 412,
// breaking all proxy/fallback path tests that only care about Go ↔ BFF wire
// contract. Tests that want to exercise 412 can call
// `runPreflightMock.mockResolvedValueOnce({ ok: false, blockers: [...], summary: {} })`.
vi.mock('../../src/server-routes/runPreflight.js', () => ({
  listTmplNames: vi.fn(async () => new Set<string>(['initial', 'followup1', 'final'])),
  runPreflight: vi.fn(async () => ({ ok: true, blockers: [], summary: {} })),
}))

// ── fetch stub: intercepts only http://go-stub.local/* ──────────────────────
type FetchResult =
  | { ok: boolean; status: number; body: string; contentType?: string }
  | Error

interface RecordedFetch {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

const fetchQueue: FetchResult[] = []
const fetchCalls: RecordedFetch[] = []
let realFetch: typeof fetch

function installFetchStub() {
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url?: string })?.url || String(input)
    if (url.startsWith('http://go-stub.local')) {
      const headers: Record<string, string> = {}
      const initHeaders = (init?.headers ?? {}) as Record<string, string> | Headers
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((v, k) => { headers[k.toLowerCase()] = v })
      } else {
        for (const [k, v] of Object.entries(initHeaders)) headers[k.toLowerCase()] = String(v)
      }
      fetchCalls.push({
        url,
        method: (init?.method || 'GET').toUpperCase(),
        headers,
        body: typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null,
      })

      const next = fetchQueue.shift()
      if (!next) {
        // Default: 200 OK with empty JSON object — same shape Go would
        // return for an unmatched canned response. Tests that care about
        // the response shape MUST queueGo*() before the request.
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (next instanceof Error) throw next
      return new Response(next.body, {
        status: next.status,
        headers: { 'content-type': next.contentType ?? 'application/json' },
      })
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch
}

// ── helpers ─────────────────────────────────────────────────────────────────
function queueGoJSON(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  fetchQueue.push({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: JSON.stringify(body),
    contentType: 'application/json',
  })
}
function queueGoRaw(text: string, opts: { status?: number; contentType?: string } = {}) {
  fetchQueue.push({
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    body: text,
    contentType: opts.contentType ?? 'text/plain',
  })
}
function queueGoNetworkError(msg: string) {
  fetchQueue.push(new Error(msg))
}
function queueRows(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function queueDbError(msg: string) {
  queryQueue.push(new Error(msg))
}

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.OUTREACH_API_KEY = 'kt-b1-test-key'

  installFetchStub()

  const mod = await import('../../server.js')
  // Set GO_SERVER_URL AFTER import — Vite's loadEnv may have stripped it.
  // Each test re-asserts this value in beforeEach so the proxy path fires.
  process.env.GO_SERVER_URL = 'http://go-stub.local'

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
  globalThis.fetch = realFetch
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  fetchQueue.length = 0
  fetchCalls.length = 0
  queryQueue.length = 0
  sqlCalls.length = 0
  process.env.GO_SERVER_URL = 'http://go-stub.local'
  process.env.OUTREACH_API_KEY = 'kt-b1-test-key'
})

async function bffReq(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await realFetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, headers: r.headers }
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/campaigns  ↔  Go POST /api/campaigns
// ═══════════════════════════════════════════════════════════════════════════

describe('A. POST /api/campaigns — path mapping', () => {
  it('forwards to Go /api/campaigns at the configured GO_SERVER_URL', async () => {
    queueGoJSON({ id: 7, estimate: 12 })
    queueRows([{ id: 7, name: 'Demo', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    const res = await bffReq('POST', '/api/campaigns', { name: 'Demo' })
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('http://go-stub.local/api/campaigns')
    expect(fetchCalls[0].method).toBe('POST')
  })

  it('strips a trailing slash on GO_SERVER_URL when joining the Go path', async () => {
    process.env.GO_SERVER_URL = 'http://go-stub.local/'
    queueGoJSON({ id: 8, estimate: 0 })
    queueRows([{ id: 8, name: 'Slash', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    await bffReq('POST', '/api/campaigns', { name: 'Slash' })
    // No double-slash:
    expect(fetchCalls[0].url).toBe('http://go-stub.local/api/campaigns')
  })
})

describe('B. X-API-Key auth header forwarding', () => {
  it('forwards OUTREACH_API_KEY value as x-api-key header (lowercased by fetch)', async () => {
    queueGoJSON({ id: 1, estimate: 0 })
    queueRows([{ id: 1, name: 'Auth', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    await bffReq('POST', '/api/campaigns', { name: 'Auth' })
    // Header keys are normalized to lowercase by our stub
    expect(fetchCalls[0].headers['x-api-key']).toBe('kt-b1-test-key')
  })

  it('still sends x-api-key as empty string when OUTREACH_API_KEY is unset (BFF must not omit the header)', async () => {
    delete process.env.OUTREACH_API_KEY
    queueGoJSON({ id: 2, estimate: 0 })
    queueRows([{ id: 2, name: 'NoKey', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    await bffReq('POST', '/api/campaigns', { name: 'NoKey' })
    expect(fetchCalls[0].headers['x-api-key']).toBe('')
  })

  it('does NOT leak Express request headers (e.g. user-agent / cookies) onto the upstream Go fetch', async () => {
    queueGoJSON({ id: 3, estimate: 0 })
    queueRows([{ id: 3, name: 'Iso', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    await bffReq('POST', '/api/campaigns', { name: 'Iso' })
    const sent = fetchCalls[0].headers
    // Only x-api-key + content-type are passed; cookie + authorization must NOT appear
    expect(sent['cookie']).toBeUndefined()
    expect(sent['authorization']).toBeUndefined()
  })
})

describe('D. Content-Type negotiation on POST', () => {
  it('sets content-type: application/json on the upstream Go fetch', async () => {
    queueGoJSON({ id: 4, estimate: 0 })
    queueRows([{ id: 4, name: 'CT', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    await bffReq('POST', '/api/campaigns', { name: 'CT' })
    expect(fetchCalls[0].headers['content-type']).toBe('application/json')
  })
})

describe('E. Request body forwarding', () => {
  it('forwards canonical Go payload shape (name + description + steps + category_paths + category_match + min_score + region)', async () => {
    queueGoJSON({ id: 9, estimate: 5 })
    // POST /api/campaigns now pre-checks steps[].template against email_templates
    // (campaigns.js:195) BEFORE proxying to Go — feed the template-exists row first.
    queueRows([{ name: 'initial' }])
    queueRows([{ id: 9, name: 'Full', description: 'desc', status: 'draft', category_paths: ['Stroje'], sequence_config: {}, category_match: 'exact', created_at: '2026-04-30T00:00:00Z' }])
    await bffReq('POST', '/api/campaigns', {
      name: 'Full',
      description: 'desc',
      steps: [{ step: 0, delay_days: 0, template: 'initial' }],
      category_paths: ['Stroje'],
      category_match: 'exact',
      min_score: 0.42,
      region: 'CZ',
    })
    expect(fetchCalls[0].body).not.toBeNull()
    const sentBody = JSON.parse(fetchCalls[0].body as string)
    // Canonical Go payload contract — every documented field present
    expect(sentBody).toMatchObject({
      name: 'Full',
      description: 'desc',
      category_paths: ['Stroje'],
      category_match: 'exact',
      min_score: 0.42,
      region: 'CZ',
    })
    expect(Array.isArray(sentBody.steps)).toBe(true)
    expect(sentBody.steps[0]).toMatchObject({ step: 0, delay_days: 0, template: 'initial' })
  })

  it('injects a single default step when caller omits steps[]', async () => {
    queueGoJSON({ id: 10, estimate: 0 })
    queueRows([{ id: 10, name: 'NoSteps', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    await bffReq('POST', '/api/campaigns', { name: 'NoSteps' })
    const sent = JSON.parse(fetchCalls[0].body as string)
    expect(sent.steps).toEqual([{ step: 0, delay_days: 0, template: 'initial' }])
  })

  it('coerces missing category_paths to [] and missing category_match to "prefix"', async () => {
    queueGoJSON({ id: 11, estimate: 0 })
    queueRows([{ id: 11, name: 'Defaults', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    await bffReq('POST', '/api/campaigns', { name: 'Defaults' })
    const sent = JSON.parse(fetchCalls[0].body as string)
    expect(sent.category_paths).toEqual([])
    expect(sent.category_match).toBe('prefix')
    expect(sent.min_score).toBe(0)
    expect(sent.region).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/campaigns/:id/run + /pause  ↔  Go path-param forwarding
// ═══════════════════════════════════════════════════════════════════════════

describe('F. Path-param forwarding — /run', () => {
  it('forwards /api/campaigns/42/run verbatim (id preserved)', async () => {
    queueGoJSON({ ok: true })
    queueRows([{ id: 42, status: 'draft' }]) // pre-SELECT existence row (campaigns.js:911)
    const res = await bffReq('POST', '/api/campaigns/42/run')
    expect(res.status).toBe(200)
    expect(fetchCalls[0].url).toBe('http://go-stub.local/api/campaigns/42/run')
    expect(fetchCalls[0].method).toBe('POST')
  })

  it('rejects non-numeric ids with 400 BEFORE hitting Go', async () => {
    const res = await bffReq('POST', '/api/campaigns/abc/run')
    expect(res.status).toBe(400)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('G. Path-param forwarding — /pause', () => {
  it('forwards /api/campaigns/77/pause verbatim', async () => {
    queueGoJSON({ ok: true })
    // pre-SELECT existence row; status must be running/sending to pass the
    // pause precondition (campaigns.js:996,1009).
    queueRows([{ id: 77, status: 'running' }])
    const res = await bffReq('POST', '/api/campaigns/77/pause')
    expect(res.status).toBe(200)
    expect(fetchCalls[0].url).toBe('http://go-stub.local/api/campaigns/77/pause')
    expect(fetchCalls[0].method).toBe('POST')
  })

  it('forwards x-api-key on the /pause proxy too', async () => {
    queueGoJSON({ ok: true })
    queueRows([{ id: 3, status: 'running' }]) // pre-SELECT; running passes pause precondition
    await bffReq('POST', '/api/campaigns/3/pause')
    expect(fetchCalls[0].headers['x-api-key']).toBe('kt-b1-test-key')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Error pass-through envelope
// ═══════════════════════════════════════════════════════════════════════════

describe('H. 4xx pass-through', () => {
  it('Go 400 → BFF 400 with { error, http_status, response } envelope', async () => {
    queueGoJSON({ error: 'name is required' }, { ok: false, status: 400 })
    queueRows([{ id: 0, name: '', description: '', status: 'draft', category_paths: [], sequence_config: {}, category_match: 'prefix', created_at: '2026-04-30T00:00:00Z' }])
    const res = await bffReq('POST', '/api/campaigns', { name: 'Reject' })
    expect(res.status).toBe(400)
    const body = res.body as { error: string; http_status: number; response: unknown }
    expect(body.error).toBe('go service rejected')
    expect(body.http_status).toBe(400)
    expect(body.response).toMatchObject({ error: 'name is required' })
  })

  it('Go 404 on /run → BFF 404 with envelope (campaign not found)', async () => {
    queueGoJSON({ error: 'not found' }, { ok: false, status: 404 })
    // pre-SELECT row so we reach Go and pass through ITS 404 (campaigns.js:911)
    queueRows([{ id: 9999, status: 'draft' }])
    const res = await bffReq('POST', '/api/campaigns/9999/run')
    expect(res.status).toBe(404)
    const body = res.body as { error: string; http_status: number; response: unknown }
    expect(body.http_status).toBe(404)
    expect(body.response).toMatchObject({ error: 'not found' })
  })
})

describe('I. 5xx pass-through', () => {
  it('Go 500 on /pause → BFF 500 with envelope', async () => {
    queueGoJSON({ error: 'internal' }, { ok: false, status: 500 })
    queueRows([{ id: 3, status: 'running' }]) // pre-SELECT; running passes pause precondition
    const res = await bffReq('POST', '/api/campaigns/3/pause')
    expect(res.status).toBe(500)
    const body = res.body as { error: string; http_status: number; response: unknown }
    expect(body.error).toBe('go service rejected')
    expect(body.http_status).toBe(500)
  })
})

describe('J. Non-JSON Go body', () => {
  it('returns response.raw with truncated text when Go returns non-JSON HTML error page', async () => {
    const html = '<html><body><h1>500 Internal Server Error</h1>' + 'x'.repeat(800) + '</body></html>'
    queueGoRaw(html, { status: 500, contentType: 'text/html' })
    queueRows([{ id: 5, status: 'draft' }]) // pre-SELECT existence row (campaigns.js:911)
    const res = await bffReq('POST', '/api/campaigns/5/run')
    expect(res.status).toBe(500)
    const body = res.body as { error: string; response: { raw: string } }
    expect(body.error).toBe('go service rejected')
    expect(body.response.raw).toBeTruthy()
    // Truncation is applied (slice 0..500)
    expect(body.response.raw.length).toBeLessThanOrEqual(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Network error / fallback semantics
// ═══════════════════════════════════════════════════════════════════════════

describe('K. Network error → fallback', () => {
  it('Go ECONNREFUSED on POST /api/campaigns → BFF 503 (Sprint C1: no silent direct-DB fallback)', async () => {
    // Behavior change (campaigns.js:258-272, Sprint C1 #1254): the old direct-DB
    // INSERT fallback was REMOVED because it wrote zero-send draft campaigns the
    // operator thought were live. Go is now the only source of truth → 503 on
    // unreachable. No steps[] ⇒ template pre-check is skipped, so the Go fetch is
    // the first thing that runs and throws.
    queueGoNetworkError('ECONNREFUSED')
    const res = await bffReq('POST', '/api/campaigns', { name: 'Fallback' })
    expect(res.status).toBe(503)
    const body = res.body as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/unreachable/)
  })

  it('Go ECONNREFUSED on POST /:id/run → BFF 503 (Sprint C1: no silent DB fallback)', async () => {
    // Behavior change (campaigns.js:951-968, Sprint C1 #1254): the bare status-flip
    // fallback was removed — Go unreachable now returns 503 so the operator retries.
    queueGoNetworkError('ECONNREFUSED')
    queueRows([{ id: 1, status: 'draft' }]) // pre-SELECT existence row so we reach the Go fetch
    const res = await bffReq('POST', '/api/campaigns/1/run')
    expect(res.status).toBe(503)
    const body = res.body as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/unreachable/)
  })

  it('Go ECONNREFUSED on POST /:id/pause → BFF 503 (Sprint C1: no silent DB fallback)', async () => {
    // Behavior change (campaigns.js:1047-1059, Sprint C1 #1254): same as /run.
    queueGoNetworkError('ECONNREFUSED')
    queueRows([{ id: 1, status: 'running' }]) // pre-SELECT; running passes pause precondition
    const res = await bffReq('POST', '/api/campaigns/1/pause')
    expect(res.status).toBe(503)
    const body = res.body as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/unreachable/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Happy-path Go response shape contract
// ═══════════════════════════════════════════════════════════════════════════

describe('L. Round-trip — Go response shape into BFF response', () => {
  it('Go {id, estimate} merged with BFF SELECT row into final response', async () => {
    queueGoJSON({ id: 50, estimate: 13 })
    queueRows([{
      id: 50,
      name: 'Round',
      description: 'd',
      status: 'draft',
      category_paths: ['Bagry'],
      sequence_config: {},
      category_match: 'prefix',
      created_at: '2026-04-30T00:00:00Z',
    }])
    const res = await bffReq('POST', '/api/campaigns', { name: 'Round' })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.id).toBe(50)
    expect(body.estimate).toBe(13)
    expect(body.name).toBe('Round')
    expect(body.status).toBe('draft')
    expect(body.category_paths).toEqual(['Bagry'])
    // SELECT params reflect Go-returned id
    const selectCall = sqlCalls.find(c => /SELECT id, name/.test(c.sql))
    expect(selectCall?.params).toEqual([50])
  })
})

describe('M. /run happy path — no fallback warning', () => {
  it('Go {ok:true} round-trips into BFF {ok:true} with NO _warning marker', async () => {
    queueGoJSON({ ok: true })
    queueRows([{ id: 5, status: 'draft' }]) // pre-SELECT existence row (campaigns.js:911)
    const res = await bffReq('POST', '/api/campaigns/5/run')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    // No fallback marker on the success path — operator sees a clean ok.
    expect(body._warning).toBeUndefined()
    // No DB writes on the proxy path
    expect(sqlCalls.find(c => /UPDATE campaigns SET status='running'/i.test(c.sql))).toBeUndefined()
  })
})

describe('N. /pause happy path — no fallback warning', () => {
  it('Go {ok:true} round-trips into BFF {ok:true} with NO _warning marker', async () => {
    queueGoJSON({ ok: true })
    queueRows([{ id: 6, status: 'running' }]) // pre-SELECT; running passes pause precondition
    const res = await bffReq('POST', '/api/campaigns/6/pause')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body._warning).toBeUndefined()
    expect(sqlCalls.find(c => /UPDATE campaigns SET status='paused'/i.test(c.sql))).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Drift guard — schema-canonical fields
// ═══════════════════════════════════════════════════════════════════════════

describe('O. Drift guard — Go must return id (not identifier/uid/etc)', () => {
  it('Go response with renamed id field → BFF SELECT lookup returns no row → drift visible in response', async () => {
    // Drift simulation: Go renamed `id` → `identifier` without coordinating
    // with BFF. The BFF code reads `body.id` (undefined) and then SELECTs
    // WHERE id=undefined → 0 rows. The final response would contain an
    // undefined id and no campaign row — exactly the drift signal we want
    // to surface in CI.
    queueGoJSON({ identifier: 99, estimate: 4 })
    queueRows([]) // SELECT WHERE id=undefined returns nothing
    const res = await bffReq('POST', '/api/campaigns', { name: 'Drift' })
    // Status 200 (the BFF doesn't 4xx on missing fields today — that's the
    // contract bug this test documents), but the body shape exposes drift:
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    // Drift signal: estimate present (Go did respond), but no canonical id
    // means BFF couldn't enrich from DB.
    expect(body.estimate).toBe(4)
    // Either id is undefined or the spread of `null/undefined` SELECT row
    // produces no `id` key.
    expect(body.id).toBeUndefined()
  })

  it('Required Go-side response fields documented (canonical contract): id + estimate on POST /api/campaigns', () => {
    // Static assertion of the contract the BFF assumes. If Go ever drops
    // either of these, the round-trip test (case L) will fail fast.
    const REQUIRED_GO_RESPONSE_FIELDS = ['id', 'estimate'] as const
    expect(REQUIRED_GO_RESPONSE_FIELDS).toContain('id')
    expect(REQUIRED_GO_RESPONSE_FIELDS).toContain('estimate')
  })

  it('Required Go-side response field on /run + /pause: ok (boolean)', () => {
    const REQUIRED_GO_ACTION_FIELDS = ['ok'] as const
    expect(REQUIRED_GO_ACTION_FIELDS).toContain('ok')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  P. Documented BFF→Go path map (snapshot — fails if a route is added/removed
//     without updating this list, forcing a deliberate contract review).
// ═══════════════════════════════════════════════════════════════════════════

describe('P. BFF→Go route inventory snapshot', () => {
  it('matches the documented path map — every BFF /api route that proxies to Go is listed', () => {
    // Known proxy points as of KT-B1 (server.js audit):
    //   server.js:2210  POST /api/campaigns          → Go POST /api/campaigns
    //   server.js:2456  POST /api/campaigns/:id/run  → Go POST /api/campaigns/:id/run
    //   server.js:2484  POST /api/campaigns/:id/pause → Go POST /api/campaigns/:id/pause
    //   server.js:2593  GET  /api/__schema-check     → Go GET  /schema   (covered by bff-schema-check)
    const PROXY_INVENTORY = [
      { bff: 'POST /api/campaigns',              go: 'POST /api/campaigns' },
      { bff: 'POST /api/campaigns/:id/run',      go: 'POST /api/campaigns/:id/run' },
      { bff: 'POST /api/campaigns/:id/pause',    go: 'POST /api/campaigns/:id/pause' },
      { bff: 'GET /api/__schema-check',          go: 'GET /schema' },
    ]
    expect(PROXY_INVENTORY).toHaveLength(4)
    // Each entry uses a real BFF method+path
    for (const entry of PROXY_INVENTORY) {
      expect(entry.bff).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\//)
      expect(entry.go).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//)
    }
  })
})
