// AW8-3 — auditRecent route unit tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { mountAuditRecentRoute } from '../../../src/server-routes/auditRecent.js'

let server
let baseUrl

function startServer(pool) {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    mountAuditRecentRoute(app, { pool })
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
  const r = await fetch(`${baseUrl}/api/audit/recent${qs ? '?' + qs : ''}`)
  return { status: r.status, body: await r.json() }
}

describe('auditRecent', () => {
  let pool
  beforeEach(async () => {
    pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await startServer(pool)
  })
  afterEach(stopServer)

  it('rejects missing action with 400', async () => {
    const r = await get({})
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/action.*required/)
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('rejects action not in whitelist with 400', async () => {
    const r = await get({ action: 'something_arbitrary' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/whitelist/)
    expect(r.body.allowed).toContain('in_flight_reaped')
    expect(r.body.allowed).toContain('engine.panic_recovered')
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('returns rows for valid action=in_flight_reaped', async () => {
    const rows = [{ id: 1, action: 'in_flight_reaped', actor: 'watchdog_reaper', entity_type: 'campaign_contact', entity_id: '100', details: {}, created_at: new Date().toISOString() }]
    pool.query.mockResolvedValueOnce({ rows })
    const r = await get({ action: 'in_flight_reaped' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.rows).toEqual(rows)
    expect(r.body.count).toBe(1)
  })

  it('returns rows for valid action=engine.panic_recovered', async () => {
    const r = await get({ action: 'engine.panic_recovered' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.count).toBe(0)
  })

  it('clamps since_hours to MAX (336h = 14d)', async () => {
    await get({ action: 'in_flight_reaped', since_hours: '99999' })
    const params = pool.query.mock.calls[0][1]
    expect(params[1]).toBe('336')
  })

  it('clamps since_hours to MIN (1h)', async () => {
    await get({ action: 'in_flight_reaped', since_hours: '0' })
    const params = pool.query.mock.calls[0][1]
    expect(params[1]).toBe('1')
  })

  it('clamps limit to MAX 200', async () => {
    await get({ action: 'in_flight_reaped', limit: '99999' })
    const params = pool.query.mock.calls[0][1]
    expect(params[params.length - 1]).toBe(200)
  })

  it('uses default since_hours=24 when omitted', async () => {
    await get({ action: 'in_flight_reaped' })
    const params = pool.query.mock.calls[0][1]
    expect(params[1]).toBe('24')
  })

  it('passes entity_id filter through to SQL', async () => {
    await get({ action: 'in_flight_reaped', entity_id: '42' })
    const sql = pool.query.mock.calls[0][0]
    const params = pool.query.mock.calls[0][1]
    expect(sql).toMatch(/entity_id = \$3/)
    expect(params[2]).toBe('42')
  })

  it('returns ok:false on schema gap (42P01)', async () => {
    const e = new Error('relation "operator_audit_log" does not exist')
    e.code = '42P01'
    pool.query.mockRejectedValueOnce(e)
    const r = await get({ action: 'in_flight_reaped' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
    expect(r.body.reason).toMatch(/operator_audit_log/)
  })

  it('returns 500 on unexpected DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'))
    const r = await get({ action: 'in_flight_reaped' })
    expect(r.status).toBe(500)
  })

  it('orders rows DESC by created_at', async () => {
    await get({ action: 'in_flight_reaped' })
    const sql = pool.query.mock.calls[0][0]
    expect(sql).toMatch(/ORDER BY created_at DESC/)
  })
})
