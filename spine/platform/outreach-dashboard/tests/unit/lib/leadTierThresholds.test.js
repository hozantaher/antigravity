import { describe, it, expect } from 'vitest'
import {
  TIER_A_MIN,
  TIER_B_MIN,
  TIER_C_MIN,
  TIER_D_MIN,
  E_TIER_MAX_PRIORITY,
  E_TIER_AUTO_FILTER_THRESHOLD,
  E_TIER_FORCE_BLOCK_THRESHOLD,
  TIER_LABELS,
  tierFromPriority,
} from '../../../src/lib/leadTierThresholds.js'

describe('leadTierThresholds — band constants', () => {
  it('tier bounds descend strictly A > B > C > D', () => {
    expect(TIER_A_MIN).toBeGreaterThan(TIER_B_MIN)
    expect(TIER_B_MIN).toBeGreaterThan(TIER_C_MIN)
    expect(TIER_C_MIN).toBeGreaterThan(TIER_D_MIN)
  })

  it('E-tier upper bound equals D-tier lower bound (no gap)', () => {
    expect(E_TIER_MAX_PRIORITY).toBe(TIER_D_MIN)
  })

  it('auto-filter threshold is below the force-block threshold', () => {
    expect(E_TIER_AUTO_FILTER_THRESHOLD).toBeLessThan(E_TIER_FORCE_BLOCK_THRESHOLD)
  })

  it('has a label for every tier key', () => {
    expect(Object.keys(TIER_LABELS)).toHaveLength(5)
  })
})

describe('tierFromPriority — classification', () => {
  it('classifies exact lower-bound values into the correct tier', () => {
    expect(tierFromPriority(TIER_A_MIN)).toBe('A_top_0.90+')
    expect(tierFromPriority(TIER_B_MIN)).toBe('B_high_0.78-0.89')
    expect(tierFromPriority(TIER_C_MIN)).toBe('C_mid_0.65-0.77')
    expect(tierFromPriority(TIER_D_MIN)).toBe('D_low_0.50-0.64')
  })

  it('values just below a bound fall to the next-lower tier', () => {
    expect(tierFromPriority(TIER_A_MIN - 0.001)).toBe('B_high_0.78-0.89')
    expect(tierFromPriority(TIER_D_MIN - 0.001)).toBe('E_dead_below_0.50')
  })

  it('classifies extremes', () => {
    expect(tierFromPriority(1)).toBe('A_top_0.90+')
    expect(tierFromPriority(0)).toBe('E_dead_below_0.50')
  })

  it('coerces numeric strings', () => {
    expect(tierFromPriority('0.95')).toBe('A_top_0.90+')
    expect(tierFromPriority('0.50')).toBe('D_low_0.50-0.64')
  })

  it('non-finite / null / undefined / NaN all default to E_dead (fail-safe)', () => {
    expect(tierFromPriority(null)).toBe('E_dead_below_0.50')
    expect(tierFromPriority(undefined)).toBe('E_dead_below_0.50')
    expect(tierFromPriority(NaN)).toBe('E_dead_below_0.50')
    expect(tierFromPriority('not-a-number')).toBe('E_dead_below_0.50')
    // Infinity is NOT finite → guarded by !Number.isFinite → E_dead
    expect(tierFromPriority(Infinity)).toBe('E_dead_below_0.50')
  })
})
