import { describe, it, expect } from 'vitest'
import { decideAuctionOutcome } from '~/server/repos/itemRepo'

describe('decideAuctionOutcome', () => {
  it('declares the highest bidder the winner above the reserve', () => {
    expect(decideAuctionOutcome({ userId: 'u1', amount: 5000 }, 4000)).toEqual({ sold: true, winnerUserId: 'u1' })
  })

  it('sells when the bid exactly meets the reserve', () => {
    expect(decideAuctionOutcome({ userId: 'u1', amount: 4000 }, 4000)).toEqual({ sold: true, winnerUserId: 'u1' })
  })

  it('sells for any bid when there is no reserve', () => {
    expect(decideAuctionOutcome({ userId: 'u1', amount: 1 }, null)).toEqual({ sold: true, winnerUserId: 'u1' })
  })

  it('does not sell below the reserve', () => {
    expect(decideAuctionOutcome({ userId: 'u1', amount: 3999 }, 4000)).toEqual({ sold: false, winnerUserId: null })
  })

  it('does not sell with no bids (with or without a reserve)', () => {
    expect(decideAuctionOutcome(null, 4000)).toEqual({ sold: false, winnerUserId: null })
    expect(decideAuctionOutcome(null, null)).toEqual({ sold: false, winnerUserId: null })
  })
})
