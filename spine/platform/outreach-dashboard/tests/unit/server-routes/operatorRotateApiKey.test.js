// AW8-3 — operatorRotateApiKey route unit tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import {
  mountOperatorRotateApiKeyRoutes,
  fingerprintKey,
  ROTATION_INSTRUCTIONS,
  RUNBOOK_URL,
} from '../../../src/server-routes/operatorRotateApiKey.js'

let server
let baseUrl

function startServer(pool) {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    mountOperatorRotateApiKeyRoutes(app, { pool })
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

async function getStatus() {
  const r = await fetch(`${baseUrl}/api/operator/api-key-status`)
  return { status: r.status, body: await r.json() }
}

async function postRotate(body = {}, headers = {}) {
  const r = await fetch(`${baseUrl}/api/operator/rotate-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

describe('fingerprintKey', () => {
  it('returns "unset" when key is empty / missing / too short', () => {
    expect(fingerprintKey(null)).toBe('unset')
    expect(fingerprintKey(undefined)).toBe('unset')
    expect(fingerprintKey('')).toBe('unset')
    expect(fingerprintKey('xyz')).toBe('unset')
  })

  it('returns last 4 chars prefixed with ellipsis', () => {
    expect(fingerprintKey('1234567890abcdef')).toBe('…cdef')
    expect(fingerprintKey('abcd')).toBe('…abcd')
  })
})

describe('GET /api/operator/api-key-status', () => {
  let originalKey
  let pool

  beforeEach(async () => {
    originalKey = process.env.OUTREACH_API_KEY
    pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await startServer(pool)
  })
  afterEach(async () => {
    if (originalKey === undefined) delete process.env.OUTREACH_API_KEY
    else process.env.OUTREACH_API_KEY = originalKey
    await stopServer()
  })

  it('returns fingerprint=unset when env not set', async () => {
    delete process.env.OUTREACH_API_KEY
    const r = await getStatus()
    expect(r.status).toBe(200)
    expect(r.body.fingerprint).toBe('unset')
  })

  it('returns fingerprint of last 4 chars', async () => {
    process.env.OUTREACH_API_KEY = 'thekey-AABB-1234-XYZW'
    const r = await getStatus()
    expect(r.body.fingerprint).toBe('…XYZW')
  })

  it('returns rotation_count and last_rotated_at when audit rows exist', async () => {
    process.env.OUTREACH_API_KEY = 'somekey1234'
    const lastRotated = new Date(Date.now() - 86400_000 * 30).toISOString()
    pool.query.mockImplementation((sql) => {
      if (sql.includes('LIMIT 1')) return Promise.resolve({ rows: [{ created_at: lastRotated }] })
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ n: 4 }] })
      return Promise.resolve({ rows: [] })
    })
    const r = await getStatus()
    expect(r.body.rotation_count).toBe(4)
    expect(r.body.last_rotated_at).toBe(lastRotated)
    expect(r.body.age_days).toBe(30)
  })

  it('handles schema gap on operator_audit_log', async () => {
    process.env.OUTREACH_API_KEY = 'somekey'
    const e = new Error('relation operator_audit_log does not exist')
    e.code = '42P01'
    pool.query.mockRejectedValue(e)
    const r = await getStatus()
    expect(r.status).toBe(200)
    expect(r.body.last_rotated_at).toBeNull()
    expect(r.body.rotation_count).toBe(0)
    expect(r.body.age_days).toBeNull()
  })
})

describe('POST /api/operator/rotate-api-key', () => {
  let pool
  beforeEach(async () => {
    pool = { query: vi.fn() }
    await startServer(pool)
  })
  afterEach(stopServer)

  it('rejects without X-Confirm-Send: yes header (412)', async () => {
    const r = await postRotate({})
    expect(r.status).toBe(412)
    expect(r.body.error).toMatch(/X-Confirm-Send/)
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('writes audit row + returns instructions on success', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 9001 }] })
    const r = await postRotate(
      { reason: 'quarterly rotation', runbook_acknowledged: true },
      { 'x-confirm-send': 'yes', 'x-operator-id': 'tomas@example.com' },
    )
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.audit_id).toBe(9001)
    expect(r.body.runbook_url).toBe(RUNBOOK_URL)
    expect(r.body.instructions).toEqual(ROTATION_INSTRUCTIONS)
    expect(pool.query).toHaveBeenCalledTimes(1)
    const args = pool.query.mock.calls[0]
    expect(args[1][0]).toBe('tomas@example.com')
    const details = JSON.parse(args[1][1])
    expect(details.reason).toBe('quarterly rotation')
    expect(details.runbook_acknowledged).toBe(true)
  })

  it('returns 500 on schema gap with helpful message', async () => {
    const e = new Error('relation operator_audit_log does not exist')
    e.code = '42P01'
    pool.query.mockRejectedValue(e)
    const r = await postRotate({}, { 'x-confirm-send': 'yes' })
    expect(r.status).toBe(500)
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toMatch(/operator_audit_log/)
  })

  it('truncates long reason fields to 200 chars', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] })
    const longReason = 'x'.repeat(500)
    await postRotate({ reason: longReason }, { 'x-confirm-send': 'yes' })
    const args = pool.query.mock.calls[0]
    const details = JSON.parse(args[1][1])
    expect(details.reason.length).toBe(200)
  })

  it('falls back actor to "dashboard" when no header', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] })
    await postRotate({}, { 'x-confirm-send': 'yes' })
    const args = pool.query.mock.calls[0]
    expect(args[1][0]).toBe('dashboard')
  })
})

describe('Constants exported for runbook alignment', () => {
  it('ROTATION_INSTRUCTIONS has at least 5 steps', () => {
    expect(ROTATION_INSTRUCTIONS.length).toBeGreaterThanOrEqual(5)
  })
  it('RUNBOOK_URL points to docs/playbooks/secret-rotation.md', () => {
    expect(RUNBOOK_URL).toMatch(/secret-rotation\.md/)
  })
})
