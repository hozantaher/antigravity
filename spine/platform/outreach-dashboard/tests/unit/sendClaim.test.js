// sendClaim.test.js — Node twin of the exactly-once send-claim layer
// (migration 171). Mirrors features/outreach/campaigns/sender/sendclaim_test.go: decision
// mapping, fail-safe on unexpected/empty outcome, param passing, and the
// confirm / release / bulk-expire helpers. Uses a hand-rolled fake db (the
// helpers only need a .query(sql, params) → {rows, rowCount}).

import { describe, it, expect } from 'vitest'
import {
  acquireClaim,
  confirmClaim,
  releaseClaim,
  expireClaimsForContacts,
  CLAIM_PROCEED,
  CLAIM_ALREADY_SENT,
  CLAIM_IN_FLIGHT_ELSEWHERE,
  CLAIMED_BY_NODE_BATCH,
} from '../../src/lib/sendClaim.js'

function fakeDb(response) {
  const calls = []
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params })
      return response || { rows: [], rowCount: 0 }
    },
  }
}

describe('acquireClaim — outcome → decision mapping', () => {
  const cases = [
    ['acquired', CLAIM_PROCEED],
    ['sent', CLAIM_ALREADY_SENT],
    ['claiming', CLAIM_IN_FLIGHT_ELSEWHERE],
    ['weird_future_status', CLAIM_IN_FLIGHT_ELSEWHERE], // fail-safe
  ]
  for (const [outcome, want] of cases) {
    it(`outcome="${outcome}" → ${want}`, async () => {
      const db = fakeDb({ rows: [{ outcome }] })
      expect(await acquireClaim(db, 7, 42, 0)).toBe(want)
    })
  }

  it('empty result set fails safe to in-flight (never proceed)', async () => {
    const db = fakeDb({ rows: [] })
    expect(await acquireClaim(db, 7, 42, 0)).toBe(CLAIM_IN_FLIGHT_ELSEWHERE)
  })

  it('passes [campaignId, contactId, step, claimedBy] and runs the claim CTE', async () => {
    const db = fakeDb({ rows: [{ outcome: 'acquired' }] })
    await acquireClaim(db, 11, 22, 3, CLAIMED_BY_NODE_BATCH)
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql).toContain('INSERT INTO send_claims')
    expect(db.calls[0].sql).toContain('ON CONFLICT')
    expect(db.calls[0].params).toEqual([11, 22, 3, CLAIMED_BY_NODE_BATCH])
  })

  it('defaults claimedBy to node_batch', async () => {
    const db = fakeDb({ rows: [{ outcome: 'acquired' }] })
    await acquireClaim(db, 1, 2, 0)
    expect(db.calls[0].params[3]).toBe(CLAIMED_BY_NODE_BATCH)
  })
})

describe('confirmClaim', () => {
  it('returns rowCount and passes the envelope id', async () => {
    const db = fakeDb({ rowCount: 1 })
    const n = await confirmClaim(db, 7, 42, 0, 'env-123')
    expect(n).toBe(1)
    expect(db.calls[0].sql).toContain("status       = 'sent'")
    expect(db.calls[0].params).toEqual([7, 42, 0, 'env-123'])
  })

  it('maps an empty envelope id to null', async () => {
    const db = fakeDb({ rowCount: 1 })
    await confirmClaim(db, 7, 42, 0, '')
    expect(db.calls[0].params[3]).toBeNull()
  })

  it('returns 0 on idempotent no-op (already sent)', async () => {
    const db = fakeDb({ rowCount: 0 })
    expect(await confirmClaim(db, 7, 42, 0, 'e')).toBe(0)
  })
})

describe('releaseClaim', () => {
  it('flips claiming -> failed and returns rowCount', async () => {
    const db = fakeDb({ rowCount: 1 })
    const n = await releaseClaim(db, 7, 42, 0)
    expect(n).toBe(1)
    expect(db.calls[0].sql).toContain("status     = 'failed'")
    expect(db.calls[0].params).toEqual([7, 42, 0])
  })
})

describe('expireClaimsForContacts', () => {
  it('returns 0 and runs NO query for an empty list', async () => {
    const db = fakeDb({ rowCount: 9 })
    expect(await expireClaimsForContacts(db, [])).toBe(0)
    expect(db.calls).toHaveLength(0)
  })

  it('returns 0 for null input', async () => {
    const db = fakeDb({ rowCount: 9 })
    expect(await expireClaimsForContacts(db, null)).toBe(0)
    expect(db.calls).toHaveLength(0)
  })

  it('unnests campaign_id[] and contact_id[] from the reclaimed rows', async () => {
    const db = fakeDb({ rowCount: 2 })
    const n = await expireClaimsForContacts(db, [
      { campaign_id: 1, contact_id: 10 },
      { campaign_id: 1, contact_id: 11 },
    ])
    expect(n).toBe(2)
    expect(db.calls[0].sql).toContain('unnest')
    expect(db.calls[0].params).toEqual([[1, 1], [10, 11]])
  })
})
