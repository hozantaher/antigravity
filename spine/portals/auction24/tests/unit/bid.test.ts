import { describe, it, expect } from 'vitest'
import { isUserEligibleToBid } from '~/models'
import type { User } from '~/models'
import { bidError, type BidContext } from '~/server/repos/itemRepo'

const HOUR = 3600_000
const now = new Date('2025-06-01T12:00:00Z').getTime()

// A live auction with a current price of 1000 and a 100 minimum increment.
const ctx = (over: Partial<BidContext> = {}): BidContext => ({
  type: 'auction',
  sold: false,
  hidden: false,
  startMs: now - HOUR,
  endMs: now + HOUR,
  currentAmount: 1000,
  increment: 100,
  amount: 1100,
  nowMs: now,
  ...over,
})

describe('bidError', () => {
  it('accepts a bid exactly at current + increment', () => {
    expect(bidError(ctx({ amount: 1100 }))).toBeNull()
  })

  it('accepts a bid above the minimum', () => {
    expect(bidError(ctx({ amount: 5000 }))).toBeNull()
  })

  it('rejects a bid below current + increment (400)', () => {
    expect(bidError(ctx({ amount: 1099 }))?.status).toBe(400)
    expect(bidError(ctx({ amount: 1000 }))?.status).toBe(400)
    expect(bidError(ctx({ amount: 500 }))?.status).toBe(400)
  })

  it('rejects bidding on an ad', () => {
    expect(bidError(ctx({ type: 'ad' }))?.status).toBe(409)
  })

  it('rejects a sold or hidden item', () => {
    expect(bidError(ctx({ sold: true }))?.status).toBe(409)
    expect(bidError(ctx({ hidden: true }))?.status).toBe(409)
  })

  it('rejects an auction that has not started', () => {
    expect(bidError(ctx({ startMs: now + HOUR, endMs: now + 2 * HOUR }))?.status).toBe(409)
  })

  it('rejects an auction that has ended (including exactly at end)', () => {
    expect(bidError(ctx({ endMs: now - 1 }))?.status).toBe(409)
    expect(bidError(ctx({ endMs: now }))?.status).toBe(409)
  })

  it('rejects an auction with missing dates', () => {
    expect(bidError(ctx({ startMs: null }))?.status).toBe(409)
    expect(bidError(ctx({ endMs: null }))?.status).toBe(409)
  })

  it('still rejects a too-low bid placed in the last 3 minutes', () => {
    // soft-close territory but below the minimum — must be rejected, not extended
    expect(bidError(ctx({ endMs: now + 60_000, amount: 1000 }))?.status).toBe(400)
  })
})

const userLike = (over: Partial<User> = {}): User =>
  ({
    depositRequired: true,
    depositBalance: { amount: 0 },
    emailVerified: true,
    phone: '+420123456789',
    ...over,
  }) as User

describe('isUserEligibleToBid', () => {
  it('allows a verified user with phone and the required deposit', () => {
    expect(isUserEligibleToBid(userLike({ depositBalance: { amount: 500 } }))).toBe(true)
  })

  it('allows a verified user with phone when no deposit is required', () => {
    expect(isUserEligibleToBid(userLike({ depositRequired: false }))).toBe(true)
  })

  it('blocks a required-deposit user who has no deposit (no email/phone bypass)', () => {
    expect(isUserEligibleToBid(userLike({ depositBalance: { amount: 0 } }))).toBe(false)
  })

  it('blocks a user with a deposit but unverified email', () => {
    expect(isUserEligibleToBid(userLike({ depositBalance: { amount: 500 }, emailVerified: false }))).toBe(false)
  })

  it('blocks a user without a phone', () => {
    expect(isUserEligibleToBid(userLike({ depositRequired: false, phone: undefined }))).toBe(false)
  })
})
