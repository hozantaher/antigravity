// bff-notifications.contract.test.js — Sprint Y7.
//
// Verifies the GET /api/notifications + POST /api/notifications/:id/resolve
// endpoints:
//   - aggregates mailbox_alerts + auth_locked/bounce_hold + computed bounce rate
//   - sorts by severity then timestamp
//   - threshold comes from operator_settings (with fallback)
//   - resolve requires X-Confirm-Send header
//   - resolve writes operator_audit_log in same transaction (T0)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountNotificationsRoutes } from '../../src/server-routes/notifications.js'

function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  mountNotificationsRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

function makePool({ settings = {}, alerts = [], locks = [], bounces = [] } = {}) {
  return {
    query: vi.fn(async (sql, params) => {
      if (/FROM operator_settings/i.test(sql)) {
        const key = params[0]
        if (key in settings) return { rows: [{ value: String(settings[key]) }] }
        return { rows: [] }
      }
      if (/FROM mailbox_alerts/i.test(sql)) {
        return { rows: alerts }
      }
      if (/FROM outreach_mailboxes\s+WHERE status IN/i.test(sql)) {
        return { rows: locks }
      }
      if (/WITH stats/i.test(sql)) {
        return { rows: bounces }
      }
      return { rows: [] }
    }),
    connect: vi.fn(),
  }
}

describe('GET /api/notifications', () => {
  it('returns empty feed when no alerts, locks, or bounce breaches', async () => {
    const pool = makePool()
    const app = makeApp(pool)
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(200)
    expect(res.body.counts).toEqual({ total: 0, critical: 0, warning: 0, info: 0 })
    expect(res.body.notifications).toEqual([])
    expect(res.body.thresholds.bounce_rate_warn).toBeCloseTo(0.02)
  })

  it('surfaces operator_settings bounce_rate_warn_threshold override', async () => {
    const pool = makePool({ settings: { bounce_rate_warn_threshold: '0.05' } })
    const app = makeApp(pool)
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(200)
    expect(res.body.thresholds.bounce_rate_warn).toBeCloseTo(0.05)
  })

  it('aggregates mailbox_alerts rows', async () => {
    const pool = makePool({
      alerts: [
        {
          id: 1, mailbox_id: 10, from_address: 'a@x.cz',
          type: 'imap_poll_fail', severity: 'warning',
          message: 'IMAP poll timeout', created_at: new Date().toISOString(),
        },
      ],
    })
    const app = makeApp(pool)
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(200)
    expect(res.body.notifications).toHaveLength(1)
    expect(res.body.notifications[0]).toMatchObject({
      source: 'mailbox_alerts',
      type: 'imap_poll_fail',
      severity: 'warning',
      alert_id: 1,
      resolvable: true,
    })
  })

  it('surfaces auth_locked mailbox as critical (live state)', async () => {
    const pool = makePool({
      locks: [
        {
          id: 22, from_address: 'b@x.cz', status: 'auth_locked',
          auth_locked_at: new Date().toISOString(),
          auth_locked_reason: 'imap_poll_3x_fail',
        },
      ],
    })
    const app = makeApp(pool)
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(200)
    expect(res.body.notifications).toHaveLength(1)
    expect(res.body.notifications[0]).toMatchObject({
      source: 'mailbox_state',
      type: 'mailbox_auth_lock',
      severity: 'critical',
      mailbox_id: 22,
      resolvable: false,
    })
  })

  it('surfaces computed bounce_rate breach with threshold reflected in message', async () => {
    const pool = makePool({
      bounces: [
        { id: 33, from_address: 'c@x.cz', bounced: 3, total: 50, rate: 0.06 },
      ],
    })
    const app = makeApp(pool)
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(200)
    expect(res.body.notifications[0]).toMatchObject({
      source: 'computed',
      type: 'bounce_rate_high',
      severity: 'warning',
      mailbox_id: 33,
    })
    expect(res.body.notifications[0].message).toContain('6.0%')
    expect(res.body.notifications[0].message).toContain('2.0%') // threshold
  })

  it('sorts by severity then created_at desc', async () => {
    const now = Date.now()
    const pool = makePool({
      alerts: [
        { id: 1, mailbox_id: 1, type: 'x', severity: 'info', message: 'old info',
          created_at: new Date(now - 10_000).toISOString() },
        { id: 2, mailbox_id: 2, type: 'y', severity: 'warning', message: 'warn',
          created_at: new Date(now - 5_000).toISOString() },
      ],
      locks: [
        { id: 3, status: 'auth_locked', auth_locked_at: new Date(now).toISOString(),
          auth_locked_reason: 'test', from_address: 'x@x.cz' },
      ],
    })
    const app = makeApp(pool)
    const res = await request(app).get('/api/notifications')
    expect(res.body.notifications.map(n => n.severity)).toEqual(['critical', 'warning', 'info'])
  })

  it('reports correct counts breakdown', async () => {
    const pool = makePool({
      alerts: [
        { id: 1, mailbox_id: 1, type: 'x', severity: 'info', message: '',
          created_at: new Date().toISOString() },
        { id: 2, mailbox_id: 2, type: 'y', severity: 'warning', message: '',
          created_at: new Date().toISOString() },
      ],
      locks: [
        { id: 3, status: 'auth_locked', auth_locked_at: new Date().toISOString(),
          auth_locked_reason: 't', from_address: 'x@x.cz' },
      ],
    })
    const app = makeApp(pool)
    const res = await request(app).get('/api/notifications')
    expect(res.body.counts).toEqual({ total: 3, critical: 1, warning: 1, info: 1 })
  })
})

describe('POST /api/notifications/:id/resolve', () => {
  function makeTxPool({ updated = null } = {}) {
    const client = {
      query: vi.fn(async (sql) => {
        if (/^BEGIN/i.test(sql)) return {}
        if (/^COMMIT/i.test(sql)) return {}
        if (/^ROLLBACK/i.test(sql)) return {}
        if (/UPDATE mailbox_alerts/i.test(sql)) {
          return { rows: updated ? [updated] : [] }
        }
        if (/INSERT INTO operator_audit_log/i.test(sql)) {
          return { rows: [] }
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    return {
      query: vi.fn(),
      connect: vi.fn(async () => client),
      _client: client,
    }
  }

  it('rejects without X-Confirm-Send header (428)', async () => {
    const pool = makeTxPool()
    const app = makeApp(pool)
    const res = await request(app).post('/api/notifications/1/resolve')
    expect(res.status).toBe(428)
  })

  it('rejects invalid alert id (400)', async () => {
    const pool = makeTxPool()
    const app = makeApp(pool)
    const res = await request(app)
      .post('/api/notifications/abc/resolve')
      .set('X-Confirm-Send', 'yes')
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown / already-resolved alert', async () => {
    const pool = makeTxPool({ updated: null })
    const app = makeApp(pool)
    const res = await request(app)
      .post('/api/notifications/99/resolve')
      .set('X-Confirm-Send', 'yes')
    expect(res.status).toBe(404)
  })

  it('resolves successfully + writes audit log in same tx (T0)', async () => {
    const pool = makeTxPool({
      updated: { id: 5, mailbox_id: 10, type: 't', severity: 'warning', message: 'm', created_at: new Date().toISOString() },
    })
    const app = makeApp(pool)
    const res = await request(app)
      .post('/api/notifications/5/resolve')
      .set('X-Confirm-Send', 'yes')
      .set('X-Operator', 'tomas')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.alert_id).toBe(5)
    // Verify audit log INSERT was called in same client (transaction)
    const queries = pool._client.query.mock.calls.map(c => c[0])
    expect(queries.some(q => /BEGIN/i.test(q))).toBe(true)
    expect(queries.some(q => /UPDATE mailbox_alerts/i.test(q))).toBe(true)
    expect(queries.some(q => /INSERT INTO operator_audit_log/i.test(q))).toBe(true)
    expect(queries.some(q => /COMMIT/i.test(q))).toBe(true)
  })
})
