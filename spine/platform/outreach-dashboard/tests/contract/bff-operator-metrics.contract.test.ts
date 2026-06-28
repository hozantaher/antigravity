// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/operator/metrics (OP5.3)
//
//  Tests the fallback path (Go unreachable) which uses direct-DB queries.
//  The Go-proxy path is covered by the mock fetch in each test case.
//
//  Shape lock: generated_at, campaigns[], mailboxes[],
//  classifier_overrides_today, training_set_size, accuracy_rolling_7d.
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

// Save env so afterAll can restore — prevents cross-test-file env leak
// (docs/audits/2026-04-30-blind-spot-audit.md § A).
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  // Delete AFTER import so loadEnv can't repopulate it (per setup.ts comment).
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
  // Restore original env.
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string)   { queryQueue.push(new Error(msg)) }

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json as Record<string, unknown> }
}

// ─────────────────────────────────────────────────────────────────────────────
// T1. Returns 200 with expected top-level schema.
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/operator/metrics — shape lock', () => {
  it('returns 200 with all required top-level fields', async () => {
    // campaigns query
    queueRows([])
    // mailboxes query
    queueRows([])
    // overrides_today query
    queueRows([{ n: 0 }])

    const res = await get('/api/operator/metrics')
    expect(res.status).toBe(200)

    const body = res.body
    expect(body).toHaveProperty('generated_at')
    expect(body).toHaveProperty('campaigns')
    expect(body).toHaveProperty('mailboxes')
    expect(body).toHaveProperty('classifier_overrides_today')
    expect(body).toHaveProperty('training_set_size')
    expect(body).toHaveProperty('accuracy_rolling_7d')
    expect(body).toHaveProperty('_source', 'bff-fallback')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2. campaigns[] is an array (may be empty).
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/operator/metrics — campaigns shape', () => {
  it('campaigns is an array', async () => {
    queueRows([])
    queueRows([])
    queueRows([{ n: 0 }])

    const res = await get('/api/operator/metrics')
    expect(Array.isArray(res.body.campaigns)).toBe(true)
  })

  it('running campaign row has required fields', async () => {
    queueRows([{
      id: 42, name: 'machinery-q2', status: 'running',
      sent_24h: 48, bounced_24h: 2,
    }])
    // mailboxes
    queueRows([])
    // overrides_today
    queueRows([{ n: 3 }])

    const res = await get('/api/operator/metrics')
    const campaigns = res.body.campaigns as unknown[]
    expect(campaigns).toHaveLength(1)
    const c = campaigns[0] as Record<string, unknown>
    expect(c).toHaveProperty('id', 42)
    expect(c).toHaveProperty('name', 'machinery-q2')
    expect(c).toHaveProperty('status', 'running')
    expect(c).toHaveProperty('sent_24h', 48)
    expect(typeof c.bounce_rate_24h).toBe('number')
    expect(c).toHaveProperty('reply_rate_24h')
    expect(c).toHaveProperty('current_step_distribution')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3. mailboxes[] shape and circuit_state logic.
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/operator/metrics — mailboxes shape', () => {
  it('mailboxes is an array', async () => {
    queueRows([])
    queueRows([])
    queueRows([{ n: 0 }])

    const res = await get('/api/operator/metrics')
    expect(Array.isArray(res.body.mailboxes)).toBe(true)
  })

  it('bounce_hold mailbox has circuit_state=open', async () => {
    queueRows([]) // campaigns
    queueRows([
      { address: 'a@list.cz', last_score: 100, send_count_today: 10, status: 'active' },
      { address: 'b@list.cz', last_score: 0,   send_count_today: 0,  status: 'bounce_hold' },
    ])
    queueRows([{ n: 0 }]) // overrides

    const res = await get('/api/operator/metrics')
    const mailboxes = res.body.mailboxes as Array<Record<string, unknown>>
    const bhMailbox = mailboxes.find(m => m.status === 'bounce_hold')
    expect(bhMailbox?.circuit_state).toBe('open')
    const activeMailbox = mailboxes.find(m => m.status === 'active')
    expect(activeMailbox?.circuit_state).toBe('closed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4. bounce_rate_24h: 0 sends → 0 (no division-by-zero).
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/operator/metrics — zero-send safety', () => {
  it('bounce_rate_24h is 0 when sent_24h is 0', async () => {
    queueRows([{
      id: 1, name: 'empty', status: 'running',
      sent_24h: 0, bounced_24h: 0,
    }])
    queueRows([])
    queueRows([{ n: 0 }])

    const res = await get('/api/operator/metrics')
    const campaigns = res.body.campaigns as Array<Record<string, unknown>>
    expect(campaigns[0].bounce_rate_24h).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5. classifier_overrides_today reflects audit log count.
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/operator/metrics — operator stats', () => {
  it('classifier_overrides_today matches audit log count', async () => {
    queueRows([]) // campaigns
    queueRows([]) // mailboxes
    queueRows([{ n: 7 }]) // overrides

    const res = await get('/api/operator/metrics')
    expect(res.body.classifier_overrides_today).toBe(7)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T6. Schema gap (missing table) returns degraded 200 not 500.
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/operator/metrics — schema gap', () => {
  it('returns 200 with empty arrays when tables are missing', async () => {
    queueError('relation "outreach_campaigns" does not exist')
    queueError('relation "outreach_mailboxes" does not exist')
    // overrides: also missing
    queueError('relation "operator_audit_log" does not exist')

    const res = await get('/api/operator/metrics')
    // Schema gaps are tolerated; BFF returns degraded 200 not 500.
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.campaigns)).toBe(true)
    expect(Array.isArray(res.body.mailboxes)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T7. generated_at is an ISO 8601 timestamp.
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/operator/metrics — generated_at', () => {
  it('generated_at is an ISO 8601 string', async () => {
    queueRows([])
    queueRows([])
    queueRows([{ n: 0 }])

    const res = await get('/api/operator/metrics')
    const ts = res.body.generated_at as string
    expect(typeof ts).toBe('string')
    expect(() => new Date(ts).toISOString()).not.toThrow()
  })
})
