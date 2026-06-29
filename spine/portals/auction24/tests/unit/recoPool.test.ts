import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemStatus } from '~/models'
import type { PoolItemRow, ItemAttrRow } from '~/server/repos/recommendationRepo'
import * as recoRepo from '~/server/repos/recommendationRepo'
import {
  getScorablePool,
  invalidatePoolCache,
  poolRowToCandidate,
  rowToAttrs,
} from '~/server/utils/recommendation/pool'

vi.mock('~/server/repos/recommendationRepo', () => ({ loadActivePool: vi.fn() }))

const NOW = Date.UTC(2026, 5, 19, 12)

const baseRow = (over: Partial<PoolItemRow> = {}): PoolItemRow => ({
  id: 'i1',
  categoryId: 'cars',
  type: 'auction',
  countryCode: 'cz',
  startDate: new Date(NOW - 3_600_000),
  endDate: new Date(NOW + 3_600_000),
  priceFromAmount: '12345',
  bodyType: 'sedan',
  fuelType: 'diesel',
  transmission: 'manual',
  driveType: 'fwd',
  color: 'black',
  enginePowerKw: 100,
  engineDisplacementCcm: 1998,
  specs: { manufacturer: 'BMW', model: '320d', yearOfManufacture: 2018 } as never,
  images: [],
  images360: [],
  priceHighlighted: false,
  description: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  invalidatePoolCache()
})

afterEach(() => {
  invalidatePoolCache()
})

describe('rowToAttrs', () => {
  it('maps a fully-populated row (specs present, numeric string price)', () => {
    const attrs = rowToAttrs(baseRow())
    expect(attrs).toEqual({
      categorical: {
        categoryId: 'cars',
        type: 'auction',
        make: 'BMW',
        model: '320d',
        bodyType: 'sedan',
        fuelType: 'diesel',
        transmission: 'manual',
        driveType: 'fwd',
        color: 'black',
        countryCode: 'cz',
      },
      numeric: {
        price: 12345,
        year: 2018,
        enginePowerKw: 100,
        engineDisplacementCcm: 1998,
      },
    })
  })

  it('falls back to undefined when specs is null and nullable columns are null', () => {
    const row: ItemAttrRow = baseRow({
      specs: null,
      countryCode: null,
      bodyType: null,
      fuelType: null,
      transmission: null,
      driveType: null,
      color: null,
      enginePowerKw: null,
      engineDisplacementCcm: null,
      priceFromAmount: null,
    })
    const attrs = rowToAttrs(row)
    expect(attrs.categorical).toEqual({
      categoryId: 'cars',
      type: 'auction',
      make: undefined,
      model: undefined,
      bodyType: undefined,
      fuelType: undefined,
      transmission: undefined,
      driveType: undefined,
      color: undefined,
      countryCode: undefined,
    })
    expect(attrs.numeric).toEqual({
      price: undefined,
      year: undefined,
      enginePowerKw: undefined,
      engineDisplacementCcm: undefined,
    })
  })

  it('coerces a numeric (non-string) price via num()', () => {
    const attrs = rowToAttrs(baseRow({ priceFromAmount: 999 as unknown as string }))
    expect(attrs.numeric.price).toBe(999)
  })

  it('treats specs present but missing optional sub-fields as undefined', () => {
    const attrs = rowToAttrs(baseRow({ specs: { manufacturer: 'Audi' } as never }))
    expect(attrs.categorical.make).toBe('Audi')
    expect(attrs.categorical.model).toBeUndefined()
    expect(attrs.numeric.year).toBeUndefined()
  })
})

describe('poolRowToCandidate (poolStatus branches)', () => {
  it('classifies an ad as BuyNow regardless of dates', () => {
    const c = poolRowToCandidate(baseRow({ type: 'ad', startDate: null, endDate: null }), NOW)
    expect(c.status).toBe(ItemStatus.BuyNow)
    expect(c.endMs).toBeNull()
  })

  it('classifies a live auction (start<=now<end)', () => {
    const c = poolRowToCandidate(baseRow(), NOW)
    expect(c.status).toBe(ItemStatus.AuctionLive)
    expect(c.endMs).toBe(NOW + 3_600_000)
  })

  it('classifies a soon auction (start>now)', () => {
    const c = poolRowToCandidate(
      baseRow({ startDate: new Date(NOW + 3_600_000), endDate: new Date(NOW + 7_200_000) }),
      NOW,
    )
    expect(c.status).toBe(ItemStatus.AuctionSoon)
  })

  it('classifies an ended auction (end<=now) as AuctionEnd', () => {
    const c = poolRowToCandidate(
      baseRow({ startDate: new Date(NOW - 7_200_000), endDate: new Date(NOW - 3_600_000) }),
      NOW,
    )
    expect(c.status).toBe(ItemStatus.AuctionEnd)
  })

  it('treats null start/end auction dates as epoch 0 → AuctionEnd', () => {
    const c = poolRowToCandidate(baseRow({ startDate: null, endDate: null }), NOW)
    expect(c.status).toBe(ItemStatus.AuctionEnd)
    expect(c.endMs).toBeNull()
  })

  it('carries make from specs and builds a vector', () => {
    const c = poolRowToCandidate(baseRow(), NOW)
    expect(c.make).toBe('BMW')
    expect(c.id).toBe('i1')
    expect(c.categoryId).toBe('cars')
    expect(c.countryCode).toBe('cz')
    expect(typeof c.vector).toBe('object')
    expect(Object.keys(c.vector).length).toBeGreaterThan(0)
  })

  it('leaves make undefined when specs is null', () => {
    const c = poolRowToCandidate(baseRow({ specs: null }), NOW)
    expect(c.make).toBeUndefined()
  })
})

describe('getScorablePool (TTL cache)', () => {
  it('loads from the repo on a cold cache and caches the result', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([baseRow()])
    const pool = await getScorablePool(NOW)
    expect(pool).toHaveLength(1)
    expect(pool[0]?.id).toBe('i1')
    expect(recoRepo.loadActivePool).toHaveBeenCalledTimes(1)
  })

  it('serves the cached snapshot within the TTL window without re-querying', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([baseRow()])
    const first = await getScorablePool(NOW)
    const second = await getScorablePool(NOW + 44_000)
    expect(second).toBe(first)
    expect(recoRepo.loadActivePool).toHaveBeenCalledTimes(1)
  })

  it('refreshes the pool once the TTL has elapsed', async () => {
    vi.mocked(recoRepo.loadActivePool)
      .mockResolvedValueOnce([baseRow({ id: 'old' })])
      .mockResolvedValueOnce([baseRow({ id: 'new' })])
    const first = await getScorablePool(NOW)
    const second = await getScorablePool(NOW + 45_000)
    expect(first[0]?.id).toBe('old')
    expect(second[0]?.id).toBe('new')
    expect(recoRepo.loadActivePool).toHaveBeenCalledTimes(2)
  })

  it('re-queries after invalidatePoolCache clears the snapshot', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([baseRow()])
    await getScorablePool(NOW)
    invalidatePoolCache()
    await getScorablePool(NOW)
    expect(recoRepo.loadActivePool).toHaveBeenCalledTimes(2)
  })

  it('caches an empty pool', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([])
    const pool = await getScorablePool(NOW)
    expect(pool).toEqual([])
    await getScorablePool(NOW)
    expect(recoRepo.loadActivePool).toHaveBeenCalledTimes(1)
  })
})
