// bff-ingest-freshness.contract.test.js — GET /api/ingest-freshness.
// Returns the pipeline heartbeat (last poll + last inbound + recent-poll count).
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(pool) {
  const app = express()
  const { mountIngestFreshnessRoute } = await import('../../src/server-routes/ingestFreshness.js')
  mountIngestFreshnessRoute(app, { pool, capture500: (res, e) => res.status(500).json({ error: e.message }), safeError: (e) => e })
  return app
}

describe('GET /api/ingest-freshness', () => {
  it('returns the heartbeat fields from a single query', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ last_poll_at: '2026-06-01T16:25:10Z', last_inbound_at: '2026-05-29T21:11:35Z', mailboxes_polled_recently: 4 }] }) }
    const res = await request(await makeApp(pool)).get('/api/ingest-freshness')
    expect(res.status).toBe(200)
    expect(res.body.last_poll_at).toBe('2026-06-01T16:25:10Z')
    expect(res.body.mailboxes_polled_recently).toBe(4)
    expect(res.body.as_of).toBeTruthy()
  })

  it('nulls degrade cleanly (empty pipeline → no crash, recently=0)', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ last_poll_at: null, last_inbound_at: null, mailboxes_polled_recently: null }] }) }
    const res = await request(await makeApp(pool)).get('/api/ingest-freshness')
    expect(res.status).toBe(200)
    expect(res.body.last_poll_at).toBeNull()
    expect(res.body.mailboxes_polled_recently).toBe(0)
  })

  it('surfaces a 500 with message on query failure', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) }
    const res = await request(await makeApp(pool)).get('/api/ingest-freshness')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('db down')
  })
})
