// POST /api/replies/bulk-handled — bulk triage contract (#1021 [S5.3]).
//
// The endpoint marks many replies handled in one tx. It routes each signed id
// via the repository's setHandled (positive → reply_inbox, negative →
// unmatched_inbound) and writes ONE batch audit row
// (feedback_audit_log_on_mutations T0). Internal state flip only — no mail, so
// no X-Confirm-Send gate.
//
// Coverage (risk-proportional — state-mutating, internal):
//   boundary: empty array / over-limit / non-integer ids → 400
//   happy:    2 ids → setHandled called per id, single batch audit INSERT
//   partial:  not_found ids surface in `failed`, the rest still commit
//   audit:    operator_audit_log row carries counts only, never PII

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// Control setHandled per id without touching a real DB.
const setHandledMock = vi.fn()
vi.mock('../../src/lib/repliesRepository.js', () => ({
  setHandled: (...args) => setHandledMock(...args),
  findById: vi.fn(),
  classifyReplyId: vi.fn(),
  setClassification: vi.fn(),
}))

const { mountRepliesRoutes } = await import('../../src/server-routes/replies.js')

function buildApp(mockPool) {
  const app = express()
  app.use(express.json())
  mountRepliesRoutes(app, {
    pool: mockPool,
    capture500: (res, err) => res.status(500).json({ error: String(err?.message || err) }),
    safeError: (e) => String(e?.message || e),
  })
  return app
}

function makePool() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
  const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rows: [] }) }
  return { pool, client }
}

beforeEach(() => {
  vi.clearAllMocks()
  setHandledMock.mockReset()
})

describe('POST /api/replies/bulk-handled', () => {
  it('rejects an empty ids array with 400', async () => {
    const { pool } = makePool()
    const res = await request(buildApp(pool)).post('/api/replies/bulk-handled').send({ ids: [] })
    expect(res.status).toBe(400)
  })

  it('rejects more than 200 ids with 400', async () => {
    const { pool } = makePool()
    const ids = Array.from({ length: 201 }, (_, i) => i + 1)
    const res = await request(buildApp(pool)).post('/api/replies/bulk-handled').send({ ids })
    expect(res.status).toBe(400)
  })

  it('rejects non-integer ids with 400', async () => {
    const { pool } = makePool()
    const res = await request(buildApp(pool)).post('/api/replies/bulk-handled').send({ ids: ['x', 2] })
    expect(res.status).toBe(400)
  })

  it('marks every id handled + writes ONE batch audit row', async () => {
    const { pool, client } = makePool()
    setHandledMock.mockResolvedValue({ ok: true, physicalId: 1, source: 'reply_inbox' })
    const res = await request(buildApp(pool)).post('/api/replies/bulk-handled').send({ ids: [10, -20] })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.updated).toBe(2)
    expect(res.body.failed).toEqual([])

    // setHandled invoked once per id, target = true.
    expect(setHandledMock).toHaveBeenCalledTimes(2)
    expect(setHandledMock).toHaveBeenCalledWith(client, 10, true)
    expect(setHandledMock).toHaveBeenCalledWith(client, -20, true)

    // Exactly one audit INSERT, inside BEGIN/COMMIT.
    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    const auditCalls = sqls.filter((s) => /INSERT INTO operator_audit_log/.test(s))
    expect(auditCalls).toHaveLength(1)
    expect(sqls.some((s) => /BEGIN/.test(s))).toBe(true)
    expect(sqls.some((s) => /COMMIT/.test(s))).toBe(true)
  })

  it('surfaces not_found ids in failed while still committing the rest', async () => {
    const { pool } = makePool()
    setHandledMock
      .mockResolvedValueOnce({ ok: true, physicalId: 5, source: 'reply_inbox' })
      .mockResolvedValueOnce({ ok: false, error: 'not_found' })
    const res = await request(buildApp(pool)).post('/api/replies/bulk-handled').send({ ids: [5, 999] })

    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(1)
    expect(res.body.failed).toEqual([{ id: 999, error: 'not_found' }])
  })

  it('audit details carry counts only — never email/PII', async () => {
    const { pool, client } = makePool()
    setHandledMock.mockResolvedValue({ ok: true, physicalId: 1, source: 'reply_inbox' })
    await request(buildApp(pool)).post('/api/replies/bulk-handled').send({ ids: [1] })

    const auditCall = client.query.mock.calls.find((c) => /INSERT INTO operator_audit_log/.test(String(c[0])))
    expect(auditCall).toBeTruthy()
    const detailsJson = auditCall[1].find((p) => typeof p === 'string' && p.startsWith('{'))
    const details = JSON.parse(detailsJson)
    expect(details).toMatchObject({ requested: 1, updated: 1, failed: 0, handled: true })
    // No email-shaped value anywhere in the audit params.
    expect(JSON.stringify(auditCall[1])).not.toMatch(/@/)
  })
})
