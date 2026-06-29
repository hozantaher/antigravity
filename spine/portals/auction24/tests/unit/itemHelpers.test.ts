import { describe, it, expect } from 'vitest'
import type { Item } from '~/models'
import { ItemType, ItemStatus, itemStatus, itemCurrentPrice, isAuctionLive, defaultSort } from '~/models'

const HOUR = 3600_000
const now = Date.now()

const mk = (over: Partial<Item> = {}): Item => ({
  id: 'i',
  title: 't',
  image: '',
  images: [],
  images360: [],
  description: {},
  highlights: {},
  priceFrom: { amount: 1000 },
  categoryId: 'car',
  userId: 'u1',
  bids: [],
  priceHighlighted: false,
  taxIncluded: false,
  sold: false,
  closed: false,
  hidden: false,
  type: ItemType.auction,
  visibleUpdated: now,
  ...over,
})

describe('itemCurrentPrice', () => {
  it('returns priceFrom when there are no bids', () => {
    expect(itemCurrentPrice(mk())?.amount).toBe(1000)
  })
  it('returns the last (highest) bid when bids exist', () => {
    const item = mk({
      bids: [
        { userId: 'a', date: now - HOUR, amount: 1100 },
        { userId: 'b', date: now, amount: 1200 },
      ],
    })
    expect(itemCurrentPrice(item)?.amount).toBe(1200)
  })
})

describe('isAuctionLive / itemStatus', () => {
  it('detects a live auction', () => {
    const item = mk({ startDate: now - HOUR, endDate: now + HOUR })
    expect(isAuctionLive(item)).toBe(true)
    expect(itemStatus(item)).toBe(ItemStatus.AuctionLive)
  })
  it('classifies an ad as BuyNow', () => {
    expect(itemStatus(mk({ type: ItemType.ad }))).toBe(ItemStatus.BuyNow)
  })
  it('classifies a sold item as Sold regardless of type', () => {
    expect(itemStatus(mk({ sold: true }))).toBe(ItemStatus.Sold)
  })
  it('classifies an ended-but-not-closed auction as AuctionProcessing', () => {
    const item = mk({ startDate: now - 2 * HOUR, endDate: now - HOUR, closed: false })
    expect(itemStatus(item)).toBe(ItemStatus.AuctionProcessing)
  })
  it('classifies a future auction as AuctionSoon', () => {
    expect(itemStatus(mk({ startDate: now + HOUR, endDate: now + 2 * HOUR }))).toBe(ItemStatus.AuctionSoon)
  })
})

describe('defaultSort', () => {
  it('orders live auctions ahead of ads', () => {
    const live = mk({ id: 'live', startDate: now - HOUR, endDate: now + HOUR })
    const ad = mk({ id: 'ad', type: ItemType.ad })
    expect(defaultSort(live, ad)).toBeLessThan(0)
    expect([ad, live].sort(defaultSort)[0]!.id).toBe('live')
  })
  it('orders live auctions by soonest end first', () => {
    const soon = mk({ id: 'soon', startDate: now - HOUR, endDate: now + HOUR })
    const later = mk({ id: 'later', startDate: now - HOUR, endDate: now + 5 * HOUR })
    expect([later, soon].sort(defaultSort)[0]!.id).toBe('soon')
  })
})
