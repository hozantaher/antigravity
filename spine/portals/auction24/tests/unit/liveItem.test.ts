import { describe, it, expect } from 'vitest'
import { ItemType, applyLiveItem, liveItemChanged, itemCurrentPrice } from '~/models'
import type { Item, LiveItem } from '~/models'
import type { ItemRow } from '~/server/db/schema'
import { toLiveItem } from '~/server/repos/mappers'

const eur = { code: 'EUR', symbol: '€', symbolBefore: false }
const bid = (amount: number): NonNullable<LiveItem['lastBid']> => ({ userId: 'b1', date: 5, amount, currency: eur })

const baseItem = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  title: 't',
  image: '',
  images: [],
  images360: [],
  description: {},
  highlights: {},
  categoryId: 'car',
  userId: 'u1',
  bids: [],
  priceHighlighted: false,
  taxIncluded: false,
  sold: false,
  closed: false,
  hidden: false,
  type: ItemType.auction,
  priceFrom: { amount: 1000, currency: eur },
  endDate: 1_000_000,
  ...over,
})

describe('applyLiveItem', () => {
  it('overlays last bid, count, end, and close/winner without mutating the original', () => {
    const item = baseItem()
    const live: LiveItem = {
      id: 'i1',
      lastBid: bid(1500),
      bidCount: 3,
      endDate: 2_000_000,
      sold: true,
      closed: true,
      winner: { id: 'b1', name: 'Bob' },
    }
    const out = applyLiveItem(item, live)
    expect(out.bids).toEqual([bid(1500)])
    expect(out.bidCount).toBe(3)
    expect(out.endDate).toBe(2_000_000)
    expect(out.sold).toBe(true)
    expect(out.closed).toBe(true)
    expect(out.winner).toEqual({ id: 'b1', name: 'Bob' })
    // current price follows the new last bid
    expect(itemCurrentPrice(out)?.amount).toBe(1500)
    // input untouched
    expect(item.bids).toEqual([])
    expect(item.endDate).toBe(1_000_000)
  })

  it('clears bids (price falls back to priceFrom) when live reports none', () => {
    const out = applyLiveItem(baseItem({ bids: [bid(1500)], bidCount: 1 }), {
      id: 'i1',
      bidCount: 0,
      endDate: 1_000_000,
      sold: false,
      closed: false,
    })
    expect(out.bids).toEqual([])
    expect(out.bidCount).toBe(0)
    expect(itemCurrentPrice(out)?.amount).toBe(1000)
  })
})

describe('liveItemChanged', () => {
  // Full detail item leaves bidCount undefined → bids.length (1) is the comparison baseline.
  const item = baseItem({ bids: [bid(1500)] })
  const match: LiveItem = { id: 'i1', lastBid: bid(1500), bidCount: 1, endDate: 1_000_000, sold: false, closed: false }

  it('false when the slim state matches the full item', () => {
    expect(liveItemChanged(item, match)).toBe(false)
  })

  it('true on a new bid (count up)', () => {
    expect(liveItemChanged(item, { ...match, lastBid: bid(1600), bidCount: 2 })).toBe(true)
  })

  it('true on a soft-close-extended end', () => {
    expect(liveItemChanged(item, { ...match, endDate: 1_180_000 })).toBe(true)
  })

  it('true when it closes / sells', () => {
    expect(liveItemChanged(item, { ...match, sold: true, closed: true })).toBe(true)
  })
})

describe('toLiveItem', () => {
  const row: Pick<ItemRow, 'id' | 'endDate' | 'sold' | 'closed' | 'winner'> = {
    id: 'i1',
    endDate: new Date('2025-01-03T00:00:00Z'),
    sold: false,
    closed: false,
    winner: null,
  }

  it('maps end to epoch-ms and carries the bid summary', () => {
    const out = toLiveItem(row, { count: 4, last: { userId: 'b1', date: 5, amount: 1500, currency: eur } })
    expect(out.endDate).toBe(new Date('2025-01-03T00:00:00Z').getTime())
    expect(out.bidCount).toBe(4)
    expect(out.lastBid?.amount).toBe(1500)
    expect(out.winner).toBeUndefined()
  })

  it('defaults count to 0 and lastBid undefined with no summary', () => {
    const out = toLiveItem(row)
    expect(out.bidCount).toBe(0)
    expect(out.lastBid).toBeUndefined()
  })
})
