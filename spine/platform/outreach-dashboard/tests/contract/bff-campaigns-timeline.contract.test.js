// bff-campaigns-timeline.contract.test.js — Sprint L3 (#1288)
//
// Contract tests for GET /api/campaigns/:id/timeline
//
// Coverage areas:
//   1.  Invalid campaign id (non-numeric) → 400
//   2.  Invalid campaign id (zero) → 400
//   3.  Negative id → 400
//   4.  Limit capped at 50
//   5.  Offset default (0) when not supplied
//   6.  Empty campaign (no sends, no skipped) → empty contacts array
//   7.  Happy path: 1 contact with sent + reply events
//   8.  Events sorted chronologically per contact
//   9.  reply_received carries classification field
//  10.  sequence_skipped carries reason from details JSONB
//  11.  thread_closed event included when outreach_threads status='closed'
//  12.  PII guard: slog/console call uses contact_id only (no email in query param)
//  13.  Multiple contacts ordered by most recent activity (desc)
//  14.  Contact with ONLY skipped status (no sends) is included
//  15+. DB error → 500

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const { mountCampaignTimelineRoutes } = await import(
    '../../src/server-routes/campaignTimeline.js'
  )
  mountCampaignTimelineRoutes(app, { pool: poolMock })
  return app
}

/**
 * Build a pool mock that returns given row arrays in sequence for pool.query calls.
 *
 * Each call to pool.query consumes the next item from `responses`.
 * An item can be:
 *   - an array of row objects  → returned as { rows }
 *   - an Error instance        → thrown
 */
function makePool(responses = []) {
  let idx = 0
  return {
    query: vi.fn(async () => {
      const resp = responses[idx++]
      if (!resp) return { rows: [] }
      if (resp instanceof Error) throw resp
      return { rows: resp }
    }),
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const NOW      = new Date('2026-05-12T10:00:00Z').toISOString()
const EARLIER  = new Date('2026-05-11T08:00:00Z').toISOString()
const REPLY_AT = new Date('2026-05-12T11:30:00Z').toISOString()
const CLOSE_AT = new Date('2026-05-12T12:00:00Z').toISOString()

// Empty sub-queries (replies, threads, skipped) — used for "nothing extra" cases.
const NO_REPLIES  = []
const NO_THREADS  = []
const NO_SKIPPED  = []

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/campaigns/:id/timeline', () => {

  // ── validation ────────────────────────────────────────────────────────────

  it('1. rejects non-numeric id with 400', async () => {
    const pool = makePool()
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/abc/timeline')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid campaign id')
  })

  it('2. rejects zero id with 400', async () => {
    const pool = makePool()
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/0/timeline')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid campaign id')
  })

  it('3. rejects negative id with 400', async () => {
    const pool = makePool()
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/-5/timeline')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid campaign id')
  })

  // ── paging ────────────────────────────────────────────────────────────────

  it('4. limit is capped at 50 when caller passes limit=999', async () => {
    const pool = makePool([
      // contacts query → empty
      [],
    ])
    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/1/timeline?limit=999')
    expect(res.status).toBe(200)
    // Pool was called with limit param = 50 (capped)
    const firstCall = pool.query.mock.calls[0]
    expect(firstCall[1][1]).toBe(50)
  })

  it('5. offset defaults to 0 when not supplied', async () => {
    const pool = makePool([[]])
    const app  = await makeApp(pool)
    await request(app).get('/api/campaigns/1/timeline')
    const firstCall = pool.query.mock.calls[0]
    expect(firstCall[1][2]).toBe(0)
  })

  // ── empty campaign ────────────────────────────────────────────────────────

  it('6. returns empty contacts for a campaign with no activity', async () => {
    const pool = makePool([[]])
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/42/timeline')
    expect(res.status).toBe(200)
    expect(res.body.contacts).toEqual([])
    expect(res.body.total_contacts).toBe(0)
  })

  // ── happy path ────────────────────────────────────────────────────────────

  it('7. happy path: 1 contact with sent + reply events', async () => {
    const contactRow = {
      contact_id: 100,
      email: 'buyer@firma.cz',
      first_name: 'Jan',
      last_name: 'Novák',
      last_event_at: REPLY_AT,
    }
    const sendRow = {
      contact_id: 100,
      send_event_id: 1,
      step: 0,
      template: 'Bagrista_seq1',
      status: 'replied',
      ts: NOW,
    }
    const replyRow = {
      contact_id: 100,
      send_event_id: 1,
      classification: 'positive',
      ts: REPLY_AT,
    }

    const pool = makePool([
      [contactRow],     // contacts query (paginated)
      [{ total: 1 }],   // COUNT(*) total_contacts query (full distinct set)
      [sendRow],        // sends query
      [replyRow],       // replies query
      NO_THREADS,       // threads query
      NO_SKIPPED,       // skipped query
    ])
    const app = await makeApp(pool)
    const res = await request(app).get('/api/campaigns/457/timeline')

    expect(res.status).toBe(200)
    expect(res.body.contacts).toHaveLength(1)
    expect(res.body.total_contacts).toBe(1)

    const c = res.body.contacts[0]
    expect(c.contact_id).toBe(100)
    expect(c.email).toBe('buyer@firma.cz')
    expect(c.first_name).toBe('Jan')
    expect(c.last_name).toBe('Novák')
    expect(c.events).toHaveLength(2)

    const sentEv  = c.events.find(e => e.type === 'sent')
    const replyEv = c.events.find(e => e.type === 'reply_received')
    expect(sentEv).toBeDefined()
    expect(replyEv).toBeDefined()
    expect(sentEv.step).toBe(0)
    expect(sentEv.template).toBe('Bagrista_seq1')
  })

  // ── chronological ordering ────────────────────────────────────────────────

  it('8. events within a contact are sorted chronologically', async () => {
    const contact = { contact_id: 10, email: 'x@y.cz', first_name: null, last_name: null, last_event_at: REPLY_AT }
    const sendRow  = { contact_id: 10, send_event_id: 1, step: 0, template: 'T1', status: 'sent', ts: EARLIER }
    const replyRow = { contact_id: 10, send_event_id: 1, classification: 'negative', ts: REPLY_AT }

    const pool = makePool([[contact], [{ total: 1 }], [sendRow], [replyRow], NO_THREADS, NO_SKIPPED])
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/1/timeline')

    expect(res.body.total_contacts).toBe(1)
    const evs = res.body.contacts[0].events
    expect(evs[0].type).toBe('sent')
    expect(evs[1].type).toBe('reply_received')
    expect(new Date(evs[0].timestamp) < new Date(evs[1].timestamp)).toBe(true)
  })

  // ── classification badge ───────────────────────────────────────────────────

  it('9. reply_received carries classification from reply_inbox', async () => {
    const contact  = { contact_id: 20, email: 'a@b.cz', first_name: null, last_name: null, last_event_at: REPLY_AT }
    const sendRow  = { contact_id: 20, send_event_id: 2, step: 1, template: null, status: 'replied', ts: EARLIER }
    const replyRow = { contact_id: 20, send_event_id: 2, classification: 'question', ts: REPLY_AT }

    const pool = makePool([[contact], [{ total: 1 }], [sendRow], [replyRow], NO_THREADS, NO_SKIPPED])
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/1/timeline')

    const replyEv = res.body.contacts[0].events.find(e => e.type === 'reply_received')
    expect(replyEv.classification).toBe('question')
  })

  // ── skipped reason ────────────────────────────────────────────────────────

  it('10. sequence_skipped carries reason from details JSONB', async () => {
    const contact    = { contact_id: 30, email: 's@skip.cz', first_name: null, last_name: null, last_event_at: NOW }
    const skippedRow = { contact_id: 30, reason: 'per_domain_cooldown', ts: NOW }

    const pool = makePool([[contact], [{ total: 1 }], [], [], NO_THREADS, [skippedRow]])
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/1/timeline')

    const skipEv = res.body.contacts[0].events.find(e => e.type === 'sequence_skipped')
    expect(skipEv).toBeDefined()
    expect(skipEv.reason).toBe('per_domain_cooldown')
  })

  // ── thread_closed ─────────────────────────────────────────────────────────

  it('11. thread_closed event appears when outreach_threads has status=closed', async () => {
    const contact    = { contact_id: 40, email: 't@thread.cz', first_name: null, last_name: null, last_event_at: CLOSE_AT }
    const sendRow    = { contact_id: 40, send_event_id: 5, step: 0, template: null, status: 'replied', ts: EARLIER }
    const replyRow   = { contact_id: 40, send_event_id: 5, classification: 'positive', ts: REPLY_AT }
    const threadRow  = { contact_id: 40, ts: CLOSE_AT }

    const pool = makePool([[contact], [{ total: 1 }], [sendRow], [replyRow], [threadRow], NO_SKIPPED])
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/1/timeline')

    const closeEv = res.body.contacts[0].events.find(e => e.type === 'thread_closed')
    expect(closeEv).toBeDefined()
    expect(closeEv.timestamp).toBe(new Date(CLOSE_AT).toISOString())
  })

  // ── PII guard ─────────────────────────────────────────────────────────────

  it('12. no email address leaked into pool.query params (PII guard)', async () => {
    const contact = { contact_id: 50, email: 'secret@pii.cz', first_name: 'X', last_name: null, last_event_at: NOW }
    const pool    = makePool([[contact], [], [], NO_THREADS, NO_SKIPPED])
    const app     = await makeApp(pool)
    await request(app).get('/api/campaigns/1/timeline')

    // None of the query param arrays should contain an email string
    for (const call of pool.query.mock.calls) {
      const params = call[1] || []
      for (const p of params) {
        if (typeof p === 'string') {
          expect(p).not.toContain('@pii.cz')
        }
      }
    }
  })

  // ── multiple contacts ordering ────────────────────────────────────────────

  it('13. contacts ordered by most recent activity desc (DB responsibility)', async () => {
    // The ordering is done in SQL; the BFF should preserve DB row order.
    const c1 = { contact_id: 1, email: 'first@x.cz',  first_name: null, last_name: null, last_event_at: REPLY_AT  }
    const c2 = { contact_id: 2, email: 'second@x.cz', first_name: null, last_name: null, last_event_at: EARLIER }

    // total_contacts is now a separate COUNT(*) over the full distinct-contact
    // set — independent of the page. Here 25 total though only 2 are on this page.
    const pool = makePool([[c1, c2], [{ total: 25 }], [], [], NO_THREADS, NO_SKIPPED])
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/1/timeline')

    expect(res.body.contacts[0].contact_id).toBe(1)
    expect(res.body.contacts[1].contact_id).toBe(2)
    // true count comes from COUNT(*), NOT contacts.length (page size)
    expect(res.body.contacts).toHaveLength(2)
    expect(res.body.total_contacts).toBe(25)
  })

  // ── skipped-only contact ──────────────────────────────────────────────────

  it('14. contact with ONLY skipped status (no sends) is included', async () => {
    const contact    = { contact_id: 60, email: 'skipped@only.cz', first_name: null, last_name: null, last_event_at: NOW }
    const skippedRow = { contact_id: 60, reason: 'suppressed', ts: NOW }

    const pool = makePool([[contact], [{ total: 1 }], [], [], NO_THREADS, [skippedRow]])
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/1/timeline')

    expect(res.body.contacts).toHaveLength(1)
    expect(res.body.contacts[0].contact_id).toBe(60)
    const skipEv = res.body.contacts[0].events.find(e => e.type === 'sequence_skipped')
    expect(skipEv).toBeDefined()
  })

  // ── DB error ──────────────────────────────────────────────────────────────

  it('15. returns 500 when pool.query throws', async () => {
    const pool = makePool([new Error('DB connection lost')])
    const app  = await makeApp(pool)
    const res  = await request(app).get('/api/campaigns/1/timeline')
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('internal server error')
  })

  // ── response shape ────────────────────────────────────────────────────────

  it('16. response includes limit, offset, total_contacts fields', async () => {
    const contact = { contact_id: 70, email: 'shape@test.cz', first_name: null, last_name: null, last_event_at: NOW }
    const pool    = makePool([[contact], [], [], NO_THREADS, NO_SKIPPED])
    const app     = await makeApp(pool)
    const res     = await request(app).get('/api/campaigns/1/timeline?limit=10&offset=0')
    expect(res.body.limit).toBe(10)
    expect(res.body.offset).toBe(0)
    expect(typeof res.body.total_contacts).toBe('number')
  })

})
