// replies-repository.test.js — Sprint B1 (issue #1247)
//
// Unit tests for src/lib/repliesRepository.js. Uses a hand-rolled mock pool
// since these tests don't depend on real SQL execution semantics — they
// verify routing logic (which table gets queried for which ID).

import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyReplyId,
  findById,
  setHandled,
  setClassification,
} from '../../src/lib/repliesRepository.js'

function makeMockPool(handler) {
  const calls = []
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), args })
      return handler(sql, args) || { rows: [], rowCount: 0 }
    },
  }
}

describe('classifyReplyId', () => {
  it('positive numeric → reply_inbox', () => {
    expect(classifyReplyId(42)).toEqual({ source: 'reply_inbox', physicalId: 42 })
  })
  it('numeric string positive → reply_inbox', () => {
    expect(classifyReplyId('42')).toEqual({ source: 'reply_inbox', physicalId: 42 })
  })
  it('negative numeric → unmatched_inbound with absolute id', () => {
    expect(classifyReplyId(-7)).toEqual({ source: 'unmatched_inbound', physicalId: 7 })
  })
  it('negative string → unmatched_inbound', () => {
    expect(classifyReplyId('-100')).toEqual({ source: 'unmatched_inbound', physicalId: 100 })
  })
  it('zero rejected', () => {
    expect(classifyReplyId(0)).toBeNull()
  })
  it('non-numeric rejected', () => {
    expect(classifyReplyId('abc')).toBeNull()
  })
  it('undefined rejected', () => {
    expect(classifyReplyId(undefined)).toBeNull()
  })
  it('NaN rejected', () => {
    expect(classifyReplyId(Number.NaN)).toBeNull()
  })
})

describe('findById — positive id (reply_inbox)', () => {
  it('returns unified shape with reply_inbox fields', async () => {
    const pool = makeMockPool((sql) => {
      if (/FROM reply_inbox/.test(sql)) {
        return { rows: [{
          id: 42, from_email: 'a@b.cz', subject: 'hi', body_preview: 'plain',
          body_html: '<p>hi</p>', received_at: '2026-05-12T16:00:00Z',
          handled: false, handled_at: null, classification: 'positive',
          message_id: '<x@y>', in_reply_to: '<a@b>', contact_id: 7,
          campaign_id: 3, send_event_id: 99,
        }] }
      }
      return null
    })
    const r = await findById(pool, 42)
    expect(r).not.toBeNull()
    expect(r.source).toBe('reply_inbox')
    expect(r.id).toBe(42)
    expect(r.body_html).toBe('<p>hi</p>')
    expect(r.classification).toBe('positive')
    expect(r.contact_id).toBe(7)
  })

  it('returns null when row missing', async () => {
    const pool = makeMockPool(() => ({ rows: [] }))
    expect(await findById(pool, 99999)).toBeNull()
  })

  it('rejects invalid id', async () => {
    const pool = makeMockPool(() => ({ rows: [] }))
    expect(await findById(pool, 'not-a-number')).toBeNull()
    expect(pool.calls).toHaveLength(0)
  })
})

describe('findById — negative id (unmatched_inbound)', () => {
  it('returns unified shape with body_html=null', async () => {
    const pool = makeMockPool((sql) => {
      if (/FROM unmatched_inbound/.test(sql)) {
        return { rows: [{
          id: 5, from_address: 'Display Name <x@y.cz>', subject: 'orphan',
          body_preview: 'body', message_id: '<m@z>', in_reply_to: '',
          received_at: '2026-05-12T16:00:00Z', reviewed: false, reviewed_at: null,
        }] }
      }
      return null
    })
    const r = await findById(pool, -5)
    expect(r).not.toBeNull()
    expect(r.source).toBe('unmatched_inbound')
    expect(r.id).toBe(-5)
    expect(r.from_email).toBe('Display Name <x@y.cz>')
    expect(r.body_html).toBeNull()
    expect(r.classification).toBeNull()
    expect(r.contact_id).toBeNull()
    expect(r.campaign_id).toBeNull()
    expect(r.handled).toBe(false)
  })
})

describe('setHandled', () => {
  it('routes positive id to reply_inbox UPDATE', async () => {
    const pool = makeMockPool((sql) => {
      if (/UPDATE reply_inbox/.test(sql)) return { rowCount: 1 }
      return { rowCount: 0 }
    })
    const result = await setHandled(pool, 42, true)
    expect(result).toEqual({ ok: true, source: 'reply_inbox', physicalId: 42 })
    expect(pool.calls[0].sql).toMatch(/UPDATE reply_inbox/)
  })

  it('routes negative id to unmatched_inbound UPDATE', async () => {
    const pool = makeMockPool((sql) => {
      if (/UPDATE unmatched_inbound/.test(sql)) return { rowCount: 1 }
      return { rowCount: 0 }
    })
    const result = await setHandled(pool, -8, false)
    expect(result).toEqual({ ok: true, source: 'unmatched_inbound', physicalId: 8 })
    expect(pool.calls[0].sql).toMatch(/UPDATE unmatched_inbound/)
  })

  it('returns not_found when no row updated', async () => {
    const pool = makeMockPool(() => ({ rowCount: 0 }))
    expect(await setHandled(pool, 999, true)).toEqual({ ok: false, error: 'not_found' })
  })

  it('rejects invalid id without query', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1 }))
    expect(await setHandled(pool, 'bad', true)).toEqual({ ok: false, error: 'invalid_id' })
    expect(pool.calls).toHaveLength(0)
  })
})

describe('setClassification', () => {
  it('routes positive id with KT-B4 snapshot capture', async () => {
    let updateCalled = false
    const pool = makeMockPool((sql) => {
      if (/SELECT classification FROM reply_inbox/.test(sql)) {
        return { rows: [{ classification: 'positive' }] }
      }
      if (/UPDATE reply_inbox/.test(sql)) {
        updateCalled = true
        return { rows: [{
          id: 42, from_email: 'a@b.cz', contact_id: 1, campaign_id: 2,
          classification: 'negative', handled: true, handled_at: '2026-05-12T16:00:00Z',
        }] }
      }
      return null
    })
    const r = await setClassification(pool, 42, 'negative')
    expect(r.ok).toBe(true)
    expect(r.source).toBe('reply_inbox')
    expect(r.was_previous).toBe('positive')
    expect(r.from_email).toBe('a@b.cz')
    expect(updateCalled).toBe(true)
  })

  it('routes negative id to unmatched_inbound, returns was_previous=null', async () => {
    const pool = makeMockPool((sql) => {
      if (/UPDATE unmatched_inbound/.test(sql)) {
        return { rows: [{
          id: 5, from_address: 'orphan@x.cz', subject: 'Re: ahoj',
        }] }
      }
      return null
    })
    const r = await setClassification(pool, -5, 'unsubscribe')
    expect(r.ok).toBe(true)
    expect(r.source).toBe('unmatched_inbound')
    expect(r.was_previous).toBeNull()
    expect(r.from_email).toBe('orphan@x.cz')
  })

  it('returns not_found when row missing', async () => {
    const pool = makeMockPool(() => ({ rows: [] }))
    expect(await setClassification(pool, -99, 'negative')).toEqual({
      ok: false, error: 'not_found',
    })
  })
})
