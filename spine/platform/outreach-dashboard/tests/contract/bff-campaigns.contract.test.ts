// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/campaigns + /api/campaigns/:id (+ /sends)
//
// Pins the list + detail + create + sends routes that don't have a
// dedicated contract test (bff-campaigns-preflight covers /preflight +
// /email-quality + /capacity but not the core CRUD surface).
// ═══════════════════════════════════════════════════════════════════════════

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
    // Transaction support for routes that use pool.connect(): the client shares
    // the same queued-result contract, but transaction-control statements pass
    // through transparently (no queue consume, no call registered) so existing
    // per-query expectations stay aligned.
    async connect() {
      const self = this
      return {
        async query(sql: string, params?: unknown[]) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(typeof sql === 'string' ? sql : '')) {
            return { rows: [], rowCount: 0 }
          }
          return self.query(sql, params)
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

// ── Go-proxy fetch stub ──────────────────────────────────────────────────────
// Sprint C1 (#1254): POST /api/campaigns now proxies to Go service.
// Tests that exercise the success path set process.env.GO_SERVER_URL='http://go-stub.local'
// and push Go response entries onto fetchQueue. The stub passes all other URLs
// (BFF HTTP requests from the req() helper) through to the real fetch.
type FetchStubResult = { ok: boolean; status: number; body: string }
const fetchQueue: FetchStubResult[] = []
const fetchCalls: Array<{ url: string; method: string; body: string | null }> = []
let realFetch: typeof fetch

function installFetchStub() {
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input)
    if (url.startsWith('http://go-stub.local')) {
      fetchCalls.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : null,
      })
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
  // Strip AFTER import — Vite's loadEnv repopulates GO_SERVER_URL from
  // .env when the module graph is processed. Tests that exercise the
  // Go-proxy path set it explicitly inside their `it` block.
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
  delete process.env.GO_SERVER_URL
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
//  GET /api/campaigns
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/campaigns', () => {
  it('200 returns list shape directly (not wrapped)', async () => {
    const rows = [
      { id: 1, name: 'Test', description: null, status: 'draft',
        category_paths: [], sequence_config: [], category_match: 'prefix',
        created_at: '2026-04-20', stats: {} },
    ]
    queueRows(rows)
    const res = await req('GET', '/api/campaigns')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(rows)
  })

  it('200 with [] when no rows', async () => {
    queueRows([])
    const res = await req('GET', '/api/campaigns')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('500 with {error} on pg throw', async () => {
    queueError('db down')
    const res = await req('GET', '/api/campaigns')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'db down' })
  })

  it('list query joins send_events for per-campaign stats', async () => {
    queueRows([])
    await req('GET', '/api/campaigns')
    expect(calls[0].sql).toMatch(/send_events/)
    expect(calls[0].sql).toMatch(/jsonb_object_agg/)
  })

  it('ORDER BY c.created_at DESC (newest first)', async () => {
    queueRows([])
    await req('GET', '/api/campaigns')
    expect(calls[0].sql).toMatch(/ORDER BY c\.created_at DESC/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/campaigns
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/campaigns', () => {
  it('400 when name missing', async () => {
    const res = await req('POST', '/api/campaigns', {})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'name required' })
  })

  it('400 when name is not a string', async () => {
    const res = await req('POST', '/api/campaigns', { name: 42 })
    expect(res.status).toBe(400)
  })

  it('400 when body is invalid JSON', async () => {
    const res = await req('POST', '/api/campaigns', 'not json{')
    expect(res.status).toBe(400)
  })

  it('200 returns full row with default sequence_config (3 steps)', async () => {
    // Sprint C1 (#1254): create is now proxied to Go service; BFF does a
    // SELECT after Go succeeds to return the full row shape.
    process.env.GO_SERVER_URL = 'http://go-stub.local'
    fetchQueue.push({ ok: true, status: 200, body: JSON.stringify({ id: 42, estimate: 5 }) })
    const defaultSeq = [
      { step: 0, delay_days: 0, template: 'initial' },
      { step: 1, delay_days: 5, template: 'followup1' },
      { step: 2, delay_days: 12, template: 'final' },
    ]
    // BFF does pool.query('SELECT ... FROM campaigns WHERE id=$1') after Go create.
    queueRows([{ id: 42, name: 'Foo', description: null, status: 'draft',
      category_paths: [], sequence_config: defaultSeq,
      category_match: 'prefix', created_at: '2026-04-20' }])
    const res = await req('POST', '/api/campaigns', { name: 'Foo' })
    expect(res.status).toBe(200)
    expect((res.body as any).sequence_config).toEqual(defaultSeq)
  })

  it('category_match defaults to "prefix" when omitted', async () => {
    // Sprint C1: BFF forwards creation to Go. Verify Go received category_match='prefix'.
    process.env.GO_SERVER_URL = 'http://go-stub.local'
    fetchQueue.push({ ok: true, status: 200, body: JSON.stringify({ id: 1, estimate: 0 }) })
    queueRows([{ id: 1, category_match: 'prefix' }])
    await req('POST', '/api/campaigns', { name: 'x' })
    const goBody = JSON.parse(fetchCalls[0].body ?? '{}') as Record<string, unknown>
    expect(goBody.category_match).toBe('prefix')
  })

  it('category_paths defaults to [] when not an array', async () => {
    // Sprint C1: BFF forwards creation to Go. Verify Go received category_paths=[].
    process.env.GO_SERVER_URL = 'http://go-stub.local'
    fetchQueue.push({ ok: true, status: 200, body: JSON.stringify({ id: 1, estimate: 0 }) })
    queueRows([{ id: 1 }])
    await req('POST', '/api/campaigns', { name: 'x', category_paths: 'not-array' })
    const goBody = JSON.parse(fetchCalls[0].body ?? '{}') as Record<string, unknown>
    expect(goBody.category_paths).toEqual([])
  })

  it('500 when INSERT fails', async () => {
    // Sprint C1: DB INSERT is owned by Go. Equivalent failure: Go returns 500.
    // BFF forwards the error status to the caller via res.status(r.status).
    process.env.GO_SERVER_URL = 'http://go-stub.local'
    fetchQueue.push({ ok: false, status: 500, body: JSON.stringify({ error: 'db_error' }) })
    const res = await req('POST', '/api/campaigns', { name: 'x' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/campaigns/:id
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/campaigns/:id', () => {
  it('404 when id is not numeric', async () => {
    const res = await req('GET', '/api/campaigns/abc')
    expect(res.status).toBe(404)
    // Sprint v2: route calls next() for non-numeric IDs to allow sibling routes
    // (e.g. /api/campaigns/last-24h-summary). Express returns HTML 404 for
    // unmatched paths — body parses as a string, not a JSON object.
    expect(typeof res.body).toBe('string')
  })

  it('404 when campaign missing', async () => {
    queueRows([]) // no row
    const res = await req('GET', '/api/campaigns/999')
    expect(res.status).toBe(404)
  })

  it('200 returns {campaign, stats}', async () => {
    queueRows([{ id: 7, name: 'Foo', status: 'draft', category_paths: [], sequence_config: [], category_match: 'prefix', created_at: '2026-04-20', updated_at: '2026-04-20' }])
    queueRows([{ status: 'sent', cnt: 12 }, { status: 'bounced', cnt: 1 }])
    const res = await req('GET', '/api/campaigns/7')
    expect(res.status).toBe(200)
    expect((res.body as any).campaign.id).toBe(7)
    expect((res.body as any).stats).toEqual({ sent: 12, bounced: 1 })
  })

  it('stats query failure → stats={}, campaign still returned', async () => {
    queueRows([{ id: 7, name: 'Foo', status: 'draft', category_paths: [], sequence_config: [], category_match: 'prefix', created_at: '2026-04-20', updated_at: '2026-04-20' }])
    queueError('stats query timeout')
    const res = await req('GET', '/api/campaigns/7')
    // stats query .catch(() => ({rows:[]})), so 200 still.
    expect(res.status).toBe(200)
    expect((res.body as any).stats).toEqual({})
  })

  it('500 on initial campaign-lookup error', async () => {
    queueError('db down')
    const res = await req('GET', '/api/campaigns/7')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/campaigns/:id/sends
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/campaigns/:id/sends', () => {
  it('200 with default limit=50', async () => {
    queueRows([])
    await req('GET', '/api/campaigns/7/sends')
    // params[1] is limit
    expect(calls[0].params?.[1]).toBe(50)
  })

  it('200 clamps limit to max 200', async () => {
    queueRows([])
    await req('GET', '/api/campaigns/7/sends?limit=500')
    expect(calls[0].params?.[1]).toBe(200)
  })

  it('200 respects explicit offset', async () => {
    queueRows([])
    await req('GET', '/api/campaigns/7/sends?offset=25')
    expect(calls[0].params?.[2]).toBe(25)
  })

  it('returns [] gracefully when send_events table missing (.catch path)', async () => {
    queueError('relation send_events does not exist')
    const res = await req('GET', '/api/campaigns/7/sends')
    // .catch(() => ({rows:[]})) swallows → 200 with []
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})
