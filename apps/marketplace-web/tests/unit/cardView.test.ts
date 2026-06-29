import { describe, expect, it } from 'vitest'
import { toCardView } from '~/features/supply/auction-items/logic/cardView'
import { ItemType, type Item, type Price } from '~/models'

const media = { image: 'img.jpg', srcset: 'img.jpg 1x' }

const priceFrom: Price = { amount: 100, currency: { code: 'CZK', symbol: 'Kč', symbolBefore: false } } as never
const lastBid: Price = { amount: 250, currency: { code: 'CZK', symbol: 'Kč', symbolBefore: false } } as never

const baseItem = (overrides: Partial<Item> = {}): Item =>
  ({
    id: 'i1',
    bids: [],
    priceFrom,
    type: ItemType.auction,
    ...overrides,
  }) as never

describe('toCardView', () => {
  it('carries the supplied media through unchanged', () => {
    const view = toCardView(baseItem(), media)
    expect(view.image).toBe('img.jpg')
    expect(view.srcset).toBe('img.jpg 1x')
    expect(view.item.id).toBe('i1')
  })

  it('uses priceFrom when there are no bids', () => {
    const view = toCardView(baseItem({ bids: [] }), media)
    expect(view.price).toBe(priceFrom)
  })

  it('uses the last bid as the current price when bids exist', () => {
    const view = toCardView(baseItem({ bids: [lastBid] as never }), media)
    expect(view.price).toBe(lastBid)
  })

  it('prefers the explicit bidCount when present', () => {
    const view = toCardView(baseItem({ bids: [lastBid] as never, bidCount: 7 }), media)
    expect(view.bidCount).toBe(7)
  })

  it('treats bidCount of 0 as an explicit value (not nullish fallback)', () => {
    const view = toCardView(baseItem({ bids: [lastBid] as never, bidCount: 0 }), media)
    expect(view.bidCount).toBe(0)
  })

  it('falls back to bids.length when bidCount is undefined', () => {
    const view = toCardView(baseItem({ bids: [lastBid, lastBid] as never, bidCount: undefined }), media)
    expect(view.bidCount).toBe(2)
  })

  it('marks the auction live when within the start/end window', () => {
    const now = Date.now()
    const view = toCardView(baseItem({ startDate: now - 1000, endDate: now + 1000 }), media)
    expect(view.live).toBe(true)
  })

  it('marks the auction not live when outside the window', () => {
    const now = Date.now()
    const view = toCardView(baseItem({ startDate: now - 2000, endDate: now - 1000 }), media)
    expect(view.live).toBe(false)
  })

  it('marks the auction not live when dates are missing', () => {
    const view = toCardView(baseItem(), media)
    expect(view.live).toBe(false)
  })
})
