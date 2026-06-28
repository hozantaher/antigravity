// PATCH /api/replies/:id/flag — flag/star contract (#mail-client triage).
//
// reply_inbox only (matched leads); negative/unmatched id → 400. UPDATE +
// audit in one tx. Coverage: positive flag (UPDATE + audit), negative id 400,
// not-found 404, default flagged=true.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../src/lib/repliesRepository.js', () => ({
  setHandled: vi.fn(), findById: vi.fn(), classifyReplyId: vi.fn(), setClassification: vi.fn(),
}))

const { mountRepliesRoutes } = await import('../../src/server-routes/replies.js')

function buildApp({ updateRowCount = 1 } = {}) {
  const client = {
    query: vi.fn(async (sql) => {
      if (/UPDATE reply_inbox/.test(sql)) return { rowCount: updateRowCount }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rows: [] }) }
  const app = express()
  app.use(express.json())
  mountRepliesRoutes(app, {
    pool,
    capture500: (res, err) => res.status(500).json({ error: String(err?.message || err) }),
    safeError: (e) => String(e?.message || e),
  })
  return { app, client }
}

beforeEach(() => { vi.clearAllMocks() })

describe('PATCH /api/replies/:id/flag', () => {
  it('flags a reply_inbox row + writes audit', async () => {
    const { app, client } = buildApp()
    const res = await request(app).patch('/api/replies/36/flag').send({ flagged: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, flagged: true })
    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((s) => /UPDATE reply_inbox/.test(s) && /flagged/.test(s))).toBe(true)
    expect(sqls.some((s) => /operator_audit_log/.test(s))).toBe(true)
  })

  it('defaults flagged to true when body omits it', async () => {
    const { app } = buildApp()
    const res = await request(app).patch('/api/replies/36/flag').send({})
    expect(res.body.flagged).toBe(true)
  })

  it('unflags when flagged:false', async () => {
    const { app } = buildApp()
    const res = await request(app).patch('/api/replies/36/flag').send({ flagged: false })
    expect(res.body).toEqual({ ok: true, flagged: false })
  })

  it('rejects a negative (unmatched) id with 400', async () => {
    const { app } = buildApp()
    const res = await request(app).patch('/api/replies/-5/flag').send({ flagged: true })
    expect(res.status).toBe(400)
  })

  it('404 when the row does not exist', async () => {
    const { app } = buildApp({ updateRowCount: 0 })
    const res = await request(app).patch('/api/replies/999999/flag').send({ flagged: true })
    expect(res.status).toBe(404)
  })
})
