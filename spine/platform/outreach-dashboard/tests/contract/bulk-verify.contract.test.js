// bulk-verify.contract.test.js — Sprint H1
// ─────────────────────────────────────────────────────────────────────────────
// Contract tests for the 5 new H1 bulk-verify endpoints in verifyLoop.js.
//
// Routes tested (12 cases):
//   POST /api/contacts/verify/bulk-enqueue  (T01–T04)
//   POST /api/contacts/verify/pause         (T05–T06)
//   POST /api/contacts/verify/resume        (T07–T08)
//   GET  /api/contacts/verify/progress      (T09–T10)
//   PUT  /api/contacts/verify/config        (T11–T12)
//
// All state-changing routes require X-Confirm-Send: yes header.
// Mocked pool; no real DB required.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mountVerifyLoopRoutes } from '../../src/server-routes/verifyLoop.js'

// ─── helpers ────────────────────────────────────────────────────────────────

const CONFIRM = { 'x-confirm-send': 'yes' }

function buildApp(mockPool) {
  const app = express()
  app.use(express.json())
  mountVerifyLoopRoutes(app, {
    pool: mockPool,
    runContactVerifyCron: vi.fn().mockResolvedValue(undefined),
    capture: vi.fn(),
  })
  return app
}

// ─── POST /api/contacts/verify/bulk-enqueue ──────────────────────────────────

describe('POST /api/contacts/verify/bulk-enqueue', () => {
  let mockPool

  beforeEach(() => {
    vi.clearAllMocks()
    mockPool = {
      query: vi.fn(),
    }
  })

  it('T01: enqueues unverified contacts and returns counts', async () => {
    // total eligible, terminal, enqueue (rowCount)
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ cnt: 400 }] })  // total eligible
      .mockResolvedValueOnce({ rows: [{ cnt: 26 }] })   // skipped_terminal
      .mockResolvedValueOnce({ rows: [], rowCount: 374 }) // enqueued
      .mockResolvedValueOnce({ rows: [] })               // audit_log INSERT

    const app = buildApp(mockPool)
    const res = await request(app)
      .post('/api/contacts/verify/bulk-enqueue')
      .set(CONFIRM)
      .send({ scope: 'unverified' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      enqueued: 374,
      total: 400,
      skipped_terminal: 26,
    })
  })

  it('T02: rejects missing X-Confirm-Send header', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .post('/api/contacts/verify/bulk-enqueue')
      .send({ scope: 'all' })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('X-Confirm-Send')
  })

  it('T03: rejects invalid scope', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .post('/api/contacts/verify/bulk-enqueue')
      .set(CONFIRM)
      .send({ scope: 'bogus' })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('scope')
  })

  it('T04: rejects campaign scope with non-numeric id', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .post('/api/contacts/verify/bulk-enqueue')
      .set(CONFIRM)
      .send({ scope: 'campaign:abc' })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('campaign id')
  })
})

// ─── POST /api/contacts/verify/pause ────────────────────────────────────────

describe('POST /api/contacts/verify/pause', () => {
  let mockPool

  beforeEach(() => {
    vi.clearAllMocks()
    mockPool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
  })

  it('T05: pauses loop with confirm header', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .post('/api/contacts/verify/pause')
      .set(CONFIRM)
      .send({ reason: 'maintenance' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.paused).toBe(true)
  })

  it('T06: rejects pause without confirm header', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .post('/api/contacts/verify/pause')
      .send({ reason: 'maintenance' })

    expect(res.status).toBe(400)
  })
})

// ─── POST /api/contacts/verify/resume ───────────────────────────────────────

describe('POST /api/contacts/verify/resume', () => {
  let mockPool

  beforeEach(() => {
    vi.clearAllMocks()
    mockPool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
  })

  it('T07: resumes loop with confirm header', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .post('/api/contacts/verify/resume')
      .set(CONFIRM)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, paused: false })
  })

  it('T08: rejects resume without confirm header', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .post('/api/contacts/verify/resume')
      .send({})

    expect(res.status).toBe(400)
  })
})

// ─── GET /api/contacts/verify/progress ──────────────────────────────────────

describe('GET /api/contacts/verify/progress', () => {
  let mockPool

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T09: returns full progress shape', async () => {
    mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ value: '1000' }] })   // daily_max setting
        .mockResolvedValueOnce({ rows: [{ value: 'false' }] })  // paused setting
        .mockResolvedValueOnce({ rows: [{ value: 'true' }] })   // enabled setting
        .mockResolvedValueOnce({ rows: [{ cnt: 426296 }] })     // total_eligible
        .mockResolvedValueOnce({ rows: [{ cnt: 12000 }] })      // verified_total
        .mockResolvedValueOnce({ rows: [{ cnt: 5000 }] })       // pending
        .mockResolvedValueOnce({ rows: [{ used: 300 }] })       // daily_used
        .mockResolvedValueOnce({ rows: [             // status_breakdown
          { email_status: 'valid', cnt: 414296 },
          { email_status: 'invalid', cnt: 3000 },
          { email_status: 'risky', cnt: 5000 },
          { email_status: 'catch_all', cnt: 4000 },
        ] })
        .mockResolvedValueOnce({ rows: [{ cnt: 5 }] })          // recent_per_minute
    }

    const app = buildApp(mockPool)
    const res = await request(app).get('/api/contacts/verify/progress')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      total_eligible: 426296,
      verified_total: 12000,
      pending: 5000,
      daily_used: 300,
      daily_max: 1000,
      paused: false,
      enabled: true,
    })
    expect(res.body.status_breakdown).toMatchObject({
      valid: 414296,
      invalid: 3000,
    })
    expect(res.body).toHaveProperty('eta_days_remaining')
    expect(res.body).toHaveProperty('recent_per_minute')
  })

  it('T10: returns 500 on DB error', async () => {
    mockPool = {
      query: vi.fn().mockRejectedValue(new Error('DB down')),
    }

    const app = buildApp(mockPool)
    const res = await request(app).get('/api/contacts/verify/progress')

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('internal error')
  })
})

// ─── PUT /api/contacts/verify/config ────────────────────────────────────────

describe('PUT /api/contacts/verify/config', () => {
  let mockPool

  beforeEach(() => {
    vi.clearAllMocks()
    mockPool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
  })

  it('T11: updates daily_max and batch_size', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .put('/api/contacts/verify/config')
      .set(CONFIRM)
      .send({ daily_max: 2000, batch_size: 50 })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.updated).toContain('email_verify_daily_max')
    expect(res.body.updated).toContain('email_verify_batch_size')
  })

  it('T12: rejects out-of-range daily_max', async () => {
    const app = buildApp(mockPool)
    const res = await request(app)
      .put('/api/contacts/verify/config')
      .set(CONFIRM)
      .send({ daily_max: 99 }) // below minimum 100

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('daily_max')
  })
})
