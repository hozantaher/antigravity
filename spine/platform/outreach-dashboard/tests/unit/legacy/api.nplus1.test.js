// N+1 query detector — pins per-endpoint query budget. Server exposes
// X-Query-Count via X-Query-Probe: 1 header (AsyncLocalStorage in server.js).
// Failure = handler grew a per-row loop or accidentally added a join sub-fetch.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'

const BASE = 'http://localhost:3001'

beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

async function probe(path, init = {}) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { 'X-Query-Probe': '1', ...(init.headers || {}) },
  })
  const count = Number(r.headers.get('X-Query-Count') || -1)
  return { status: r.status, count }
}

// Budget = expected query count per request. Anything higher = N+1 or new join.
// Increase ONLY when handler genuinely needs more queries (and document why).
const BUDGET = {
  'GET /api/companies/stats':         1,  // single reltuples lookup
  'GET /api/companies?limit=5':       2,  // count + page
  'GET /api/companies?limit=5&search=z': 2,
  'GET /api/campaigns':               1,
  'GET /api/mailboxes':               1,
  'GET /api/templates':               1,
  'GET /api/segments':                1,
  'GET /api/replies?limit=5':         2,
  'GET /api/contacts?limit=5':        2,
}

describe('N+1 query budget per endpoint', () => {
  for (const [route, max] of Object.entries(BUDGET)) {
    it(`${route} ≤ ${max} queries`, async () => {
      const [, path] = route.split(' ', 2)
      const { status, count } = await probe(path)
      expect(status, `route returned ${status}`).toBeLessThan(500)
      expect(count, `query count ${count} exceeds budget ${max}`).toBeLessThanOrEqual(max)
      expect(count).toBeGreaterThan(0)
    })
  }

  it('list endpoint scales O(1) — limit=5 vs limit=50 same query count', async () => {
    const a = await probe('/api/campaigns?limit=5')
    const b = await probe('/api/campaigns?limit=50')
    expect(a.count).toBe(b.count)
  })

  it('list endpoint scales O(1) — companies limit=5 vs limit=20', async () => {
    const a = await probe('/api/companies?limit=5')
    const b = await probe('/api/companies?limit=20')
    expect(a.count).toBe(b.count)
  })
})
