import { describe, it, expect } from 'vitest'
import {
  FEATURE_NAMES,
  featureVector,
  dot,
  magnitude,
  cosine,
  centroid,
  lookalikeScore,
} from '../../../src/lib/lookalike.js'

describe('featureVector', () => {
  it('returns a vector of length FEATURE_NAMES.length', () => {
    const v = featureVector({}, [])
    expect(v).toHaveLength(FEATURE_NAMES.length)
  })

  it('all values clamped to [0,1]', () => {
    const v = featureVector({
      icp_tier: 'ideal', velikost_firmy: 'small',
      email_confidence: 200, sector_confidence: 5,
      composite_score: 999, engagement_score: -1,
      email: 'a@b.cz', website: 'x.cz',
    })
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
    }
  })

  it('icp ideal=1, irrelevant=0', () => {
    const ideal = featureVector({ icp_tier: 'ideal' })
    const irrelevant = featureVector({ icp_tier: 'irrelevant' })
    expect(ideal[0]).toBe(1)
    expect(irrelevant[0]).toBe(0)
  })

  it('handles missing icp/size with sensible default', () => {
    const v = featureVector({})
    expect(v[0]).toBe(0.5)
    expect(v[1]).toBe(0.5)
  })

  it('extracts mx_enterprise from facts (Map)', () => {
    const facts = new Map([['mx_provider', 'google_workspace']])
    const v = featureVector({}, facts)
    expect(v[FEATURE_NAMES.indexOf('mx_enterprise')]).toBe(1)
  })

  it('extracts mx_enterprise from facts (array)', () => {
    const v = featureVector({}, [{ field: 'mx_provider', value: 'microsoft_365' }])
    expect(v[FEATURE_NAMES.indexOf('mx_enterprise')]).toBe(1)
  })

  it('seznam_cz / consumer MX → mx_enterprise=0', () => {
    const v = featureVector({}, [{ field: 'mx_provider', value: 'seznam_cz' }])
    expect(v[FEATURE_NAMES.indexOf('mx_enterprise')]).toBe(0)
  })

  it('SPF strict + DMARC reject reflected', () => {
    const v = featureVector({}, [
      { field: 'spf',   value: { spf_strict: true } },
      { field: 'dmarc', value: { dmarc_policy: 'reject' } },
    ])
    expect(v[FEATURE_NAMES.indexOf('spf_strict')]).toBe(1)
    expect(v[FEATURE_NAMES.indexOf('dmarc_strict')]).toBe(1)
  })

  it('DMARC p=none → dmarc_strict=0', () => {
    const v = featureVector({}, [
      { field: 'dmarc', value: { dmarc_policy: 'none' } },
    ])
    expect(v[FEATURE_NAMES.indexOf('dmarc_strict')]).toBe(0)
  })
})

describe('linalg primitives', () => {
  it('dot product correct', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32)
  })
  it('dot uses min length', () => {
    expect(dot([1, 2], [4, 5, 6, 7])).toBe(14)
  })
  it('magnitude of unit vec = 1', () => {
    expect(magnitude([1, 0, 0])).toBe(1)
  })
  it('magnitude of [3,4] = 5', () => {
    expect(magnitude([3, 4])).toBe(5)
  })
  it('cosine of identical vecs = 1', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6)
  })
  it('cosine of orthogonal = 0', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0)
  })
  it('cosine of zero vec = 0 (no NaN)', () => {
    expect(cosine([0, 0], [1, 2])).toBe(0)
    expect(cosine([1, 2], [0, 0])).toBe(0)
  })
})

describe('centroid', () => {
  it('mean of single vector is itself', () => {
    expect(centroid([[1, 2, 3]])).toEqual([1, 2, 3])
  })
  it('mean of [1,1] and [3,3] = [2,2]', () => {
    expect(centroid([[1, 1], [3, 3]])).toEqual([2, 2])
  })
  it('null/empty → null', () => {
    expect(centroid([])).toBeNull()
    expect(centroid(null)).toBeNull()
  })
})

describe('lookalikeScore', () => {
  const converters = [
    featureVector({ icp_tier: 'ideal',    velikost_firmy: 'medium', email: 'a@b.cz', website: 'x.cz', composite_score: 80, engagement_score: 0.4 }),
    featureVector({ icp_tier: 'good',     velikost_firmy: 'small',  email: 'a@b.cz', website: 'x.cz', composite_score: 70, engagement_score: 0.3 }),
    featureVector({ icp_tier: 'ideal',    velikost_firmy: 'medium', email: 'a@b.cz', website: 'x.cz', composite_score: 75, engagement_score: 0.5 }),
  ]
  const cen = centroid(converters)

  it('candidate matching converter pattern → high score', () => {
    const r = lookalikeScore(
      { icp_tier: 'ideal', velikost_firmy: 'medium', email: 'a@b.cz', website: 'x.cz', composite_score: 78, engagement_score: 0.4 },
      cen,
    )
    expect(r.score).toBeGreaterThan(80)
  })

  it('candidate very different from converters → lower score', () => {
    const lookalike = lookalikeScore(
      { icp_tier: 'ideal', velikost_firmy: 'medium', email: 'a@b.cz', website: 'x.cz', composite_score: 78 },
      cen,
    )
    const off = lookalikeScore(
      { icp_tier: 'irrelevant', velikost_firmy: 'micro', composite_score: 5, engagement_score: 0 },
      cen,
    )
    expect(off.score).toBeLessThan(lookalike.score)
  })

  it('null centroid → score 0 with no NaN', () => {
    const r = lookalikeScore({ icp_tier: 'ideal' }, null)
    expect(r.score).toBe(0)
    expect(r.similarity).toBe(0)
  })

  it('exposes per-feature components', () => {
    const r = lookalikeScore(
      { icp_tier: 'ideal', velikost_firmy: 'medium', email: 'a@b.cz', website: 'x.cz' },
      cen,
    )
    expect(Object.keys(r.components).sort()).toEqual([...FEATURE_NAMES].sort())
  })

  it('reflects parser version', () => {
    expect(lookalikeScore.version).toBe('lookalike_v1')
  })
})
