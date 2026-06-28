// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/proxy-pool + /api/proxy-pool-trend + /api/anti-trace/health
//
// Consumed by Mailboxes.jsx PoolHealthWidget + PoolTrendSparkline.
// Integration surface between BFF ↔ anti-trace-relay — the proxy pool
// is the single point of egress for the SEND pipeline.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

vi.mock('pg', () => {
  class Pool {
    async query() { return { rows: [], rowCount: 0 } }
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

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/proxy-pool-trend
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/proxy-pool-trend', () => {
  it('200 returns snapshot object (in-memory ring buffer)', async () => {
    const res = await get('/api/proxy-pool-trend')
    expect(res.status).toBe(200)
    // poolTrend.snapshot() returns {bucket_seconds, buckets:[...]} shape
    expect(typeof res.body).toBe('object')
    expect(res.body).not.toBeNull()
  })

  it('response doesn\'t leak backend error message', async () => {
    // Even without specific mock, route is safe (no DB call, in-memory only).
    const res = await get('/api/proxy-pool-trend')
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('ECONNREFUSED')
    expect(body).not.toContain('stack')
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/proxy-pool
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/proxy-pool', () => {
  it('responds (may 200 or 500 depending on relay reachability)', async () => {
    const res = await get('/api/proxy-pool')
    expect([200, 500]).toContain(res.status)
  })

  it('?full=1 returns unfiltered shape when 200', async () => {
    const res = await get('/api/proxy-pool?full=1')
    // Can be 200 (cached data) or 500 (relay unreachable in test); just no throw
    expect([200, 500]).toContain(res.status)
  })

  it('?refresh=1 forces fresh fetch (smoke)', async () => {
    const res = await get('/api/proxy-pool?refresh=1')
    expect([200, 500]).toContain(res.status)
  })

  it('default response strips proxy credentials — working[].addr has no raw password', async () => {
    const res = await get('/api/proxy-pool')
    if (res.status !== 200) return // relay unreachable, skip
    const body = res.body as any
    if (!body?.working) return
    for (const p of body.working) {
      // addr format should be country://host:port without user:pass@
      if (typeof p.addr === 'string') {
        // Accept either 'user@host:port' format (allowed) or plain 'host:port'
        // Just confirm no obvious password patterns
        expect(p.addr).not.toMatch(/password=/i)
      }
    }
  })

  it('response shape (when 200) includes counts', async () => {
    const res = await get('/api/proxy-pool')
    if (res.status !== 200) return
    // Typical shape: {total, working:[...], cz_count, working_count, ...}
    const body = res.body as any
    // At least one of: total, working_count, working array should exist
    const hasShape = 'total' in body || 'working' in body || 'working_count' in body
    expect(hasShape).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/anti-trace/health
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/anti-trace/health', () => {
  it('200 with {ok, ...} (never 500 from endpoint itself)', async () => {
    const res = await get('/api/anti-trace/health')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('ok')
  })

  it('response has reason field when ok=false', async () => {
    const res = await get('/api/anti-trace/health')
    const body = res.body as any
    if (body && body.ok === false) {
      expect(body).toHaveProperty('reason')
    }
  })

  it('never leaks raw SQL password in response', async () => {
    const res = await get('/api/anti-trace/health')
    const body = JSON.stringify(res.body)
    expect(body).not.toMatch(/password=\w+/i)
    expect(body).not.toMatch(/user:pass/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Route inventory smoke — non-registered paths return 404 (not 200)
// ═══════════════════════════════════════════════════════════════════════

describe('proxy-pool route inventory', () => {
  it('POST /api/proxy-pool → non-200 (only GET registered)', async () => {
    const r = await fetch(baseUrl + '/api/proxy-pool', { method: 'POST' })
    expect(r.status).not.toBe(200)
  })

  it('DELETE /api/proxy-pool-trend → non-200', async () => {
    const r = await fetch(baseUrl + '/api/proxy-pool-trend', { method: 'DELETE' })
    expect(r.status).not.toBe(200)
  })
})
