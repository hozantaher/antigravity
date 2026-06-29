import { describe, expect, it } from 'vitest'
import {
  aggregateEngagement,
  ageInDays,
  AFFINITY_DIMS,
  anchorSim,
  attrAffinity,
  base,
  buildItemVector,
  buildVisitorProfile,
  categoricalDims,
  categoricalSim,
  confidence,
  cosineSim,
  decayFactor,
  effectiveEvidence,
  epsilonInject,
  finalScore,
  freshOnSite,
  gammaFor,
  hashUnit,
  isNewsletterDue,
  isRecoEventType,
  ItemStatus,
  itemSignalMeta,
  mmrSelect,
  numericDims,
  numericSim,
  passesNewsletterHorizon,
  personal,
  popCombine,
  popRate,
  priceBand,
  RECO_CONFIG,
  RECO_EVENT_TYPES,
  relevance,
  saturate,
  signalContribution,
  topMakes,
  transformSignal,
  validStatusGate,
  VID_COOKIE,
  withinSessionReRank,
  type EngagedItem,
  type EngagementEvent,
  type Item,
  type ItemAttrs,
  type RankCandidate,
  type SessionSeen,
} from '~/models'

const NOW = 1_700_000_000_000

describe('saturate', () => {
  it('is 0 at 0 and approaches 1', () => {
    expect(saturate(0, 5)).toBe(0)
    expect(saturate(5, 5)).toBeCloseTo(1 - Math.exp(-1), 6)
    expect(saturate(1000, 5)).toBeGreaterThan(0.99)
  })
  it('treats non-positive scale as a step', () => {
    expect(saturate(2, 0)).toBe(1)
    expect(saturate(0, 0)).toBe(0)
  })
})

describe('decay & age', () => {
  it('halves at the half-life', () => {
    expect(decayFactor(RECO_CONFIG.halfLifeDays)).toBeCloseTo(0.5, 6)
    expect(decayFactor(0)).toBe(1)
  })
  it('age never goes negative', () => {
    expect(ageInDays(NOW + 10_000, NOW)).toBe(0)
    expect(ageInDays(NOW - 86_400_000, NOW)).toBeCloseTo(1, 6)
  })
})

describe('transformSignal', () => {
  it('clamps dwell and saturates', () => {
    expect(transformSignal('dwell_active', 1000)).toBeCloseTo(saturate(180, 90), 6) // clamped to 180
  })
  it('applies hover/viewport thresholds', () => {
    expect(transformSignal('card_hover_dwell', 500)).toBe(0)
    expect(transformSignal('card_hover_dwell', 5000)).toBeGreaterThan(0)
    expect(transformSignal('card_viewport_dwell', 1)).toBe(0)
    expect(transformSignal('card_viewport_dwell', 6)).toBeGreaterThan(0)
  })
  it('clamps scroll depth to 0..1 and treats unit signals as 1', () => {
    expect(transformSignal('scroll_depth', 1.5)).toBe(1)
    expect(transformSignal('bid_placed')).toBe(1)
    expect(transformSignal('favorite_add', null)).toBe(1)
  })
})

describe('aggregateEngagement', () => {
  it('sums weighted signals and clamps to >= 0', () => {
    const events: EngagementEvent[] = [
      { itemId: 'a', type: 'favorite_add', occurredAt: NOW },
      { itemId: 'a', type: 'favorite_remove', occurredAt: NOW },
      { itemId: 'b', type: 'favorite_remove', occurredAt: NOW },
    ]
    const out = aggregateEngagement(events, NOW)
    const a = out.find(x => x.itemId === 'a')!
    const b = out.find(x => x.itemId === 'b')!
    expect(a.e).toBeCloseTo(4, 6) // 6 - 2
    expect(b.e).toBe(0) // -2 clamped
  })
  it('applies the return-visit multiplier across distinct sessions', () => {
    const one = aggregateEngagement([{ itemId: 'a', type: 'detail_view', occurredAt: NOW, sessionId: 's1' }], NOW)
    const two = aggregateEngagement(
      [
        { itemId: 'a', type: 'detail_view', occurredAt: NOW, sessionId: 's1' },
        { itemId: 'a', type: 'detail_view', occurredAt: NOW, sessionId: 's2' },
      ],
      NOW,
    )
    // two sessions => returnVisits 1 => >2x single (which has no multiplier)
    expect(two[0]!.e).toBeGreaterThan(one[0]!.e * 2)
  })
})

describe('evidence & confidence', () => {
  it('counts engaged items, not engagement size', () => {
    const engaged = [
      { itemId: 'a', e: 100, evidence: 1 },
      { itemId: 'b', e: 1, evidence: 1 },
      { itemId: 'c', e: 0, evidence: 1 },
    ]
    expect(effectiveEvidence(engaged)).toBeCloseTo(2, 6) // c has e=0 -> excluded
  })
  it('alpha rises monotonically from 0', () => {
    expect(confidence(0)).toBe(0)
    expect(confidence(5, 5)).toBe(0.5)
    expect(confidence(100, 5)).toBeGreaterThan(confidence(10, 5))
  })
})

const engaged = (over: Partial<EngagedItem['attrs']> & { e: number }): EngagedItem => ({
  e: over.e,
  attrs: { categorical: over.categorical ?? {}, numeric: over.numeric ?? {} },
})

describe('buildVisitorProfile', () => {
  const profile = buildVisitorProfile([
    engaged({ e: 10, categorical: { make: 'bmw', bodyType: 'suv' }, numeric: { year: 2018, price: 500_000 } }),
    engaged({ e: 5, categorical: { make: 'audi', bodyType: 'suv' }, numeric: { year: 2020, price: 600_000 } }),
  ])
  it('builds categorical distributions that sum to 1', () => {
    expect(profile.categorical.make!.bmw).toBeCloseTo(10 / 15, 6)
    expect(profile.categorical.make!.audi).toBeCloseTo(5 / 15, 6)
    expect(profile.categorical.bodyType!.suv).toBeCloseTo(1, 6)
  })
  it('builds numeric gaussians with a sigma floor', () => {
    expect(profile.numeric.year!.mu).toBeCloseTo((10 * 2018 + 5 * 2020) / 15, 4)
    const single = buildVisitorProfile([engaged({ e: 1, numeric: { year: 2018 } })])
    expect(single.numeric.year!.sigma).toBe(RECO_CONFIG.sigmaFloor)
  })
  it('exposes top makes sorted by mass', () => {
    expect(topMakes(profile)[0]![0]).toBe('bmw')
  })
})

describe('similarity helpers', () => {
  const profile = buildVisitorProfile([engaged({ e: 10, categorical: { make: 'bmw' }, numeric: { year: 2018 } })])
  it('categoricalSim returns the mass, numericSim peaks at mu', () => {
    expect(categoricalSim(profile, 'make', 'bmw')).toBeCloseTo(1, 6)
    expect(categoricalSim(profile, 'make', 'kia')).toBe(0)
    expect(numericSim(profile, 'year', 2018)).toBeCloseTo(1, 6)
    expect(numericSim(profile, 'price', 999)).toBeUndefined() // no price signal
  })
  it('personal skips & renormalizes missing dims', () => {
    const full = personal(profile, { categorical: { make: 'bmw' }, numeric: { year: 2018 } })
    expect(full).toBeCloseTo(1, 6)
    const partial = personal(profile, { categorical: { make: 'kia' }, numeric: {} })
    expect(partial).toBe(0)
  })
  it('base blends personal and popularity by alpha', () => {
    expect(base(0, 1, 0.2)).toBeCloseTo(0.2, 6)
    expect(base(1, 0.9, 0.2)).toBeCloseTo(0.9, 6)
    expect(base(0.5, 1, 0)).toBeCloseTo(0.5, 6)
  })
})

describe('content vector & affinity', () => {
  it('priceBand buckets by threshold', () => {
    expect(priceBand(50_000)).toBe('b0')
    expect(priceBand(150_000)).toBe('b1')
    expect(priceBand(5_000_000)).toBe('b5')
    expect(priceBand(null)).toBeUndefined()
  })
  it('cosineSim is 1 for identical, 0 for disjoint', () => {
    const a = buildItemVector({ categorical: { make: 'bmw', bodyType: 'suv' }, numeric: { price: 500_000 } })
    const b = buildItemVector({ categorical: { make: 'bmw', bodyType: 'suv' }, numeric: { price: 500_000 } })
    const c = buildItemVector({ categorical: { make: 'kia', bodyType: 'hatchback' }, numeric: { price: 90_000 } })
    expect(cosineSim(a, b)).toBeCloseTo(1, 6)
    expect(cosineSim(a, c)).toBe(0)
  })
  it('attrAffinity averages psi-weighted neighbor scores', () => {
    const lookup = (dim: string, x: string, y: string) => (dim === 'make' && x === 'bmw' && y === 'audi' ? 0.8 : 0)
    const aff = attrAffinity(
      { categorical: { make: 'bmw' }, numeric: {} },
      { categorical: { make: 'audi' }, numeric: {} },
      lookup,
    )
    expect(aff).toBeCloseTo(0.8, 6)
  })
})

describe('anchor blend & relevance', () => {
  it('gammaFor leans on content without affinity data', () => {
    expect(gammaFor(false)).toBe(1)
    expect(gammaFor(true)).toBe(0.6)
  })
  it('anchorSim mixes content and affinity', () => {
    expect(anchorSim(0.6, 0.5, 1)).toBeCloseTo(0.7, 6)
  })
  it('relevance falls back to base without an anchor', () => {
    expect(relevance(null, 0.42)).toBe(0.42)
    expect(relevance(1, 0)).toBeCloseTo(RECO_CONFIG.anchorBeta, 6)
  })
})

describe('freshness & validity', () => {
  it('boosts only auctions ending within the window', () => {
    expect(freshOnSite(null, NOW)).toBe(0)
    expect(freshOnSite(NOW - 1000, NOW)).toBe(0)
    expect(freshOnSite(NOW + 48 * 3_600_000, NOW)).toBe(0)
    expect(freshOnSite(NOW + 12 * 3_600_000, NOW)).toBeCloseTo(RECO_CONFIG.freshOnSiteMaxBoost * 0.5, 6)
  })
  it('newsletter horizon excludes auctions ending too soon', () => {
    expect(passesNewsletterHorizon(null, NOW)).toBe(true)
    expect(passesNewsletterHorizon(NOW + 24 * 3_600_000, NOW)).toBe(false)
    expect(passesNewsletterHorizon(NOW + 72 * 3_600_000, NOW)).toBe(true)
  })
  it('validStatusGate enforces anchor/excluded/status', () => {
    const ok = validStatusGate(ItemStatus.AuctionLive, 'c', 'a', new Set())
    expect(ok).toBe(true)
    expect(validStatusGate(ItemStatus.AuctionLive, 'a', 'a', new Set())).toBe(false)
    expect(validStatusGate(ItemStatus.AuctionLive, 'c', 'a', new Set(['c']))).toBe(false)
    expect(validStatusGate(ItemStatus.Sold, 'c', 'a', new Set())).toBe(false)
  })
})

describe('finalScore', () => {
  it('zeroes invalid candidates and blends weights otherwise', () => {
    const parts = { relevance: 1, trend: 1, quality: 1, fresh: 1 }
    expect(finalScore(parts, false)).toBe(0)
    const w = RECO_CONFIG.finalWeights
    expect(finalScore(parts, true)).toBeCloseTo(w.rel + w.trend + w.quality + w.fresh, 6)
  })
})

describe('mmrSelect', () => {
  const cand = (
    id: string,
    score: number,
    vector: Record<string, number>,
    make?: string,
    categoryId?: string,
  ): RankCandidate => ({
    id,
    score,
    vector,
    make,
    categoryId,
  })
  it('prefers diversity over raw score', () => {
    const out = mmrSelect([cand('c1', 1, { x: 1 }), cand('c2', 0.9, { x: 1 }), cand('c3', 0.8, { y: 1 })], 3)
    expect(out.map(c => c.id)).toEqual(['c1', 'c3', 'c2'])
  })
  it('enforces the per-brand cap', () => {
    const out = mmrSelect(
      [cand('c1', 1, { a: 1 }, 'bmw'), cand('c2', 0.9, { b: 1 }, 'bmw'), cand('c3', 0.8, { c: 1 }, 'bmw')],
      5,
    )
    expect(out).toHaveLength(RECO_CONFIG.perBrandCap)
  })
})

describe('hashUnit & epsilonInject', () => {
  it('hashUnit is deterministic in [0,1)', () => {
    expect(hashUnit('vid-1')).toBe(hashUnit('vid-1'))
    expect(hashUnit('vid-1')).not.toBe(hashUnit('vid-2'))
    const h = hashUnit('x')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(1)
  })
  it('reserves exploration slots from the pool', () => {
    const ranked = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}` }))
    const pool = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` }))
    const out = epsilonInject(ranked, pool, 12, 'vid-1')
    expect(out).toHaveLength(12)
    const injected = out.filter(o => o.id.startsWith('p'))
    expect(injected.length).toBe(Math.round(12 * RECO_CONFIG.explorationEpsilon))
  })
  it('returns the head when the pool is empty', () => {
    const ranked = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` }))
    expect(epsilonInject(ranked, [], 3, 'v').map(o => o.id)).toEqual(['r0', 'r1', 'r2'])
  })
})

describe('popularity', () => {
  it('shrinks the rate toward the prior with few impressions', () => {
    expect(popRate(0, 0, 0.5)).toBeCloseTo(0.5, 6)
    expect(popRate(100, 100, 0.5)).toBeGreaterThan(0.5)
  })
  it('combines components', () => {
    const v = popCombine({ popRate: 1, bidCount: 10, favCount: 5, distinctViewers: 20, trend: 1 })
    expect(v).toBeGreaterThan(0)
  })
})

describe('withinSessionReRank', () => {
  const attrsOf = (i: { make?: string; bodyType?: string; priceBand?: string }) => i
  const seen: SessionSeen = { makes: new Set(['audi']), bodyTypes: new Set(), priceBands: new Set() }
  it('never drops items and is stable without matches', () => {
    const items = [{ make: 'bmw' }, { make: 'kia' }]
    const out = withinSessionReRank(items, attrsOf, seen)
    expect(out).toHaveLength(2)
    expect(out).toEqual(items)
  })
  it('boosts session-matching candidates', () => {
    const items = [{ make: 'bmw' }, { make: 'audi' }]
    const out = withinSessionReRank(items, attrsOf, seen, 2)
    expect(out[0]!.make).toBe('audi')
  })
})

describe('isNewsletterDue', () => {
  it('is due when never sent or past the window', () => {
    expect(isNewsletterDue(null, NOW)).toBe(true)
    expect(isNewsletterDue(NOW - 2 * 86_400_000, NOW)).toBe(false)
    expect(isNewsletterDue(NOW - 8 * 86_400_000, NOW)).toBe(true)
  })
})

describe('itemSignalMeta', () => {
  it('snapshots make, bodyType and priceBand', () => {
    const item = {
      bids: [],
      priceFrom: { amount: 150_000 },
      bodyType: 'suv',
      specs: { manufacturer: 'bmw' },
    } as unknown as Item
    expect(itemSignalMeta(item)).toEqual({ make: 'bmw', bodyType: 'suv', priceBand: 'b1' })
  })
  it('tolerates missing specs, bodyType and price', () => {
    const item = { bids: [] } as unknown as Item
    expect(itemSignalMeta(item)).toEqual({ make: undefined, bodyType: undefined, priceBand: undefined })
  })
})

describe('isRecoEventType', () => {
  it('accepts known event types only', () => {
    expect(isRecoEventType('bid_placed')).toBe(true)
    expect(isRecoEventType('favorite_remove')).toBe(true)
    expect(isRecoEventType('not_a_type')).toBe(false)
    expect(isRecoEventType(42)).toBe(false)
    expect(isRecoEventType(null)).toBe(false)
    expect(isRecoEventType(undefined)).toBe(false)
  })
})

describe('constants & dim accessors', () => {
  it('exposes the cookie name and the event taxonomy', () => {
    expect(VID_COOKIE).toBe('a24_vid')
    expect(RECO_EVENT_TYPES).toContain('bid_placed')
    expect(RECO_EVENT_TYPES.length).toBeGreaterThan(0)
  })
  it('returns the numeric and categorical dimension lists', () => {
    expect(numericDims()).toContain('price')
    expect(numericDims()).toContain('year')
    expect(categoricalDims()).toContain('make')
    expect(categoricalDims()).toContain('categoryId')
  })
})

describe('transformSignal saturating branches', () => {
  it('saturates photo_view, photo_zoom, pano and impression_fatigue', () => {
    expect(transformSignal('photo_view', 8)).toBeCloseTo(saturate(8, RECO_CONFIG.saturation.photo_view!), 6)
    expect(transformSignal('photo_zoom', 3)).toBeCloseTo(saturate(3, RECO_CONFIG.saturation.photo_zoom!), 6)
    expect(transformSignal('pano_360_interact', 3)).toBeCloseTo(
      saturate(3, RECO_CONFIG.saturation.pano_360_interact!),
      6,
    )
    expect(transformSignal('impression_fatigue', 10)).toBeCloseTo(
      saturate(10, RECO_CONFIG.saturation.impression_fatigue!),
      6,
    )
  })
  it('clamps scroll depth below zero to zero', () => {
    expect(transformSignal('scroll_depth', -1)).toBe(0)
  })
})

describe('signalContribution', () => {
  it('is weight * transform * decay', () => {
    const fresh = signalContribution('favorite_add', null, NOW, NOW)
    expect(fresh).toBeCloseTo(RECO_CONFIG.signalWeights.favorite_add, 6)
    const aged = signalContribution('favorite_add', null, NOW - RECO_CONFIG.halfLifeDays * 86_400_000, NOW)
    expect(aged).toBeCloseTo(RECO_CONFIG.signalWeights.favorite_add * 0.5, 4)
  })
})

describe('buildVisitorProfile price-space & empty dims', () => {
  it('builds price gaussian in log space and skips dims without signal', () => {
    const profile = buildVisitorProfile([
      engaged({ e: 4, numeric: { price: 400_000 } }),
      engaged({ e: 0, numeric: { price: 900_000 } }), // e<=0 skipped
      engaged({ e: 2, numeric: {} }), // missing numeric skipped
    ])
    expect(profile.numeric.price!.mu).toBeCloseTo(Math.log(400_000), 6)
    expect(profile.numeric.year).toBeUndefined()
    expect(profile.categorical.make).toBeUndefined()
  })
  it('returns empty vectors with no engagement', () => {
    const profile = buildVisitorProfile([])
    expect(profile.categorical).toEqual({})
    expect(profile.numeric).toEqual({})
  })
})

describe('personal numeric + weight guards', () => {
  it('blends categorical and numeric dims, skipping absent gaussians', () => {
    const profile = buildVisitorProfile([engaged({ e: 10, categorical: { make: 'bmw' }, numeric: { price: 500_000 } })])
    const score = personal(profile, { categorical: { make: 'bmw' }, numeric: { price: 500_000 } })
    expect(score).toBeCloseTo(1, 6)
    // numeric dim present on candidate but absent in profile gaussian -> skipped
    const partial = personal(profile, { categorical: { make: 'bmw' }, numeric: { year: 2018 } })
    expect(partial).toBeCloseTo(1, 6)
  })
})

describe('buildItemVector', () => {
  it('encodes one-hot categoricals, price band and year band', () => {
    const vec = buildItemVector({
      categorical: { make: 'bmw' },
      numeric: { price: 500_000, year: 2019 },
    })
    expect(vec['make:bmw']).toBeCloseTo(Math.sqrt(RECO_CONFIG.dimensionWeights.make!), 6)
    expect(vec['priceBand:b2']).toBeCloseTo(Math.sqrt(RECO_CONFIG.dimensionWeights.price!), 6)
    expect(vec['yearBand:y2019']).toBeCloseTo(Math.sqrt(RECO_CONFIG.dimensionWeights.year!), 6)
  })
  it('omits dims with zero weight or missing values', () => {
    const vec = buildItemVector({ categorical: {}, numeric: {} })
    expect(Object.keys(vec)).toHaveLength(0)
  })
})

describe('cosineSim guards', () => {
  it('returns 0 when either vector is empty', () => {
    expect(cosineSim({}, { x: 1 })).toBe(0)
    expect(cosineSim({ x: 1 }, {})).toBe(0)
  })
})

describe('attrAffinity guards & dims', () => {
  it('returns 0 when no shared affinity dims are present', () => {
    const aff = attrAffinity({ categorical: {}, numeric: {} }, { categorical: {}, numeric: {} }, () => 0.9)
    expect(aff).toBe(0)
  })
  it('exposes the affinity dim extractors', () => {
    const attrs: ItemAttrs = {
      categorical: { make: 'bmw', bodyType: 'suv', categoryId: 'cars' },
      numeric: { price: 150_000 },
    }
    const got = AFFINITY_DIMS.map(d => d.of(attrs))
    expect(got).toEqual(['bmw', 'suv', 'b1', 'cars'])
  })
})

describe('mmrSelect per-category cap & exhaustion', () => {
  const cand = (id: string, score: number, vector: Record<string, number>, categoryId?: string): RankCandidate => ({
    id,
    score,
    vector,
    categoryId,
  })
  it('enforces the per-category cap and stops when all are capped', () => {
    const out = mmrSelect(
      [
        cand('c1', 1, { a: 1 }, 'cat'),
        cand('c2', 0.9, { b: 1 }, 'cat'),
        cand('c3', 0.8, { c: 1 }, 'cat'),
        cand('c4', 0.7, { d: 1 }, 'cat'),
      ],
      4,
    )
    expect(out).toHaveLength(RECO_CONFIG.perCategoryCap)
  })
})

describe('coverage top-up: engagement, affinity, within-session re-rank', () => {
  const NOW = 1_700_000_000_000

  it('aggregateEngagement skips empty itemId, applies the return-session multiplier, feeds evidence/confidence', () => {
    const eng = aggregateEngagement(
      [
        { itemId: '', type: 'detail_view', occurredAt: NOW, sessionId: 's0' },
        { itemId: 'a', type: 'bid_placed', occurredAt: NOW },
        { itemId: 'a', type: 'detail_view', occurredAt: NOW, sessionId: 's1' },
        { itemId: 'a', type: 'detail_view', occurredAt: NOW, sessionId: 's2' },
      ] as EngagementEvent[],
      NOW,
    )
    expect(eng).toHaveLength(1)
    const a = eng.find(x => x.itemId === 'a')!
    expect(a.e).toBeGreaterThan(0)
    expect(a.evidence).toBeGreaterThan(0)
    const nEff = effectiveEvidence(eng)
    expect(nEff).toBeGreaterThan(0)
    expect(confidence(nEff)).toBeGreaterThan(0)
  })

  it('signalContribution is zero for an unknown signal type', () => {
    expect(signalContribution('not_a_signal' as never, 1, NOW, NOW)).toBe(0)
  })

  it('topMakes returns [] when the profile carries no make mass', () => {
    expect(topMakes({ categorical: {}, numeric: {} } as never)).toEqual([])
    expect(topMakes({ categorical: { make: { bmw: 0.7, audi: 0.3 } }, numeric: {} } as never, 1)).toEqual([
      ['bmw', 0.7],
    ])
  })

  it('personal returns 0 when no candidate dim overlaps the profile', () => {
    const prof = { categorical: { make: { bmw: 1 } }, numeric: {} } as never
    expect(personal(prof, { categorical: {}, numeric: {} } as ItemAttrs)).toBe(0)
  })

  it('attrAffinity returns 0 with no shared dims and >0 when an affinity dim matches', () => {
    const lookup = (_d: string, x: string, y: string): number => (x === y ? 1 : 0)
    expect(
      attrAffinity(
        { categorical: {}, numeric: {} } as ItemAttrs,
        { categorical: {}, numeric: {} } as ItemAttrs,
        lookup,
      ),
    ).toBe(0)
    const anchor = { categorical: { make: 'bmw' }, numeric: {} } as ItemAttrs
    const cand = { categorical: { make: 'bmw' }, numeric: {} } as ItemAttrs
    expect(attrAffinity(anchor, cand, lookup)).toBeGreaterThan(0)
  })

  it('withinSessionReRank boosts matched make/bodyType/priceBand and leaves attr-less items unboosted', () => {
    const seen: SessionSeen = { makes: new Set(['bmw']), bodyTypes: new Set(['suv']), priceBands: new Set(['mid']) }
    const items = [{ id: 'none' }, { id: 'body' }, { id: 'full' }]
    const attrsOf = (it: { id: string }) =>
      it.id === 'full'
        ? { make: 'bmw', bodyType: 'suv', priceBand: 'mid' }
        : it.id === 'body'
          ? { bodyType: 'sedan' }
          : {}
    const out = withinSessionReRank(items, attrsOf, seen, 10)
    expect(out[0]!.id).toBe('full')
    expect(out.map(i => i.id)).toEqual(expect.arrayContaining(['none', 'body', 'full']))
  })
})
