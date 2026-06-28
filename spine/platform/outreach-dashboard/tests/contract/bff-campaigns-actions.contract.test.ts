// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/campaigns/:id/{run,pause} + PATCH/:id + DELETE/:id
//
// Completes the campaign-action surface coverage. Complements:
//   - bff-campaigns.contract.test.ts (GET list + GET detail + POST + /sends)
//   - bff-campaigns-preflight.contract.test.ts (/preflight /email-quality /capacity)
//
// Fix history:
//   - 2026-05-05: Fixed Pool mock to include PoolClient + connect() so that
//     handlers using pool.connect() work correctly. Updated pause tests to
//     queue the SELECT status row. Added #940 precondition tests (412 when
//     pausing a draft/paused/completed campaign).
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

// Full Pool + PoolClient mock — handlers that use pool.connect() need
// a PoolClient with query() and release(). Mirrors the mock in
// bff-delete-audit-log.contract.test.ts which covers the same pattern.
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

// ── Go-proxy fetch stub ──────────────────────────────────────────────────────
// Sprint C1 (#1254): /run and /pause now proxy to Go service (no DB fallback).
// The stub intercepts 'http://go-stub.local' URLs; all other URLs (BFF HTTP
// requests from the req() helper) pass through to the real fetch.
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

let baseUrl = ''
let server: import('http').Server

const savedEnv: Record<string, string | undefined> = {}
beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  installFetchStub()
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
  // tests in this file exercise the Go-proxy path. Tests that return before
  // the Go check (404, 500 from BEGIN, 412 precondition) are unaffected.
  process.env.GO_SERVER_URL = 'http://go-stub.local'
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/campaigns/:id/run
//
//  Handler flow (fallback path, GO_SERVER_URL unset):
//    pool.connect() → BEGIN → SELECT id,status → UPDATE → audit INSERT → COMMIT
//
//  Queue strategy: each client.query() call consumes one queue entry.
//  Default (empty queue) returns {rows:[],rowCount:0}.
//  So queue: empty for BEGIN, then the SELECT row; UPDATE/audit/COMMIT use defaults.
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/campaigns/:id/run', () => {
  // NOTE: All tests use ?force=1 to bypass the runPreflight gate so they
  // exercise the Go-proxy path in isolation. The preflight gate itself is
  // covered by bff-run-preflight.contract.test.ts.
  it('200 {ok:true} on success (Go proxy path)', async () => {
    // OLD mock: BEGIN consumes first entry; SELECT consumes second entry.
    queueRows([]) // BEGIN
    queueRows([{ id: 42, status: 'draft' }]) // SELECT
    // Sprint C1: Go proxy returns {ok:true}; BFF forwards it to caller.
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await req('POST', '/api/campaigns/42/run?force=1')
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })

  it('forwards /run to Go service with correct campaign ID (Sprint C1)', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 42, status: 'draft' }]) // SELECT
    await req('POST', '/api/campaigns/42/run?force=1')
    // Sprint C1: Go service owns the state change; BFF proxies and audits.
    // Verify BFF forwarded the /run action to Go with the correct campaign ID.
    expect(fetchCalls.some(f => f.url.includes('/campaigns/42/run'))).toBe(true)
  })

  it('404 when campaign not found', async () => {
    queueRows([]) // BEGIN
    // SELECT returns empty → not found
    const res = await req('POST', '/api/campaigns/9999/run?force=1')
    expect(res.status).toBe(404)
    expect((res.body as { error: string }).error).toMatch(/not found/i)
  })

  it('500 when pg throws on BEGIN', async () => {
    queueError('constraint fail')
    const res = await req('POST', '/api/campaigns/42/run?force=1')
    expect(res.status).toBe(500)
  })

  it('GET method not registered (only POST)', async () => {
    const res = await req('GET', '/api/campaigns/42/run')
    // Note: no direct GET handler for /run — Express 404 OR generic detail fallback.
    expect(res.status).not.toBe(200)
  })

  it('x-preflight-only: 1 returns preflight result without running (200 or 412)', async () => {
    // With empty pool responses, runPreflight will find no mailboxes → blockers → 412.
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-preflight-only': '1' },
    }
    const r = await fetch(baseUrl + '/api/campaigns/42/run', init)
    const body = await r.json() as { ok: boolean; preflight_only: boolean; blockers: unknown[] }
    // Must be 200 or 412 (not 500, not actual run)
    expect([200, 412]).toContain(r.status)
    expect(body.preflight_only).toBe(true)
    expect(Array.isArray(body.blockers)).toBe(true)
    // No UPDATE query should have fired — preflight-only is read-only
    expect(calls.find(c => /UPDATE campaigns SET status/i.test(c.sql))).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/campaigns/:id/pause
//
//  Handler flow (fallback path, GO_SERVER_URL unset):
//    BEGIN → SELECT id, status → [precondition check] → UPDATE → audit → COMMIT
//
//  #940 precondition: only running/sending campaigns can be paused.
//  Anything else → 412 with {error, current_status, hint}.
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/campaigns/:id/pause', () => {
  it('200 {ok:true} when campaign is running (happy path)', async () => {
    // OLD mock: BEGIN consumes first entry; SELECT consumes second.
    queueRows([]) // BEGIN
    queueRows([{ id: 42, status: 'running' }]) // SELECT
    // Sprint C1: Go proxy returns {ok:true}; BFF forwards it to caller.
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await req('POST', '/api/campaigns/42/pause')
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })

  it('200 {ok:true} when campaign is sending', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 42, status: 'sending' }]) // SELECT
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await req('POST', '/api/campaigns/42/pause')
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })

  it('forwards /pause to Go service with correct campaign ID (Sprint C1)', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 42, status: 'running' }]) // SELECT
    await req('POST', '/api/campaigns/42/pause')
    // Sprint C1: Go service owns the state change; verify BFF forwarded /pause.
    expect(fetchCalls.some(f => f.url.includes('/campaigns/42/pause'))).toBe(true)
  })

  it('404 when campaign not found', async () => {
    queueRows([]) // BEGIN
    // SELECT returns empty (default empty queue response)
    const res = await req('POST', '/api/campaigns/42/pause')
    expect(res.status).toBe(404)
    expect((res.body as { error: string }).error).toMatch(/not found/i)
  })

  it('500 when pg throws on BEGIN', async () => {
    queueError('db down')
    const res = await req('POST', '/api/campaigns/42/pause')
    expect(res.status).toBe(500)
  })

  // ── #940 precondition tests ─────────────────────────────────────────────
  it('412 when campaign is in draft status (#940 precondition)', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'draft' }]) // SELECT
    const res = await req('POST', '/api/campaigns/1/pause')
    expect(res.status).toBe(412)
    const body = res.body as { error: string; current_status: string }
    expect(body.error).toMatch(/cannot pause/i)
    expect(body.current_status).toBe('draft')
  })

  it('412 when campaign is already paused (#940 precondition)', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'paused' }]) // SELECT
    const res = await req('POST', '/api/campaigns/1/pause')
    expect(res.status).toBe(412)
    const body = res.body as { error: string; current_status: string }
    expect(body.error).toMatch(/cannot pause/i)
    expect(body.current_status).toBe('paused')
  })

  it('412 when campaign is completed (#940 precondition)', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'completed' }]) // SELECT
    const res = await req('POST', '/api/campaigns/1/pause')
    expect(res.status).toBe(412)
    const body = res.body as { error: string; current_status: string }
    expect(body.current_status).toBe('completed')
  })

  it('412 when campaign is archived (#940 precondition)', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'archived' }]) // SELECT
    const res = await req('POST', '/api/campaigns/1/pause')
    expect(res.status).toBe(412)
  })

  it('412 response body includes current_status and hint fields', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 5, status: 'draft' }]) // SELECT
    const res = await req('POST', '/api/campaigns/5/pause')
    expect(res.status).toBe(412)
    const body = res.body as { error: string; current_status: string; hint: string }
    expect(body.current_status).toBe('draft')
    expect(typeof body.hint).toBe('string')
    expect(body.hint.length).toBeGreaterThan(0)
  })

  it('412 does NOT issue any UPDATE query', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'draft' }]) // SELECT
    await req('POST', '/api/campaigns/1/pause')
    const updateCall = calls.find(c => /UPDATE campaigns SET status/i.test(c.sql))
    expect(updateCall).toBeUndefined()
  })

  it('run → pause state transitions use distinct Go proxy endpoints (Sprint C1)', async () => {
    // Sprint C1: Go service owns the state change; BFF proxies each action.
    // Verify /run and /pause reach distinct Go endpoints.
    queueRows([]) // BEGIN for run
    queueRows([{ id: 1, status: 'draft' }]) // SELECT for run
    await req('POST', '/api/campaigns/1/run?force=1')
    const runCall = fetchCalls.find(f => f.url.includes('/campaigns/1/run'))
    expect(runCall).toBeDefined()

    fetchCalls.length = 0
    calls.length = 0

    queueRows([]) // BEGIN for pause
    queueRows([{ id: 1, status: 'running' }]) // SELECT for pause
    await req('POST', '/api/campaigns/1/pause')
    const pauseCall = fetchCalls.find(f => f.url.includes('/campaigns/1/pause'))
    expect(pauseCall).toBeDefined()
    // Verify they targeted different action endpoints
    expect(runCall!.url).not.toBe(pauseCall!.url)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PATCH /api/campaigns/:id
// ═══════════════════════════════════════════════════════════════════════

// PATCH handler flow: pool.connect() → BEGIN → SELECT id,status → UPDATE → audit INSERT → COMMIT
// Queue strategy: empty for BEGIN, existing campaign row for SELECT, then UPDATE result row.
describe('PATCH /api/campaigns/:id', () => {
  it('200 returns updated row', async () => {
    const row = { id: 7, name: 'Foo', status: 'paused', stats: {}, created_at: '2026-04-20' }
    queueRows([])  // BEGIN
    queueRows([{ id: 7, status: 'draft' }]) // SELECT current state
    queueRows([row]) // UPDATE RETURNING
    const res = await req('PATCH', '/api/campaigns/7', { status: 'paused' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(row)
  })

  it('passes status into UPDATE query params', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, status: 'draft' }]) // SELECT current state
    queueRows([{ id: 7 }]) // UPDATE RETURNING
    await req('PATCH', '/api/campaigns/7', { status: 'archived' })
    const updateCall = calls.find(c => /UPDATE campaigns SET status/i.test(c.sql))
    expect(updateCall).toBeDefined()
    expect(updateCall!.params).toEqual(['archived', '7'])
  })

  it('404 when campaign not found', async () => {
    queueRows([]) // BEGIN
    // SELECT returns empty → not found
    const res = await req('PATCH', '/api/campaigns/7', { status: 'paused' })
    expect(res.status).toBe(404)
  })

  it('500 when pg throws on BEGIN', async () => {
    // status validation runs BEFORE pool.connect() — an invalid status value
    // returns 400 before DB is touched. Use a valid status ('paused') so
    // validation passes and BEGIN fires, consuming the queued error → 500.
    queueError('syntax err')
    const res = await req('PATCH', '/api/campaigns/7', { status: 'paused' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/campaigns/:id
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/campaigns/:id', () => {
  it('200 {ok:true} on success', async () => {
    // DELETE handler: BEGIN → SELECT campaign → DELETE → audit INSERT → COMMIT
    queueRows([]) // BEGIN
    queueRows([{ id: 7, name: 'Test Campaign', subject: null }]) // SELECT
    const res = await req('DELETE', '/api/campaigns/7')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('issues DELETE FROM campaigns', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 7, name: 'Test', subject: null }]) // SELECT
    await req('DELETE', '/api/campaigns/7')
    const deleteCall = calls.find(c => /DELETE FROM campaigns/i.test(c.sql))
    expect(deleteCall).toBeDefined()
    expect(deleteCall!.params).toEqual(['7'])
  })

  it('404 when campaign not found', async () => {
    queueRows([]) // BEGIN
    // SELECT returns empty (default empty queue response)
    const res = await req('DELETE', '/api/campaigns/7')
    expect(res.status).toBe(404)
  })

  it('500 when pg throws on BEGIN', async () => {
    queueError('fk constraint violation')
    const res = await req('DELETE', '/api/campaigns/7')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Cross-action transitions
// ═══════════════════════════════════════════════════════════════════════

describe('state transition contracts', () => {
  it('pause from draft → 412 (not 200)', async () => {
    // Server must reject: cannot pause a draft campaign.
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'draft' }]) // SELECT
    const a = await req('POST', '/api/campaigns/1/pause')
    expect(a.status).toBe(412)
  })

  it('pause from running → 200', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'running' }]) // SELECT
    const a = await req('POST', '/api/campaigns/1/pause')
    expect(a.status).toBe(200)
  })

  it('run → run returns 200 twice (run is idempotent via blind UPDATE)', async () => {
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'draft' }]) // SELECT
    const a = await req('POST', '/api/campaigns/1/run?force=1')
    queueRows([]) // BEGIN
    queueRows([{ id: 1, status: 'running' }]) // SELECT
    const b = await req('POST', '/api/campaigns/1/run?force=1')
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })
})
