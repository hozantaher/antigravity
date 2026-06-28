// bff-suppressions-domain-aj10a.contract.test.js — Sprint AJ10a (#1397).
//
// Verifies POST /api/suppressions/domain behavior. Used by the
// GlobalDomainSuppressPanel surfaced in CompanyDrawer + ThreadDetail to
// suppress an entire email domain across every campaign + future
// enrollments.
//
// Per HARD RULE feedback_audit_log_on_mutations the audit row must land
// in the same transaction as the outreach_suppressions INSERT + the
// campaign_contacts cascade UPDATE.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const { mountSuppressionRoutes } = await import('../../src/server-routes/suppression.js')
  const capture500 = (res, err) => res.status(500).json({ error: err.message })
  const safeError = (e) => e
  mountSuppressionRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

function makeClient() {
  return { query: vi.fn(), release: vi.fn() }
}

describe('POST /api/suppressions/domain (AJ10a #1397)', () => {
  let pool, client
  beforeEach(() => {
    client = makeClient()
    pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }
  })

  // ── Validation paths ──────────────────────────────────────────────────

  it('rejects missing domain with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({ reason: 'tiscali_systemic_bounce_2026-05-15', confirm: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/domain must be a non-empty string/)
  })

  it('rejects empty domain with 400', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({ domain: '', reason: 'tiscali_systemic_bounce_2026-05-15', confirm: true })
    expect(res.status).toBe(400)
  })

  it('rejects invalid domain syntax', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({
        domain: 'not-a-domain',
        reason: 'tiscali_systemic_bounce_2026-05-15',
        confirm: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_domain')
  })

  it('rejects missing reason', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({ domain: 'tiscali.cz', confirm: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/reason must be a non-empty string/)
  })

  it('rejects too-short reason (audit-log discipline)', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({ domain: 'tiscali.cz', reason: 'short', confirm: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('reason_too_short')
  })

  it('rejects missing X-Confirm-Send header with 412 on mutation path', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .send({
        domain: 'tiscali.cz',
        reason: 'tiscali_systemic_bounce_2026-05-15',
        confirm: true,
      })
    expect(res.status).toBe(412)
    expect(res.body.error).toBe('missing_confirm_header')
  })

  it('rejects missing confirm flag on mutation path', async () => {
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({
        domain: 'tiscali.cz',
        reason: 'tiscali_systemic_bounce_2026-05-15',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/confirm must be true/)
  })

  // ── Dry-run path ──────────────────────────────────────────────────────

  it('dry-run returns impact count + campaigns breakdown without writes', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { campaign_id: 457, count: 574 },
          { campaign_id: 460, count: 12 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // existing suppression lookup
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain?dry_run=true')
      .send({
        domain: 'tiscali.cz',
        reason: 'tiscali_systemic_bounce_2026-05-15',
      })
    expect(res.status).toBe(200)
    expect(res.body.dry_run).toBe(true)
    expect(res.body.contacts_skipped).toBe(586)
    expect(res.body.campaigns_affected).toEqual([
      { campaign_id: 457, count: 574 },
      { campaign_id: 460, count: 12 },
    ])
    expect(res.body.already_suppressed).toBe(false)
    // Mutation client.connect should NOT have been called.
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('dry-run flags already_suppressed when row exists', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // no impact
      .mockResolvedValueOnce({ rows: [{ id: 2804 }] }) // existing row
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain?dry_run=true')
      .send({
        domain: 'tiscali.cz',
        reason: 'tiscali_systemic_bounce_2026-05-15',
      })
    expect(res.status).toBe(200)
    expect(res.body.already_suppressed).toBe(true)
    expect(res.body.suppression_id).toBe(2804)
  })

  // ── Mutation path ─────────────────────────────────────────────────────

  it('inserts new suppression + cascades skip + emits audit in same tx', async () => {
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing → empty
      .mockResolvedValueOnce({ rows: [{ id: 2804 }] }) // INSERT outreach_suppressions
      .mockResolvedValueOnce({
        rows: [
          { id: 9001, campaign_id: 457 },
          { id: 9002, campaign_id: 457 },
          { id: 9003, campaign_id: 460 },
        ],
      }) // UPDATE campaign_contacts RETURNING
      .mockResolvedValueOnce({ rows: [{ id: 62450 }] }) // INSERT operator_audit_log
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({
        domain: 'tiscali.cz',
        reason: 'tiscali_systemic_bounce_2026-05-15',
        confirm: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.suppression_id).toBe(2804)
    expect(res.body.contacts_skipped).toBe(3)
    expect(res.body.audit_log_id).toBe(62450)
    expect(res.body.campaigns_affected).toEqual([
      { campaign_id: 457, count: 2 },
      { campaign_id: 460, count: 1 },
    ])

    const sqlCalls = client.query.mock.calls.map((c) => c[0])
    // Ordering: BEGIN, SELECT outreach_suppressions, INSERT outreach_suppressions, UPDATE campaign_contacts, INSERT audit, COMMIT
    expect(sqlCalls[0]).toBe('BEGIN')
    expect(sqlCalls[1]).toMatch(/SELECT id FROM outreach_suppressions/i)
    expect(sqlCalls[2]).toMatch(/INSERT INTO outreach_suppressions/i)
    expect(sqlCalls[3]).toMatch(/UPDATE campaign_contacts/i)
    expect(sqlCalls[3]).toMatch(/c\.email ILIKE/i)
    expect(sqlCalls[4]).toMatch(/INSERT INTO operator_audit_log/i)
    expect(sqlCalls[4]).toMatch(/domain_suppress_global/)
    expect(sqlCalls[5]).toBe('COMMIT')
  })

  it('reuses existing suppression row without re-inserting', async () => {
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 2804 }] }) // SELECT existing → found
      // NB: no INSERT outreach_suppressions
      .mockResolvedValueOnce({ rows: [{ id: 9001, campaign_id: 457 }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 62450 }] }) // INSERT audit
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({
        domain: 'tiscali.cz',
        reason: 'tiscali_systemic_bounce_2026-05-15',
        confirm: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.already_suppressed).toBe(true)
    expect(res.body.suppression_id).toBe(2804)
    const sqlCalls = client.query.mock.calls.map((c) => c[0])
    // No INSERT into outreach_suppressions should appear.
    expect(sqlCalls.some((s) => /INSERT INTO outreach_suppressions/i.test(s))).toBe(false)
    expect(sqlCalls[sqlCalls.length - 1]).toBe('COMMIT')
  })

  it('zero matches still commits + audits the suppression insert', async () => {
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing → empty
      .mockResolvedValueOnce({ rows: [{ id: 9999 }] }) // INSERT outreach_suppressions
      .mockResolvedValueOnce({ rows: [] }) // UPDATE 0 rows
      .mockResolvedValueOnce({ rows: [{ id: 62451 }] }) // INSERT audit
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({
        domain: 'no-match.cz',
        reason: 'preemptive_blocklist_addition',
        confirm: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.contacts_skipped).toBe(0)
    expect(res.body.audit_log_id).toBe(62451)
    expect(res.body.campaigns_affected).toEqual([])
  })

  it('rolls back + releases client on DB error', async () => {
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [{ id: 2804 }] }) // INSERT outreach_suppressions
      .mockRejectedValueOnce(new Error('update failed'))
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({
        domain: 'tiscali.cz',
        reason: 'tiscali_systemic_bounce_2026-05-15',
        confirm: true,
      })
    expect(res.status).toBe(500)
    expect(client.query.mock.calls.some((c) => c[0] === 'ROLLBACK')).toBe(true)
    expect(client.release).toHaveBeenCalled()
  })

  it('normalizes domain (lowercase + trim) before SQL', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // dry-run impact
      .mockResolvedValueOnce({ rows: [] }) // dry-run existing
    const app = await makeApp(pool)
    const res = await request(app)
      .post('/api/suppressions/domain?dry_run=true')
      .send({
        domain: '  Tiscali.CZ ',
        reason: 'tiscali_systemic_bounce_2026-05-15',
      })
    expect(res.status).toBe(200)
    expect(res.body.domain).toBe('tiscali.cz')
    // The ILIKE pattern in the dry-run SQL should use the normalized domain.
    const params = pool.query.mock.calls[0][1]
    expect(params).toContain('%@tiscali.cz')
  })

  it('audit_log details payload omits PII (only counts + breakdown)', async () => {
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [{ id: 2804 }] }) // INSERT outreach_suppressions
      .mockResolvedValueOnce({
        rows: [{ id: 9001, campaign_id: 457 }],
      }) // UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 62450 }] }) // INSERT audit
      .mockResolvedValueOnce({}) // COMMIT
    const app = await makeApp(pool)
    await request(app)
      .post('/api/suppressions/domain')
      .set('X-Confirm-Send', 'yes')
      .send({
        domain: 'tiscali.cz',
        reason: 'tiscali_systemic_bounce_2026-05-15',
        confirm: true,
      })
    const auditCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && /INSERT INTO operator_audit_log/i.test(c[0]),
    )
    expect(auditCall).toBeTruthy()
    // params[2] is the JSON details payload.
    const details = JSON.parse(auditCall[1][2])
    expect(details.domain).toBe('tiscali.cz')
    expect(details.contacts_skipped).toBe(1)
    expect(details.campaigns_affected).toEqual([{ campaign_id: 457, count: 1 }])
    // No email fields should be present in the audit payload.
    expect(JSON.stringify(details)).not.toMatch(/@/)
  })
})
