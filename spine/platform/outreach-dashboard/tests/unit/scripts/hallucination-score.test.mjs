// A6 — hallucination-score aggregator tests.

import { describe, it, expect } from 'vitest'
import {
  computeScore,
  scoreLinkage,
  scoreAssertionDensity,
  scoreFixtureDrift,
  scoreNoSignal,
  scoreMutation,
  scoreFlaky,
  severityOf,
} from '../../../scripts/hallucination-score.mjs'

describe('severityOf', () => {
  it('T-1: >=85 → green', () => expect(severityOf(85)).toBe('green'))
  it('T-2: 70..84 → yellow', () => expect(severityOf(75)).toBe('yellow'))
  it('T-3: 50..69 → orange', () => expect(severityOf(60)).toBe('orange'))
  it('T-4: <50 → red', () => expect(severityOf(40)).toBe('red'))
})

describe('scoreLinkage', () => {
  it('T-5: 0% orphans → 100', () => {
    const r = scoreLinkage({ summary: { orphan_pct: 0 } })
    expect(r.value).toBe(100)
  })

  it('T-6: 5% orphans → 90', () => {
    const r = scoreLinkage({ summary: { orphan_pct: 5 } })
    expect(r.value).toBe(90)
  })

  it('T-7: 50% orphans → 0', () => {
    const r = scoreLinkage({ summary: { orphan_pct: 50 } })
    expect(r.value).toBe(0)
  })

  it('T-8: missing summary → null value', () => {
    expect(scoreLinkage(null).value).toBe(null)
  })
})

describe('scoreAssertionDensity', () => {
  it('T-9: 0% low-density + 0 tautology → 100', () => {
    const r = scoreAssertionDensity({ summary: { low_density_pct: 0, tautology_blocks: 0, test_blocks: 100 } })
    expect(r.value).toBe(100)
  })

  it('T-10: 50% low-density → 50', () => {
    const r = scoreAssertionDensity({ summary: { low_density_pct: 50, tautology_blocks: 0, test_blocks: 100 } })
    expect(r.value).toBe(50)
  })

  it('T-11: tautology blocks add penalty', () => {
    const a = scoreAssertionDensity({ summary: { low_density_pct: 0, tautology_blocks: 0, test_blocks: 100 } })
    const b = scoreAssertionDensity({ summary: { low_density_pct: 0, tautology_blocks: 5, test_blocks: 100 } })
    expect(b.value).toBeLessThan(a.value)
  })
})

describe('scoreFixtureDrift', () => {
  it('T-12: all reachable → 100', () => {
    const r = scoreFixtureDrift({ summary: { reachable: 10, endpoints: 10 } })
    expect(r.value).toBe(100)
  })

  it('T-13: half reachable → 50', () => {
    const r = scoreFixtureDrift({ summary: { reachable: 5, endpoints: 10 } })
    expect(r.value).toBe(50)
  })

  it('T-14: zero endpoints defaults to 100 (n/a)', () => {
    const r = scoreFixtureDrift({ summary: { reachable: 0, endpoints: 0 } })
    expect(r.value).toBe(100)
  })
})

describe('scoreNoSignal', () => {
  it('T-15: 0 no-signal in 10 → 100', () => {
    const r = scoreNoSignal({ findings: Array(10).fill({ kind: 'good-signal' }) })
    expect(r.value).toBe(100)
  })

  it('T-16: 5/10 no-signal → 50', () => {
    const r = scoreNoSignal({ findings: [
      ...Array(5).fill({ kind: 'no-signal' }),
      ...Array(5).fill({ kind: 'good-signal' }),
    ] })
    expect(r.value).toBe(50)
  })

  it('T-17: empty findings → 100 (n/a)', () => {
    const r = scoreNoSignal({ findings: [] })
    expect(r.value).toBe(100)
  })
})

describe('scoreMutation', () => {
  it('T-18: 90% kill rate → 90', () => {
    const r = scoreMutation({ mutationScore: 90 })
    expect(r.value).toBe(90)
  })

  it('T-19: missing report → null', () => {
    expect(scoreMutation(null).value).toBe(null)
  })

  it('T-20: killRate alias accepted', () => {
    const r = scoreMutation({ killRate: 80 })
    expect(r.value).toBe(80)
  })
})

describe('scoreFlaky', () => {
  it('T-21: 0 quarantined → 100', () => {
    const r = scoreFlaky({ quarantined: [], total: 100 })
    expect(r.value).toBe(100)
  })

  it('T-22: 1 quarantined per 200 tests → 99', () => {
    const r = scoreFlaky({ quarantined: ['x'], total: 200 })
    expect(r.value).toBe(99)
  })
})

describe('computeScore', () => {
  it('T-23: all-green inputs → score >= 95', () => {
    const r = computeScore({
      mutation: { mutationScore: 95 },
      linkage: { summary: { orphan_pct: 0 } },
      assertion: { summary: { low_density_pct: 0, tautology_blocks: 0, test_blocks: 100 } },
      fixtureDrift: { summary: { reachable: 10, endpoints: 10 } },
      noSignal: { findings: Array(10).fill({ kind: 'good-signal' }) },
      flaky: { quarantined: [], total: 100 },
    })
    expect(r.score).toBeGreaterThanOrEqual(95)
    expect(r.severity).toBe('green')
  })

  it('T-24: redistributes weight when components missing', () => {
    const r = computeScore({
      mutation: null,
      linkage: { summary: { orphan_pct: 0 } },
      assertion: { summary: { low_density_pct: 0, tautology_blocks: 0, test_blocks: 100 } },
      fixtureDrift: null,
      noSignal: null,
      flaky: null,
    })
    expect(r.score).toBe(100)
  })

  it('T-25: severity reflects total score', () => {
    const r = computeScore({
      mutation: { mutationScore: 30 },
      linkage: { summary: { orphan_pct: 50 } },
      assertion: { summary: { low_density_pct: 100, tautology_blocks: 0, test_blocks: 100 } },
      fixtureDrift: { summary: { reachable: 0, endpoints: 10 } },
      noSignal: { findings: [{ kind: 'no-signal' }] },
      flaky: { quarantined: ['a','b','c','d','e'], total: 100 },
    })
    expect(r.severity).toBe('red')
  })

  it('T-26: returns components + breakdown for dashboard', () => {
    const r = computeScore({})
    expect(r).toHaveProperty('components')
    expect(r.components).toHaveProperty('linkage')
    expect(r.components).toHaveProperty('mutation')
  })
})
