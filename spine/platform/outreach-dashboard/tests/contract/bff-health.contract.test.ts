// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/health/{watchdog,proxy-exhaust,system,guards,drift}
//
// Operator dashboard health surface. These drive banners + /watchdog page
// + Dashboard widget. Locks graceful behavior when tables are missing
// (fresh env) vs real errors.
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

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/health/watchdog
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/health/watchdog', () => {
  it('200 with healthy=true when recent events present', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString() // 1min ago
    queueRows([{ created_at: recent }])
    queueRows([{ event_type: 'auto_pause', n: 2 }])
    const res = await get('/api/health/watchdog')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ stale: false, healthy: true })
    expect((res.body as any).counts_24h).toEqual({ auto_pause: 2 })
  })

  it('200 with stale=true + healthy=false when last event > 15min ago', async () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    queueRows([{ created_at: old }])
    queueRows([])
    const res = await get('/api/health/watchdog')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ stale: true, healthy: false })
  })

  it('200 with stale=true when no events (fresh env)', async () => {
    queueRows([])
    queueRows([])
    const res = await get('/api/health/watchdog')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ stale: true, healthy: false, last_event_at: null })
  })

  it('200 graceful fallback when watchdog_events table missing', async () => {
    queueError('relation "watchdog_events" does not exist')
    const res = await get('/api/health/watchdog')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ last_event_at: null, stale: true, counts_24h: {}, healthy: false })
  })

  it('500 on generic pg error', async () => {
    queueError('connection refused')
    const res = await get('/api/health/watchdog')
    expect(res.status).toBe(500)
  })

  it('counts_24h window uses interval 24h', async () => {
    queueRows([])
    queueRows([])
    await get('/api/health/watchdog')
    expect(calls[1].sql).toMatch(/24 hours/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/health/auth-fail-alerts
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/health/auth-fail-alerts', () => {
  it('200 with {alerts, count} when events exist', async () => {
    queueRows([
      { mailbox_id: 3, from_address: 'a@x.cz', created_at: '2026-04-23', fail_count: 4 },
      { mailbox_id: 7, from_address: 'b@y.cz', created_at: '2026-04-23', fail_count: 3 },
    ])
    const res = await get('/api/health/auth-fail-alerts')
    expect(res.status).toBe(200)
    expect((res.body as any).count).toBe(2)
    expect((res.body as any).alerts).toHaveLength(2)
  })

  it('200 with empty when no alerts', async () => {
    queueRows([])
    const res = await get('/api/health/auth-fail-alerts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ alerts: [], count: 0 })
  })

  it('filters auto_healed=false (SEND-S2 reset semantics)', async () => {
    queueRows([])
    await get('/api/health/auth-fail-alerts')
    const sql = calls[0].sql
    expect(sql).toMatch(/auto_healed, false/i)
    expect(sql).toMatch(/=\s*false/i)
  })

  it('inner-joins outreach_mailboxes to drop orphan events', async () => {
    queueRows([])
    await get('/api/health/auth-fail-alerts')
    expect(calls[0].sql).toMatch(/JOIN outreach_mailboxes/i)
  })

  it('LIMIT 500 cap', async () => {
    queueRows([])
    await get('/api/health/auth-fail-alerts')
    expect(calls[0].sql).toMatch(/LIMIT 500/)
  })

  it('graceful fallback when watchdog_events table missing', async () => {
    queueError('relation "watchdog_events" does not exist')
    const res = await get('/api/health/auth-fail-alerts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ alerts: [], count: 0 })
  })

  it('500 on non-missing-table pg error', async () => {
    queueError('timeout')
    const res = await get('/api/health/auth-fail-alerts')
    expect(res.status).toBe(500)
  })

  it('response never includes password field (sanitized projection)', async () => {
    queueRows([{ mailbox_id: 1, from_address: 'x@y.cz', created_at: '2026-04-23', fail_count: 3 }])
    const res = await get('/api/health/auth-fail-alerts')
    expect(JSON.stringify(res.body)).not.toContain('"password"')
  })

  it('sanitized alert shape: only {mailbox_id, from_address, created_at, fail_count}', async () => {
    queueRows([{ mailbox_id: 1, from_address: 'x@y.cz', created_at: '2026-04-23', fail_count: 3 }])
    const res = await get('/api/health/auth-fail-alerts')
    const alert = (res.body as any).alerts[0]
    expect(Object.keys(alert).sort()).toEqual(['created_at', 'fail_count', 'from_address', 'mailbox_id'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/health/proxy-exhaust
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/health/proxy-exhaust', () => {
  it('200 returns aggregated shape (not raw rows)', async () => {
    queueRows([])
    const res = await get('/api/health/proxy-exhaust')
    expect(res.status).toBe(200)
    // aggregateProxyExhaust yields {triggered, count, mailboxes_affected, severity, window_minutes}
    expect(res.body).toHaveProperty('triggered')
    expect(res.body).toHaveProperty('count')
  })

  it('uses 10-minute window', async () => {
    queueRows([])
    await get('/api/health/proxy-exhaust')
    expect(calls[0].sql).toMatch(/10 minutes/i)
  })

  it('filters check_name=proxy_reassign_exhausted', async () => {
    queueRows([])
    await get('/api/health/proxy-exhaust')
    expect(calls[0].sql).toMatch(/check_name = 'proxy_reassign_exhausted'/)
  })

  it('graceful fallback on missing watchdog_events table', async () => {
    queueError('relation "watchdog_events" does not exist')
    const res = await get('/api/health/proxy-exhaust')
    expect(res.status).toBe(200)
    // aggregated empty shape
    expect(res.body).toHaveProperty('triggered')
  })

  it('500 on generic pg error', async () => {
    queueError('timeout')
    const res = await get('/api/health/proxy-exhaust')
    expect(res.status).toBe(500)
  })
})
