// bff-data-quality.contract.test.js — GET /api/data-quality.
//
// Read-only system-wide integrity checks. Focus: the manual_reply_stuck check
// (added when the reply composer landed) must run, carry 'error' severity, and
// roll into the top-level errors count when it's non-zero — so a broken relay
// worker (operator thinks they replied, mail never went out) surfaces loudly.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(poolMock) {
  const app = express()
  const { mountDataQualityRoute } = await import('../../src/server-routes/dataQualityChecks.js')
  mountDataQualityRoute(app, {
    pool: poolMock,
    capture500: (res, err) => res.status(500).json({ error: err.message }),
    safeError: (e) => e,
  })
  return app
}

describe('GET /api/data-quality', () => {
  let counts
  beforeEach(() => { counts = {} })

  // The route fires CHECKS in order; we return per-call counts so we can drive
  // a specific check's value regardless of array position.
  function poolReturning(byOrder) {
    let i = 0
    return { query: vi.fn().mockImplementation(async () => ({ rows: [{ n: byOrder[i++] ?? 0 }] })) }
  }

  it('includes manual_reply_stuck as an error-severity check', async () => {
    const app = await makeApp(poolReturning([]))
    const res = await request(app).get('/api/data-quality')
    expect(res.status).toBe(200)
    const check = res.body.checks.find((c) => c.key === 'manual_reply_stuck')
    expect(check).toBeTruthy()
    expect(check.severity).toBe('error')
  })

  it('all-zero counts → 0 errors, 0 warnings (healthy)', async () => {
    const app = await makeApp(poolReturning([]))  // every check returns 0
    const res = await request(app).get('/api/data-quality')
    expect(res.body.errors).toBe(0)
    expect(res.body.warnings).toBe(0)
    expect(res.body.checks.every((c) => c.count === 0)).toBe(true)
  })

  it('a stuck reply rolls into the top-level errors count', async () => {
    // Find the index of manual_reply_stuck by running once with a marker.
    const probe = await makeApp(poolReturning([]))
    const order = (await request(probe).get('/api/data-quality')).body.checks
    const idx = order.findIndex((c) => c.key === 'manual_reply_stuck')
    const counts = order.map((_, i) => (i === idx ? 4 : 0))  // 4 stuck replies
    const app = await makeApp(poolReturning(counts))
    const res = await request(app).get('/api/data-quality')
    expect(res.body.checks[idx].count).toBe(4)
    expect(res.body.errors).toBeGreaterThanOrEqual(1)
  })

  it('returns 500 with message when a check query throws', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) }
    const app = await makeApp(pool)
    const res = await request(app).get('/api/data-quality')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('db down')
  })
})
