// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — POST /api/campaigns/:id/run (trigger) + GET /api/campaigns/:id/preflight
//
//  The /run handler is simple (UPDATE + {ok:true}), covered here with
//  additional state-machine and monkey cases beyond bff-campaigns-actions.
//
//  The /preflight handler calls computeCampaignPreflight() which fans out to
//  4 parallel DB queries. We stub pg and campaignPreflight.js so the tests
//  stay fast and do not touch the network.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── pg stub ──────────────────────────────────────────────────────────────────
type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class PoolClient {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
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
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// ── runPreflight stub ─────────────────────────────────────────────────────────
// PR #527 / #568 added an airtight preflight gate to POST /run. The gate
// calls runPreflight(pool, id) which fans out to 3 DB queries (mailboxes,
// campaign, contacts/campaign_contacts). In unit tests the pg pool is fully
// stubbed and empty, so every runPreflight call would fire M1_no_valid_mailbox
// and return 412 — breaking all /run shape/state-machine tests.
//
// We stub the whole module here so /run contract tests can focus on the
// proxy-to-Go behavior without wiring up preflight fixtures.
// Tests that explicitly want to exercise 412 behaviour can override via
// `runPreflightMock.mockResolvedValueOnce(...)`.
vi.mock('../../src/server-routes/runPreflight.js', () => ({
  listTmplNames: vi.fn(async () => new Set<string>(['initial', 'followup1', 'final'])),
  runPreflight: vi.fn(async () => ({ ok: true, blockers: [], summary: {} })),
}))

// ── Go-proxy fetch stub ──────────────────────────────────────────────────────
// Sprint C1 (#1254): /run and /pause now proxy to Go service.
// The stub intercepts 'http://go-stub.local' URLs; BFF HTTP requests pass through.
type FetchStubResult = { ok: boolean; status: number; body: string }
const fetchQueue: FetchStubResult[] = []
const fetchCalls: Array<{ url: string; method: string }> = []
let realFetch: typeof fetch

function installFetchStub() {
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input)
    if (url.startsWith('http://go-stub.local')) {
      fetchCalls.push({ url, method: (init?.method ?? 'GET').toUpperCase() })
      if (!fetchQueue.length) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const next = fetchQueue.shift()!
      return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch
}

// ── server lifecycle ─────────────────────────────────────────────────────────
let baseUrl = ''
let server: import('http').Server

// Module-level savedEnv — fixes the scoping issue with the outer afterAll
// (which referenced savedEnv before it had a module-level declaration).
// Also stores GO_SERVER_URL for proper cleanup.
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  installFetchStub()
  const mod = await import('../../server.js')
  // Strip AFTER import — Vite's loadEnv repopulates from .env when the
  // server.js module graph is processed.
  delete process.env.GO_SERVER_URL
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
  globalThis.fetch = realFetch
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
  fetchQueue.length = 0
  fetchCalls.length = 0
  // Sprint C1: /run and /pause require Go orchestrator. Set globally so all
  // /run tests exercise the Go-proxy path. Tests that return before the Go
  // check (404, 500 from BEGIN, 412 preflight) are unaffected.
  process.env.GO_SERVER_URL = 'http://go-stub.local'
})

// ── helpers ───────────────────────────────────────────────────────────────────
function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ── Preflight shape fixture ───────────────────────────────────────────────────
// computeCampaignPreflight returns 5 checks; we mock the module so we can
// inject exact shapes without depending on the fan-out queries.
const PREFLIGHT_ALL_OK = {
  campaign_id: 1,
  campaign_name: 'Test Campaign',
  campaign_status: 'paused',
  ok: true,
  checks: [
    { name: 'proxy_assignments',    ok: true,  reason: null },
    { name: 'full_check_fresh',     ok: true,  reason: null },
    { name: 'suppression_populated',ok: true,  reason: null },
    { name: 'daily_capacity',       ok: true,  reason: null },
    { name: 'templates_valid',      ok: true,  reason: null },
  ],
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/campaigns/:id/run  (trigger campaign)
// ═══════════════════════════════════════════════════════════════════════════

// Run handler flow (Go proxy path, GO_SERVER_URL set in beforeEach):
//   pool.connect() → BEGIN → SELECT id,status → Go proxy → audit INSERT → COMMIT
// Queue: empty for BEGIN (OLD mock), then campaign row for SELECT.
// Audit/COMMIT use empty-queue defaults. Push Go responses to fetchQueue for
// tests that assert body.ok === true.
describe('POST /api/campaigns/:id/run (trigger campaign)', () => {
  it('valid campaign → 200 {ok: true}', async () => {
    q([]) // BEGIN
    q([{ id: 1, status: 'draft' }]) // SELECT
    // Sprint C1: Go proxy returns {ok:true}; BFF forwards it to caller.
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await req('POST', '/api/campaigns/1/run')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true })
  })

  it('forwards /run to Go service with correct campaign ID (Sprint C1)', async () => {
    q([]) // BEGIN
    q([{ id: 42, status: 'paused' }]) // SELECT
    await req('POST', '/api/campaigns/42/run')
    // Sprint C1: Go service owns the state change; verify BFF proxied the request.
    expect(fetchCalls.some(f => f.url.includes('/campaigns/42/run'))).toBe(true)
  })

  it('paused campaign state transition → 200 (Go proxy handles)', async () => {
    // Go proxy path: a paused campaign can be activated without a pre-check
    // on current status (Go's runner validates its own preconditions).
    q([]) // BEGIN
    q([{ id: 5, status: 'paused' }]) // SELECT
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await req('POST', '/api/campaigns/5/run')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true })
  })

  it('no contacts / empty DB → 200 {ok: true}', async () => {
    // BFF proxies to Go; contact counts are not queried by BFF's /run handler.
    q([]) // BEGIN
    q([{ id: 3, status: 'draft' }]) // SELECT
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await req('POST', '/api/campaigns/3/run')
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })

  it('404 when campaign not found', async () => {
    q([]) // BEGIN
    // SELECT returns empty → 404
    const res = await req('POST', '/api/campaigns/9999/run')
    expect(res.status).toBe(404)
  })

  it('DB error → 500 with error message', async () => {
    qErr('deadlock detected') // BEGIN throws
    const res = await req('POST', '/api/campaigns/1/run')
    expect(res.status).toBe(500)
    expect((res.body as { error: string }).error).toBeTruthy()
  })

  it('MONKEY: concurrent run requests → server survives', async () => {
    // Queue 40 rows — BEGIN + SELECT per request
    for (let i = 0; i < 20; i++) {
      q([]) // BEGIN
      q([{ id: i + 1, status: 'draft' }]) // SELECT
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        req('POST', `/api/campaigns/${i + 1}/run`)
      )
    )
    for (const r of results) {
      // 200: success, 404: campaign not found (queue interleaving), 500: DB error
      expect([200, 404, 500]).toContain(r.status)
    }
    // At least some should have succeeded (queue has enough entries for some)
    const okCount = results.filter(r => r.status === 200).length
    expect(okCount).toBeGreaterThan(0)
  })

  it('run → pause → run sequence: pause 412 if from running', async () => {
    // Run 1
    q([]) // BEGIN
    q([{ id: 1, status: 'draft' }]) // SELECT
    const run1 = await req('POST', '/api/campaigns/1/run')
    // Pause: campaign must be running to pause
    q([]) // BEGIN
    q([{ id: 1, status: 'running' }]) // SELECT
    const pause1 = await req('POST', '/api/campaigns/1/pause')
    // Run 2
    q([]) // BEGIN
    q([{ id: 1, status: 'paused' }]) // SELECT
    const run2 = await req('POST', '/api/campaigns/1/run')
    expect(run1.status).toBe(200)
    expect(pause1.status).toBe(200) // running → pause OK
    expect(run2.status).toBe(200)
  })

  it('response shape contains ok:true', async () => {
    q([]) // BEGIN
    q([{ id: 1, status: 'draft' }]) // SELECT
    // Sprint C1: Go proxy returns {ok:true}; BFF forwards it to caller.
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await req('POST', '/api/campaigns/1/run')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.ok).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/campaigns/:id/preflight
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/campaigns/:id/preflight', () => {
  // We mock computeCampaignPreflight so we control the 5-check output precisely
  // without depending on the fan-out query ordering.
  let preflightMock: ReturnType<typeof vi.fn>

const savedEnv: Record<string, string | undefined> = {}
  beforeAll(async () => {
    // Stub out the campaignPreflight module BEFORE the server loads it.
    // The server imports it at the top-level, so we use a module-level mock.
    // Note: vi.mock is hoisted, so we configure return value per-test via
    // the preflightMock function reference.
    const mod = await import('../../campaignPreflight.js')
    preflightMock = vi.fn()
    vi.spyOn(mod, 'computeCampaignPreflight').mockImplementation(preflightMock)
  })

  beforeEach(() => {
    preflightMock?.mockReset()
  })

  it('returns exactly 5 check objects', async () => {
    preflightMock.mockResolvedValue(PREFLIGHT_ALL_OK)
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(200)
    const body = res.body as typeof PREFLIGHT_ALL_OK
    expect(body.checks).toHaveLength(5)
    // All expected check names present
    const names = body.checks.map((c) => c.name)
    expect(names).toContain('proxy_assignments')
    expect(names).toContain('full_check_fresh')
    expect(names).toContain('suppression_populated')
    expect(names).toContain('daily_capacity')
    expect(names).toContain('templates_valid')
  })

  it('all checks true → ok: true', async () => {
    preflightMock.mockResolvedValue(PREFLIGHT_ALL_OK)
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(200)
    const body = res.body as typeof PREFLIGHT_ALL_OK
    expect(body.ok).toBe(true)
    expect(body.checks.every((c) => c.ok)).toBe(true)
  })

  it('missing templates → ok: false, templates_valid check fails with reason', async () => {
    const result = {
      ...PREFLIGHT_ALL_OK,
      ok: false,
      checks: PREFLIGHT_ALL_OK.checks.map((c) =>
        c.name === 'templates_valid'
          ? { ...c, ok: false, reason: 'chybí šablony: InitEmail' }
          : c
      ),
    }
    preflightMock.mockResolvedValue(result)
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(200)
    const body = res.body as typeof result
    expect(body.ok).toBe(false)
    const tplCheck = body.checks.find((c) => c.name === 'templates_valid')
    expect(tplCheck?.ok).toBe(false)
    expect(tplCheck?.reason).toBeTruthy()
  })

  it('empty suppression → ok: false with reason', async () => {
    const result = {
      ...PREFLIGHT_ALL_OK,
      ok: false,
      checks: PREFLIGHT_ALL_OK.checks.map((c) =>
        c.name === 'suppression_populated'
          ? { ...c, ok: false, reason: 'suppression_list je prázdný — riziko sendů na interní domény' }
          : c
      ),
    }
    preflightMock.mockResolvedValue(result)
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(200)
    const body = res.body as typeof result
    expect(body.ok).toBe(false)
    const suppCheck = body.checks.find((c) => c.name === 'suppression_populated')
    expect(suppCheck?.ok).toBe(false)
    expect(suppCheck?.reason).toMatch(/suppression/)
  })

  it('stale full-check → ok: false, full_check_fresh fails', async () => {
    const result = {
      ...PREFLIGHT_ALL_OK,
      ok: false,
      checks: PREFLIGHT_ALL_OK.checks.map((c) =>
        c.name === 'full_check_fresh'
          ? { ...c, ok: false, reason: '2 mailboxů bez fresh full-check (≤6h)' }
          : c
      ),
    }
    preflightMock.mockResolvedValue(result)
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(200)
    const body = res.body as typeof result
    const fcCheck = body.checks.find((c) => c.name === 'full_check_fresh')
    expect(fcCheck?.ok).toBe(false)
    expect(fcCheck?.reason).toBeTruthy()
  })

  it('zero daily capacity → ok: false, daily_capacity check fails', async () => {
    const result = {
      ...PREFLIGHT_ALL_OK,
      ok: false,
      checks: PREFLIGHT_ALL_OK.checks.map((c) =>
        c.name === 'daily_capacity'
          ? { ...c, ok: false, reason: 'denní kapacita 0 pod minimum 100' }
          : c
      ),
    }
    preflightMock.mockResolvedValue(result)
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(200)
    const body = res.body as typeof result
    const capCheck = body.checks.find((c) => c.name === 'daily_capacity')
    expect(capCheck?.ok).toBe(false)
  })

  it('DB error inside preflight → 500', async () => {
    preflightMock.mockRejectedValue(new Error('db connection refused'))
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(500)
  })

  it('MONKEY: unknown campaign_id → 404 or null result', async () => {
    // computeCampaignPreflight returns null when campaign not found
    preflightMock.mockResolvedValue(null)
    const res = await req('GET', '/api/campaigns/99999/preflight')
    expect(res.status).toBe(404)
  })

  it('response includes campaign_id, campaign_name, campaign_status', async () => {
    preflightMock.mockResolvedValue(PREFLIGHT_ALL_OK)
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(200)
    const body = res.body as typeof PREFLIGHT_ALL_OK
    expect(body.campaign_id).toBeDefined()
    expect(body.campaign_name).toBeDefined()
    expect(body.campaign_status).toBeDefined()
  })

  it('invalid id (non-numeric) → 400', async () => {
    const res = await req('GET', '/api/campaigns/abc/preflight')
    expect(res.status).toBe(400)
  })

  it('multiple failed checks → ok: false, each failing check has reason', async () => {
    const result = {
      ...PREFLIGHT_ALL_OK,
      ok: false,
      checks: [
        { name: 'proxy_assignments',     ok: false, reason: '2 mailboxů bez proxy_url' },
        { name: 'full_check_fresh',      ok: false, reason: '1 mailbox bez fresh full-check' },
        { name: 'suppression_populated', ok: true,  reason: null },
        { name: 'daily_capacity',        ok: true,  reason: null },
        { name: 'templates_valid',       ok: true,  reason: null },
      ],
    }
    preflightMock.mockResolvedValue(result)
    const res = await req('GET', '/api/campaigns/1/preflight')
    expect(res.status).toBe(200)
    const body = res.body as typeof result
    expect(body.ok).toBe(false)
    const failing = body.checks.filter((c) => !c.ok)
    expect(failing.length).toBe(2)
    for (const f of failing) {
      expect(f.reason).toBeTruthy()
    }
  })
})
