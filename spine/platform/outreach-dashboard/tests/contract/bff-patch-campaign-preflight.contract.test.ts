// Pre-flight gate also fires on PATCH /api/campaigns/:id when status
// transitions to 'running' or 'active'. Without this, the Campaigns.jsx
// toggle (which PATCHes status) bypasses the safety gate guarding /run.
//
// Status flips that don't activate (e.g. → 'paused', → 'completed') still
// pass through unchecked; the gate only triggers on launch transitions.

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

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  vi.resetModules()
  const mod = await import('../../server.js')
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
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

function pushAll(...outcomes: QueryOutcome[]) { queryQueue.push(...outcomes) }
async function patch(id: number, body: object, query = '') {
  return fetch(`${baseUrl}/api/campaigns/${id}${query}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/campaigns/:id — pre-flight gate on launch transitions', () => {
  it('1: status="running" hits the gate and 412s when no valid mailbox', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'xxxxxxxx' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'initial' }] }] },
      { rows: [{ n: 100 }] },
    )
    const res = await patch(1, { status: 'running' })
    expect(res.status).toBe(412)
  })

  it('2: status="active" also hits the gate', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'xxxxxxxx' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'initial' }] }] },
      { rows: [{ n: 100 }] },
    )
    const res = await patch(1, { status: 'active' })
    expect(res.status).toBe(412)
  })

  it('3: status="paused" does NOT trigger the gate', async () => {
    pushAll(
      { rows: [{ id: 1, name: 'C1', status: 'paused', stats: {}, created_at: '2026-05-01' }] },
    )
    const res = await patch(1, { status: 'paused' })
    expect(res.status).toBe(200)
    // No mailbox lookup should fire
    const sql = calls.map(c => c.sql).join(' | ')
    expect(sql).not.toMatch(/FROM outreach_mailboxes/)
  })

  it('4: status="completed" does NOT trigger the gate', async () => {
    pushAll(
      { rows: [{ id: 1, name: 'C1', status: 'completed', stats: {}, created_at: '2026-05-01' }] },
    )
    const res = await patch(1, { status: 'completed' })
    expect(res.status).toBe(200)
  })

  it('5: ?force=1 bypasses gate even on running', async () => {
    pushAll(
      { rows: [{ id: 1, name: 'C1', status: 'running', stats: {}, created_at: '2026-05-01' }] },
    )
    const res = await patch(1, { status: 'running' }, '?force=1')
    expect(res.status).toBe(200)
  })

  it('6: ok preflight → status update succeeds', async () => {
    // runPreflight uses pool.query() (3 entries): mailboxes, campaign, contacts.
    // PATCH handler (NEW mock — BEGIN/COMMIT transparent): SELECT campBefore, UPDATE RETURNING.
    // Sprint AH: 'intro_machinery' is the only .tmpl file present on disk in the
    // test environment (modules/outreach/configs/templates/). Using 'initial' triggers
    // T2_missing_tmpl_file → 412. Use 'intro_machinery' so the preflight T2 check passes.
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99', status: 'active' }] },  // mailboxes
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'intro_machinery' }] }] },  // campaign
      { rows: [{ n: 100 }] },  // eligible contacts
      // PATCH handler: BEGIN transparent → SELECT current state (campBefore) → UPDATE RETURNING
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], category_match: 'prefix' }] },  // SELECT campBefore
      { rows: [{ id: 1, name: 'C1', status: 'running', stats: {}, created_at: '2026-05-01' }] },  // UPDATE RETURNING
    )
    const res = await patch(1, { status: 'running' })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('running')
  })

  it('7: 412 response carries blockers + Czech detail + action_url', async () => {
    pushAll(
      { rows: [] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'initial' }] }] },
      { rows: [{ n: 100 }] },
    )
    const res = await patch(1, { status: 'running' })
    const body = await res.json() as { blockers: Array<{ code: string; detail: string; action_url: string }> }
    expect(body.blockers.length).toBeGreaterThan(0)
    expect(body.blockers[0].detail.length).toBeGreaterThan(0)
    expect(body.blockers[0].action_url).toMatch(/^\//)
  })

  it('8: missing status field still PATCHes (treated as no-op)', async () => {
    pushAll(
      { rows: [{ id: 1, name: 'C1', status: 'paused', stats: {}, created_at: '2026-05-01' }] },
    )
    const res = await patch(1, {})
    expect(res.status).toBe(200)
  })

  it('9: unknown status string does NOT trigger gate', async () => {
    pushAll(
      { rows: [{ id: 1, name: 'C1', status: 'archived', stats: {}, created_at: '2026-05-01' }] },
    )
    const res = await patch(1, { status: 'archived' })
    expect(res.status).toBe(200)
  })

  it('10: zero-eligible blocks running flip', async () => {
    pushAll(
      { rows: [{ id: 1, email: 'a@x.cz', password: 'StrongP@ss99' }] },
      { rows: [{ id: 1, name: 'C1', status: 'paused', category_paths: ['machinery'], sequence_config: [{ template: 'initial' }] }] },
      { rows: [{ n: 0 }] },
    )
    const res = await patch(1, { status: 'running' })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string }> }
    expect(body.blockers.some(b => b.code === 'S1_zero_eligible')).toBe(true)
  })
})
