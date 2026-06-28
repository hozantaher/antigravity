// mailboxHealthHistory.test.js — ADD-4 (2026-05-14)
//
// Unit coverage for the BFF endpoint
// GET /api/mailboxes/:id/health-history?days=N
// (declared inside mountMailboxRoutes in src/server-routes/mailboxes.js).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { mountMailboxRoutes } from '../../../src/server-routes/mailboxes.js'

let server
let baseUrl

function startServer(pool) {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    const deps = {
      pool,
      setRouteTags: () => {},
      capture500: (res, err, safeError) => res.status(500).json({ error: safeError(err) }),
      safeError: (e) => (e && e.message) || 'error',
    }
    mountMailboxRoutes(app, deps)
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

async function get(path) {
  const r = await fetch(`${baseUrl}${path}`)
  return { status: r.status, body: await r.json() }
}

describe('GET /api/mailboxes/:id/health-history', () => {
  let pool
  beforeEach(async () => {
    pool = { query: vi.fn(), connect: vi.fn() }
    await startServer(pool)
  })
  afterEach(async () => {
    await stopServer()
    vi.restoreAllMocks()
  })

  it('rejects non-numeric :id with 400', async () => {
    const r = await get('/api/mailboxes/abc/health-history')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_id')
  })

  it('returns 404 when mailbox row not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const r = await get('/api/mailboxes/1180/health-history')
    expect(r.status).toBe(404)
  })

  it('returns aggregated daily series for a known mailbox', async () => {
    pool.query
      // mailbox lookup
      .mockResolvedValueOnce({ rows: [{ from_address: 'hozan.taher.75@post.cz' }] })
      // daily series (3 days for brevity)
      .mockResolvedValueOnce({
        rows: [
          { day: '2026-05-08', sends: 100, bounces: 1 },
          { day: '2026-05-09', sends: 200, bounces: 5 },
          { day: '2026-05-10', sends: 247, bounces: 9 },
        ],
      })
      // last_score lookup
      .mockResolvedValueOnce({ rows: [{ last_score: 82, last_score_at: '2026-05-10T08:00:00Z' }] })

    const r = await get('/api/mailboxes/1180/health-history?days=3')
    expect(r.status).toBe(200)
    expect(r.body.mailbox_id).toBe(1180)
    expect(r.body.days_requested).toBe(3)
    expect(r.body.last_score).toBe(82)
    expect(r.body.series).toHaveLength(3)
    expect(r.body.series[2]).toMatchObject({ day: '2026-05-10', sends: 247, bounces: 9 })
    // bounce_rate_pct = round(9/247*1000)/10 = 3.6
    expect(r.body.series[2].bounce_rate_pct).toBe(3.6)
  })

  it('returns 0% bounce_rate_pct for a day with zero sends', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ from_address: 'addr@test' }] })
      .mockResolvedValueOnce({ rows: [{ day: '2026-05-10', sends: 0, bounces: 0 }] })
      .mockResolvedValueOnce({ rows: [{ last_score: 70, last_score_at: null }] })

    const r = await get('/api/mailboxes/9/health-history?days=1')
    expect(r.body.series[0].bounce_rate_pct).toBe(0)
  })

  it('caps days param at 30 (anti-DoS)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ from_address: 'addr@test' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ last_score: null, last_score_at: null }] })

    const r = await get('/api/mailboxes/9/health-history?days=999')
    expect(r.status).toBe(200)
    expect(r.body.days_requested).toBe(30)
    // The SQL parameter for days should also be 30.
    const seriesQueryParams = pool.query.mock.calls[1][1]
    expect(seriesQueryParams[0]).toBe(30)
  })

  it('defaults to 7 days when days param omitted', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ from_address: 'addr@test' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ last_score: null, last_score_at: null }] })

    const r = await get('/api/mailboxes/9/health-history')
    expect(r.body.days_requested).toBe(7)
  })

  it('returns null last_score when mailbox row has no score', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ from_address: 'addr@test' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ last_score: null, last_score_at: null }] })

    const r = await get('/api/mailboxes/9/health-history')
    expect(r.body.last_score).toBe(null)
  })

  it('returns 500 on unexpected DB error in series query', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ from_address: 'addr@test' }] })
      .mockRejectedValueOnce(new Error('connection refused'))

    const r = await get('/api/mailboxes/9/health-history')
    expect(r.status).toBe(500)
  })
})
