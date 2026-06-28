// mailboxStatus.test.js — AH3 (2026-05-15)
//
// Unit coverage for PATCH /api/mailboxes/:id/status.
// Covers:
//   - missing X-Confirm-Send → 403
//   - invalid id → 400
//   - invalid status value (e.g. 'retired', 'foo') → 400 with allowed list
//   - confirm:true missing → 400
//   - activate without reason → 400
//   - reason too long → 400
//   - mailbox not found → 404 + ROLLBACK
//   - mailbox already auth_locked → 409 (must use dedicated unlock route)
//   - mailbox already retired → 409
//   - happy path activate (with reason) → 200 + audit row + COMMIT
//   - happy path pause (no reason → defaults) → 200 + audit row

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mountMailboxRoutes } from '../../../src/server-routes/mailboxes.js'

function makeApp() {
  const routes = new Map()
  const app = {
    get: () => {},
    post: () => {},
    delete: () => {},
    patch: (path, handler) => { routes.set(`PATCH ${path}`, handler) },
  }
  return { app, routes }
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(b) { this.body = b; return this },
  }
}

function mountWithMockPool({ clientQueries = [] }) {
  const released = { value: false }
  const client = {
    query: vi.fn(async (sql, params) => {
      if (!clientQueries.length) return { rows: [], rowCount: 0 }
      const next = clientQueries.shift()
      if (next instanceof Error) throw next
      return next
    }),
    release: () => { released.value = true },
  }
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [] })),
  }
  const { app, routes } = makeApp()
  mountMailboxRoutes(app, {
    pool,
    setRouteTags: () => {},
    capture500: (res, err) => res.status(500).json({ error: 'internal', message: err?.message }),
    safeError: (e) => e?.message || String(e),
  })
  return { app, routes, client, pool, released }
}

describe('PATCH /api/mailboxes/:id/status — AH3', () => {
  let handler, ctx

  function bind({ clientQueries }) {
    ctx = mountWithMockPool({ clientQueries })
    handler = ctx.routes.get('PATCH /api/mailboxes/:id/status')
    expect(handler).toBeTypeOf('function')
  }

  beforeEach(() => {
    handler = null
    ctx = null
  })

  it('refuses without X-Confirm-Send → 403', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: {}, body: { status: 'paused', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(403)
    expect(ctx.pool.connect).not.toHaveBeenCalled()
  })

  it('invalid id → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '0' }, headers: { 'x-confirm-send': 'yes' }, body: { status: 'paused', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('invalid_id')
  })

  it('rejects destructive status value (retired) → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { status: 'retired', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('invalid_status')
    expect(res.body.allowed).toEqual(['active', 'paused'])
  })

  it('rejects destructive status value (auth_locked) → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { status: 'auth_locked', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('invalid_status')
  })

  it('confirm:true missing → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { status: 'paused' } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('confirm_required')
  })

  it('activate without reason → 400 (reason_required_for_activate)', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { status: 'active', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('reason_required_for_activate')
  })

  it('reason too long → 400', async () => {
    bind({ clientQueries: [] })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { status: 'paused', reason: 'x'.repeat(201), confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('reason_too_long')
  })

  it('mailbox not found → 404 + ROLLBACK', async () => {
    bind({
      clientQueries: [
        { rows: [] },           // BEGIN
        { rows: [] },           // SELECT FOR UPDATE empty
        { rows: [] },           // ROLLBACK
      ],
    })
    const req = {
      params: { id: '9999' },
      headers: { 'x-confirm-send': 'yes' },
      body: { status: 'active', reason: 'r', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(404)
    expect(ctx.client.query.mock.calls.some(([sql]) => /^ROLLBACK/i.test(sql))).toBe(true)
    expect(ctx.released.value).toBe(true)
  })

  it('current status auth_locked → 409 (dedicated endpoint required)', async () => {
    bind({
      clientQueries: [
        { rows: [] },           // BEGIN
        { rows: [{ id: 1, from_address: 'a@b.cz', status: 'auth_locked', status_reason: 'auth' }] }, // SELECT FOR UPDATE
        { rows: [] },           // ROLLBACK
      ],
    })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { status: 'active', reason: 'r', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(409)
    expect(res.body.error).toBe('destructive_status_requires_dedicated_endpoint')
    expect(res.body.current_status).toBe('auth_locked')
    expect(ctx.released.value).toBe(true)
  })

  it('current status retired → 409', async () => {
    bind({
      clientQueries: [
        { rows: [] },           // BEGIN
        { rows: [{ id: 1, from_address: 'a@b.cz', status: 'retired', status_reason: null }] }, // SELECT FOR UPDATE
        { rows: [] },           // ROLLBACK
      ],
    })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { status: 'active', reason: 'r', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(409)
  })

  it('happy path — activate from paused with reason, audit + COMMIT', async () => {
    bind({
      clientQueries: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', status: 'paused', status_reason: 'bounce_rate_historical' }] }, // SELECT
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', status: 'active', status_reason: 'unpause_post_bounce_review' }] }, // UPDATE RETURNING
        { rows: [] },                                                    // INSERT audit
        { rows: [] },                                                    // COMMIT
      ],
    })
    const req = {
      params: { id: '1180' },
      headers: { 'x-confirm-send': 'yes' },
      body: { status: 'active', reason: 'unpause_post_bounce_review', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.mailbox.status).toBe('active')
    const auditCall = ctx.client.query.mock.calls.find(([sql]) => /operator_audit_log/.test(sql))
    expect(auditCall).toBeDefined()
    expect(auditCall[0]).toMatch(/mailbox\.status_change/)
    const auditPayload = JSON.parse(auditCall[1][1])
    expect(auditPayload.from).toBe('paused')
    expect(auditPayload.to).toBe('active')
    expect(auditPayload.to_reason).toBe('unpause_post_bounce_review')
    expect(auditPayload.from_address).toBe('mb1@test.cz')
    expect(ctx.client.query.mock.calls.filter(([sql]) => /^COMMIT/i.test(sql)).length).toBe(1)
  })

  it('happy path — pause without reason defaults to operator_manual_pause', async () => {
    bind({
      clientQueries: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ id: 1, from_address: 'a@b.cz', status: 'active', status_reason: null }] }, // SELECT
        { rows: [{ id: 1, from_address: 'a@b.cz', status: 'paused', status_reason: 'operator_manual_pause' }] }, // UPDATE RETURNING
        { rows: [] },                                                    // INSERT audit
        { rows: [] },                                                    // COMMIT
      ],
    })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { status: 'paused', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.mailbox.status).toBe('paused')
    const updateCall = ctx.client.query.mock.calls.find(([sql]) => /UPDATE outreach_mailboxes/.test(sql) && /status_reason/.test(sql))
    expect(updateCall).toBeDefined()
    // params: [id, status, reason]
    expect(updateCall[1][2]).toBe('operator_manual_pause')
  })

  it('DB error during UPDATE → ROLLBACK + 500', async () => {
    bind({
      clientQueries: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ id: 1, from_address: 'a@b.cz', status: 'paused', status_reason: null }] }, // SELECT
        new Error('connection reset'),                                   // UPDATE fails
      ],
    })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { status: 'active', reason: 'r', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(500)
    expect(ctx.client.query.mock.calls.some(([sql]) => /^ROLLBACK/i.test(sql))).toBe(true)
  })
})
