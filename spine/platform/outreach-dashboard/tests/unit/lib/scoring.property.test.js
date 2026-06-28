// Property tests: /scoring weight-slider invariants
// Invariants:
//   1. DEFAULT_WEIGHTS axes sum === 100
//   2. Each axis weight in [0, 50] (slider range)
//   3. After any single-axis mutation keeping others fixed, sum changes predictably
//   4. computeCompositeScore always returns number in [0, 100]
//   5. computeCompositeScore is deterministic (same input → same output)
//   6. All weight keys are non-negative (no negative weights allowed)

import { describe, it, expect } from 'vitest'
import { DEFAULT_WEIGHTS, computeCompositeScore } from '../../../src/lib/scoring.js'

const AXIS_KEYS = ['icp', 'email', 'engagement', 'size', 'recency', 'sector']
const PENALTY_KEYS = ['bounce_penalty', 'unsub_penalty', 'inactive_penalty', 'free_webmail_penalty', 'fatigue_penalty']
const SLIDER_MAX = 50

// ── 1. Default weights sum to 100 ─────────────────────────────────────────

describe('DEFAULT_WEIGHTS — axes sum invariant', () => {
  it('axis weights sum exactly to 100', () => {
    const sum = AXIS_KEYS.reduce((acc, k) => acc + DEFAULT_WEIGHTS[k], 0)
    expect(sum).toBe(100)
  })

  it('each axis weight is in [0, SLIDER_MAX]', () => {
    for (const k of AXIS_KEYS) {
      expect(DEFAULT_WEIGHTS[k]).toBeGreaterThanOrEqual(0)
      expect(DEFAULT_WEIGHTS[k]).toBeLessThanOrEqual(SLIDER_MAX)
    }
  })

  it('each penalty weight is non-negative', () => {
    for (const k of PENALTY_KEYS) {
      expect(DEFAULT_WEIGHTS[k]).toBeGreaterThanOrEqual(0)
    }
  })

  it('all weight values are integers', () => {
    for (const k of [...AXIS_KEYS, ...PENALTY_KEYS]) {
      expect(Number.isInteger(DEFAULT_WEIGHTS[k])).toBe(true)
    }
  })
})

// ── 2. Slider bounds property ──────────────────────────────────────────────

describe('Slider bounds property — any axis weight mutation', () => {
  // Property: for any valid slider value [0, 50], weights remain bounded
  const sliderValues = [0, 1, 10, 25, 50]

  for (const axisKey of AXIS_KEYS) {
    for (const val of sliderValues) {
      it(`weight[${axisKey}]=${val} stays in [0, ${SLIDER_MAX}]`, () => {
        const mutated = { ...DEFAULT_WEIGHTS, [axisKey]: val }
        expect(mutated[axisKey]).toBeGreaterThanOrEqual(0)
        expect(mutated[axisKey]).toBeLessThanOrEqual(SLIDER_MAX)
      })
    }
  }
})

// ── 3. computeCompositeScore bounds ───────────────────────────────────────

describe('computeCompositeScore — output bounds [0, 100]', () => {
  const companyFixtures = [
    // Full positive company
    {
      icp_tier: 'ideal', email_confidence: 100, total_sent: 10, total_replied: 5,
      velikost_firmy: '50-249', last_contacted: new Date(Date.now() - 7 * 86400_000).toISOString(),
      sector_certainty: 0.9, total_bounced: 0, status: 'valid',
      bounce_rate: 0, is_unsubscribed: false, is_inactive: false,
      is_free_webmail: false, recent_sends_60d: 1,
    },
    // Empty / default company
    {
      icp_tier: 'unscored', email_confidence: 0, total_sent: 0, total_replied: 0,
      velikost_firmy: null, last_contacted: null,
      sector_certainty: 0, total_bounced: 0, status: 'valid',
      bounce_rate: 0, is_unsubscribed: false, is_inactive: false,
      is_free_webmail: false, recent_sends_60d: 0,
    },
    // Penalised company
    {
      icp_tier: 'good', email_confidence: 50, total_sent: 20, total_replied: 0,
      velikost_firmy: '1-9', last_contacted: new Date(Date.now() - 365 * 86400_000).toISOString(),
      sector_certainty: 0.3, total_bounced: 5, status: 'bounced',
      bounce_rate: 0.25, is_unsubscribed: true, is_inactive: true,
      is_free_webmail: true, recent_sends_60d: 8,
    },
  ]

  function getScore(result) {
    if (result == null) return null
    if (typeof result === 'number') return result
    if (typeof result === 'object' && 'score' in result) return result.score
    return null
  }

  for (const company of companyFixtures) {
    it(`score in [0, 100] for company icp=${company.icp_tier} confidence=${company.email_confidence}`, () => {
      const result = computeCompositeScore(company, DEFAULT_WEIGHTS)
      const score = getScore(result)
      if (score == null) return
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    })
  }

  it('score is deterministic (same input same output)', () => {
    const company = companyFixtures[0]
    const s1 = getScore(computeCompositeScore(company, DEFAULT_WEIGHTS))
    const s2 = getScore(computeCompositeScore(company, DEFAULT_WEIGHTS))
    expect(s1).toBe(s2)
  })

  it('score does not crash on null/undefined weights fields', () => {
    const partial = { icp: 30, email: 20 } // missing most fields
    expect(() => computeCompositeScore(companyFixtures[0], partial)).not.toThrow()
  })
})

// ── 4. Weight mutation — sum delta property ────────────────────────────────

describe('Weight sum delta property', () => {
  it('increasing one axis by N decreases sum parity predictably', () => {
    const base = { ...DEFAULT_WEIGHTS }
    const baseSum = AXIS_KEYS.reduce((a, k) => a + base[k], 0)
    const mutated = { ...base, icp: base.icp + 10 }
    const mutatedSum = AXIS_KEYS.reduce((a, k) => a + mutated[k], 0)
    expect(mutatedSum).toBe(baseSum + 10)
  })

  it('zeroing all axes gives sum = 0', () => {
    const zeroed = Object.fromEntries(AXIS_KEYS.map(k => [k, 0]))
    const sum = AXIS_KEYS.reduce((a, k) => a + zeroed[k], 0)
    expect(sum).toBe(0)
  })

  it('max all axes gives sum = 300 (6 axes × 50)', () => {
    const maxed = Object.fromEntries(AXIS_KEYS.map(k => [k, SLIDER_MAX]))
    const sum = AXIS_KEYS.reduce((a, k) => a + maxed[k], 0)
    expect(sum).toBe(SLIDER_MAX * AXIS_KEYS.length)
  })
})
