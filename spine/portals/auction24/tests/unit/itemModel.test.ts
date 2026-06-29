import { describe, expect, it } from 'vitest'
import {
  contentLocaleKey,
  defaultSort,
  hasAuctionEnded,
  hasAuctionStarted,
  isAuctionLive,
  isMinPriceReached,
  ItemStatus,
  ItemType,
  itemCurrentPrice,
  itemStatus,
  type Item,
} from '~/models'

const NOW = Date.now()
const base = (over: Partial<Item> = {}): Item =>
  ({
    id: 'i',
    title: 't',
    image: '',
    images: [],
    images360: [],
    description: {},
    highlights: {},
    categoryId: 'car',
    userId: 'u',
    bids: [],
    priceHighlighted: false,
    taxIncluded: false,
    sold: false,
    closed: false,
    hidden: false,
    type: ItemType.auction,
    ...over,
  }) as Item

const live = (over: Partial<Item> = {}) => base({ startDate: NOW - 1000, endDate: NOW + 100_000, ...over })
const soon = (over: Partial<Item> = {}) => base({ startDate: NOW + 50_000, endDate: NOW + 100_000, ...over })

describe('hasAuctionStarted', () => {
  it('is false without dates', () => {
    expect(hasAuctionStarted(base())).toBe(false)
  })
  it('is true once startDate has passed', () => {
    expect(hasAuctionStarted(live())).toBe(true)
    expect(hasAuctionStarted(soon())).toBe(false)
  })
})

describe('itemCurrentPrice', () => {
  it('returns priceFrom when there are no bids', () => {
    expect(itemCurrentPrice(base({ priceFrom: { amount: 100 } as never }))?.amount).toBe(100)
  })
  it('returns the last bid otherwise', () => {
    expect(itemCurrentPrice(base({ bids: [{ amount: 100 }, { amount: 200 }] as never }))?.amount).toBe(200)
  })
})

describe('itemStatus', () => {
  it.each([
    [base({ sold: true }), ItemStatus.Sold],
    [base({ type: ItemType.ad }), ItemStatus.BuyNow],
    [live(), ItemStatus.AuctionLive],
    [soon(), ItemStatus.AuctionSoon],
    [base({ startDate: NOW - 2000, endDate: NOW - 1000, closed: false }), ItemStatus.AuctionProcessing],
    [base({ startDate: NOW - 2000, endDate: NOW - 1000, closed: true }), ItemStatus.AuctionEnd],
  ])('derives the lifecycle status', (item, expected) => {
    expect(itemStatus(item)).toBe(expected)
  })
})

describe('defaultSort', () => {
  it('orders by status rank across statuses', () => {
    const items = [soon(), live(), base({ type: ItemType.ad })]
    const sorted = [...items].sort(defaultSort).map(itemStatus)
    expect(sorted).toEqual([ItemStatus.AuctionLive, ItemStatus.BuyNow, ItemStatus.AuctionSoon])
  })

  it('within live, sorts by soonest endDate', () => {
    const a = live({ id: 'a', endDate: NOW + 5000 })
    const b = live({ id: 'b', endDate: NOW + 1000 })
    expect([a, b].sort(defaultSort).map(i => i.id)).toEqual(['b', 'a'])
  })

  it('within same non-live status, sorts by newest visibleUpdated', () => {
    const a = soon({ id: 'a', visibleUpdated: 1000 })
    const b = soon({ id: 'b', visibleUpdated: 5000 })
    expect([a, b].sort(defaultSort).map(i => i.id)).toEqual(['b', 'a'])
  })
})

describe('isMinPriceReached', () => {
  it('is true when the auction is not live', () => {
    expect(isMinPriceReached(soon({ minimalPrice: { amount: 999 } as never }))).toBe(true)
  })
  it('is true when current or minimal price is missing', () => {
    expect(isMinPriceReached(live())).toBe(true)
  })
  it('compares current price against the reserve when live', () => {
    const min = { minimalPrice: { amount: 1000 } as never }
    expect(isMinPriceReached(live({ ...min, bids: [{ amount: 1500 }] as never }))).toBe(true)
    expect(isMinPriceReached(live({ ...min, bids: [{ amount: 800 }] as never }))).toBe(false)
    expect(isMinPriceReached(live({ ...min, bids: [{ amount: 1000 }] as never }))).toBe(false)
  })
})

describe('null-guarded predicates', () => {
  it('return the safe default when the item is missing', () => {
    expect(hasAuctionStarted(undefined as never)).toBe(false)
    expect(isAuctionLive(undefined as never)).toBe(false)
    expect(hasAuctionEnded(undefined as never)).toBe(false)
  })
  it('treat an auction missing one of start/end as not-started / ended / not-live', () => {
    const onlyStart = base({ startDate: NOW - 1000 })
    expect(hasAuctionStarted(onlyStart)).toBe(false)
    expect(hasAuctionEnded(onlyStart)).toBe(true)
    expect(isAuctionLive(onlyStart)).toBe(false)
  })
})

describe('hasAuctionEnded', () => {
  it('is true once endDate has passed, false while still running', () => {
    expect(hasAuctionEnded(base({ startDate: NOW - 2000, endDate: NOW - 1000 }))).toBe(true)
    expect(hasAuctionEnded(live())).toBe(false)
  })
})

describe('contentLocaleKey', () => {
  it('maps Serbian rs -> srb and passes every other locale through unchanged', () => {
    expect(contentLocaleKey('rs')).toBe('srb')
    expect(contentLocaleKey('en')).toBe('en')
    expect(contentLocaleKey('cz')).toBe('cz')
  })
})

describe('defaultSort nullish fallback', () => {
  it('treats a missing visibleUpdated as 0 within the same status', () => {
    const a = soon({ id: 'a', visibleUpdated: undefined })
    const b = soon({ id: 'b', visibleUpdated: 5000 })
    expect([a, b].sort(defaultSort).map(i => i.id)).toEqual(['b', 'a'])
  })
})
