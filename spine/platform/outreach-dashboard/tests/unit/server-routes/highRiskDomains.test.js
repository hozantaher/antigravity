// highRiskDomains.test.js — Sprint AE2 (2026-05-14)
//
// Unit-test coverage for the BFF route module that handles GET/PUT on the
// `presend_smtp_probe_high_risk_domains` operator_settings row.
//
// Pattern mirrors `tests/unit/server-routes/auditRecent.test.js`: spin up an
// Express app with a stubbed pg pool, exercise the route via fetch.
//
// Asserts:
//   - GET happy path (list + counter)
//   - GET when row absent → empty domains, counter=0
//   - GET when audit_log absent → counter falls back to 0 without 500
//   - PUT happy path (200, list returned, audit_log INSERT fires)
//   - PUT empty list (level-2 disabled globally) succeeds
//   - PUT invalid domain format → 400, no SQL writes
//   - PUT > MAX_DOMAINS → 400
//   - PUT non-array → 400
//   - PUT dedup case-insensitive (Foo.Cz + foo.cz → one row)
//   - PUT missing X-Confirm-Send header → 400
//   - PUT transaction ROLLBACK on DB error (no audit row written)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import {
  mountHighRiskDomainsRoutes,
  parseStoredDomains,
  serializeDomains,
  validateDomainList,
  SETTING_KEY,
  AUDIT_ACTION,
  MAX_DOMAINS,
} from '../../../src/server-routes/highRiskDomains.js'

let server
let baseUrl

function startServer(pool) {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    mountHighRiskDomainsRoutes(app, { pool })
    server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
}

function stopServer() {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
}

async function get() {
  const r = await fetch(`${baseUrl}/api/operator-settings/high-risk-domains`)
  return { status: r.status, body: await r.json() }
}

async function put(body, headers = { 'x-confirm-send': 'yes' }) {
  const r = await fetch(`${baseUrl}/api/operator-settings/high-risk-domains`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

/**
 * Build a pool stub that simulates BEGIN/COMMIT/ROLLBACK semantics by
 * shifting from a queue of predetermined query outcomes. Top-level
 * `pool.query` and the client returned by `pool.connect()` share the queue
 * + calls log so a single test can drive both transactional and non-tx
 * calls in order.
 */
function makePool({ queue = [], failOn = null } = {}) {
  const calls = []
  const queueRef = [...queue]
  const exec = async (sql, params) => {
    calls.push({ sql, params })
    if (failOn && (failOn.matcher.test(sql))) {
      if (failOn.consume !== false) failOn.matcher = /__never__/ // fire once
      throw new Error(failOn.message || 'simulated db error')
    }
    if (queueRef.length === 0) return { rows: [], rowCount: 0 }
    const next = queueRef.shift()
    if (next instanceof Error) throw next
    return next
  }
  return {
    calls,
    queue: queueRef,
    query: vi.fn(exec),
    connect: vi.fn(async () => ({
      query: vi.fn(exec),
      release: vi.fn(),
    })),
  }
}

// ── parseStoredDomains + serializeDomains + validateDomainList ───────────────

describe('parseStoredDomains', () => {
  it('returns empty array for null/empty/undefined', () => {
    expect(parseStoredDomains(null)).toEqual([])
    expect(parseStoredDomains(undefined)).toEqual([])
    expect(parseStoredDomains('')).toEqual([])
  })

  it('splits on comma, trims, lowercases, dedups', () => {
    expect(parseStoredDomains('Foo.Cz, foo.cz, bar.com')).toEqual(['foo.cz', 'bar.com'])
  })

  it('ignores empty entries (trailing comma etc.)', () => {
    expect(parseStoredDomains('a.cz,,b.cz, ,c.cz')).toEqual(['a.cz', 'b.cz', 'c.cz'])
  })
})

describe('serializeDomains', () => {
  it('joins with comma without spaces', () => {
    expect(serializeDomains(['a.cz', 'b.cz'])).toBe('a.cz,b.cz')
  })
})

describe('validateDomainList', () => {
  it('rejects non-array', () => {
    expect(validateDomainList('a.cz,b.cz').ok).toBe(false)
    expect(validateDomainList(null).ok).toBe(false)
    expect(validateDomainList({}).ok).toBe(false)
  })

  it('rejects non-string entries', () => {
    const r = validateDomainList(['a.cz', 42])
    expect(r.ok).toBe(false)
    expect(r.code).toBe('wrong_type')
  })

  it('rejects invalid format', () => {
    const r = validateDomainList(['valid.cz', 'not-a-domain'])
    expect(r.ok).toBe(false)
    expect(r.code).toBe('invalid_format')
  })

  it('rejects entries > MAX_DOMAINS', () => {
    const arr = Array.from({ length: MAX_DOMAINS + 1 }, (_, i) => `d${i}.cz`)
    const r = validateDomainList(arr)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('too_many')
  })

  it('dedups case-insensitive', () => {
    const r = validateDomainList(['Foo.Cz', 'foo.cz', 'bar.com'])
    expect(r.ok).toBe(true)
    expect(r.domains).toEqual(['foo.cz', 'bar.com'])
  })

  it('skips blank entries', () => {
    const r = validateDomainList(['a.cz', '', '   ', 'b.cz'])
    expect(r.ok).toBe(true)
    expect(r.domains).toEqual(['a.cz', 'b.cz'])
  })

  it('accepts empty list (level-2 disabled)', () => {
    const r = validateDomainList([])
    expect(r.ok).toBe(true)
    expect(r.domains).toEqual([])
  })
})

// ── GET /api/operator-settings/high-risk-domains ─────────────────────────────

describe('GET /api/operator-settings/high-risk-domains', () => {
  let pool
  afterEach(stopServer)

  it('returns parsed domain list + 24h counter on happy path', async () => {
    pool = makePool({
      queue: [
        { rows: [{ value: 'tiscali.cz,atlas.cz', updated_at: '2026-05-14T10:00:00Z', updated_by: 'operator-AE1' }] },
        { rows: [{ n: '7' }] },
      ],
    })
    await startServer(pool)
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.domains).toEqual(['tiscali.cz', 'atlas.cz'])
    expect(r.body.active_probe_count_24h).toBe(7)
    expect(r.body.updated_by).toBe('operator-AE1')
    expect(r.body.max_domains).toBe(MAX_DOMAINS)
  })

  it('returns empty domains when no row exists (level-2 disabled)', async () => {
    pool = makePool({
      queue: [
        { rows: [] },
        { rows: [{ n: '0' }] },
      ],
    })
    await startServer(pool)
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.domains).toEqual([])
    expect(r.body.active_probe_count_24h).toBe(0)
  })

  it('returns counter=0 when audit_log lookup fails (graceful fallback)', async () => {
    // First call succeeds (settings lookup), second throws (audit lookup).
    pool = makePool()
    let callIdx = 0
    pool.query = vi.fn(async (sql) => {
      callIdx++
      if (callIdx === 1) {
        return { rows: [{ value: 'tiscali.cz', updated_at: null, updated_by: null }] }
      }
      throw new Error('operator_audit_log does not exist')
    })
    await startServer(pool)
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.domains).toEqual(['tiscali.cz'])
    expect(r.body.active_probe_count_24h).toBe(0)
  })

  it('returns 500 when settings lookup itself fails', async () => {
    pool = makePool()
    pool.query = vi.fn(async () => { throw new Error('db down') })
    await startServer(pool)
    const r = await get()
    expect(r.status).toBe(500)
  })
})

// ── PUT /api/operator-settings/high-risk-domains — security gate ─────────────

describe('PUT — security gate', () => {
  let pool
  afterEach(stopServer)

  it('400 when X-Confirm-Send header is missing', async () => {
    pool = makePool()
    await startServer(pool)
    const r = await put({ domains: ['a.cz'] }, { /* no confirm header */ })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('confirm_required')
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('400 when X-Confirm-Send is wrong value', async () => {
    pool = makePool()
    await startServer(pool)
    const r = await put({ domains: ['a.cz'] }, { 'x-confirm-send': 'no' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('confirm_required')
  })
})

// ── PUT — validation ─────────────────────────────────────────────────────────

describe('PUT — validation', () => {
  let pool
  afterEach(stopServer)

  it('400 on non-array body.domains', async () => {
    pool = makePool()
    await startServer(pool)
    const r = await put({ domains: 'a.cz,b.cz' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('not_array')
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('400 on invalid domain format', async () => {
    pool = makePool()
    await startServer(pool)
    const r = await put({ domains: ['valid.cz', 'invalid'] })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('invalid_format')
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('400 on > MAX_DOMAINS entries', async () => {
    pool = makePool()
    await startServer(pool)
    const big = Array.from({ length: MAX_DOMAINS + 1 }, (_, i) => `d${i}.cz`)
    const r = await put({ domains: big })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('too_many')
  })
})

// ── PUT — happy paths ────────────────────────────────────────────────────────

describe('PUT — happy paths', () => {
  let pool
  afterEach(stopServer)

  it('200 + persisted list + audit_log INSERT', async () => {
    pool = makePool({
      queue: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ value: 'tiscali.cz' }] },                              // SELECT prev FOR UPDATE
        { rows: [{ key: SETTING_KEY, value: 'tiscali.cz,atlas.cz', updated_at: '2026-05-14T10:00:00Z', updated_by: 'dashboard' }] }, // UPSERT
        { rows: [] },                                                    // INSERT audit_log
        { rows: [] },                                                    // COMMIT
      ],
    })
    await startServer(pool)
    const r = await put({ domains: ['tiscali.cz', 'atlas.cz'] })
    expect(r.status).toBe(200)
    expect(r.body.domains).toEqual(['tiscali.cz', 'atlas.cz'])

    // Find the audit INSERT among the captured calls (from connect()'s client).
    const client = (await pool.connect.mock.results[0].value)
    // Note: vi.fn().mock.results captures the resolved value of each connect() call.
    // We re-read the call history from the pool-level calls + the client mock fns.
    const allCalls = pool.query.mock.calls.concat(client.query.mock.calls.map((c) => c))
    const auditCall = allCalls.find(([sql]) => /operator_audit_log/.test(sql))
    expect(auditCall).toBeTruthy()
    expect(auditCall[1][0]).toBe(AUDIT_ACTION) // action param
    const details = JSON.parse(auditCall[1][3])
    expect(details.key).toBe(SETTING_KEY)
    expect(details.new_value).toBe('tiscali.cz,atlas.cz')
    expect(details.old_value).toBe('tiscali.cz')
    expect(details.old_count).toBe(1)
    expect(details.new_count).toBe(2)
  })

  it('200 on empty list (level-2 disabled globally)', async () => {
    pool = makePool({
      queue: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ value: 'tiscali.cz' }] },                              // SELECT prev
        { rows: [{ key: SETTING_KEY, value: '', updated_at: '2026-05-14T10:00:00Z', updated_by: 'dashboard' }] }, // UPSERT
        { rows: [] },                                                    // audit
        { rows: [] },                                                    // COMMIT
      ],
    })
    await startServer(pool)
    const r = await put({ domains: [] })
    expect(r.status).toBe(200)
    expect(r.body.domains).toEqual([])
  })

  it('200 + dedup case-insensitive in stored value', async () => {
    pool = makePool({
      queue: [
        { rows: [] },                                                    // BEGIN
        { rows: [] },                                                    // SELECT prev (no row)
        { rows: [{ key: SETTING_KEY, value: 'foo.cz,bar.com', updated_at: '2026-05-14T10:00:00Z', updated_by: 'dashboard' }] },
        { rows: [] },                                                    // audit
        { rows: [] },                                                    // COMMIT
      ],
    })
    await startServer(pool)
    const r = await put({ domains: ['Foo.Cz', 'foo.cz', 'BAR.COM'] })
    expect(r.status).toBe(200)
    expect(r.body.domains).toEqual(['foo.cz', 'bar.com'])

    // UPSERT param[1] is the canonical comma-serialized form.
    const client = (await pool.connect.mock.results[0].value)
    const upsertCall = client.query.mock.calls.find(
      ([sql]) => /INSERT INTO operator_settings/.test(sql)
    )
    expect(upsertCall).toBeTruthy()
    expect(upsertCall[1][1]).toBe('foo.cz,bar.com')
  })

  it('uses x-actor header when present', async () => {
    pool = makePool({
      queue: [
        { rows: [] },                                                    // BEGIN
        { rows: [] },                                                    // SELECT prev
        { rows: [{ key: SETTING_KEY, value: 'a.cz', updated_at: '2026-05-14T10:00:00Z', updated_by: 'alice@hozan' }] },
        { rows: [] },
        { rows: [] },
      ],
    })
    await startServer(pool)
    await put({ domains: ['a.cz'] }, {
      'x-confirm-send': 'yes',
      'x-actor': 'alice@hozan',
    })
    const client = (await pool.connect.mock.results[0].value)
    const upsertCall = client.query.mock.calls.find(
      ([sql]) => /INSERT INTO operator_settings/.test(sql)
    )
    expect(upsertCall[1][2]).toBe('alice@hozan')
  })
})

// ── PUT — error paths ────────────────────────────────────────────────────────

describe('PUT — error paths', () => {
  let pool
  afterEach(stopServer)

  it('500 + ROLLBACK on UPSERT failure; no audit row written', async () => {
    // BEGIN ok; SELECT prev ok; UPSERT throws.
    let auditCallSeen = false
    pool = makePool()
    let calls = 0
    pool.connect = vi.fn(async () => ({
      query: vi.fn(async (sql) => {
        calls++
        if (/operator_audit_log/.test(sql)) {
          auditCallSeen = true
        }
        if (calls === 1) return { rows: [] }                  // BEGIN
        if (calls === 2) return { rows: [] }                  // SELECT prev FOR UPDATE
        if (calls === 3) throw new Error('constraint violation') // UPSERT fails
        return { rows: [] }                                   // ROLLBACK
      }),
      release: vi.fn(),
    }))
    await startServer(pool)
    const r = await put({ domains: ['a.cz'] })
    expect(r.status).toBe(500)
    expect(auditCallSeen).toBe(false)
  })
})
