import { describe, it, expect } from 'vitest'
import {
  computeCompositeScore,
  scoreTier,
  tierColor,
  scoreColor,
  axisEngagement,
  axisRecency,
  bouncePenaltyRatio,
  bayesianRate,
  fatiguePenaltyRatio,
  computeExpectedValueScore,
  SIZE_DEAL_PROXY,
  DEFAULT_WEIGHTS,
  ENGAGEMENT_PRIORS,
} from '../../../src/lib/scoring.js'

describe('scoreTier', () => {
  it('maps scores to S/A/B/C/D bands', () => {
    expect(scoreTier(100)).toBe('S')
    expect(scoreTier(80)).toBe('S')
    expect(scoreTier(79)).toBe('A')
    expect(scoreTier(65)).toBe('A')
    expect(scoreTier(64)).toBe('B')
    expect(scoreTier(45)).toBe('B')
    expect(scoreTier(44)).toBe('C')
    expect(scoreTier(25)).toBe('C')
    expect(scoreTier(24)).toBe('D')
    expect(scoreTier(0)).toBe('D')
  })
})

describe('axisEngagement (Bayesian shrinkage)', () => {
  it('returns prior mean when no sends (not 0)', () => {
    const r = axisEngagement({ total_sent: 0, total_replied: 0, total_opened: 0 })
    // With 0 sends, posterior collapses to prior: 0.7*replyRate + 0.3*openRate
    const expected = 0.7 * ENGAGEMENT_PRIORS.replyRate + 0.3 * ENGAGEMENT_PRIORS.openRate
    expect(r).toBeCloseTo(expected, 3)
  })

  it('shrinks 1/1 toward prior (no overconfidence)', () => {
    // Naïve rate = 1.0 (100% reply) — Bayesian should pull it down
    const r = axisEngagement({ total_sent: 1, total_replied: 1, total_opened: 1 })
    expect(r).toBeLessThan(0.5)   // not "100%"
    expect(r).toBeGreaterThan(0.05)
  })

  it('large N: posterior ≈ empirical rate', () => {
    // 1000 sends, 200 replied, 500 opened — prior wash-out regime
    const r = axisEngagement({ total_sent: 1000, total_replied: 200, total_opened: 500 })
    // Empirical: 0.7*0.2 + 0.3*0.5 = 0.14 + 0.15 = 0.29
    expect(r).toBeCloseTo(0.29, 1)
  })

  it('custom priors override defaults', () => {
    // Pretend sector prior: 10% reply, 40% open
    const r = axisEngagement(
      { total_sent: 0, total_replied: 0, total_opened: 0 },
      { replyRate: 0.10, openRate: 0.40, priorStrength: 20 },
    )
    expect(r).toBeCloseTo(0.7 * 0.10 + 0.3 * 0.40, 3)
  })
})

describe('bayesianRate', () => {
  it('empty trials returns prior mean', () => {
    expect(bayesianRate(0, 0, 0.03, 20)).toBeCloseTo(0.03, 5)
  })
  it('huge N: converges to empirical rate', () => {
    expect(bayesianRate(300, 1000, 0.03, 20)).toBeCloseTo(0.3, 1)
  })
  it('1/1 observation shrinks toward prior, not to 1', () => {
    const r = bayesianRate(1, 1, 0.03, 20)
    expect(r).toBeLessThan(0.2)
    expect(r).toBeGreaterThan(0.03)
  })
  it('strength=0 (no prior) gives raw rate', () => {
    expect(bayesianRate(3, 10, 0.03, 0.001)).toBeCloseTo(0.3, 2)
  })
})

describe('axisRecency', () => {
  it('returns 1 for contact today', () => {
    expect(axisRecency({ last_contacted: new Date().toISOString() }, 30)).toBeCloseTo(1, 2)
  })
  it('halves at halflife', () => {
    const d = new Date(Date.now() - 30 * 86400000).toISOString()
    expect(axisRecency({ last_contacted: d }, 30)).toBeCloseTo(0.5, 2)
  })
  it('returns 0.5 when never contacted (neutral prior)', () => {
    expect(axisRecency({ last_contacted: null }, 30)).toBe(0.5)
  })
})

describe('fatiguePenaltyRatio', () => {
  it('0 below threshold', () => {
    expect(fatiguePenaltyRatio({ recent_60d_count: 0 })).toBe(0)
    expect(fatiguePenaltyRatio({ recent_60d_count: 2 })).toBe(0)
  })
  it('starts ramping at threshold (3 → 0.2 with default 3..7)', () => {
    expect(fatiguePenaltyRatio({ recent_60d_count: 3 })).toBeCloseTo(0.2, 3)
  })
  it('saturates at upper bound', () => {
    expect(fatiguePenaltyRatio({ recent_60d_count: 7 })).toBe(1)
    expect(fatiguePenaltyRatio({ recent_60d_count: 99 })).toBe(1)
  })
  it('linear midpoint (5 → 0.6)', () => {
    expect(fatiguePenaltyRatio({ recent_60d_count: 5 })).toBeCloseTo(0.6, 3)
  })
  it('respects custom threshold/saturation', () => {
    expect(fatiguePenaltyRatio({ recent_60d_count: 4 }, 5, 10)).toBe(0)
    expect(fatiguePenaltyRatio({ recent_60d_count: 5 }, 5, 10)).toBeCloseTo(1 / 6, 3)
    expect(fatiguePenaltyRatio({ recent_60d_count: 10 }, 5, 10)).toBe(1)
  })
  it('handles missing field as 0', () => {
    expect(fatiguePenaltyRatio({})).toBe(0)
  })
})

describe('computeCompositeScore + fatigue', () => {
  it('subtracts fatigue penalty proportionally', () => {
    const base = { icp_tier: 'good', email_confidence: 80, velikost_firmy: 'small', email: 'a@b.cz' }
    const fresh   = computeCompositeScore({ ...base, recent_60d_count: 0 }).score
    const fatigued = computeCompositeScore({ ...base, recent_60d_count: 7 }).score
    expect(fresh - fatigued).toBe(DEFAULT_WEIGHTS.fatigue_penalty)
  })
  it('zero fatigue when contact below threshold', () => {
    const base = { icp_tier: 'good', email_confidence: 80, velikost_firmy: 'small', email: 'a@b.cz' }
    const a = computeCompositeScore({ ...base, recent_60d_count: 0 }).score
    const b = computeCompositeScore({ ...base, recent_60d_count: 2 }).score
    expect(a).toBe(b)
  })
})

describe('bouncePenaltyRatio', () => {
  it('0 when no sends', () => {
    expect(bouncePenaltyRatio({ total_sent: 0, total_bounced: 0 })).toBe(0)
  })
  it('ratio bounced/sent', () => {
    expect(bouncePenaltyRatio({ total_sent: 10, total_bounced: 3 })).toBeCloseTo(0.3, 3)
  })
})

describe('computeCompositeScore', () => {
  it('ideal company scores high', () => {
    const { score, tier } = computeCompositeScore({
      icp_tier: 'ideal', email_confidence: 90, sector_confidence: 0.9,
      velikost_firmy: 'small', total_sent: 10, total_replied: 5, total_opened: 8,
      last_contacted: new Date().toISOString(),
      email: 'sales@company.cz',
    })
    expect(score).toBeGreaterThan(80)
    expect(tier).toBe('S')
  })

  it('irrelevant+inactive scores very low', () => {
    const { score, tier } = computeCompositeScore({
      icp_tier: 'irrelevant', email_confidence: 0, sector_confidence: 0,
      velikost_firmy: 'micro', total_sent: 0,
      v_likvidaci: true,
      email: 'info@gmail.com',
    })
    expect(score).toBeLessThanOrEqual(15)
    expect(tier).toBe('D')
  })

  it('unsub penalty applied', () => {
    const base = { icp_tier: 'good', email_confidence: 80, velikost_firmy: 'small', sector_confidence: 0.7, email: 'a@corp.cz' }
    const good = computeCompositeScore(base).score
    const bad  = computeCompositeScore({ ...base, contact_status: 'unsubscribed' }).score
    expect(bad).toBe(Math.max(0, good - DEFAULT_WEIGHTS.unsub_penalty))
  })

  it('free webmail penalty only on free domain', () => {
    const base = { icp_tier: 'good', email_confidence: 80, velikost_firmy: 'small' }
    const biz  = computeCompositeScore({ ...base, email: 'sales@company.cz' }).score
    const free = computeCompositeScore({ ...base, email: 'sales@gmail.com' }).score
    expect(biz - free).toBe(DEFAULT_WEIGHTS.free_webmail_penalty)
  })

  it('returns components with axes_raw', () => {
    const r = computeCompositeScore({
      icp_tier: 'good', email_confidence: 50, sector_confidence: 0.5,
      velikost_firmy: 'small', total_sent: 0,
    })
    expect(r.components).toHaveProperty('icp')
    expect(r.components).toHaveProperty('penalties')
    expect(r.components.axes_raw.icp).toBeCloseTo(0.6, 2)
    expect(r.components.axes_raw.email).toBeCloseTo(0.5, 2)
  })

  it('bounce penalty scales with bounce rate', () => {
    const base = { icp_tier: 'good', email_confidence: 80, velikost_firmy: 'small', email: 'a@b.cz', total_sent: 10, total_replied: 0, total_opened: 0 }
    const clean = computeCompositeScore({ ...base, total_bounced: 0 }).score
    const bouncy = computeCompositeScore({ ...base, total_bounced: 5 }).score
    expect(Math.abs(clean - bouncy - 0.5 * DEFAULT_WEIGHTS.bounce_penalty)).toBeLessThanOrEqual(1)
  })

  it('custom weights override defaults', () => {
    const c = { icp_tier: 'ideal', email_confidence: 0, velikost_firmy: 'small', email: 'a@b.cz' }
    const d = computeCompositeScore(c).score
    const heavy = computeCompositeScore(c, { ...DEFAULT_WEIGHTS, icp: 100, email: 0, engagement: 0, size: 0, recency: 0, sector: 0 }).score
    expect(heavy).toBe(100)
    expect(heavy).toBeGreaterThan(d)
  })

  it('score clamped to [0,100]', () => {
    const r = computeCompositeScore({ icp_tier: 'irrelevant' }, { ...DEFAULT_WEIGHTS, unsub_penalty: 1000 })
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })
})

describe('computeExpectedValueScore — propensity × deal-size proxy', () => {
  const ideal = { icp_tier: 'ideal', email_confidence: 100, email: 'a@firma.cz', sector_confidence: 1 }

  it('larger size beats smaller size at equal propensity', () => {
    const small = computeExpectedValueScore({ ...ideal, velikost_firmy: 'small' })
    const large = computeExpectedValueScore({ ...ideal, velikost_firmy: 'large' })
    expect(large.ev_score).toBeGreaterThan(small.ev_score)
    expect(large.size_proxy).toBe(SIZE_DEAL_PROXY.large)
  })

  it('large × low-prop can beat micro × high-prop on EV (size matters)', () => {
    const microHigh = computeExpectedValueScore({ ...ideal, velikost_firmy: 'micro' })
    const largeWeak = computeExpectedValueScore({
      icp_tier: 'irrelevant', email: 'a@b.cz', velikost_firmy: 'large',
    })
    // micro 1×0.72=0.72 vs large 20×0.14=2.8 — EV ranking favors size
    expect(largeWeak.deal_value_estimate).toBeGreaterThan(microHigh.deal_value_estimate)
    expect(microHigh.composite_score).toBeGreaterThan(largeWeak.composite_score)
  })

  it('unknown size falls back to default proxy', () => {
    const r = computeExpectedValueScore({ ...ideal, velikost_firmy: '' })
    expect(r.size_proxy).toBe(2)
  })

  it('ev_score in [0,100]', () => {
    for (const v of ['micro','small','medium','large','enterprise','']) {
      const r = computeExpectedValueScore({ ...ideal, velikost_firmy: v })
      expect(r.ev_score).toBeGreaterThanOrEqual(0)
      expect(r.ev_score).toBeLessThanOrEqual(100)
    }
  })

  it('returns propensity matching composite/100', () => {
    const r = computeExpectedValueScore({ ...ideal, velikost_firmy: 'medium' })
    expect(r.propensity).toBeCloseTo(r.composite_score / 100, 2)
  })
})

describe('color helpers', () => {
  it('tierColor maps S/A green, B yellow, C orange, D muted', () => {
    expect(tierColor('S')).toContain('green')
    expect(tierColor('A')).toContain('green')
    expect(tierColor('B')).toContain('yellow')
    expect(tierColor('C')).toContain('orange')
    expect(tierColor('D')).toContain('muted')
  })
  it('scoreColor by band', () => {
    expect(scoreColor(null)).toContain('muted')
    expect(scoreColor(90)).toContain('green')
    expect(scoreColor(50)).toContain('yellow')
    expect(scoreColor(30)).toContain('orange')
    expect(scoreColor(10)).toContain('red')
  })
})
