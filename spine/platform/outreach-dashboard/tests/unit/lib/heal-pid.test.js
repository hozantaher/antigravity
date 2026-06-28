// HXX3 — PID-style self-tuning of heal cooldown.
// Adjusts cooldown duration based on outcome history (commit/rollback rate).
// Targets stable success rate within damping bounds.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { assertConvergence } from '../../helpers/slo-helpers.js'
import {
  PIDController,
  COOLDOWN_BOUNDS_MS,
  DEFAULT_TARGET_SUCCESS_RATE,
} from '../../../src/lib/heal-pid.js'

describe('HXX3 — PIDController initialization', () => {
  it('starts at default cooldown (30min)', () => {
    const pid = new PIDController()
    expect(pid.cooldown_ms).toBe(30 * 60 * 1000)
  })

  it('respects initial cooldown override', () => {
    const pid = new PIDController({ initial_cooldown_ms: 60 * 60 * 1000 })
    expect(pid.cooldown_ms).toBe(60 * 60 * 1000)
  })

  it('exposes target_success_rate (default 0.8)', () => {
    const pid = new PIDController()
    expect(pid.target_success_rate).toBe(DEFAULT_TARGET_SUCCESS_RATE)
  })

  it('exposes cooldown_bounds (5min .. 24h)', () => {
    expect(COOLDOWN_BOUNDS_MS.min).toBe(5 * 60 * 1000)
    expect(COOLDOWN_BOUNDS_MS.max).toBe(24 * 60 * 60 * 1000)
  })
})

describe('HXX3 — Update on outcomes', () => {
  it('all successes (1.0 rate, above 0.8 target) → shrink cooldown', () => {
    const pid = new PIDController()
    const c0 = pid.cooldown_ms
    for (let i = 0; i < 5; i++) pid.recordOutcome('commit')
    expect(pid.cooldown_ms).toBeLessThan(c0)
  })

  it('all rollbacks (0.0 rate, below 0.8 target) → grow cooldown', () => {
    const pid = new PIDController()
    const c0 = pid.cooldown_ms
    for (let i = 0; i < 5; i++) pid.recordOutcome('rollback')
    expect(pid.cooldown_ms).toBeGreaterThan(c0)
  })

  it('mixed at target rate → cooldown stable (within damping)', () => {
    const pid = new PIDController()
    // 8 commits + 2 rollbacks = 0.8 = target
    for (let i = 0; i < 8; i++) pid.recordOutcome('commit')
    for (let i = 0; i < 2; i++) pid.recordOutcome('rollback')
    const c1 = pid.cooldown_ms
    for (let i = 0; i < 4; i++) pid.recordOutcome('commit')
    for (let i = 0; i < 1; i++) pid.recordOutcome('rollback')
    // Cooldown should still be near initial; small drift OK
    expect(Math.abs(pid.cooldown_ms - c1) / c1).toBeLessThan(0.5)
  })

  it('cooldown bounded at min (5min)', () => {
    const pid = new PIDController({ initial_cooldown_ms: COOLDOWN_BOUNDS_MS.min })
    for (let i = 0; i < 100; i++) pid.recordOutcome('commit')
    expect(pid.cooldown_ms).toBeGreaterThanOrEqual(COOLDOWN_BOUNDS_MS.min)
  })

  it('cooldown bounded at max (24h)', () => {
    const pid = new PIDController({ initial_cooldown_ms: COOLDOWN_BOUNDS_MS.max })
    for (let i = 0; i < 100; i++) pid.recordOutcome('rollback')
    expect(pid.cooldown_ms).toBeLessThanOrEqual(COOLDOWN_BOUNDS_MS.max)
  })

  it('damping factor prevents wild oscillation (no flips per step > 50%)', () => {
    const pid = new PIDController({ damping: 0.3 })
    const cooldowns = []
    for (let i = 0; i < 50; i++) {
      pid.recordOutcome(i % 2 === 0 ? 'commit' : 'rollback')
      cooldowns.push(pid.cooldown_ms)
    }
    // Per-step change capped by damping × cooldown; never exceeds 50% in single step.
    let maxStepRatio = 0
    for (let i = 1; i < cooldowns.length; i++) {
      const ratio = Math.abs(cooldowns[i] - cooldowns[i - 1]) / cooldowns[i - 1]
      if (ratio > maxStepRatio) maxStepRatio = ratio
    }
    expect(maxStepRatio).toBeLessThan(0.5)
  })

  it('unknown outcome ignored (no-op)', () => {
    const pid = new PIDController()
    const c0 = pid.cooldown_ms
    pid.recordOutcome('unknown_kind')
    expect(pid.cooldown_ms).toBe(c0)
  })
})

describe('HXX3 — Convergence under stationary distribution', () => {
  it('100 events with constant 0.7 commit rate → cooldown trends toward growth (rate < target)', () => {
    const pid = new PIDController({ damping: 0.5 })
    const cooldowns = []
    for (let i = 0; i < 100; i++) {
      const isCommit = (i % 10) < 7
      pid.recordOutcome(isCommit ? 'commit' : 'rollback')
      cooldowns.push(pid.cooldown_ms)
    }
    // Rate=0.7 is below target=0.8 → expect cooldown to grow over time
    expect(cooldowns[cooldowns.length - 1]).toBeGreaterThan(cooldowns[0])
    // Tail range bounded relative to mean (no wild oscillation)
    const tail = cooldowns.slice(-20)
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length
    const range = Math.max(...tail) - Math.min(...tail)
    expect(range / mean).toBeLessThan(1)
  })

  it('property: cooldown stays within bounds across any random sequence', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('commit', 'rollback'), { minLength: 1, maxLength: 200 }),
        (outcomes) => {
          const pid = new PIDController()
          for (const o of outcomes) pid.recordOutcome(o)
          return pid.cooldown_ms >= COOLDOWN_BOUNDS_MS.min &&
                 pid.cooldown_ms <= COOLDOWN_BOUNDS_MS.max
        }
      ),
      { numRuns: 200 }
    )
  })

  it('property: damping ensures monotonic-ish behavior under repeated same-outcome', () => {
    const pid = new PIDController()
    const cooldowns = []
    for (let i = 0; i < 50; i++) {
      pid.recordOutcome('commit')
      cooldowns.push(pid.cooldown_ms)
    }
    // 50 successes should monotonically shrink (or stay) — never grow
    for (let i = 1; i < cooldowns.length; i++) {
      expect(cooldowns[i]).toBeLessThanOrEqual(cooldowns[i - 1] + 1)  // tolerance for damping
    }
  })
})

describe('HXX3 — Defensive', () => {
  it('damping must be in (0, 1)', () => {
    expect(() => new PIDController({ damping: 0 })).toThrow()
    expect(() => new PIDController({ damping: 1 })).toThrow()
    expect(() => new PIDController({ damping: -0.5 })).toThrow()
  })

  it('initial cooldown clamped to bounds', () => {
    const pid1 = new PIDController({ initial_cooldown_ms: 1 })
    expect(pid1.cooldown_ms).toBe(COOLDOWN_BOUNDS_MS.min)
    const pid2 = new PIDController({ initial_cooldown_ms: 1e15 })
    expect(pid2.cooldown_ms).toBe(COOLDOWN_BOUNDS_MS.max)
  })

  it('target_success_rate must be in (0, 1)', () => {
    expect(() => new PIDController({ target_success_rate: 0 })).toThrow()
    expect(() => new PIDController({ target_success_rate: 1 })).toThrow()
    expect(() => new PIDController({ target_success_rate: 1.5 })).toThrow()
  })

  it('history exposed for diagnostics', () => {
    const pid = new PIDController()
    pid.recordOutcome('commit')
    pid.recordOutcome('rollback')
    expect(pid.history.length).toBe(2)
  })

  it('history capped at maxHistory (rolling)', () => {
    const pid = new PIDController({ max_history: 50 })
    for (let i = 0; i < 100; i++) pid.recordOutcome('commit')
    expect(pid.history.length).toBe(50)
  })
})
