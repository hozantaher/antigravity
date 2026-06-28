// bff-campaign-contact-reset.contract.test.js — #1403
// PATCH /api/campaigns/:id/contacts/:contact_id/reset-next-send — per-contact
// reschedule (next_send_at = NOW()), gated by X-Confirm-Send + audit-logged.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(pool) {
  const app = express()
  app.use(express.json())
  const { mountCampaignsRoutes } = await import('../../src/server-routes/campaigns.js')
  mountCampaignsRoutes(app, { pool, capture500: (res, e) => res.status(500).json({ error: e.message }), safeError: (e) => e, setRouteTags: () => {}, Sentry: { captureException: () => {} } })
  return app
}

describe('PATCH /api/campaigns/:id/contacts/:contact_id/reset-next-send', () => {
  let pool
  beforeEach(() => { pool = { query: vi.fn() } })

  it('400 without X-Confirm-Send (send-adjacent guard)', async () => {
    const res = await request(await makeApp(pool)).patch('/api/campaigns/457/contacts/12/reset-next-send')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('missing_confirmation')
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('400 on non-numeric ids', async () => {
    const res = await request(await makeApp(pool)).patch('/api/campaigns/abc/contacts/x/reset-next-send').set('X-Confirm-Send', 'yes')
    expect(res.status).toBe(400)
  })

  it('404 when the campaign_contact does not exist', async () => {
    pool.query = vi.fn().mockResolvedValue({ rows: [] })
    const res = await request(await makeApp(pool)).patch('/api/campaigns/457/contacts/999/reset-next-send').set('X-Confirm-Send', 'yes')
    expect(res.status).toBe(404)
  })

  it('resets next_send_at + audit-logs on success', async () => {
    pool.query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ contact_id: 12, status: 'pending', next_send_at: '2026-06-01T18:00:00Z' }] }) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] }) // audit insert
    const res = await request(await makeApp(pool)).patch('/api/campaigns/457/contacts/12/reset-next-send').set('X-Confirm-Send', 'yes')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, campaign_id: 457, contact_id: 12, status: 'pending' })
    expect(pool.query.mock.calls[0][0]).toMatch(/UPDATE campaign_contacts/)
    expect(pool.query.mock.calls[0][1]).toEqual([457, 12])
    expect(pool.query.mock.calls[1][0]).toMatch(/operator_audit_log/)
  })
})
