// verify-loop.contract.test.js — Sprint AM3
// ─────────────────────────────────────────────────────────────────────────────
// Contract tests for operator surface of contact verification loop.
//
// Routes tested (6 total):
//   GET    /api/verify-loop/status      — overall loop state + daily budget
//   POST   /api/verify-loop/pause       — pause with reason
//   POST   /api/verify-loop/resume      — resume
//   POST   /api/verify-loop/trigger     — manual run
//   GET    /api/verify-loop/queue       — pending contacts (limit=50 default)
//   POST   /api/contacts/:id/reverify   — bump priority + schedule immediate

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mountVerifyLoopRoutes } from '../../src/server-routes/verifyLoop.js'

describe('verify-loop contract', () => {
  let app
  let mockPool
  let mockClient
  let mockRunContactVerifyCron

  beforeEach(() => {
    vi.clearAllMocks()
    app = express()
    app.use(express.json())

    mockRunContactVerifyCron = vi.fn().mockResolvedValue(undefined)

    // POST /:id/reverify now wraps its UPDATE + audit INSERT in one
    // BEGIN/COMMIT on a connected client, so the pool hands out a fake tx
    // client. Routes that still read via pool.query (status, queue, trigger)
    // are unaffected.
    mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    }

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(mockClient),
    }

    // Mount the routes
    mountVerifyLoopRoutes(app, {
      pool: mockPool,
      runContactVerifyCron: mockRunContactVerifyCron,
      capture: vi.fn(),
    })
  })

  // Supertest wrapper that mirrors the prior callRoute() signature so
  // each `it()` keeps its existing assertions without rewriting them.
  const callRoute = async (method, path, body = null) => {
    const verb = method.toLowerCase()
    const req = request(app)[verb](path)
    if (body !== null) req.send(body)
    const resp = await req
    return { status: resp.status, body: resp.body }
  }

  describe('GET /api/verify-loop/status', () => {
    it('T01: returns full status object with all fields', async () => {
      process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true'
      process.env.VERIFY_DAILY_MAX = '500'

      mockPool.query
        // /status now resolves enabled / daily_max / paused DB-first from
        // operator_settings (3 reads) before the data queries.
        .mockResolvedValueOnce({ rows: [{ value: '500' }] }) // operator_settings email_verify_daily_max
        .mockResolvedValueOnce({ rows: [{ value: 'false' }] }) // operator_settings verify_loop_paused
        .mockResolvedValueOnce({ rows: [{ value: 'true' }] }) // operator_settings verify_loop_enabled
        .mockResolvedValueOnce({ rows: [{ used: 150 }] }) // daily used
        .mockResolvedValueOnce({ rows: [{ cnt: 5 }] }) // inflight
        .mockResolvedValueOnce({ rows: [{ cnt: 42 }] }) // queue depth
        .mockResolvedValueOnce({ rows: [{ cnt: 3 }] }) // error count
        .mockResolvedValueOnce({ rows: [{ created_at: '2026-05-11T10:00:00Z' }] }) // last tick

      const res = await callRoute('GET', '/api/verify-loop/status')

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        enabled: true,
        daily_max: 500,
        daily_used: 150,
        daily_remaining: 350,
        inflight: 5,
        queue_depth: 42,
      })
    })

    it('T02: includes pause state', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ used: 0 }] })
        .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
        .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
        .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
        .mockResolvedValueOnce({ rows: [] })

      const res = await callRoute('GET', '/api/verify-loop/status')

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('paused')
      expect(res.body).toHaveProperty('paused_reason')
    })
  })

  describe('POST /api/verify-loop/pause', () => {
    it('T03: pauses loop with reason', async () => {
      const res = await callRoute('POST', '/api/verify-loop/pause', { reason: 'credential rotation' })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.paused).toBe(true)
    })
  })

  describe('POST /api/verify-loop/resume', () => {
    it('T04: resumes loop', async () => {
      const res = await callRoute('POST', '/api/verify-loop/resume', {})

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, paused: false })
    })
  })

  describe('POST /api/verify-loop/trigger', () => {
    it('T05: triggers manual run', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }] }) // no inflight

      const res = await callRoute('POST', '/api/verify-loop/trigger', {})

      expect(res.status).toBe(200)
      expect(res.body.started).toBe(true)
      expect(mockRunContactVerifyCron).toHaveBeenCalled()
    })

    it('T06: rejects when inflight', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: 3 }] }) // 3 inflight

      const res = await callRoute('POST', '/api/verify-loop/trigger', {})

      expect(res.status).toBe(202)
      expect(res.body.busy).toBe(true)
    })
  })

  describe('GET /api/verify-loop/queue', () => {
    it('T07: returns queue with default limit', async () => {
      const mockQueue = [
        { id: 1, email: 'test1@example.com', email_status: 'risky', email_verify_attempts: 1 },
        { id: 2, email: 'test2@example.com', email_status: 'valid', email_verify_attempts: 0 },
      ]

      mockPool.query.mockResolvedValueOnce({ rows: mockQueue })

      const res = await callRoute('GET', '/api/verify-loop/queue')

      expect(res.status).toBe(200)
      expect(res.body.length).toBe(2)
      expect(res.body[0].email).toBe('test1@example.com')
    })

    it('T08: respects custom limit', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] })

      await callRoute('GET', '/api/verify-loop/queue?limit=100')

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $1'),
        [100]
      )
    })
  })

  describe('POST /api/contacts/:id/reverify', () => {
    it('T09: reverifies contact (UPDATE + audit INSERT in one tx)', async () => {
      const res = await callRoute('POST', '/api/contacts/123/reverify', {})

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.contact_id).toBe(123)

      // The reverify now opens a tx on a connected client and commits the
      // contacts UPDATE together with its operator_audit_log row.
      expect(mockPool.connect).toHaveBeenCalledTimes(1)
      const sqls = mockClient.query.mock.calls.map((c) => String(c[0]))
      expect(sqls[0]).toBe('BEGIN')
      const updateIdx = sqls.findIndex((s) => /UPDATE contacts/.test(s))
      const auditIdx = sqls.findIndex((s) => /operator_audit_log/.test(s))
      const commitIdx = sqls.findIndex((s) => /^\s*COMMIT/.test(s))
      expect(updateIdx).toBeGreaterThan(0)
      expect(auditIdx).toBeGreaterThan(updateIdx) // audit follows the UPDATE
      expect(commitIdx).toBeGreaterThan(auditIdx) // audit committed in-tx
      expect(sqls).not.toContain('ROLLBACK')
      expect(mockClient.release).toHaveBeenCalled()
    })

    it('T10: sets priority if provided (passes through the tx UPDATE)', async () => {
      await callRoute('POST', '/api/contacts/456/reverify', { priority: 50 })

      // The priced UPDATE flows through the connected tx client, not pool.query.
      const updateCall = mockClient.query.mock.calls.find((c) => /UPDATE contacts/.test(String(c[0])))
      expect(updateCall).toBeDefined()
      expect(updateCall[0]).toMatch(/email_verify_priority = \$2/)
      expect(updateCall[1]).toEqual([456, 50])
      expect(mockPool.connect).toHaveBeenCalled()
    })

    it('T11: rejects invalid id', async () => {
      const res = await callRoute('POST', '/api/contacts/invalid/reverify', {})

      expect(res.status).toBe(400)
      // Rejected before any DB work — no tx opened.
      expect(mockPool.connect).not.toHaveBeenCalled()
    })

    it('T12: handles DB errors (rolls back, returns 500)', async () => {
      // The error now arises on the tx client's UPDATE; the route must roll
      // back and surface a 500 (no COMMIT).
      mockClient.query.mockImplementation((sql) => {
        if (/UPDATE contacts/.test(String(sql))) return Promise.reject(new Error('DB error'))
        return Promise.resolve({ rows: [], rowCount: 0 })
      })

      const res = await callRoute('POST', '/api/contacts/123/reverify', {})

      expect(res.status).toBe(500)
      const sqls = mockClient.query.mock.calls.map((c) => String(c[0]))
      expect(sqls).toContain('ROLLBACK')
      expect(sqls.some((s) => /^\s*COMMIT/.test(s))).toBe(false)
      expect(mockClient.release).toHaveBeenCalled()
    })
  })
})
