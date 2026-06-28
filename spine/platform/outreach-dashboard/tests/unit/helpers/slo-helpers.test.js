// SHARED-1 — SLO helpers tests (TDD RED first).
// Pure functions used across HX5, HXX3, HXX5.

import { describe, it, expect } from 'vitest'
import {
  percentile,
  assertPercentile,
  assertHistogramBounded,
  assertConvergence,
  assertMonotonic,
  assertNoStateOscillation,
} from '../../helpers/slo-helpers.js'

describe('percentile', () => {
  it('P0 returns min', () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1)
  })

  it('P100 returns max', () => {
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5)
  })

  it('P50 returns median (odd)', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
  })

  it('P50 returns median (even)', () => {
    // linear interpolation between 2 and 3
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 5)
  })

  it('P99 of 100 sorted values returns ~99', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(arr, 99)).toBeGreaterThanOrEqual(98)
    expect(percentile(arr, 99)).toBeLessThanOrEqual(100)
  })

  it('handles unsorted input (sorts internally)', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3)
  })

  it('throws on empty array', () => {
    expect(() => percentile([], 50)).toThrow(/empty/i)
  })

  it('throws on out-of-range percentile', () => {
    expect(() => percentile([1, 2], -1)).toThrow(/range/i)
    expect(() => percentile([1, 2], 101)).toThrow(/range/i)
  })

  it('handles single-element array', () => {
    expect(percentile([42], 50)).toBe(42)
    expect(percentile([42], 99)).toBe(42)
  })
})

describe('assertPercentile', () => {
  it('passes when P99 within bound', () => {
    const values = Array.from({ length: 100 }, (_, i) => i)
    expect(() => assertPercentile(values, 99, 100)).not.toThrow()
  })

  it('throws when P99 exceeds bound', () => {
    const values = Array.from({ length: 100 }, (_, i) => i * 10)
    expect(() => assertPercentile(values, 99, 100)).toThrow(/exceeded/i)
  })

  it('error message includes percentile + actual + bound', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    try {
      assertPercentile(values, 90, 50)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.message).toMatch(/P90/)
      expect(e.message).toMatch(/50/)
    }
  })
})

describe('assertHistogramBounded', () => {
  it('passes when all percentiles within bounds', () => {
    const values = Array.from({ length: 100 }, (_, i) => i)
    expect(() => assertHistogramBounded(values, { p50: 50, p90: 90, p99: 100 })).not.toThrow()
  })

  it('throws on first failed bound, naming it', () => {
    const values = Array.from({ length: 100 }, (_, i) => i)
    expect(() => assertHistogramBounded(values, { p50: 10, p90: 90, p99: 100 })).toThrow(/p50/i)
  })

  it('handles partial bounds (only p99)', () => {
    const values = [1, 2, 3, 4, 5]
    expect(() => assertHistogramBounded(values, { p99: 5 })).not.toThrow()
  })
})

describe('assertConvergence', () => {
  it('passes when sequence converges (variance shrinks)', () => {
    // Damped oscillation
    const seq = [10, 5, 7, 6, 6.5, 6.2, 6.3, 6.25, 6.27, 6.26]
    expect(() => assertConvergence(seq, { window: 5, maxVariance: 0.1 })).not.toThrow()
  })

  it('throws when sequence diverges', () => {
    const seq = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]
    expect(() => assertConvergence(seq, { window: 5, maxVariance: 1 })).toThrow(/diverg/i)
  })

  it('throws when sequence oscillates without dampening', () => {
    const seq = [10, 5, 10, 5, 10, 5, 10, 5, 10, 5]
    expect(() => assertConvergence(seq, { window: 5, maxVariance: 0.1 })).toThrow()
  })

  it('handles short sequences gracefully', () => {
    expect(() => assertConvergence([1, 2], { window: 5, maxVariance: 0.1 })).toThrow(/window/i)
  })
})

describe('assertMonotonic', () => {
  it('passes for strictly increasing', () => {
    expect(() => assertMonotonic([1, 2, 3, 4, 5], 'increasing')).not.toThrow()
  })

  it('throws on non-monotonic', () => {
    expect(() => assertMonotonic([1, 2, 1, 3], 'increasing')).toThrow()
  })

  it('passes for non-decreasing (allows equals)', () => {
    expect(() => assertMonotonic([1, 1, 2, 2, 3], 'non-decreasing')).not.toThrow()
  })

  it('handles decreasing direction', () => {
    expect(() => assertMonotonic([5, 4, 3, 2, 1], 'decreasing')).not.toThrow()
  })
})

describe('assertNoStateOscillation', () => {
  it('passes when each state visited ≤ maxVisits', () => {
    const trace = ['active', 'paused', 'active', 'paused']  // each 2×
    expect(() => assertNoStateOscillation(trace, 3)).not.toThrow()
  })

  it('throws when state visited > maxVisits', () => {
    const trace = ['a', 'b', 'a', 'b', 'a', 'b', 'a']  // 'a' = 4×, 'b' = 3×
    expect(() => assertNoStateOscillation(trace, 3)).toThrow(/oscillat/i)
  })

  it('error message names the offending state', () => {
    const trace = ['x', 'x', 'x', 'x', 'x']
    try {
      assertNoStateOscillation(trace, 3)
    } catch (e) {
      expect(e.message).toMatch(/x/)
    }
  })

  it('handles empty trace gracefully', () => {
    expect(() => assertNoStateOscillation([], 3)).not.toThrow()
  })
})
