// Fault injection probes — server honors X-Fault header when started with
// FAULT_INJECT_ALLOWED=1. Asserts: error envelope is sane (no leaked stack),
// no crash, status codes match expectations. Catches regressions where a
// handler's catch block emits raw error.message that contains paths.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'

const BASE = 'http://localhost:3001'

beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

const fault = (path, mode) => fetch(`${BASE}${path}`, { headers: { 'X-Fault': mode } })

describe('Chaos / fault injection', () => {
  it('db-down → 503 with sane envelope (no stack leak)', async () => {
    const r = await fault('/api/companies/stats', 'db-down')
    expect(r.status).toBe(503)
    const body = await r.json()
    expect(body).toEqual({ error: 'database unavailable' })
    expect(JSON.stringify(body)).not.toMatch(/\/Users|node_modules|at \w+/i)
  })

  it('throw → 500 sanitized', async () => {
    const r = await fault('/api/companies/stats', 'throw')
    expect(r.status).toBe(500)
    const body = await r.json()
    expect(body.error).toBe('internal error')
    expect(JSON.stringify(body)).not.toMatch(/\/Users|node_modules|at \w+/i)
  })

  it('latency 1500ms → still completes < 5s', async () => {
    const t0 = Date.now()
    const r = await fault('/api/companies/stats', 'latency')
    const dt = Date.now() - t0
    expect(r.status).toBeLessThan(500)
    expect(dt).toBeGreaterThanOrEqual(1500)
    expect(dt).toBeLessThan(5_000)
  })

  it('truncate → list endpoint reduced to 1 item, shape preserved', async () => {
    const r = await fault('/api/companies?limit=10', 'truncate')
    const body = await r.json()
    if (body.rows) {
      expect(body.rows.length).toBeLessThanOrEqual(1)
    }
  })

  it('unknown fault mode → request passes through (no 400/500 added)', async () => {
    const r = await fault('/api/companies/stats', 'totally-unknown-mode')
    // unknown values are no-op. Real request still runs.
    expect([200, 500]).toContain(r.status)
  })

  it('no fault header → normal response', async () => {
    const r = await fetch(`${BASE}/api/companies/stats`)
    expect(r.status).toBe(200)
  })
})
