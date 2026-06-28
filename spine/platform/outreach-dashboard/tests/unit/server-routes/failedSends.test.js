// AW8-3 — failedSends route unit tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { mountFailedSendsRoutes } from '../../../src/server-routes/failedSends.js'

let server
let baseUrl

function startServer(pool) {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    mountFailedSendsRoutes(app, { pool })
    server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
}

function stopServer() {
  return new Promise((resolve) => server ? server.close(() => resolve()) : resolve())
}

async function get(query = {}) {
  const qs = new URLSearchParams(query).toString()
  const r = await fetch(`${baseUrl}/api/failed-sends${qs ? '?' + qs : ''}`)
  return { status: r.status, body: await r.json() }
}

async function post(path, body = {}, headers = {}) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

describe('failedSends GET /api/failed-sends', () => {
  let pool
  beforeEach(async () => {
    pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await startServer(pool)
  })
  afterEach(stopServer)

  it('clamps since_days to MAX 30', async () => {
    await get({ since_days: '999' })
    const params = pool.query.mock.calls[0][1]
    expect(params[0]).toBe('30')
  })

  it('uses default since_days=7 when omitted', async () => {
    await get()
    const params = pool.query.mock.calls[0][1]
    expect(params[0]).toBe('7')
  })

  it('clamps limit to MAX 500', async () => {
    await get({ limit: '9999' })
    const params = pool.query.mock.calls[0][1]
    expect(params[params.length - 1]).toBe(500)
  })

  it('returns ok:true with rows from pool', async () => {
    const rows = [{ id: 1, contact_email: 'foo@example.com', smtp_response: '550 user unknown', cc_id: 88, retry_count: 2 }]
    pool.query.mockResolvedValueOnce({ rows })
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.rows).toEqual(rows)
    expect(r.body.count).toBe(1)
  })

  it('passes campaign_id filter through to SQL when valid', async () => {
    await get({ campaign_id: '42' })
    const sql = pool.query.mock.calls[0][0]
    const params = pool.query.mock.calls[0][1]
    expect(sql).toMatch(/se\.campaign_id = \$2/)
    expect(params[1]).toBe(42)
  })

  it('ignores invalid campaign_id', async () => {
    await get({ campaign_id: 'NOT_A_NUMBER' })
    const sql = pool.query.mock.calls[0][0]
    expect(sql).not.toMatch(/se\.campaign_id = \$2/)
  })

  it('returns ok:false on schema gap', async () => {
    const e = new Error('relation does not exist')
    e.code = '42P01'
    pool.query.mockRejectedValueOnce(e)
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
    expect(r.body.reason).toBeTruthy()
  })

  it('orders by sent_at DESC', async () => {
    await get()
    const sql = pool.query.mock.calls[0][0]
    expect(sql).toMatch(/ORDER BY se\.sent_at DESC/)
  })
})

describe('failedSends POST /api/failed-sends/:cc_id/reset', () => {
  let pool
  let client
  beforeEach(async () => {
    // The reset endpoint now binds the status flip + audit INSERT in ONE
    // BEGIN/COMMIT on a connected client (pool.connect()). The mock pool hands
    // out a fake tx client; each test configures client.query as needed.
    client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() }
    pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }
    await startServer(pool)
  })
  afterEach(stopServer)

  it('rejects invalid cc_id with 400', async () => {
    const r = await post('/api/failed-sends/abc/reset', { confirm: true })
    expect(r.status).toBe(400)
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('rejects without confirm:true with 412', async () => {
    const r = await post('/api/failed-sends/42/reset', {})
    expect(r.status).toBe(412)
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('flips status pending and audit-logs in one tx on success', async () => {
    client.query.mockImplementation((sql) => {
      if (String(sql).includes('UPDATE campaign_contacts')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, campaign_id: 7, contact_id: 999, status: 'pending' }] })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    const r = await post('/api/failed-sends/42/reset', { confirm: true })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.reset).toBe(true)
    expect(r.body.cc_id).toBe(42)
    expect(r.body.previous_status).toBe('failed')
    expect(r.body.new_status).toBe('pending')

    // Flip + audit row are committed atomically on the connected client:
    // BEGIN → UPDATE → audit INSERT → COMMIT, with the audit INSERT in-tx.
    expect(pool.connect).toHaveBeenCalledTimes(1)
    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    expect(sqls[0]).toBe('BEGIN')
    const updateIdx = sqls.findIndex((s) => /UPDATE campaign_contacts/.test(s))
    const auditIdx = sqls.findIndex((s) => /operator_audit_log/.test(s))
    const commitIdx = sqls.findIndex((s) => /^\s*COMMIT/.test(s))
    expect(updateIdx).toBeGreaterThan(0)
    expect(auditIdx).toBeGreaterThan(updateIdx) // audit follows the flip
    expect(commitIdx).toBeGreaterThan(auditIdx) // audit is committed in-tx
    expect(sqls).not.toContain('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })

  it('returns reset:false when row not in failed status (rolls back, no commit)', async () => {
    client.query.mockImplementation((sql) => {
      const s = String(sql)
      if (s.includes('UPDATE campaign_contacts')) return Promise.resolve({ rowCount: 0, rows: [] })
      if (s.includes('SELECT') && s.includes('campaign_contacts')) {
        return Promise.resolve({ rows: [{ id: 42, status: 'sent' }] })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    const r = await post('/api/failed-sends/42/reset', { confirm: true })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.reset).toBe(false)
    expect(r.body.current_status).toBe('sent')

    // No mutation: the tx is rolled back, never committed, no audit row.
    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    expect(sqls).toContain('ROLLBACK')
    expect(sqls.some((s) => /^\s*COMMIT/.test(s))).toBe(false)
    expect(sqls.some((s) => /operator_audit_log/.test(s))).toBe(false)
    expect(client.release).toHaveBeenCalled()
  })

  it('returns 404 when row missing entirely (rolls back)', async () => {
    client.query.mockImplementation((sql) => {
      const s = String(sql)
      if (s.includes('UPDATE campaign_contacts')) return Promise.resolve({ rowCount: 0, rows: [] })
      if (s.includes('SELECT') && s.includes('campaign_contacts')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    const r = await post('/api/failed-sends/99/reset', { confirm: true })
    expect(r.status).toBe(404)

    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    expect(sqls).toContain('ROLLBACK')
    expect(sqls.some((s) => /^\s*COMMIT/.test(s))).toBe(false)
    expect(client.release).toHaveBeenCalled()
  })

  it('rolls back the re-arm and returns 500 when the audit INSERT fails', async () => {
    // NEW correct behavior: flip + audit are atomic. A failing audit INSERT
    // rolls back the status flip and surfaces a 500 — previously a 200
    // {reset:true} could ship with the audit silently swallowed.
    client.query.mockImplementation((sql) => {
      const s = String(sql)
      if (s.includes('UPDATE campaign_contacts')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, campaign_id: 1, contact_id: 5, status: 'pending' }] })
      }
      if (s.includes('operator_audit_log')) return Promise.reject(new Error('audit table missing'))
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    const r = await post('/api/failed-sends/42/reset', { confirm: true })
    expect(r.status).toBe(500)
    expect(r.body.ok).toBe(false)

    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    expect(sqls).toContain('ROLLBACK')
    expect(sqls.some((s) => /^\s*COMMIT/.test(s))).toBe(false)
    expect(client.release).toHaveBeenCalled()
  })
})
