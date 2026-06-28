// todayUsage.test.js — AC2 (2026-05-14)
//
// Unit coverage for GET /api/mailboxes/:id/today-usage. Uses a mocked pg
// pool — no DB round-trip. Covers:
//   - happy path with phase cap dominating
//   - override-dominating path
//   - missing mailbox 404
//   - invalid id 400
//   - exhausted limit (remaining=0)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { mountTodayUsageRoute } from '../../../src/server-routes/todayUsage.js'

let server
let baseUrl

function startServer(pool) {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    const deps = {
      pool,
      capture500: (res, err, safeError) => res.status(500).json({ error: safeError(err) }),
      safeError: (e) => (e && e.message) || 'error',
    }
    mountTodayUsageRoute(app, deps)
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

async function getUsage(id) {
  const r = await fetch(`${baseUrl}/api/mailboxes/${id}/today-usage`)
  return { status: r.status, body: await r.json() }
}

describe('GET /api/mailboxes/:id/today-usage', () => {
  let pool

  beforeEach(async () => {
    pool = { query: vi.fn() }
    await startServer(pool)
  })

  afterEach(async () => {
    await stopServer()
    vi.restoreAllMocks()
  })

  it('rejects non-numeric id with 400', async () => {
    const r = await getUsage('abc')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_id')
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('rejects zero / negative id with 400', async () => {
    const r = await getUsage('0')
    expect(r.status).toBe(400)
  })

  it('returns 404 when mailbox not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const r = await getUsage('999')
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('not_found')
  })

  it('happy path — warmup_d0, no override, 3 of 10 sent today', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1180,
        lifecycle_phase: 'warmup_d0',
        daily_cap_override: null,
        from_address: 'mb1@seznam.cz',
        created_at: new Date('2026-05-14T08:00:00Z'),
        sent_today_count: 3,
      }],
    })
    const r = await getUsage('1180')
    expect(r.status).toBe(200)
    expect(r.body.mailbox_id).toBe(1180)
    expect(r.body.lifecycle_phase).toBe('warmup_d0')
    expect(r.body.phase_cap).toBe(10)
    expect(r.body.daily_cap_override).toBeNull()
    expect(r.body.effective_cap).toBe(10)
    expect(r.body.sent_today_count).toBe(3)
    expect(r.body.remaining_today).toBe(7)
    expect(r.body.cap_source).toBe('lifecycle_phase')
    expect(r.body.phase_advances_at).toMatch(/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('override LOWERS production cap → cap_source = daily_cap_override', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1181,
        lifecycle_phase: 'production',
        daily_cap_override: 30,
        from_address: 'mb2@seznam.cz',
        created_at: new Date('2026-03-01T00:00:00Z'),
        sent_today_count: 10,
      }],
    })
    const r = await getUsage('1181')
    expect(r.status).toBe(200)
    expect(r.body.phase_cap).toBe(180)
    expect(r.body.daily_cap_override).toBe(30)
    expect(r.body.effective_cap).toBe(30)
    expect(r.body.cap_source).toBe('daily_cap_override')
    expect(r.body.remaining_today).toBe(20)
    expect(r.body.phase_advances_at).toBeNull() // production = terminal
  })

  it('override HIGHER than phase cap is silently capped (only lowers)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1182,
        lifecycle_phase: 'warmup_d0',
        daily_cap_override: 999,
        from_address: 'mb3@seznam.cz',
        created_at: new Date('2026-05-14T08:00:00Z'),
        sent_today_count: 0,
      }],
    })
    const r = await getUsage('1182')
    expect(r.status).toBe(200)
    expect(r.body.phase_cap).toBe(10)
    expect(r.body.daily_cap_override).toBe(999)
    expect(r.body.effective_cap).toBe(10)
    expect(r.body.cap_source).toBe('lifecycle_phase')
  })

  it('exhausted limit — remaining_today === 0', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1183,
        lifecycle_phase: 'warmup_d3',
        daily_cap_override: null,
        from_address: 'mb4@seznam.cz',
        created_at: new Date('2026-05-10T08:00:00Z'),
        sent_today_count: 30,
      }],
    })
    const r = await getUsage('1183')
    expect(r.status).toBe(200)
    expect(r.body.effective_cap).toBe(30)
    expect(r.body.sent_today_count).toBe(30)
    expect(r.body.remaining_today).toBe(0)
  })

  it('handles unknown lifecycle_phase gracefully (falls back to default)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1184,
        lifecycle_phase: 'warmup_d999',
        daily_cap_override: null,
        from_address: 'mb5@seznam.cz',
        created_at: new Date('2026-05-14T08:00:00Z'),
        sent_today_count: 1,
      }],
    })
    const r = await getUsage('1184')
    expect(r.status).toBe(200)
    expect(r.body.phase_cap).toBe(10) // DEFAULT_PHASE_CAP
    expect(r.body.effective_cap).toBe(10)
  })

  it('null lifecycle_phase falls back to warmup_d0', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1185,
        lifecycle_phase: null,
        daily_cap_override: null,
        from_address: 'mb6@seznam.cz',
        created_at: new Date('2026-05-14T08:00:00Z'),
        sent_today_count: 0,
      }],
    })
    const r = await getUsage('1185')
    expect(r.status).toBe(200)
    expect(r.body.lifecycle_phase).toBe('warmup_d0')
    expect(r.body.effective_cap).toBe(10)
  })

  it('returns 500 on unexpected DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'))
    const r = await getUsage('1186')
    expect(r.status).toBe(500)
  })
})
