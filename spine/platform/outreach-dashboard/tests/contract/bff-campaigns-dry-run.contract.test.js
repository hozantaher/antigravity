// bff-campaigns-dry-run.contract.test.js — Sprint K2
//
// Contract tests for POST /api/campaigns/:id/dry-run (campaignDryRun.js).
//
// 4 cases:
//   1. Basic happy path — returns waterfall counts, no emails in body.
//   2. 404 — unknown campaign id returns {error: 'campaign not found'}.
//   3. Suppression hits all — after_suppression = 0, eligible = 0.
//   4. Dedup hits all — after_dedup = 0, eligible = 0 (all contacts DnT).
//
// PII guard: response body must not contain any @-domain strings.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock pg before importing server ──────────────────────────────────────────

const queryQueue = []
const calls = []

vi.mock('pg', () => {
  class Pool {
    async query(sql, params) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()
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
let server

beforeAll(async () => {
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  const { app } = mod
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()))
  delete process.env.BFF_IMPORT_ONLY
  delete process.env.BFF_AUTH_DISABLED
  delete process.env.DATABASE_URL
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

/** Push a successful query result */
function q(rows, rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

/** Push an error result */
function qErr(msg) {
  queryQueue.push(Object.assign(new Error(msg), { code: '42P01' }))
}

async function post(path) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST' })
  const body = await res.json()
  return { status: res.status, body }
}

// ── Test 1: Basic happy path ──────────────────────────────────────────────────

describe('POST /api/campaigns/:id/dry-run — basic happy path', () => {
  it('returns 4-step waterfall with counts', async () => {
    // campaign lookup
    q([{ id: 457, segment_definition: { category_paths: ['excavators'] } }])
    // Step 1 — total_match
    q([{ n: 500 }])
    // Step 2 — after_suppression
    q([{ n: 480 }])
    // Step 3 — after_dedup
    q([{ n: 420 }])
    // Step 4 — eligible
    q([{ n: 400 }])

    const { status, body } = await post('/api/campaigns/457/dry-run')

    expect(status).toBe(200)
    expect(body.total_match).toBe(500)
    expect(body.after_suppression).toBe(480)
    expect(body.after_dedup).toBe(420)
    expect(body.eligible).toBe(400)
    expect(Array.isArray(body.steps)).toBe(true)
    expect(body.steps).toHaveLength(4)
  })

  it('steps carry label, count, removed', async () => {
    q([{ id: 457, segment_definition: {} }])
    q([{ n: 100 }])
    q([{ n: 90 }])
    q([{ n: 80 }])
    q([{ n: 70 }])

    const { body } = await post('/api/campaigns/457/dry-run')

    expect(body.steps[0]).toMatchObject({ label: expect.any(String), count: 100, removed: 0 })
    expect(body.steps[1]).toMatchObject({ label: expect.any(String), count: 90,  removed: 10 })
    expect(body.steps[2]).toMatchObject({ label: expect.any(String), count: 80,  removed: 10 })
    expect(body.steps[3]).toMatchObject({ label: expect.any(String), count: 70,  removed: 10 })
  })

  it('PII guard — body contains no email addresses', async () => {
    q([{ id: 457, segment_definition: {} }])
    q([{ n: 50 }])
    q([{ n: 40 }])
    q([{ n: 30 }])
    q([{ n: 20 }])

    const { body } = await post('/api/campaigns/457/dry-run')

    const serialised = JSON.stringify(body)
    // No @-domain patterns should appear in the response
    expect(serialised).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
  })
})

// ── Test 2: 404 — campaign not found ─────────────────────────────────────────

describe('POST /api/campaigns/:id/dry-run — 404 missing campaign', () => {
  it('returns 404 with error field', async () => {
    q([]) // empty rows = not found

    const { status, body } = await post('/api/campaigns/99999/dry-run')

    expect(status).toBe(404)
    expect(body).toMatchObject({ error: 'campaign not found' })
  })

  it('does not fire Step 1-4 queries when campaign missing', async () => {
    q([]) // only 1 query should fire

    await post('/api/campaigns/99999/dry-run')

    // Only 1 query should have been called (the campaign lookup)
    expect(calls).toHaveLength(1)
  })
})

// ── Test 3: Suppression hits all ─────────────────────────────────────────────

describe('POST /api/campaigns/:id/dry-run — suppression hits all', () => {
  it('after_suppression=0 propagates to eligible=0', async () => {
    q([{ id: 457, segment_definition: {} }])
    q([{ n: 200 }]) // total_match
    q([{ n: 0 }])   // after_suppression — all suppressed
    q([{ n: 0 }])   // after_dedup
    q([{ n: 0 }])   // eligible

    const { status, body } = await post('/api/campaigns/457/dry-run')

    expect(status).toBe(200)
    expect(body.total_match).toBe(200)
    expect(body.after_suppression).toBe(0)
    expect(body.after_dedup).toBe(0)
    expect(body.eligible).toBe(0)
    expect(body.steps[1].removed).toBe(200)
  })
})

// ── Test 4: Dedup hits all ────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/dry-run — dedup hits all', () => {
  it('after_dedup=0 leaves eligible=0', async () => {
    q([{ id: 457, segment_definition: {} }])
    q([{ n: 150 }]) // total_match
    q([{ n: 150 }]) // after_suppression — suppression passes all
    q([{ n: 0 }])   // after_dedup — dedup blocks all (e.g., all dnt=true)
    q([{ n: 0 }])   // eligible

    const { status, body } = await post('/api/campaigns/457/dry-run')

    expect(status).toBe(200)
    expect(body.after_suppression).toBe(150)
    expect(body.after_dedup).toBe(0)
    expect(body.eligible).toBe(0)
    expect(body.steps[2].removed).toBe(150)
  })
})

// ── Test 5: Invalid campaign id ───────────────────────────────────────────────

describe('POST /api/campaigns/:id/dry-run — validation', () => {
  it('returns 400 for non-numeric campaign id', async () => {
    const { status, body } = await post('/api/campaigns/not-a-number/dry-run')

    expect(status).toBe(400)
    expect(body).toMatchObject({ error: expect.any(String) })
  })
})
