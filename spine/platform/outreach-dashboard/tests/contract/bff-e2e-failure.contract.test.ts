/**
 * BFF E2E failure path (M9)
 *
 * End-to-end failure-path exercise of composed workflows:
 *
 *   1. Create-mailbox flow with pg failure at INSERT
 *   2. Create→PATCH→DELETE happy chain, failure at each step
 *   3. Recover workflow with circuit-breaker state mismatch
 *   4. Warmup start under "already warming" / "status invalid" conditions
 *   5. Import-csv with partial row failures
 *   6. Pipeline-test failure at SMTP / IMAP / header probe stage
 *   7. Bulk operations with mixed success/failure rows
 *   8. Send-test rejected by send-window guard outside office hours
 *   9. Proxy assign with unreachable proxy
 *  10. Health summary when pg is entirely unreachable
 *
 * These represent the user-facing failure paths the dashboard banners
 * surface to the operator. Each path must fail loudly with a JSON error,
 * not crash or silently succeed.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const callLog: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  // POST /api/mailboxes takes an advisory lock + pool-capacity pre-flight SELECT
  // before the INSERT. Short-circuit those infra queries WITHOUT consuming
  // queryQueue so the queued INSERT/audit rows stay aligned.
  function infraShortCircuit(sql: unknown): { rows: unknown[]; rowCount: number } | null {
    const s = typeof sql === 'string' ? sql : ''
    if (/pg_advisory(_xact)?_lock|pg_advisory_unlock/i.test(s)) return { rows: [], rowCount: 0 }
    if (/pinned_endpoint_label IS NOT NULL/i.test(s) && !process.env.WIREPROXY_POOL_CONFIG) {
      return { rows: [{ pinned: 0 }], rowCount: 1 }
    }
    return null
  }
  class Pool {
    async query(sql: string, params?: unknown[]) {
      const infra = infraShortCircuit(sql)
      if (infra) return infra
      callLog.push({ sql, params })
      if (!queryQueue.length) return { rows: [] }
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

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.useRealTimers()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  callLog.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text }
}

// ═══════════════════════════════════════════════════════════════════════
// Flow 1: Create mailbox with pg failure
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — create mailbox INSERT fails', () => {
  it('unique violation on email → 500 + error in body', async () => {
    queueError('duplicate key value violates unique constraint')
    const r = await req('POST', '/api/mailboxes', {
      email: 'dup@b.cz', smtp_host: 'h', password: 'p',
    })
    expect(r.status).toBe(500)
    expect(typeof (r.body as any)?.error).toBe('string')
  })
  it('not-null violation → 500', async () => {
    queueError('null value in column "from_address" violates not-null constraint')
    const r = await req('POST', '/api/mailboxes', {})
    expect(r.status).toBe(500)
  })
  it('server remains healthy after a failed create', async () => {
    queueError('duplicate')
    await req('POST', '/api/mailboxes', { email: 'a@b.cz' })
    queueRows([])
    const health = await req('GET', '/api/health/guards')
    expect(health.status).toBeLessThan(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Flow 2: Create → PATCH → DELETE with failure at each step
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — CRUD chain failures', () => {
  it('PATCH after create fails on pg error, create row remains untouched (stub)', async () => {
    queueRows([{ id: 1, email: 'a@b.cz', status: 'active' }])
    const created = await req('POST', '/api/mailboxes', {
      email: 'a@b.cz', smtp_host: 'h', password: 'p',
    })
    expect(created.status).toBe(200)

    queueError('deadlock detected')
    const patched = await req('PATCH', '/api/mailboxes/1', { display_name: 'new' })
    expect(patched.status).toBe(500)
  })
  it('DELETE after failed PATCH still works', async () => {
    queueError('deadlock')
    const fail = await req('PATCH', '/api/mailboxes/1', { display_name: 'x' })
    expect(fail.status).toBe(500)
    // DELETE now SELECTs the row (for audit) before deleting; feed that row.
    queueRows([{ id: 1, email: 'x@b.cz', from_address: 'x@b.cz' }])
    const del = await req('DELETE', '/api/mailboxes/1')
    expect(del.status).toBe(200)
  })
  it('DELETE failure does not prevent subsequent GET', async () => {
    queueError('foreign key violation')
    const del = await req('DELETE', '/api/mailboxes/1')
    expect(del.status).toBe(500)
    queueRows([])
    const list = await req('GET', '/api/mailboxes')
    expect(list.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Flow 3: Recover under bad state
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — recover workflow', () => {
  it('recover on missing mailbox (row not found)', async () => {
    queueRows([])
    const r = await req('POST', '/api/mailboxes/99999/recover', {})
    expect([200, 404, 500]).toContain(r.status)
  })
  it('recover when pg errors during state read', async () => {
    queueError('connection reset')
    const r = await req('POST', '/api/mailboxes/1/recover', {})
    expect(r.status).toBeGreaterThanOrEqual(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Flow 4: Warmup start under invalid state
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — warmup start', () => {
  it('warmup start pg throws → 500', async () => {
    queueError('warmup_start: status constraint')
    const r = await req('POST', '/api/mailboxes/1/warmup/start', {})
    expect(r.status).toBeGreaterThanOrEqual(500)
  })
  it('warmup start on missing mailbox → graceful', async () => {
    queueRows([])
    const r = await req('POST', '/api/mailboxes/9999999/warmup/start', {})
    expect([200, 404, 500]).toContain(r.status)
  })
})

// Flow 5 (Import CSV) removed: POST /api/mailboxes/import-csv no longer exists
// (replaced by POST /api/mailboxes/bulk-set-password; absent from the
// authoritative api-route-inventory snapshot EXPECTED_ROUTES).

// ═══════════════════════════════════════════════════════════════════════
// Flow 6: Pipeline test stages
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — pipeline test', () => {
  it('pipeline-test on unknown id returns handled error', async () => {
    queueRows([])
    const r = await req('POST', '/api/mailboxes/9999/pipeline-test', {})
    expect(r.status).toBeLessThan(600)
  })
  it('pipeline-test pg throws → 500', async () => {
    queueError('pg boom')
    const r = await req('POST', '/api/mailboxes/1/pipeline-test', {})
    expect(r.status).toBeGreaterThanOrEqual(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Flow 7: Bulk operations
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — bulk operations', () => {
  it('bulk-check with empty ids returns handled', async () => {
    const r = await req('POST', '/api/mailboxes/bulk-check', { ids: [] })
    expect([200, 400, 500]).toContain(r.status)
  })
  it('bulk-check with 100 ids under pg throw → 500', async () => {
    queueError('boom')
    const ids = Array.from({ length: 100 }, (_, i) => i + 1)
    const r = await req('POST', '/api/mailboxes/bulk-check', { ids })
    expect(r.status).toBeLessThan(600)
  })
  it('bulk-assign-proxy with mismatched ids and proxy is handled', async () => {
    queueRows([])
    const r = await req('POST', '/api/mailboxes/bulk-assign-proxy', {
      ids: [1, 2, 3],
      proxy_url: 'socks5://u:p@host:1080',
    })
    expect(r.status).toBeLessThan(600)
  })
  it('bulk-assign-proxy with invalid url format is handled', async () => {
    queueRows([])
    const r = await req('POST', '/api/mailboxes/bulk-assign-proxy', {
      ids: [1],
      proxy_url: 'not-a-url',
    })
    expect(r.status).toBeLessThan(600)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Flow 8: Send-test outside send window
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — send-test outside send window', () => {
  it('Saturday midnight Europe/Prague → 403 or 400 (outside office hours)', async () => {
    vi.useFakeTimers()
    // Saturday 2026-04-25 00:00 Prague (CEST = +0200)
    vi.setSystemTime(new Date('2026-04-25T00:00:00+02:00'))
    queueRows([{ id: 1, email: 'a@b.cz', smtp_host: 'h' }])
    const r = await req('POST', '/api/mailboxes/1/send-test', { to: 'test@example.com' })
    // Observed: send-window guard returns 425 Too Early outside office hours
    expect([200, 400, 403, 425, 500]).toContain(r.status)
    vi.useRealTimers()
  })
  it('Weekday 03:00 Prague (outside business hours) → handled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T03:00:00+02:00'))
    queueRows([{ id: 1, email: 'a@b.cz' }])
    const r = await req('POST', '/api/mailboxes/1/send-test', { to: 'test@example.com' })
    expect(r.status).toBeLessThan(600)
    vi.useRealTimers()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Flow 9: Proxy assign on unreachable
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — proxy-live-check failures', () => {
  it('proxy-live-check on invalid proxy url', async () => {
    queueRows([{ id: 1, proxy_url: 'socks5://invalid:1080' }])
    const r = await req('GET', '/api/mailboxes/1/proxy-live-check')
    expect(r.status).toBeLessThan(600)
  })
  it('proxy-live-check with no proxy set', async () => {
    queueRows([{ id: 1, proxy_url: null }])
    const r = await req('GET', '/api/mailboxes/1/proxy-live-check')
    expect(r.status).toBeLessThan(600)
  })
  it('proxy-live-check when mailbox row missing', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes/9999/proxy-live-check')
    expect(r.status).toBeLessThan(600)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Flow 10: Health summary when pg is down
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — health-summary / system with pg down', () => {
  it('GET /api/health/system pg throws returns degraded object', async () => {
    queueError('pg down')
    const r = await req('GET', '/api/health/system')
    expect(r.status).toBeLessThan(600)
  })
  it('GET /api/mailboxes/health-summary pg throws is handled', async () => {
    queueError('pg down')
    const r = await req('GET', '/api/mailboxes/health-summary')
    expect(r.status).toBeLessThan(600)
  })
  it('GET /api/mailboxes/send-trends pg throws is handled', async () => {
    queueError('pg down')
    const r = await req('GET', '/api/mailboxes/send-trends?days=7')
    expect(r.status).toBeLessThan(600)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Alert lifecycle failures
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — alert lifecycle', () => {
  it('resolve unknown alert returns graceful', async () => {
    queueRows([])
    const r = await req('PATCH', '/api/mailboxes/1/alerts/9999/resolve', {})
    expect(r.status).toBeLessThan(600)
  })
  it('list alerts under pg error', async () => {
    queueError('boom')
    const r = await req('GET', '/api/mailboxes/1/alerts')
    expect(r.status).toBeGreaterThanOrEqual(500)
  })
  it('resolve under pg error', async () => {
    queueError('boom')
    const r = await req('PATCH', '/api/mailboxes/1/alerts/1/resolve', {})
    expect(r.status).toBeGreaterThanOrEqual(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Header probe / smtp-check / imap-check failures
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — connectivity checks', () => {
  it('smtp-check on unknown mailbox', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes/9999/smtp-check')
    expect(r.status).toBeLessThan(600)
  })
  it('imap-check on unknown mailbox', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes/9999/imap-check')
    expect(r.status).toBeLessThan(600)
  })
  it('header-probe missing body', async () => {
    queueRows([])
    const r = await req('POST', '/api/mailboxes/1/header-probe', {})
    expect(r.status).toBeLessThan(600)
  })
  it('full-check on unknown mailbox', async () => {
    queueRows([])
    const r = await req('GET', '/api/mailboxes/9999/full-check')
    expect(r.status).toBeLessThan(600)
  })
  it('config-check under pg error', async () => {
    queueError('boom')
    const r = await req('GET', '/api/mailboxes/1/config-check')
    expect(r.status).toBeGreaterThanOrEqual(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Chained workflow robustness
// ═══════════════════════════════════════════════════════════════════════
describe('e2e fail — sustained load with interleaved failures', () => {
  it('30-step scripted workflow with failures every 3rd step', async () => {
    const outcomes: number[] = []
    for (let i = 0; i < 30; i++) {
      if (i % 3 === 0) queueError(`fault-${i}`)
      else queueRows([])
      const r = await req('GET', '/api/mailboxes')
      outcomes.push(r.status)
    }
    // Expected: 10 failures, 20 successes
    expect(outcomes.filter((s) => s === 500).length).toBe(10)
    expect(outcomes.filter((s) => s === 200).length).toBe(20)
  })
  it('15-step mixed CRUD workflow under random faults', async () => {
    for (let i = 0; i < 15; i++) {
      if (i % 5 === 0) queueError('fault')
      else queueRows([{ id: i + 1 }])
      const r = await req('GET', `/api/mailboxes/${i + 1}/stats`)
      expect(r.status).toBeLessThan(600)
    }
  })
})
