// Pre-flight gate on POST /api/campaigns/:id/run.
// ─────────────────────────────────────────────────────────────────────────────
// Verifies the gate refuses to /run a campaign that would silently fail:
//   M1 — no mailbox has a real password (every send hits SMTP-AUTH fail)
//   T1 — campaign has no template with subject + body
//   S1 — campaign's category_paths cover zero eligible contacts
//
// Plus the deliberate-override path (`?force=1`) and the "all good" path
// where the gate forwards through to the Go upstream.

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
        on() {} end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// ── Go-proxy fetch stub ──────────────────────────────────────────────────────
// Sprint C1 (#1254): after passing preflight, /run proxies to Go service.
// The stub intercepts 'http://go-stub.local' URLs; BFF HTTP requests + the
// runPreflight self-fetch to /api/anti-trace/egress pass through to realFetch.
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
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  installFetchStub()
  vi.resetModules()
  const mod = await import('../../server.js')
  // server.js loads .env on import — wipe AFTER import.
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
  // Sprint C1: /run proxies to Go after preflight passes. Set globally so
  // happy-path tests exercise the Go-proxy path. Tests that 412 in preflight
  // return before the Go check and are unaffected.
  process.env.GO_SERVER_URL = 'http://go-stub.local'
})

function pushAll(...outcomes: QueryOutcome[]) { queryQueue.push(...outcomes) }

function readyCampaignSetup() {
  // Pre-flight runs in this order: mailboxes → campaign lookup → template → segments
  // After preflight passes, /run handler: BEGIN (transparent) → SELECT → Go proxy
  // Sprint AH: only 'intro_machinery.tmpl' exists on disk in test env; using
  // 'initial' triggers T2_missing_tmpl_file → 412. Use 'intro_machinery'.
  pushAll(
    { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'active' }] },
    { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ step: 0, template: 'intro_machinery' }] }] },
    // template path takes the sequence-config branch (no DB query)
    { rows: [{ n: 100 }] },  // eligible-contacts COUNT
    // /run handler: BEGIN (transparent) → SELECT id,status → Go proxy
    { rows: [{ id: 1, status: 'paused' }] },  // SELECT campBefore in /run handler
  )
}

describe('POST /api/campaigns/:id/run — pre-flight gate', () => {
  it('1: 412 when no mailbox has a valid password', async () => {
    pushAll(
      { rows: [
        { id: 1, email: 'a@x.cz', password: 'xxxxxxxx' },
        { id: 2, email: 'b@x.cz', password: 'admin123' },
      ]},
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ step: 0, template: 'initial' }] }] },
      { rows: [{ n: 100 }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'M1_no_valid_mailbox')).toBe(true)
  })

  it('2: 412 when campaign not found', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99' }] },
      { rows: [] },  // campaign lookup empty
    )
    const res = await fetch(`${baseUrl}/api/campaigns/9999/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'C1_not_found')).toBe(true)
  })

  it('3: 412 when campaign has no sectors selected', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: [], sequence_config: [{ step: 0, template: 'initial' }] }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'S1_no_sectors')).toBe(true)
  })

  it('4: 412 when zero eligible contacts in selected sectors', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ step: 0, template: 'initial' }] }] },
      { rows: [{ n: 0 }] },  // zero eligible
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'S1_zero_eligible')).toBe(true)
  })

  it('5: 412 when campaign has no template references and DB has no usable templates', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [] }] },
      // template fallback DB lookup → empty
      { rows: [] },
      { rows: [{ n: 100 }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'T1_no_template')).toBe(true)
  })

  it('6: 412 response carries Czech detail text and action_url for each blocker', async () => {
    pushAll(
      { rows: [] },  // zero mailboxes
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ step: 0, template: 'initial' }] }] },
      { rows: [{ n: 100 }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    const body = await res.json() as { blockers: Array<{ detail: string; action_url: string }> }
    expect(body.blockers.length).toBeGreaterThan(0)
    for (const b of body.blockers) {
      expect(typeof b.detail).toBe('string')
      expect(b.detail.length).toBeGreaterThan(0)
      expect(b.action_url).toMatch(/^\//)
    }
  })

  it('7: 412 response includes a hint about ?force=1', async () => {
    pushAll(
      { rows: [] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ step: 0, template: 'initial' }] }] },
      { rows: [{ n: 100 }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    const body = await res.json() as { hint: string }
    expect(body.hint).toMatch(/force=1/)
  })

  it('8: ?force=1 bypasses pre-flight and proxies to Go', async () => {
    // With force=1 the gate is skipped entirely; /run handler: BEGIN (transparent)
    // → SELECT campBefore → Go proxy. Sprint C1: Go proxy returns {ok:true}.
    pushAll({ rows: [{ id: 1, status: 'paused' }] })  // SELECT campBefore in /run handler
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await fetch(`${baseUrl}/api/campaigns/1/run?force=1`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
    // No mailbox / campaign lookup queries should fire under force=1
    const sql = calls.map(c => c.sql).join(' | ')
    expect(sql).not.toMatch(/FROM outreach_mailboxes/)
  })

  it('9: invalid id returns 400 not 412', async () => {
    const res = await fetch(`${baseUrl}/api/campaigns/abc/run`, { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('10: happy path — all 3 checks ok, Go proxy is called', async () => {
    readyCampaignSetup()
    // Sprint C1: Go proxy returns {ok:true}; BFF forwards it to caller.
    fetchQueue.push({ ok: true, status: 200, body: '{"ok":true}' })
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(200)
    // Sprint C1: BFF proxies to Go; Go owns the state change (no BFF UPDATE SQL).
    expect(fetchCalls.some(f => f.url.includes('/campaigns/1/run'))).toBe(true)
  })

  it('11: missing prospect tables → segments blocker fires gracefully (no 500)', async () => {
    const tableErr = new Error('relation "outreach_contacts" does not exist')
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ step: 0, template: 'initial' }] }] },
      tableErr,
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'S1_zero_eligible')).toBe(true)
  })

  it('12: pre-flight error (real DB error) → 500, not 412', async () => {
    pushAll(new Error('connection refused'))
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(500)
  })

  it('13: M2 — mailbox has valid pwd but is paused → 412', async () => {
    pushAll(
      { rows: [
        { id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'paused' },
        { id: 2, email: 'b@x.cz', password: 'AnotherP@ss88', status: 'failed' },
      ]},
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'initial' }] }] },
      { rows: [{ n: 100 }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'M2_no_active_mailbox')).toBe(true)
  })

  it('14: M2 ok when at least one mailbox is active', async () => {
    // Sprint AH: use 'intro_machinery' (only .tmpl on disk in test env).
    pushAll(
      { rows: [
        { id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'paused' },
        { id: 2, email: 'b@x.cz', password: 'AnotherP@ss88', status: 'active' },
      ]},
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'intro_machinery' }] }] },
      { rows: [{ n: 100 }] },
      // /run handler: BEGIN (transparent) → SELECT campBefore → Go proxy
      { rows: [{ id: 1, status: 'paused' }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('15: T2 — campaign references nonexistent .tmpl file → 412', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'active' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'made-up-template-that-does-not-exist' }] }] },
      { rows: [{ n: 100 }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string; missing_files?: string[] }> }
    const t2 = body.blockers.find(b => b.code === 'T2_missing_tmpl_file')
    expect(t2).toBeDefined()
    expect(t2?.missing_files).toContain('made-up-template-that-does-not-exist')
  })

  it('16: T2 ok when campaign template name matches existing .tmpl file', async () => {
    // Sprint AH: 'intro_machinery' is the template that actually exists on disk
    // in the test environment. 'heavy-01-intro' does not exist → T2 blocker.
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'active' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'intro_machinery' }] }] },
      { rows: [{ n: 100 }] },
      // /run handler: BEGIN (transparent) → SELECT campBefore → Go proxy
      { rows: [{ id: 1, status: 'paused' }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('17: empty category_paths is OK when campaign_contacts is pre-enqueued', async () => {
    // Mirrors prod campaign 455 ("Soft launch 001"): category_paths=[]
    // but 20 rows already in campaign_contacts. Operator should be able
    // to launch without re-editing the wizard step 3.
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'active' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: [], sequence_config: [{ template: 'intro_machinery' }] }] },
      { rows: [{ n: 20 }] },  // pre-enqueued contacts
      // /run handler: BEGIN (transparent) → SELECT campBefore → Go proxy
      { rows: [{ id: 1, status: 'paused' }] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('18: empty category_paths AND zero pre-enqueued → S1_no_sectors', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'active' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: [], sequence_config: [{ template: 'intro_machinery' }] }] },
      { rows: [{ n: 0 }] },  // zero pre-enqueued
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'S1_no_sectors')).toBe(true)
  })

  // CAD-M4 / issue #559 — egress gate. Egress endpoint is accessed via
  // self-fetch to /api/anti-trace/egress; without /v1/egress-debug
  // upstream relay the BFF returns ok:false and runPreflight degrades
  // silently (no blocker). Tests below directly exercise the BFF's
  // /api/anti-trace/egress shape via vi.mock fetch override IS too
  // invasive — instead we trust degraded mode (no blocker) and rely on
  // production smoke for live drift detection. The audit ratchet
  // (M3 + M2) catches code-level bypasses.
  //
  // 19 — self-fetch failure mode: egress endpoint unreachable, preflight
  // does NOT add EG1/EG2 blockers (degrades silently per memory
  // feedback_no_speculation: don't block on uncertain external state).
  it('19: egress endpoint unreachable → no EG1/EG2 blocker (degrade gracefully)', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'active' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'intro_machinery' }] }] },
      { rows: [{ n: 100 }] },
      { rowCount: 1, rows: [] },
    )
    const res = await fetch(`${baseUrl}/api/campaigns/1/run`, { method: 'POST' })
    // The egress fetch will go to BFF self / fail because relay env
    // unset in test. Either way: no EG1/EG2 blocker because relay was
    // unreachable. Status not 412 with EG codes.
    if (res.status === 412) {
      const body = await res.json() as { blockers: Array<{ code: string }> }
      expect(body.blockers.some(b => b.code === 'EG1_mode_forbidden')).toBe(false)
      expect(body.blockers.some(b => b.code === 'EG2_country_drift')).toBe(false)
    }
  })
})
