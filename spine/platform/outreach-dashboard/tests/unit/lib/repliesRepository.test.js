// repliesRepository.test.js — quality-sweep "unit" dimension (2026-05-30)
//
// The repository is the single source of truth for the signed-ID routing
// between reply_inbox (positive ID) and unmatched_inbound (negative ID).
// It carried zero unit coverage despite being the dual-table contract that
// every /api/replies/:id handler depends on. Per feedback_extreme_testing
// this is state-mutating data access → boundary + error + both-table paths.

import { describe, it, expect, vi } from 'vitest'
import {
  classifyReplyId,
  findById,
  setHandled,
  setClassification,
} from '../../../src/lib/repliesRepository.js'

describe('classifyReplyId (pure ID routing)', () => {
  it('positive ID → reply_inbox with same physical id', () => {
    expect(classifyReplyId(42)).toEqual({ source: 'reply_inbox', physicalId: 42 })
  })

  it('negative ID → unmatched_inbound with absolute physical id', () => {
    expect(classifyReplyId(-7)).toEqual({ source: 'unmatched_inbound', physicalId: 7 })
  })

  it('numeric string is coerced', () => {
    expect(classifyReplyId('15')).toEqual({ source: 'reply_inbox', physicalId: 15 })
    expect(classifyReplyId('-15')).toEqual({ source: 'unmatched_inbound', physicalId: 15 })
  })

  it('zero is rejected (no row 0 in either table)', () => {
    expect(classifyReplyId(0)).toBeNull()
    expect(classifyReplyId('0')).toBeNull()
  })

  it('non-finite / garbage input → null', () => {
    expect(classifyReplyId('null')).toBeNull()
    expect(classifyReplyId('abc')).toBeNull()
    expect(classifyReplyId(NaN)).toBeNull()
    expect(classifyReplyId(undefined)).toBeNull()
  })
})

// Minimal pg.Pool stub: records the query + returns whatever rows the test
// queued. Keeps the SQL opaque (the test asserts behavior, not text).
function mockPool(result) {
  const query = vi.fn(() => Promise.resolve(result))
  return { query }
}

describe('findById', () => {
  it('returns null for an invalid id without touching the DB', async () => {
    const pool = mockPool({ rows: [] })
    expect(await findById(pool, 0)).toBeNull()
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('reply_inbox row maps to the unified shape (positive id preserved)', async () => {
    const pool = mockPool({
      rows: [{
        id: 5, from_email: 'a@b.cz', subject: 'Re: x', body_preview: 'hi',
        body_html: '<p>hi</p>', received_at: '2026-05-30T00:00:00Z',
        handled: false, handled_at: null, classification: 'positive',
        message_id: '<m1>', in_reply_to: '<m0>', contact_id: 9,
        campaign_id: 3, send_event_id: 11,
      }],
    })
    const out = await findById(pool, 5)
    expect(out).toMatchObject({
      id: 5, source: 'reply_inbox', from_email: 'a@b.cz',
      classification: 'positive', campaign_id: 3, send_event_id: 11,
    })
  })

  it('unmatched_inbound row maps from_address→from_email + negative id', async () => {
    const pool = mockPool({
      rows: [{
        id: 8, from_address: 'orphan@x.cz', subject: 'Re: y',
        body_preview: 'orphan', message_id: '<u1>', in_reply_to: null,
        received_at: '2026-05-30T00:00:00Z', reviewed: true,
        reviewed_at: '2026-05-30T01:00:00Z',
      }],
    })
    const out = await findById(pool, -8)
    expect(out).toMatchObject({
      id: -8, source: 'unmatched_inbound', from_email: 'orphan@x.cz',
      handled: true, classification: null, campaign_id: null,
      body_html: null,
    })
  })

  it('returns null when the row does not exist', async () => {
    expect(await findById(mockPool({ rows: [] }), 999)).toBeNull()
    expect(await findById(mockPool({ rows: [] }), -999)).toBeNull()
  })
})

describe('setHandled', () => {
  it('invalid id → {ok:false, error:invalid_id}', async () => {
    const pool = mockPool({ rowCount: 0 })
    expect(await setHandled(pool, 0, true)).toEqual({ ok: false, error: 'invalid_id' })
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('reply_inbox update success', async () => {
    const pool = mockPool({ rowCount: 1 })
    expect(await setHandled(pool, 12, true)).toEqual({ ok: true, source: 'reply_inbox', physicalId: 12 })
  })

  it('unmatched_inbound update success', async () => {
    const pool = mockPool({ rowCount: 1 })
    expect(await setHandled(pool, -12, false)).toEqual({ ok: true, source: 'unmatched_inbound', physicalId: 12 })
  })

  it('no row affected → not_found', async () => {
    expect(await setHandled(mockPool({ rowCount: 0 }), 12, true)).toEqual({ ok: false, error: 'not_found' })
  })
})

describe('setClassification', () => {
  it('invalid id → {ok:false, error:invalid_id}', async () => {
    expect(await setClassification(mockPool({ rows: [] }), 0, 'positive'))
      .toEqual({ ok: false, error: 'invalid_id' })
  })

  it('reply_inbox: captures previous classification + returns from_email', async () => {
    // First query = previous-classification SELECT, second = UPDATE RETURNING.
    const pool = { query: vi.fn() }
    pool.query
      .mockResolvedValueOnce({ rows: [{ classification: 'auto_reply' }] })
      .mockResolvedValueOnce({ rows: [{ id: 4, from_email: 'a@b.cz', classification: 'positive', handled: true }] })
    const out = await setClassification(pool, 4, 'positive')
    expect(out).toMatchObject({ ok: true, source: 'reply_inbox', from_email: 'a@b.cz', was_previous: 'auto_reply' })
  })

  it('reply_inbox not found → not_found', async () => {
    const pool = { query: vi.fn() }
    pool.query
      .mockResolvedValueOnce({ rows: [{ classification: null }] })
      .mockResolvedValueOnce({ rows: [] })
    expect(await setClassification(pool, 4, 'positive')).toEqual({ ok: false, error: 'not_found' })
  })

  it('unmatched_inbound: marks reviewed + returns from_address as from_email, was_previous null', async () => {
    const pool = mockPool({ rows: [{ id: 9, from_address: 'orphan@x.cz', subject: 'Re: y' }] })
    const out = await setClassification(pool, -9, 'negative')
    expect(out).toMatchObject({ ok: true, source: 'unmatched_inbound', from_email: 'orphan@x.cz', was_previous: null })
  })
})
