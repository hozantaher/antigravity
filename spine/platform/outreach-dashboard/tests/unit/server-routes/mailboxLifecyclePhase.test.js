// mailboxLifecyclePhase.test.js — AH3 (2026-05-15) + AJ10d (2026-05-16)
//
// Unit coverage for PATCH /api/mailboxes/:id/lifecycle-phase.
// Covers (AH3):
//   - missing X-Confirm-Send header → 403
//   - invalid id (non-numeric / negative / zero) → 400
//   - invalid phase (not in PHASE_ORDER) → 400 with allowed list
//   - missing reason → 400
//   - reason too long (>200) → 400
//   - confirm:true missing → 400
//   - mailbox not found → 404 + ROLLBACK
//   - happy path → 200 + UPDATE + audit row in same tx + COMMIT
//   - DB error during UPDATE → ROLLBACK + capture500
//
// AJ10d additions (lifecycle phase auto mode):
//   - lifecycle_phase: null (auto) → 200; target resolved by DB CASE; audit row carries auto=true
//   - lifecycle_phase: undefined (field missing) → 400 invalid_phase
//   - new lifecycle_phase: 'production' key works (preferred over legacy `phase`)
//   - response includes effective_cap + auto flag
//
// HARD RULE feedback_no_magic_thresholds: phase enum imported from
// lifecyclePhaseCaps.PHASE_ORDER — assertions check the actual values.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mountMailboxRoutes } from '../../../src/server-routes/mailboxes.js'
import { PHASE_ORDER } from '../../../src/lib/lifecyclePhaseCaps.js'

function makeApp() {
  const routes = new Map()
  const app = {
    get: () => {},
    post: () => {},
    delete: () => {},
    patch: (path, handler) => { routes.set(`PATCH ${path}`, handler) },
  }
  // Capture PATCH handlers only — other verbs share the same harness so we
  // accept their registrations as no-ops here.
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

function mountWithMockPool({ poolQuery, clientQueries = [] }) {
  const released = { value: false }
  const calls = []
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params })
      if (!clientQueries.length) return { rows: [], rowCount: 0 }
      const next = clientQueries.shift()
      if (next instanceof Error) throw next
      return next
    }),
    release: () => { released.value = true },
  }
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (...args) => poolQuery ? poolQuery(...args) : { rows: [] }),
  }
  const { app, routes } = makeApp()
  mountMailboxRoutes(app, {
    pool,
    setRouteTags: () => {},
    capture500: (res, err) => res.status(500).json({ error: 'internal', message: err?.message }),
    safeError: (e) => e?.message || String(e),
  })
  return { app, routes, client, pool, released, calls }
}

describe('PATCH /api/mailboxes/:id/lifecycle-phase — AH3', () => {
  let handler, ctx

  function bind({ clientQueries }) {
    ctx = mountWithMockPool({ clientQueries })
    handler = ctx.routes.get('PATCH /api/mailboxes/:id/lifecycle-phase')
    expect(handler).toBeTypeOf('function')
  }

  beforeEach(() => {
    handler = null
    ctx = null
  })

  it('refuses without X-Confirm-Send header → 403', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: {}, body: { phase: 'production', reason: 'x', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(403)
    expect(res.body.error).toMatch(/X-Confirm-Send/)
    // Pool.connect must not have been called for short-circuited request
    expect(ctx.pool.connect).not.toHaveBeenCalled()
  })

  it('invalid id (non-numeric) → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: 'abc' }, headers: { 'x-confirm-send': 'yes' }, body: { phase: 'production', reason: 'x', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('invalid_id')
  })

  it('invalid id (negative) → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '-3' }, headers: { 'x-confirm-send': 'yes' }, body: { phase: 'production', reason: 'x', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('invalid phase (not in PHASE_ORDER) → 400 with allowed list', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { phase: 'foo', reason: 'x', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('invalid_phase')
    expect(res.body.allowed).toEqual(PHASE_ORDER)
  })

  it('destructive status string not in PHASE_ORDER → 400 (no escape)', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { phase: 'retired', reason: 'x', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('invalid_phase')
  })

  it('missing reason → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { phase: 'production', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('reason_required')
  })

  it('reason too long (>200) → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { phase: 'production', reason: 'x'.repeat(201), confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('reason_too_long')
  })

  it('confirm:true missing → 400', async () => {
    bind({ clientQueries: [] })
    const req = { params: { id: '1' }, headers: { 'x-confirm-send': 'yes' }, body: { phase: 'production', reason: 'x' } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('confirm_required')
  })

  it('mailbox not found → 404 + ROLLBACK', async () => {
    bind({
      clientQueries: [
        { rows: [] },           // BEGIN
        { rows: [] },           // SELECT FOR UPDATE — empty
        { rows: [] },           // ROLLBACK
      ],
    })
    const req = { params: { id: '9999' }, headers: { 'x-confirm-send': 'yes' }, body: { phase: 'production', reason: 'x', confirm: true } }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(404)
    expect(res.body.error).toBe('not_found')
    // ROLLBACK must have been issued
    expect(ctx.client.query.mock.calls.some(([sql]) => /^ROLLBACK/i.test(sql))).toBe(true)
    expect(ctx.released.value).toBe(true)
  })

  it('happy path — phase changes, audit row inserted, COMMIT', async () => {
    bind({
      clientQueries: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', lifecycle_phase: 'warmup_d0', daily_cap_override: null, created_at: new Date('2026-05-01T00:00:00Z') }] }, // SELECT FOR UPDATE
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', lifecycle_phase: 'production', effective_cap: 180 }] }, // UPDATE … RETURNING
        { rows: [] },                                                    // INSERT audit
        { rows: [] },                                                    // COMMIT
      ],
    })
    const req = {
      params: { id: '1180' },
      headers: { 'x-confirm-send': 'yes' },
      body: { phase: 'production', reason: 'skip warmup, DKIM ok', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.mailbox.lifecycle_phase).toBe('production')
    expect(res.body.old_phase).toBe('warmup_d0')
    expect(res.body.new_phase).toBe('production')
    expect(res.body.effective_cap).toBe(180)
    expect(res.body.auto).toBe(false)
    // Audit row inserted with correct action + diff
    const auditCall = ctx.client.query.mock.calls.find(([sql]) => /operator_audit_log/.test(sql))
    expect(auditCall).toBeDefined()
    expect(auditCall[0]).toMatch(/mailbox\.lifecycle_phase_change/)
    const auditPayload = JSON.parse(auditCall[1][1])
    expect(auditPayload.from).toBe('warmup_d0')
    expect(auditPayload.to).toBe('production')
    expect(auditPayload.reason).toBe('skip warmup, DKIM ok')
    expect(auditPayload.from_address).toBe('mb1@test.cz')
    expect(auditPayload.auto).toBe(false)
    // COMMIT must have been issued (not ROLLBACK)
    const commits = ctx.client.query.mock.calls.filter(([sql]) => /^COMMIT/i.test(sql))
    expect(commits.length).toBe(1)
    expect(ctx.released.value).toBe(true)
  })

  it('DB error during UPDATE → ROLLBACK + 500', async () => {
    bind({
      clientQueries: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', lifecycle_phase: 'warmup_d0', daily_cap_override: null, created_at: new Date('2026-05-01T00:00:00Z') }] }, // SELECT
        new Error('duplicate key'),                                      // UPDATE fails
      ],
    })
    const req = {
      params: { id: '1180' },
      headers: { 'x-confirm-send': 'yes' },
      body: { phase: 'production', reason: 'r', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(500)
    expect(ctx.client.query.mock.calls.some(([sql]) => /^ROLLBACK/i.test(sql))).toBe(true)
    expect(ctx.released.value).toBe(true)
  })

  it('reason is trimmed and length-capped (boundary)', async () => {
    bind({
      clientQueries: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ id: 1, from_address: 'a@b.cz', lifecycle_phase: 'warmup_d0', daily_cap_override: null, created_at: new Date('2026-05-01T00:00:00Z') }] }, // SELECT
        { rows: [{ id: 1, from_address: 'a@b.cz', lifecycle_phase: 'warmup_d3', effective_cap: 30 }] }, // UPDATE RETURNING
        { rows: [] },                                                    // INSERT audit
        { rows: [] },                                                    // COMMIT
      ],
    })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { phase: 'warmup_d3', reason: '   hello   ', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    const auditCall = ctx.client.query.mock.calls.find(([sql]) => /operator_audit_log/.test(sql))
    const auditPayload = JSON.parse(auditCall[1][1])
    expect(auditPayload.reason).toBe('hello')
  })

  it('all PHASE_ORDER values are accepted', async () => {
    for (const phase of PHASE_ORDER) {
      bind({
        clientQueries: [
          { rows: [] },                                                  // BEGIN
          { rows: [{ id: 1, from_address: 'a@b.cz', lifecycle_phase: 'warmup_d0', daily_cap_override: null, created_at: new Date('2026-05-01T00:00:00Z') }] },
          { rows: [{ id: 1, from_address: 'a@b.cz', lifecycle_phase: phase, effective_cap: 100 }] },
          { rows: [] },                                                  // INSERT audit
          { rows: [] },                                                  // COMMIT
        ],
      })
      const req = {
        params: { id: '1' },
        headers: { 'x-confirm-send': 'yes' },
        body: { phase, reason: 'r', confirm: true },
      }
      const res = makeRes()
      await handler(req, res)
      expect(res.statusCode).toBe(200)
    }
  })

  // ── AJ10d (2026-05-16) ─────────────────────────────────────────────────
  // Auto-mode + new `lifecycle_phase` field name. Closes #1402.

  it('AJ10d: lifecycle_phase=null (auto) → 200; target resolved by DB CASE; auto flag in audit', async () => {
    bind({
      clientQueries: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', lifecycle_phase: 'production', daily_cap_override: null, created_at: new Date('2026-04-01T00:00:00Z') }] }, // SELECT
        { rows: [{ phase: 'warmup_d14' }] },                             // SELECT CASE WHEN (auto resolution)
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', lifecycle_phase: 'warmup_d14', effective_cap: 120 }] }, // UPDATE RETURNING
        { rows: [] },                                                    // INSERT audit
        { rows: [] },                                                    // COMMIT
      ],
    })
    const req = {
      params: { id: '1180' },
      headers: { 'x-confirm-send': 'yes' },
      body: { lifecycle_phase: null, reason: 'remove operator pin', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.auto).toBe(true)
    expect(res.body.old_phase).toBe('production')
    expect(res.body.new_phase).toBe('warmup_d14')
    expect(res.body.effective_cap).toBe(120)
    const auditCall = ctx.client.query.mock.calls.find(([sql]) => /operator_audit_log/.test(sql))
    const auditPayload = JSON.parse(auditCall[1][1])
    expect(auditPayload.auto).toBe(true)
    expect(auditPayload.from).toBe('production')
    expect(auditPayload.to).toBe('warmup_d14')
  })

  it('AJ10d: lifecycle_phase=production (preferred key) → 200', async () => {
    bind({
      clientQueries: [
        { rows: [] },                                                    // BEGIN
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', lifecycle_phase: 'warmup_d0', daily_cap_override: null, created_at: new Date('2026-05-01T00:00:00Z') }] },
        { rows: [{ id: 1180, from_address: 'mb1@test.cz', lifecycle_phase: 'production', effective_cap: 180 }] },
        { rows: [] },
        { rows: [] },
      ],
    })
    const req = {
      params: { id: '1180' },
      headers: { 'x-confirm-send': 'yes' },
      body: { lifecycle_phase: 'production', reason: 'fast-track post DKIM verify', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.auto).toBe(false)
    expect(res.body.new_phase).toBe('production')
  })

  it('AJ10d: lifecycle_phase missing AND legacy phase missing → 400 invalid_phase', async () => {
    bind({ clientQueries: [] })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { reason: 'oops', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('invalid_phase')
    expect(res.body.auto_mode_value).toBeNull()
  })

  it('AJ10d: lifecycle_phase=null with invalid reason → 400 reason_required', async () => {
    bind({ clientQueries: [] })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { lifecycle_phase: null, reason: '', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('reason_required')
  })

  it('AJ10d: lifecycle_phase rejects non-allowed strings (defense in depth)', async () => {
    bind({ clientQueries: [] })
    const req = {
      params: { id: '1' },
      headers: { 'x-confirm-send': 'yes' },
      body: { lifecycle_phase: 'retired', reason: 'try to bypass', confirm: true },
    }
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('invalid_phase')
  })
})
