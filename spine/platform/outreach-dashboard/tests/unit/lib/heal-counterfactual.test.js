// HXX2 — Counterfactual heal validation.
// Use existing ShadowRunner (src/test/chaos-sim.js) to compare metric outcome
// of "heal applied" vs "heal NOT applied". Heal is net-positive iff metric
// improves by ≥ ε. Builds on heal-rollback HealStrategyScorer for bookkeeping.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { ShadowRunner } from '../../helpers/chaos-sim.js'
import {
  evaluateCounterfactual,
  classifyDelta,
  COUNTERFACTUAL_VERDICTS,
} from '../../../src/lib/heal-counterfactual.js'

describe('HXX2 — classifyDelta', () => {
  it('positive delta > epsilon → "net_positive"', () => {
    expect(classifyDelta(10, 0.5)).toBe(COUNTERFACTUAL_VERDICTS.NET_POSITIVE)
  })

  it('negative delta < -epsilon → "net_negative"', () => {
    expect(classifyDelta(-10, 0.5)).toBe(COUNTERFACTUAL_VERDICTS.NET_NEGATIVE)
  })

  it('|delta| within ε → "no_op"', () => {
    expect(classifyDelta(0.3, 0.5)).toBe(COUNTERFACTUAL_VERDICTS.NO_OP)
    expect(classifyDelta(-0.3, 0.5)).toBe(COUNTERFACTUAL_VERDICTS.NO_OP)
  })

  it('boundary delta = ε exactly → "no_op"', () => {
    expect(classifyDelta(0.5, 0.5)).toBe(COUNTERFACTUAL_VERDICTS.NO_OP)
  })

  it('boundary delta = ε + 0.001 → "net_positive"', () => {
    expect(classifyDelta(0.501, 0.5)).toBe(COUNTERFACTUAL_VERDICTS.NET_POSITIVE)
  })

  it('NaN delta → "indeterminate"', () => {
    expect(classifyDelta(NaN, 0.5)).toBe(COUNTERFACTUAL_VERDICTS.INDETERMINATE)
  })

  it('Infinity delta → "indeterminate"', () => {
    expect(classifyDelta(Infinity, 0.5)).toBe(COUNTERFACTUAL_VERDICTS.INDETERMINATE)
  })

  it('default epsilon = 1', () => {
    expect(classifyDelta(0.5)).toBe(COUNTERFACTUAL_VERDICTS.NO_OP)
    expect(classifyDelta(1.5)).toBe(COUNTERFACTUAL_VERDICTS.NET_POSITIVE)
  })
})

describe('HXX2 — evaluateCounterfactual via ShadowRunner', () => {
  it('heal that improves metric → net_positive', () => {
    const sr = new ShadowRunner({ initialState: { x: 0 } })
    // Primary: heal applied → x becomes 100
    // Shadow:  heal NOT applied → x stays 0
    const result = evaluateCounterfactual({
      shadowRunner: sr,
      primaryFn: () => ({ x: 100 }),
      shadowFn: () => ({ x: 0 }),
      metric: (s) => s.x,
      epsilon: 1,
    })
    expect(result.verdict).toBe(COUNTERFACTUAL_VERDICTS.NET_POSITIVE)
    expect(result.delta).toBe(100)
  })

  it('heal that worsens metric → net_negative', () => {
    const sr = new ShadowRunner({ initialState: { x: 50 } })
    const result = evaluateCounterfactual({
      shadowRunner: sr,
      primaryFn: () => ({ x: 0 }),    // heal made things worse
      shadowFn: () => ({ x: 50 }),    // no-heal stayed at 50
      metric: (s) => s.x,
      epsilon: 1,
    })
    expect(result.verdict).toBe(COUNTERFACTUAL_VERDICTS.NET_NEGATIVE)
    expect(result.delta).toBeLessThan(0)
  })

  it('heal that does nothing measurable → no_op', () => {
    const sr = new ShadowRunner({ initialState: { x: 50 } })
    const result = evaluateCounterfactual({
      shadowRunner: sr,
      primaryFn: () => ({ x: 50.2 }),
      shadowFn: () => ({ x: 50 }),
      metric: (s) => s.x,
      epsilon: 1,
    })
    expect(result.verdict).toBe(COUNTERFACTUAL_VERDICTS.NO_OP)
  })

  it('returns delta = primary - shadow', () => {
    const sr = new ShadowRunner({ initialState: {} })
    const result = evaluateCounterfactual({
      shadowRunner: sr,
      primaryFn: () => ({ score: 80 }),
      shadowFn: () => ({ score: 50 }),
      metric: (s) => s.score,
    })
    expect(result.delta).toBe(30)
    expect(result.primary).toBe(80)
    expect(result.shadow).toBe(50)
  })

  it('captures both states in result for forensics', () => {
    const sr = new ShadowRunner({ initialState: {} })
    const result = evaluateCounterfactual({
      shadowRunner: sr,
      primaryFn: () => ({ x: 1, y: 2 }),
      shadowFn: () => ({ x: 0, y: 1 }),
      metric: (s) => s.x,
    })
    expect(result.primaryState).toEqual({ x: 1, y: 2 })
    expect(result.shadowState).toEqual({ x: 0, y: 1 })
  })

  it('metric returning NaN → indeterminate', () => {
    const sr = new ShadowRunner({ initialState: {} })
    const result = evaluateCounterfactual({
      shadowRunner: sr,
      primaryFn: () => ({ x: NaN }),
      shadowFn: () => ({ x: 50 }),
      metric: (s) => s.x,
    })
    expect(result.verdict).toBe(COUNTERFACTUAL_VERDICTS.INDETERMINATE)
  })

  it('metric throwing → indeterminate (defensive)', () => {
    const sr = new ShadowRunner({ initialState: {} })
    const result = evaluateCounterfactual({
      shadowRunner: sr,
      primaryFn: () => ({ x: 1 }),
      shadowFn: () => ({ x: 1 }),
      metric: () => { throw new Error('boom') },
    })
    expect(result.verdict).toBe(COUNTERFACTUAL_VERDICTS.INDETERMINATE)
  })
})

describe('HXX2 — Heal strategy demotion via repeated counterfactuals', () => {
  it('strategy with consistent net_positive → maintains rank', () => {
    const sr = new ShadowRunner({ initialState: {} })
    let demotionVotes = 0
    for (let i = 0; i < 10; i++) {
      const r = evaluateCounterfactual({
        shadowRunner: sr,
        primaryFn: () => ({ x: 100 }),
        shadowFn: () => ({ x: 0 }),
        metric: (s) => s.x,
      })
      if (r.verdict !== COUNTERFACTUAL_VERDICTS.NET_POSITIVE) demotionVotes++
    }
    expect(demotionVotes).toBe(0)
  })

  it('strategy with 6/10 net_negative → flagged for demotion', () => {
    const sr = new ShadowRunner({ initialState: {} })
    let negCount = 0
    for (let i = 0; i < 10; i++) {
      const isNeg = i < 6
      const r = evaluateCounterfactual({
        shadowRunner: sr,
        primaryFn: () => ({ x: isNeg ? 0 : 100 }),
        shadowFn: () => ({ x: 50 }),
        metric: (s) => s.x,
      })
      if (r.verdict === COUNTERFACTUAL_VERDICTS.NET_NEGATIVE) negCount++
    }
    expect(negCount).toBeGreaterThanOrEqual(6)
  })
})

describe('HXX2 — Properties', () => {
  it('property: classifyDelta is symmetric in epsilon', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -100, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 10, noNaN: true }),
        (delta, epsilon) => {
          const v = classifyDelta(delta, epsilon)
          // For any delta and -delta, classification flips between
          // net_positive and net_negative (or both no_op)
          const = classifyDelta(-delta, epsilon)
          if (v === COUNTERFACTUAL_VERDICTS.NET_POSITIVE) {
            return === COUNTERFACTUAL_VERDICTS.NET_NEGATIVE
          }
          if (v === COUNTERFACTUAL_VERDICTS.NET_NEGATIVE) {
            return === COUNTERFACTUAL_VERDICTS.NET_POSITIVE
          }
          return v === COUNTERFACTUAL_VERDICTS.NO_OP && === COUNTERFACTUAL_VERDICTS.NO_OP
        }
      ),
      { numRuns: 200 }
    )
  })

  it('property: evaluateCounterfactual is deterministic for pure metric+fns', () => {
    const sr = new ShadowRunner({ initialState: {} })
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 }),
        (a, b) => {
          const r1 = evaluateCounterfactual({
            shadowRunner: sr,
            primaryFn: () => ({ x: a }),
            shadowFn:  () => ({ x: b }),
            metric: (s) => s.x,
          })
          const r2 = evaluateCounterfactual({
            shadowRunner: sr,
            primaryFn: () => ({ x: a }),
            shadowFn:  () => ({ x: b }),
            metric: (s) => s.x,
          })
          return r1.verdict === r2.verdict && r1.delta === r2.delta
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('HXX2 — Defensive inputs', () => {
  it('missing primaryFn → throws', () => {
    expect(() => evaluateCounterfactual({
      shadowRunner: new ShadowRunner({ initialState: {} }),
      shadowFn: () => ({}),
      metric: (s) => 0,
    })).toThrow(/primaryFn/i)
  })

  it('missing shadowFn → throws', () => {
    expect(() => evaluateCounterfactual({
      shadowRunner: new ShadowRunner({ initialState: {} }),
      primaryFn: () => ({}),
      metric: (s) => 0,
    })).toThrow(/shadowFn/i)
  })

  it('missing metric → throws', () => {
    expect(() => evaluateCounterfactual({
      shadowRunner: new ShadowRunner({ initialState: {} }),
      primaryFn: () => ({}),
      shadowFn: () => ({}),
    })).toThrow(/metric/i)
  })
})
