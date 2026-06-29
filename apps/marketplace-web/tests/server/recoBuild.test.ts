import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildRecommendations } from '~/server/utils/recommendation/build'
import * as recoRepo from '~/server/repos/recommendationRepo'
import { isRecoEnabled } from '~/server/utils/reco'
import { captureServerError } from '~/server/utils/observability'
import type { BuildEventRow, PoolItemRow } from '~/server/repos/recommendationRepo'

vi.mock('~/server/utils/reco', () => ({ isRecoEnabled: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))
vi.mock('~/server/repos/recommendationRepo', () => ({
  GLOBAL_SEGMENT: 'global',
  popularitySegmentKey: (dim: string, value: string) => `${dim}:${dim === 'country' ? value.toLowerCase() : value}`,
  loadActivePool: vi.fn(),
  loadEventWindow: vi.fn(),
  loadBidCounts: vi.fn(),
  loadFavoriteCounts: vi.fn(),
  upsertItemFeaturesBatch: vi.fn(),
  upsertPopularitySegment: vi.fn(),
  listFavoriteSignals: vi.fn(),
  listBidSignals: vi.fn(),
  listContactSignals: vi.fn(),
  loadItemAttrs: vi.fn(),
  upsertVisitorProfilesBatch: vi.fn(),
  replaceAttributeAffinity: vi.fn(),
  getProfilesFreshness: vi.fn(),
  pruneEvents: vi.fn(),
  pruneStaleProfiles: vi.fn(),
}))

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

const poolItem = (over: Partial<PoolItemRow> = {}): PoolItemRow => ({
  id: 'i1',
  categoryId: 'c1',
  type: 'auction',
  countryCode: 'CZ',
  startDate: new Date(NOW - HOUR),
  endDate: new Date(NOW + HOUR),
  priceFromAmount: '500000',
  bodyType: 'sedan',
  fuelType: 'petrol',
  transmission: 'manual',
  driveType: 'fwd',
  color: 'black',
  enginePowerKw: 110,
  engineDisplacementCcm: 1984,
  specs: { manufacturer: 'BMW', model: '320i', yearOfManufacture: 2020 } as PoolItemRow['specs'],
  images: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'],
  images360: ['p1.jpg'],
  priceHighlighted: true,
  description: { en: 'great car' },
  ...over,
})

const event = (over: Partial<BuildEventRow> = {}): BuildEventRow => ({
  vid: 'v1',
  userId: null,
  sessionId: 's1',
  type: 'detail_view',
  itemId: 'i1',
  value: null,
  occurredAt: new Date(NOW - HOUR),
  ...over,
})

const itemAttrRow = (over: Partial<PoolItemRow> = {}) => poolItem(over)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(isRecoEnabled).mockReturnValue(true)
  vi.mocked(recoRepo.loadActivePool).mockResolvedValue([])
  vi.mocked(recoRepo.loadEventWindow).mockResolvedValue([])
  vi.mocked(recoRepo.loadBidCounts).mockResolvedValue(new Map())
  vi.mocked(recoRepo.loadFavoriteCounts).mockResolvedValue(new Map())
  vi.mocked(recoRepo.upsertItemFeaturesBatch).mockResolvedValue(undefined)
  vi.mocked(recoRepo.upsertPopularitySegment).mockResolvedValue(undefined)
  vi.mocked(recoRepo.listFavoriteSignals).mockResolvedValue([])
  vi.mocked(recoRepo.listBidSignals).mockResolvedValue([])
  vi.mocked(recoRepo.listContactSignals).mockResolvedValue([])
  vi.mocked(recoRepo.loadItemAttrs).mockResolvedValue(new Map())
  vi.mocked(recoRepo.upsertVisitorProfilesBatch).mockResolvedValue(undefined)
  vi.mocked(recoRepo.replaceAttributeAffinity).mockResolvedValue(undefined)
  vi.mocked(recoRepo.getProfilesFreshness).mockResolvedValue(null)
  vi.mocked(recoRepo.pruneEvents).mockResolvedValue(0)
  vi.mocked(recoRepo.pruneStaleProfiles).mockResolvedValue(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildRecommendations — gate', () => {
  it('skips entirely when reco is disabled', async () => {
    vi.mocked(isRecoEnabled).mockReturnValue(false)
    const res = await buildRecommendations()
    expect(res).toEqual({
      skipped: true,
      items: 0,
      segments: 0,
      profiles: 0,
      affinityPairs: 0,
      prunedEvents: 0,
      errors: 0,
    })
    expect(recoRepo.loadActivePool).not.toHaveBeenCalled()
  })
})

describe('buildRecommendations — item features', () => {
  it('builds features + segments for an empty engagement pool (span=0 minMax, no events)', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([
      poolItem({ id: 'i1', categoryId: 'c1', countryCode: 'CZ' }),
      poolItem({ id: 'i2', categoryId: 'c1', countryCode: 'CZ' }),
    ])
    const res = await buildRecommendations()
    expect(res.items).toBe(2)
    // global + 1 category + 1 country
    expect(res.segments).toBe(3)
    expect(recoRepo.upsertItemFeaturesBatch).toHaveBeenCalledOnce()
    expect(res.errors).toBe(0)
  })

  it('aggregates engagement, impressions, trend window and bid/fav counts', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([
      poolItem({ id: 'i1' }),
      poolItem({ id: 'i2', countryCode: null }),
    ])
    vi.mocked(recoRepo.loadEventWindow).mockResolvedValue([
      // engagement inside trend window
      event({ itemId: 'i1', type: 'favorite_add', vid: 'va', occurredAt: new Date(NOW - HOUR) }),
      // impression branch + decay
      event({ itemId: 'i1', type: 'impression', vid: 'vb', occurredAt: new Date(NOW - HOUR) }),
      // engagement OUTSIDE the trend window (older than trendWindowHours=72h)
      event({ itemId: 'i2', type: 'bid_placed', vid: 'vc', occurredAt: new Date(NOW - 100 * HOUR) }),
      // event for an item NOT in the active pool → agg.get miss → continue
      event({ itemId: 'ghost', type: 'detail_view', vid: 'vd' }),
      // numeric value carried through (value != null branch)
      event({ itemId: 'i1', type: 'dwell', vid: 'va', value: '4200' }),
    ])
    vi.mocked(recoRepo.loadBidCounts).mockResolvedValue(new Map([['i1', 3]]))
    vi.mocked(recoRepo.loadFavoriteCounts).mockResolvedValue(new Map([['i1', 2]]))
    const res = await buildRecommendations()
    expect(res.items).toBe(2)
    expect(res.errors).toBe(0)
    const rows = vi.mocked(recoRepo.upsertItemFeaturesBatch).mock.calls[0]![0]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.itemId).toBe('i1')
  })

  it('covers every quality weight branch (none, photo-only, full, capped)', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([
      // no photos, no 360, no specs, empty description object, not highlighted
      poolItem({
        id: 'low',
        images: [],
        images360: [],
        specs: null,
        description: {},
        priceHighlighted: false,
      }),
      // single photo only (>=1 but <5), no others
      poolItem({
        id: 'one',
        images: ['only.jpg'],
        images360: [],
        specs: null,
        description: null,
        priceHighlighted: false,
      }),
      // everything → score capped at 1
      poolItem({ id: 'full' }),
    ])
    const res = await buildRecommendations()
    const rows = vi.mocked(recoRepo.upsertItemFeaturesBatch).mock.calls[0]![0]
    const byId = new Map(rows.map(r => [r.itemId, r.qualityScore]))
    expect(byId.get('low')).toBe(0)
    expect(byId.get('one')).toBeGreaterThan(0)
    expect(byId.get('full')).toBe(1)
    expect(res.items).toBe(3)
  })

  it('isolates feature-pass errors without aborting the run', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([poolItem()])
    vi.mocked(recoRepo.upsertItemFeaturesBatch).mockRejectedValue(new Error('feat boom'))
    const res = await buildRecommendations()
    expect(res.errors).toBe(1)
    expect(res.items).toBe(0)
    expect(captureServerError).toHaveBeenCalledWith(expect.any(Error), { area: 'reco.build.features' })
    // pruning still runs after an isolated feature error
    expect(recoRepo.pruneEvents).toHaveBeenCalledOnce()
  })
})

describe('buildRecommendations — heavy pass gating', () => {
  const setupHeavy = () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([
      poolItem({
        id: 'i1',
        specs: { manufacturer: 'BMW', model: '3', yearOfManufacture: 2020 } as PoolItemRow['specs'],
      }),
      poolItem({
        id: 'i2',
        specs: { manufacturer: 'Audi', model: 'A4', yearOfManufacture: 2019 } as PoolItemRow['specs'],
      }),
    ])
    vi.mocked(recoRepo.loadEventWindow).mockResolvedValue([
      event({ itemId: 'i1', vid: 'v1', userId: 'u1', type: 'detail_view' }),
      event({ itemId: 'i2', vid: 'v1', userId: 'u1', type: 'favorite_add' }),
      // anonymous vid path (no userId)
      event({ itemId: 'i1', vid: 'anon', userId: null, type: 'detail_view' }),
    ])
    vi.mocked(recoRepo.loadItemAttrs).mockResolvedValue(
      new Map([
        [
          'i1',
          itemAttrRow({
            id: 'i1',
            specs: { manufacturer: 'BMW', model: '3', yearOfManufacture: 2020 } as PoolItemRow['specs'],
          }),
        ],
        [
          'i2',
          itemAttrRow({
            id: 'i2',
            specs: { manufacturer: 'Audi', model: 'A4', yearOfManufacture: 2019 } as PoolItemRow['specs'],
          }),
        ],
      ]),
    )
  }

  it('runs the heavy pass when freshness is null (never run)', async () => {
    setupHeavy()
    vi.mocked(recoRepo.getProfilesFreshness).mockResolvedValue(null)
    vi.mocked(recoRepo.listFavoriteSignals).mockResolvedValue([{ userId: 'u1', itemId: 'i2' }])
    vi.mocked(recoRepo.listBidSignals).mockResolvedValue([{ userId: 'u2', itemId: 'i1', date: new Date(NOW - HOUR) }])
    vi.mocked(recoRepo.listContactSignals).mockResolvedValue([
      { userId: 'u3', itemId: 'i1', kind: 'offer', created: new Date(NOW - HOUR) },
      { userId: 'u3', itemId: 'i2', kind: 'contact', created: new Date(NOW - HOUR) },
    ])
    const res = await buildRecommendations()
    expect(res.profiles).toBeGreaterThan(0)
    expect(recoRepo.upsertVisitorProfilesBatch).toHaveBeenCalledOnce()
    expect(recoRepo.replaceAttributeAffinity).toHaveBeenCalled()
    expect(res.errors).toBe(0)
  })

  it('runs the heavy pass when freshness is older than the hourly interval', async () => {
    setupHeavy()
    vi.mocked(recoRepo.getProfilesFreshness).mockResolvedValue(new Date(NOW - 2 * HOUR))
    const res = await buildRecommendations()
    expect(recoRepo.upsertVisitorProfilesBatch).toHaveBeenCalledOnce()
    expect(res.profiles).toBeGreaterThan(0)
  })

  it('skips the heavy pass when freshness is recent', async () => {
    setupHeavy()
    vi.mocked(recoRepo.getProfilesFreshness).mockResolvedValue(new Date(NOW - 60_000))
    const res = await buildRecommendations()
    expect(recoRepo.listFavoriteSignals).not.toHaveBeenCalled()
    expect(recoRepo.upsertVisitorProfilesBatch).not.toHaveBeenCalled()
    expect(res.profiles).toBe(0)
    expect(res.affinityPairs).toBe(0)
  })

  it('skips profiles with no positively-engaged items (missing attrs / non-positive engagement)', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([poolItem({ id: 'i1' })])
    vi.mocked(recoRepo.loadEventWindow).mockResolvedValue([
      // engaged item attrs are NOT in the map → row undefined → flatMap drops it → empty profile skipped
      event({ itemId: 'i1', vid: 'lonely', userId: null, type: 'detail_view' }),
    ])
    vi.mocked(recoRepo.loadItemAttrs).mockResolvedValue(new Map())
    vi.mocked(recoRepo.getProfilesFreshness).mockResolvedValue(null)
    const res = await buildRecommendations()
    expect(res.profiles).toBe(0)
    // empty profile batch + empty affinity rows still flush (4 dims)
    expect(recoRepo.upsertVisitorProfilesBatch).toHaveBeenCalledWith([])
    expect(res.affinityPairs).toBe(0)
  })

  it('isolates heavy-pass errors', async () => {
    setupHeavy()
    vi.mocked(recoRepo.getProfilesFreshness).mockResolvedValue(null)
    vi.mocked(recoRepo.listBidSignals).mockRejectedValue(new Error('signals boom'))
    const res = await buildRecommendations()
    expect(res.errors).toBe(1)
    expect(res.profiles).toBe(0)
    expect(captureServerError).toHaveBeenCalledWith(expect.any(Error), { area: 'reco.build.profiles' })
  })

  it('builds an anonymous (vid) profile and skips affinity dims with no value', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([poolItem({ id: 'i1' })])
    vi.mocked(recoRepo.loadEventWindow).mockResolvedValue([
      // anonymous vid (no userId) → userId column null + key does not start with 'u:'
      event({ itemId: 'i1', vid: 'anonProfile', userId: null, type: 'favorite_add' }),
    ])
    // attrs missing make/bodyType/price → those affinity dims yield no value (continue)
    vi.mocked(recoRepo.loadItemAttrs).mockResolvedValue(
      new Map([
        [
          'i1',
          itemAttrRow({
            id: 'i1',
            bodyType: null,
            priceFromAmount: null,
            specs: null,
          }),
        ],
      ]),
    )
    vi.mocked(recoRepo.getProfilesFreshness).mockResolvedValue(null)
    const res = await buildRecommendations()
    expect(res.profiles).toBe(1)
    const rows = vi.mocked(recoRepo.upsertVisitorProfilesBatch).mock.calls[0]![0]
    expect(rows[0]!.vid).toBe('anonProfile')
    expect(rows[0]!.userId).toBeNull()
  })

  it('builds affinity rows + sorts multiple neighbors when items share attribute values', async () => {
    vi.mocked(recoRepo.loadActivePool).mockResolvedValue([
      poolItem({ id: 'i1' }),
      poolItem({ id: 'i2' }),
      poolItem({ id: 'i3' }),
    ])
    // Three bodyType values, each value co-engaged by visitors → every value has >=2
    // positive-cosine neighbors, so the neighbor sort comparator fires.
    vi.mocked(recoRepo.loadEventWindow).mockResolvedValue([
      event({ itemId: 'i1', vid: 'v1', userId: 'u1', type: 'favorite_add' }),
      event({ itemId: 'i2', vid: 'v1', userId: 'u1', type: 'favorite_add' }),
      event({ itemId: 'i3', vid: 'v1', userId: 'u1', type: 'favorite_add' }),
      event({ itemId: 'i1', vid: 'v2', userId: 'u2', type: 'favorite_add' }),
      event({ itemId: 'i2', vid: 'v2', userId: 'u2', type: 'favorite_add' }),
      event({ itemId: 'i3', vid: 'v2', userId: 'u2', type: 'favorite_add' }),
    ])
    vi.mocked(recoRepo.loadItemAttrs).mockResolvedValue(
      new Map([
        ['i1', itemAttrRow({ id: 'i1', bodyType: 'sedan' })],
        ['i2', itemAttrRow({ id: 'i2', bodyType: 'coupe' })],
        ['i3', itemAttrRow({ id: 'i3', bodyType: 'suv' })],
      ]),
    )
    vi.mocked(recoRepo.getProfilesFreshness).mockResolvedValue(null)
    const res = await buildRecommendations()
    // each of 3 bodyType values → 2 neighbors → 6 rows for that dim
    expect(res.affinityPairs).toBeGreaterThanOrEqual(6)
    expect(res.profiles).toBe(2)
  })
})

describe('buildRecommendations — pruning', () => {
  it('returns prune counts and invalidates the pool cache', async () => {
    vi.mocked(recoRepo.pruneEvents).mockResolvedValue(7)
    const res = await buildRecommendations()
    expect(res.prunedEvents).toBe(7)
    expect(recoRepo.pruneStaleProfiles).toHaveBeenCalledOnce()
  })

  it('isolates prune errors', async () => {
    vi.mocked(recoRepo.pruneEvents).mockRejectedValue(new Error('prune boom'))
    const res = await buildRecommendations()
    expect(res.errors).toBe(1)
    expect(captureServerError).toHaveBeenCalledWith(expect.any(Error), { area: 'reco.build.prune' })
  })
})
