import { describe, it, expect } from 'vitest'
import {
  findCohort,
  aggregateCohorts,
  COHORT_LEVELS,
  DEFAULT_MIN_SAMPLE,
} from '../../../src/lib/cohort.js'

const sampleRows = [
  // saas|small|ideal — 5 companies, 250 sends, 25 replies → reply 10%
  ...Array.from({ length: 5 }, () => ({
    sector: 'saas', size: 'small', icp_tier: 'ideal',
    sends: 50, replies: 5, opens: 20, clicks: 3, bounces: 1, conversions: 1,
  })),
  // saas|small|good — 3 companies, 90 sends, 3 replies → reply 3.3%
  ...Array.from({ length: 3 }, () => ({
    sector: 'saas', size: 'small', icp_tier: 'good',
    sends: 30, replies: 1, opens: 6, clicks: 0, bounces: 0, conversions: 0,
  })),
  // manufacturing|large|ideal — 1 company, 50 sends, 1 reply → 2%
  { sector: 'manufacturing', size: 'large', icp_tier: 'ideal',
    sends: 50, replies: 1, opens: 5, clicks: 0, bounces: 0, conversions: 0 },
]

describe('aggregateCohorts — per-level rollup', () => {
  it('produces 4 keys per row (one per level)', () => {
    const byKey = aggregateCohorts([sampleRows[0]])
    expect(byKey.size).toBe(COHORT_LEVELS.length)
  })

  it('parent level sums child level totals', () => {
    const byKey = aggregateCohorts(sampleRows)
    const sectorTotal = byKey.get('sector:saas')
    // saas|small|ideal: 5×50=250 sends. saas|small|good: 3×30=90. saas total=340.
    expect(sectorTotal.sends).toBe(340)
    expect(sectorTotal.replies).toBe(28)  // 5×5 + 3×1
  })

  it('global level sums all rows', () => {
    const byKey = aggregateCohorts(sampleRows)
    const g = byKey.get('global:')
    expect(g.sends).toBe(390) // 250 + 90 + 50
    expect(g.replies).toBe(29)
  })
})

describe('findCohort — fallback walks up the hierarchy', () => {
  const byKey = aggregateCohorts(sampleRows)

  it('returns most-specific cohort when sample suffices', () => {
    const c = { sector: 'saas', size: 'small', icp_tier: 'ideal' }
    const r = findCohort(c, byKey, 100)  // need ≥100 sends
    expect(r.level).toBe('sector_size_icp')
    expect(r.sample).toBe(250)
    expect(r.rates.replyRate).toBeCloseTo(0.1, 3)
  })

  it('falls back to sector_size when ICP cohort is too small', () => {
    const c = { sector: 'saas', size: 'small', icp_tier: 'good' }
    const r = findCohort(c, byKey, 100)  // good cohort 90 < 100, falls back
    expect(r.level).toBe('sector_size')
    expect(r.sample).toBe(340)
  })

  it('falls back to sector when sector_size too small', () => {
    const c = { sector: 'saas', size: 'medium', icp_tier: 'ideal' }
    const r = findCohort(c, byKey, 100)  // medium has no rows → sector
    expect(r.level).toBe('sector')
  })

  it('falls back to global when sector unknown', () => {
    const c = { sector: 'gov', size: 'large', icp_tier: 'ideal' }
    const r = findCohort(c, byKey, 100)
    expect(r.level).toBe('global')
    expect(r.sample).toBe(390)
  })

  it('returns null when even global is below minSample', () => {
    const c = { sector: 'saas', size: 'small', icp_tier: 'ideal' }
    const r = findCohort(c, byKey, 99999)
    expect(r).toBeNull()
  })

  it('null/empty cohort dimension treated as wildcard', () => {
    const c = { sector: 'saas', size: null, icp_tier: 'ideal' }
    const r = findCohort(c, byKey, 100)
    // sector_size_icp key 'saas|*|ideal' has no data → falls back
    expect(r.level).not.toBe('sector_size_icp')
  })

  it('rates are bounded to [0, 1] even with noisy stats', () => {
    const noisy = new Map([
      ['global:', { sends: 10, replies: 999, opens: 10, clicks: 10, bounces: 10, conversions: 10 }],
    ])
    const r = findCohort({ sector: 'x', size: 'y', icp_tier: 'z' }, noisy, 1)
    expect(r.rates.replyRate).toBe(1)
  })
})

describe('DEFAULT_MIN_SAMPLE — guard against tiny-cohort hallucination', () => {
  it('is at least 100 sends', () => {
    expect(DEFAULT_MIN_SAMPLE).toBeGreaterThanOrEqual(100)
  })
})
