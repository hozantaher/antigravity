// bff-mailbox-blacklist-alerts.contract.test.js — Sprint M4 (#1272).
//
// Coverage:
//   - GET: window validation, empty-fleet, top_zones extraction,
//     per-mailbox aggregation, alert rows surface
//   - POST resolve: missing header → 428, invalid id → 400, not found →
//     404, success transaction including operator_audit_log

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountMailboxBlacklistAlertsRoutes } from '../../src/server-routes/mailboxBlacklistAlerts.js'

function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  mountMailboxBlacklistAlertsRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

describe('GET /api/mailboxes/blacklist-alerts', () => {
  let pool
  beforeEach(() => { pool = { query: vi.fn() } })

  it('rejects unknown window', async () => {
    const res = await request(makeApp(pool)).get('/api/mailboxes/blacklist-alerts?window=year')
    expect(res.status).toBe(400)
    expect(res.body.allowed).toEqual(['24h', '7d', '30d', 'all'])
  })

  it('default window is 7d', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })  // alerts listing (LIMIT 200)
      .mockResolvedValueOnce({ rows: [] })  // per-mailbox rollup
      .mockResolvedValueOnce({ rows: [{ total: '0', active: '0', resolved: '0' }] })  // uncapped fleet COUNT
    const res = await request(makeApp(pool)).get('/api/mailboxes/blacklist-alerts')
    expect(res.body.window).toBe('7d')
  })

  it('accepts all 4 windows', async () => {
    for (const w of ['24h', '7d', '30d', 'all']) {
      pool.query
        .mockResolvedValueOnce({ rows: [] })  // alerts listing
        .mockResolvedValueOnce({ rows: [] })  // per-mailbox rollup
        .mockResolvedValueOnce({ rows: [{ total: '0', active: '0', resolved: '0' }] })  // uncapped fleet COUNT
      const res = await request(makeApp(pool)).get(`/api/mailboxes/blacklist-alerts?window=${w}`)
      expect(res.status).toBe(200)
      expect(res.body.window).toBe(w)
    }
  })

  it('extracts zones from "Blacklist hit: X, Y" message format', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 1, mailbox_id: 1, from_address: 'a@x', severity: 'critical',
            message: 'Blacklist hit: zen.spamhaus.org, dnsbl.sorbs.net',
            created_at: '2026-05-12', resolved_at: null },
          { id: 2, mailbox_id: 2, from_address: 'b@x', severity: 'critical',
            message: 'Blacklist hit: zen.spamhaus.org',
            created_at: '2026-05-12', resolved_at: null },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })  // per-mailbox rollup
      .mockResolvedValueOnce({ rows: [{ total: '2', active: '2', resolved: '0' }] })  // uncapped fleet COUNT
    const res = await request(makeApp(pool)).get('/api/mailboxes/blacklist-alerts?window=7d')
    const zones = Object.fromEntries(res.body.top_zones.map(z => [z.zone, z.count]))
    expect(zones['zen.spamhaus.org']).toBe(2)
    expect(zones['dnsbl.sorbs.net']).toBe(1)
  })

  it('top_zones capped at 10', async () => {
    const manyZones = Array.from({ length: 15 }, (_, i) => `zone-${i}.example`).join(', ')
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, mailbox_id: 1, from_address: 'a@x', severity: 'critical',
                 message: `Blacklist hit: ${manyZones}`,
                 created_at: '2026-05-12', resolved_at: null }],
      })
      .mockResolvedValueOnce({ rows: [] })  // per-mailbox rollup
      .mockResolvedValueOnce({ rows: [{ total: '1', active: '1', resolved: '0' }] })  // uncapped fleet COUNT
    const res = await request(makeApp(pool)).get('/api/mailboxes/blacklist-alerts?window=7d')
    expect(res.body.top_zones).toHaveLength(10)
  })

  it('fleet rollup comes from the uncapped COUNT query (not the LIMIT 200 array)', async () => {
    pool.query
      // alerts listing — capped at LIMIT 200; here only a 3-row sample.
      .mockResolvedValueOnce({
        rows: [
          { id: 1, mailbox_id: 1, from_address: 'a@x', severity: 'critical', message: 'Blacklist hit: x', created_at: '2026-05-12', resolved_at: null },
          { id: 2, mailbox_id: 1, from_address: 'a@x', severity: 'critical', message: 'Blacklist hit: y', created_at: '2026-05-11', resolved_at: '2026-05-12' },
          { id: 3, mailbox_id: 2, from_address: 'b@x', severity: 'critical', message: 'Blacklist hit: z', created_at: '2026-05-10', resolved_at: null },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })  // per-mailbox rollup
      // Dedicated uncapped fleet COUNT. Totals deliberately EXCEED the 3-row
      // listing above to prove fleet is read from this query — not derived from
      // the LIMIT 200 alerts array (which would undercount after a >200-row hit).
      .mockResolvedValueOnce({ rows: [{ total: '253', active: '200', resolved: '53' }] })
    const res = await request(makeApp(pool)).get('/api/mailboxes/blacklist-alerts?window=7d')
    expect(res.body.fleet).toEqual({ total: 253, active: 200, resolved: 53 })
  })

  it('returns empty fleet on no hits', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })  // alerts listing
      .mockResolvedValueOnce({ rows: [] })  // per-mailbox rollup
      .mockResolvedValueOnce({ rows: [{ total: '0', active: '0', resolved: '0' }] })  // uncapped fleet COUNT
    const res = await request(makeApp(pool)).get('/api/mailboxes/blacklist-alerts?window=7d')
    expect(res.body.fleet).toEqual({ total: 0, active: 0, resolved: 0 })
    expect(res.body.mailboxes).toEqual([])
    expect(res.body.top_zones).toEqual([])
  })

  it('handles malformed message (no "Blacklist hit:" prefix)', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, mailbox_id: 1, from_address: 'a@x', severity: 'critical',
                 message: 'random garbage with no zone',
                 created_at: '2026-05-12', resolved_at: null }],
      })
      .mockResolvedValueOnce({ rows: [] })  // per-mailbox rollup
      .mockResolvedValueOnce({ rows: [{ total: '1', active: '1', resolved: '0' }] })  // uncapped fleet COUNT
    const res = await request(makeApp(pool)).get('/api/mailboxes/blacklist-alerts?window=7d')
    expect(res.body.top_zones).toEqual([])
    expect(res.body.alerts).toHaveLength(1)
  })

  it('500 on db error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'))
    const res = await request(makeApp(pool)).get('/api/mailboxes/blacklist-alerts?window=7d')
    expect(res.status).toBe(500)
  })
})

describe('POST /api/mailboxes/blacklist-alerts/:id/resolve', () => {
  let pool, client
  beforeEach(() => {
    client = { query: vi.fn(), release: vi.fn() }
    pool = { connect: vi.fn().mockResolvedValue(client) }
  })

  it('requires X-Confirm-Send header', async () => {
    const res = await request(makeApp(pool)).post('/api/mailboxes/blacklist-alerts/1/resolve')
    expect(res.status).toBe(428)
  })

  it('rejects invalid alert id', async () => {
    const res = await request(makeApp(pool))
      .post('/api/mailboxes/blacklist-alerts/abc/resolve')
      .set('X-Confirm-Send', 'yes')
    expect(res.status).toBe(400)
  })

  it('returns 404 when alert not found or already resolved', async () => {
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE returns nothing
    const res = await request(makeApp(pool))
      .post('/api/mailboxes/blacklist-alerts/99/resolve')
      .set('X-Confirm-Send', 'yes')
    expect(res.status).toBe(404)
  })

  it('resolves alert + writes operator_audit_log in same tx', async () => {
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, mailbox_id: 5, message: 'Blacklist hit: zen', created_at: '2026-05-12' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit
      .mockResolvedValueOnce({}) // COMMIT
    const res = await request(makeApp(pool))
      .post('/api/mailboxes/blacklist-alerts/1/resolve')
      .set('X-Confirm-Send', 'yes')
      .set('X-Operator', 'tomas')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // BEGIN + UPDATE + INSERT audit + COMMIT = 4 client.query calls
    expect(client.query.mock.calls.length).toBe(4)
    // 3rd call is the audit INSERT
    expect(client.query.mock.calls[2][0]).toContain('INSERT INTO operator_audit_log')
    expect(client.query.mock.calls[2][1][0]).toBe('tomas')
  })
})
