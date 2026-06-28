// bff-mailbox-bounce-warnings.contract.test.js — Sprint UX-4.
//
// Verifies GET /api/mailboxes/bounce-warnings:
//   - response shape (ran_at, thresholds, warnings[])
//   - warn-threshold filter (>= 1.5%)
//   - sort order (rate DESC, worst first)
//   - operator_settings override (warn / pause / min_volume tunable)
//   - min_volume gate (under-20 mailboxes excluded)
//   - empty-fleet edge case
//   - DB error path

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountMailboxBounceWarningsRoutes } from '../../src/server-routes/mailboxBounceWarnings.js'

function makePool({ settings = {}, mailboxRows = [] } = {}) {
  return {
    query: vi.fn((sql, params) => {
      // operator_settings lookup
      if (/FROM operator_settings/i.test(sql)) {
        const key = Array.isArray(params) ? params[0] : null
        if (key && Object.prototype.hasOwnProperty.call(settings, key)) {
          return Promise.resolve({ rows: [{ value: String(settings[key]) }] })
        }
        return Promise.resolve({ rows: [] })
      }
      // mailbox aggregation
      if (/FROM outreach_mailboxes/i.test(sql)) {
        return Promise.resolve({ rows: mailboxRows })
      }
      return Promise.resolve({ rows: [] })
    }),
  }
}

function makeApp(pool) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => (e && e.message ? e.message : 'unknown')
  mountMailboxBounceWarningsRoutes(app, { pool, capture500, safeError })
  return app
}

describe('GET /api/mailboxes/bounce-warnings', () => {
  let pool
  beforeEach(() => { pool = null })

  it('returns empty warnings + default thresholds on a clean DB', async () => {
    pool = makePool({})
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.status).toBe(200)
    expect(res.body.thresholds).toEqual({
      warn: 0.015,
      pause: 0.02,
      min_volume: 20,
    })
    expect(res.body.warnings).toEqual([])
    expect(res.body.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('surfaces a single mailbox at 1.7% rate', async () => {
    pool = makePool({
      mailboxRows: [
        { mailbox_id: 7, from_address: 'a@post.cz', sends_today: 100, bounces_today: 2 },
      ],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.status).toBe(200)
    expect(res.body.warnings).toHaveLength(1)
    expect(res.body.warnings[0]).toMatchObject({
      mailbox_id: 7,
      from_address: 'a@post.cz',
      bounces_today: 2,
      sends_today: 100,
    })
    expect(res.body.warnings[0].bounce_rate).toBeCloseTo(0.02)
  })

  it('excludes mailboxes below the 1.5% warn threshold', async () => {
    pool = makePool({
      mailboxRows: [
        // 1.0% — below warn
        { mailbox_id: 1, from_address: 'a@x.cz', sends_today: 100, bounces_today: 1 },
        // 2.0% — above warn (also above pause but endpoint just filters by warn)
        { mailbox_id: 2, from_address: 'b@x.cz', sends_today: 100, bounces_today: 2 },
      ],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.body.warnings.map((w) => w.mailbox_id)).toEqual([2])
  })

  it('includes mailbox at exactly 1.5% (inclusive boundary)', async () => {
    pool = makePool({
      mailboxRows: [
        // 3 / 200 = 0.015 exactly
        { mailbox_id: 9, from_address: 'edge@x.cz', sends_today: 200, bounces_today: 3 },
      ],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.body.warnings).toHaveLength(1)
    expect(res.body.warnings[0].mailbox_id).toBe(9)
    expect(res.body.warnings[0].bounce_rate).toBeCloseTo(0.015)
  })

  it('sorts warnings by rate DESC (worst offender first)', async () => {
    pool = makePool({
      mailboxRows: [
        { mailbox_id: 1, from_address: 'low@x.cz',  sends_today: 100, bounces_today: 2 }, // 2.0%
        { mailbox_id: 2, from_address: 'high@x.cz', sends_today: 100, bounces_today: 5 }, // 5.0%
        { mailbox_id: 3, from_address: 'mid@x.cz',  sends_today: 100, bounces_today: 3 }, // 3.0%
      ],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.body.warnings.map((w) => w.mailbox_id)).toEqual([2, 3, 1])
  })

  it('honors operator_settings warn threshold override', async () => {
    pool = makePool({
      settings: { bounce_warn_threshold: '0.05' }, // raise warn to 5%
      mailboxRows: [
        { mailbox_id: 1, from_address: 'a@x.cz', sends_today: 100, bounces_today: 3 }, // 3% — below new warn
        { mailbox_id: 2, from_address: 'b@x.cz', sends_today: 100, bounces_today: 6 }, // 6% — above
      ],
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.body.thresholds.warn).toBeCloseTo(0.05)
    expect(res.body.warnings.map((w) => w.mailbox_id)).toEqual([2])
  })

  it('honors operator_settings pause + min_volume overrides', async () => {
    pool = makePool({
      settings: {
        bounce_pause_threshold: '0.03',
        bounce_min_volume: '50',
      },
    })
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.body.thresholds.pause).toBeCloseTo(0.03)
    expect(res.body.thresholds.min_volume).toBe(50)
  })

  it('falls back to defaults when operator_settings value is unparseable', async () => {
    pool = makePool({ settings: { bounce_warn_threshold: 'not-a-number' } })
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.body.thresholds.warn).toBeCloseTo(0.015)
  })

  it('returns 500 with safe error message on DB failure', async () => {
    pool = {
      query: vi.fn(() => Promise.reject(new Error('db down'))),
    }
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.status).toBe(500)
  })

  it('uses safe defaults when no operator_settings rows match', async () => {
    pool = makePool({}) // no settings, no rows
    const res = await request(makeApp(pool)).get('/api/mailboxes/bounce-warnings')
    expect(res.status).toBe(200)
    expect(res.body.thresholds).toEqual({
      warn: 0.015,
      pause: 0.02,
      min_volume: 20,
    })
  })
})
