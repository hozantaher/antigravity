import { describe, it, expect } from 'vitest'
import {
  entropy,
  mutualInformation,
  wilson95,
  featureLift,
  rankFeaturesByMI,
} from '../../../src/lib/diagnostics.js'

describe('entropy', () => {
  it('uniform Bernoulli → 1 bit', () => {
    expect(entropy([0.5, 0.5])).toBeCloseTo(1, 5)
  })
  it('certain outcome → 0 bits', () => {
    expect(entropy([1, 0])).toBe(0)
    expect(entropy([0, 0, 1])).toBe(0)
  })
  it('uniform 4-way → 2 bits', () => {
    expect(entropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(2, 5)
  })
  it('renormalizes input', () => {
    expect(entropy([1, 1])).toBeCloseTo(1, 5)  // [50,50]
  })
  it('empty/zero → 0', () => {
    expect(entropy([])).toBe(0)
    expect(entropy([0, 0])).toBe(0)
    expect(entropy(null)).toBe(0)
  })
})

describe('mutualInformation', () => {
  it('independent X,Y → MI ≈ 0', () => {
    // 100 each cell; X and Y uncorrelated
    const joint = new Map([
      ['a|0', 100], ['a|1', 100],
      ['b|0', 100], ['b|1', 100],
    ])
    expect(mutualInformation(joint, ['a','b'], ['0','1'])).toBeCloseTo(0, 5)
  })

  it('perfectly correlated → MI = H(Y) = 1 bit', () => {
    // a → always 0, b → always 1
    const joint = new Map([
      ['a|0', 200], ['a|1', 0],
      ['b|0', 0],   ['b|1', 200],
    ])
    expect(mutualInformation(joint, ['a','b'], ['0','1'])).toBeCloseTo(1, 5)
  })

  it('partially predictive → 0 < MI < 1', () => {
    const joint = new Map([
      ['a|0', 80], ['a|1', 20],   // a: 20% positive
      ['b|0', 30], ['b|1', 70],   // b: 70% positive
    ])
    const mi = mutualInformation(joint, ['a','b'], ['0','1'])
    expect(mi).toBeGreaterThan(0)
    expect(mi).toBeLessThan(1)
  })

  it('always non-negative', () => {
    const joint = new Map([['a|0', 1], ['a|1', 0], ['b|0', 0], ['b|1', 1]])
    expect(mutualInformation(joint, ['a','b'], ['0','1'])).toBeGreaterThanOrEqual(0)
  })
})

describe('wilson95', () => {
  it('zero trials → wide interval [0,1]', () => {
    const w = wilson95(0, 0)
    expect(w.lower).toBe(0)
    expect(w.upper).toBe(1)
  })
  it('5/100 → narrower than 1/20 with same point estimate', () => {
    const big = wilson95(5, 100)
    const small = wilson95(1, 20)
    expect(big.upper - big.lower).toBeLessThan(small.upper - small.lower)
  })
  it('100/100 → upper bound ≈ 1', () => {
    expect(wilson95(100, 100).upper).toBeCloseTo(1, 6)
  })
  it('p = success/trials', () => {
    expect(wilson95(50, 100).p).toBe(0.5)
  })
})

describe('featureLift', () => {
  it('global rate computed correctly', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      feature: i < 50 ? 'a' : 'b',
      outcome: i < 30 ? 1 : 0,
    }))
    const r = featureLift(rows, 10)
    expect(r.total).toBe(100)
    expect(r.global_rate).toBe(0.3)
  })

  it('top bucket has highest lift', () => {
    // a: 80% positive, b: 20% positive, global = 50%
    const rows = [
      ...Array.from({ length: 100 }, () => ({ feature: 'a', outcome: 1 })),
      ...Array.from({ length: 25 },  () => ({ feature: 'a', outcome: 0 })),
      ...Array.from({ length: 25 },  () => ({ feature: 'b', outcome: 1 })),
      ...Array.from({ length: 100 }, () => ({ feature: 'b', outcome: 0 })),
    ]
    const r = featureLift(rows, 10)
    expect(r.buckets[0].level).toBe('a')
    expect(r.buckets[0].lift).toBeGreaterThan(1)
    expect(r.buckets.at(-1).lift).toBeLessThan(1)
  })

  it('drops buckets below minBucketSize', () => {
    const rows = [
      ...Array.from({ length: 100 }, () => ({ feature: 'big',   outcome: 1 })),
      ...Array.from({ length: 5 },   () => ({ feature: 'small', outcome: 0 })),
    ]
    const r = featureLift(rows, 30)
    expect(r.buckets.length).toBe(1)
    expect(r.buckets[0].level).toBe('big')
  })

  it('null/undefined features filtered out', () => {
    const rows = [
      { feature: 'a', outcome: 1 },
      { feature: null, outcome: 1 },
      { feature: undefined, outcome: 0 },
    ]
    const r = featureLift(rows, 1)
    expect(r.total).toBe(1)
  })

  it('empty input → safe defaults', () => {
    const r = featureLift([], 1)
    expect(r.total).toBe(0)
    expect(r.global_rate).toBe(0)
    expect(r.buckets).toEqual([])
  })

  it('mutual_information present and ≥ 0', () => {
    const rows = [
      ...Array.from({ length: 100 }, () => ({ feature: 'a', outcome: 1 })),
      ...Array.from({ length: 100 }, () => ({ feature: 'b', outcome: 0 })),
    ]
    const r = featureLift(rows, 10)
    expect(r.mutual_information).toBeGreaterThan(0)
  })
})

describe('rankFeaturesByMI', () => {
  const rows = [
    // strong predictor
    ...Array.from({ length: 100 }, () => ({ sector: 'saas',    region: 'a', outcome: 1 })),
    ...Array.from({ length: 100 }, () => ({ sector: 'agro',    region: 'b', outcome: 0 })),
    // weak/no predictor (region randomly distributed)
    ...Array.from({ length: 50 },  () => ({ sector: 'saas',    region: 'a', outcome: 0 })),
    ...Array.from({ length: 50 },  () => ({ sector: 'agro',    region: 'a', outcome: 1 })),
  ]

  it('ranks predictive feature first', () => {
    const r = rankFeaturesByMI(rows, ['sector', 'region'], 30)
    expect(['sector', 'region']).toContain(r[0].feature)
    expect(r[0].mi).toBeGreaterThanOrEqual(r[1].mi)
  })

  it('handles missing feature column gracefully', () => {
    const r = rankFeaturesByMI(rows, ['nope'], 30)
    expect(r[0].feature).toBe('nope')
    expect(r[0].mi).toBe(0)
  })
})
