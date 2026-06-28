// HX2 — Anti-thrash hysteresis tests for self-healing backoff.
//
// Validates the production-grade exponential backoff schedule used by the
// mailbox auto-pause / cooldown loop. Schedule: 30min → 1h → 4h → 12h → 24h
// → escalate. Reset to 30min after 24h+ without a re-fail.
//
// Cycle semantics:
//   - A pause-resume pair where `refailed=true` advances the step counter.
//   - A pair where `refailed=false` is a clean recovery; subsequent pause
//     starts back at step 0 once RESET_AFTER_MS has elapsed.
//   - Once escalation is reached the state is sticky — no auto-revert.
//
// Property-based tests (fast-check, 200 runs each):
//   - cooldown sequence is monotonic non-decreasing within an uninterrupted
//     re-fail run.
//   - escalate flag is always a boolean.
//
// Multi-mailbox isolation is verified by exercising two independent histories
// in parallel and checking that one mailbox's state never bleeds into the
// other's cooldown computation.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { assertMonotonic } from '../../helpers/slo-helpers.js'
import {
  COOLDOWN_SCHEDULE_MS,
  RESET_AFTER_MS,
  computeNextCooldown,
  shouldEscalate,
} from '../../../src/lib/heal-backoff.js'

const MIN_30 = 30 * 60 * 1000
const HOUR_1 = 60 * 60 * 1000
const HOUR_4 = 4 * HOUR_1
const HOUR_12 = 12 * HOUR_1
const HOUR_24 = 24 * HOUR_1

/**
 * Build a synthetic history of N consecutive re-fail cycles starting at
 * `start` ms, each spaced `gapMs` apart. All cycles set `refailed=true`.
 */
function buildRefailHistory(n, { start = 0, gapMs = 60_000 } = {}) {
  const history = []
  for (let i = 0; i < n; i += 1) {
    const pauseAt = start + i * gapMs
    history.push({
      pause_at: pauseAt,
      resume_at: pauseAt + MIN_30,
      refailed: true,
    })
  }
  return history
}

describe('HX2 — Backoff schedule: monotonic step progression', () => {
  it('1) first pause: 30min cooldown (empty history → step 0)', () => {
    const result = computeNextCooldown([], 0)
    expect(result).toEqual({ cooldown_ms: MIN_30, escalate: false })
  })

  it('2) after 1 re-fail: 1h cooldown (step 1)', () => {
    const history = buildRefailHistory(1)
    const now = history.at(-1).resume_at + 1000
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(HOUR_1)
    expect(result.escalate).toBe(false)
  })

  it('3) after 2 re-fails: 4h cooldown (step 2)', () => {
    const history = buildRefailHistory(2)
    const now = history.at(-1).resume_at + 1000
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(HOUR_4)
    expect(result.escalate).toBe(false)
  })

  it('4) after 3 re-fails: 12h cooldown (step 3)', () => {
    const history = buildRefailHistory(3)
    const now = history.at(-1).resume_at + 1000
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(HOUR_12)
    expect(result.escalate).toBe(false)
  })

  it('5) after 4 re-fails: 24h cooldown (step 4)', () => {
    const history = buildRefailHistory(4)
    const now = history.at(-1).resume_at + 1000
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(HOUR_24)
    expect(result.escalate).toBe(false)
  })

  it('6) after 5 re-fails: escalate=true (manual_review_required)', () => {
    const history = buildRefailHistory(5)
    const now = history.at(-1).resume_at + 1000
    const result = computeNextCooldown(history, now)
    expect(result.escalate).toBe(true)
  })

  it('7) cooldown schedule is strictly monotonic (assertMonotonic increasing)', () => {
    expect(() => assertMonotonic(COOLDOWN_SCHEDULE_MS, 'increasing')).not.toThrow()
    expect(COOLDOWN_SCHEDULE_MS.length).toBe(5)
  })
})

describe('HX2 — Reset: 24h+ without re-fail', () => {
  it('8) reset after 24h clean: back to 30min', () => {
    // 2 re-fails, then nothing for >24h → next pause should reset to 30min.
    const history = buildRefailHistory(2)
    const lastResume = history.at(-1).resume_at
    const now = lastResume + RESET_AFTER_MS + 1000
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(MIN_30)
    expect(result.escalate).toBe(false)
  })

  it('12) edge: history with no re-fails (all clean resumes) → next pause is 30min', () => {
    const history = [
      { pause_at: 0, resume_at: MIN_30, refailed: false },
      { pause_at: HOUR_1, resume_at: HOUR_1 + MIN_30, refailed: false },
    ]
    const now = history.at(-1).resume_at + 1000
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(MIN_30)
    expect(result.escalate).toBe(false)
  })

  it('16a) boundary: re-fail at exactly 24h-ε → still counted as recent', () => {
    // Two re-fails, second within (24h - 1ms) of now → no reset.
    const history = [
      { pause_at: 0, resume_at: MIN_30, refailed: true },
      { pause_at: HOUR_1, resume_at: HOUR_1 + MIN_30, refailed: true },
    ]
    const lastResume = history.at(-1).resume_at
    const now = lastResume + RESET_AFTER_MS - 1
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(HOUR_4)
  })

  it('16b) boundary: re-fail at exactly 24h+ε → reset to 30min', () => {
    const history = [
      { pause_at: 0, resume_at: MIN_30, refailed: true },
      { pause_at: HOUR_1, resume_at: HOUR_1 + MIN_30, refailed: true },
    ]
    const lastResume = history.at(-1).resume_at
    const now = lastResume + RESET_AFTER_MS + 1
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(MIN_30)
  })
})

describe('HX2 — Edge cases and graceful inputs', () => {
  it('11) edge: empty history → 30min', () => {
    expect(computeNextCooldown([], Date.now())).toEqual({
      cooldown_ms: MIN_30,
      escalate: false,
    })
  })

  it('11b) edge: null/undefined history → 30min (defensive)', () => {
    expect(computeNextCooldown(null, 0).cooldown_ms).toBe(MIN_30)
    expect(computeNextCooldown(undefined, 0).cooldown_ms).toBe(MIN_30)
  })

  it('18) time travel: now < first pause_at → graceful (returns 30min)', () => {
    const history = buildRefailHistory(2, { start: 1_000_000 })
    const now = 0 // before any history
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(MIN_30)
    expect(result.escalate).toBe(false)
  })
})

describe('HX2 — Anti-oscillation and cycle counting', () => {
  it('13) anti-oscillation: alternating pass/fail in 24h tracked correctly', () => {
    // 8 alternating cycles within 24h: refail, clean, refail, clean...
    const history = []
    for (let i = 0; i < 8; i += 1) {
      const pauseAt = i * HOUR_1
      history.push({
        pause_at: pauseAt,
        resume_at: pauseAt + MIN_30,
        refailed: i % 2 === 0,
      })
    }
    const now = history.at(-1).resume_at + 1000
    // Only 4 re-fails counted → cooldown should be HOUR_24 (step 4).
    const result = computeNextCooldown(history, now)
    expect(result.cooldown_ms).toBe(HOUR_24)
    expect(result.escalate).toBe(false)
  })

  it('14) state machine: pause → resume → re-fail counted as one cycle', () => {
    const cycle = {
      pause_at: 0,
      resume_at: MIN_30,
      refailed: true,
    }
    const result = computeNextCooldown([cycle], cycle.resume_at + 1)
    // One re-fail cycle → step 1 → 1h cooldown.
    expect(result.cooldown_ms).toBe(HOUR_1)
  })
})

describe('HX2 — Multi-mailbox isolation', () => {
  it('15) each mailbox has independent backoff (no cross-talk)', () => {
    // Mailbox A: 3 re-fails. Mailbox B: empty.
    const histA = buildRefailHistory(3)
    const histB = []
    const now = HOUR_24
    const resA = computeNextCooldown(histA, now)
    const resB = computeNextCooldown(histB, now)
    expect(resA.cooldown_ms).toBe(HOUR_12)
    expect(resB.cooldown_ms).toBe(MIN_30)
    // Recompute A again — must not be affected by B's call.
    const resA2 = computeNextCooldown(histA, now)
    expect(resA2).toEqual(resA)
  })
})

describe('HX2 — Escalation semantics', () => {
  it('17a) escalation is sticky once reached (no auto-revert)', () => {
    // 5 re-fails → escalate. Even after 25h gap, still escalated.
    const history = buildRefailHistory(5)
    const lastResume = history.at(-1).resume_at
    const result = computeNextCooldown(history, lastResume + RESET_AFTER_MS + HOUR_1)
    expect(result.escalate).toBe(true)
  })

  it('17b) shouldEscalate matches computeNextCooldown.escalate', () => {
    const history4 = buildRefailHistory(4)
    const history5 = buildRefailHistory(5)
    const now4 = history4.at(-1).resume_at + 1
    const now5 = history5.at(-1).resume_at + 1
    expect(shouldEscalate(history4, now4)).toBe(false)
    expect(shouldEscalate(history5, now5)).toBe(true)
  })

  it('17c) shouldEscalate: 6+ re-fails still true (overshoot)', () => {
    const history = buildRefailHistory(7)
    const now = history.at(-1).resume_at + 1
    expect(shouldEscalate(history, now)).toBe(true)
  })

  it('17d) shouldEscalate: 5 re-fails but spread over >24h → not escalated', () => {
    // History older than 24h window: re-fails too far apart to count
    // simultaneously in the rolling window.
    const history = []
    for (let i = 0; i < 5; i += 1) {
      const pauseAt = i * (HOUR_24 + HOUR_1)
      history.push({
        pause_at: pauseAt,
        resume_at: pauseAt + MIN_30,
        refailed: true,
      })
    }
    const now = history.at(-1).resume_at + 1
    // Each re-fail is >24h apart → step counter resets each time.
    // Latest "run" is just 1 re-fail → no escalation.
    expect(shouldEscalate(history, now)).toBe(false)
  })
})

describe('HX2 — Property-based invariants (fast-check, 200 runs)', () => {
  it('9) property: cooldown bounded by 24h max (pre-escalation)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), n => {
        const history = buildRefailHistory(n)
        const now = n === 0 ? 0 : history.at(-1).resume_at + 1
        const result = computeNextCooldown(history, now)
        return result.cooldown_ms <= HOUR_24 && result.cooldown_ms >= MIN_30
      }),
      { numRuns: 200 }
    )
  })

  it('10) property: escalate iff effective step count ≥ schedule length', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), n => {
        const history = buildRefailHistory(n)
        const now = n === 0 ? 0 : history.at(-1).resume_at + 1
        const result = computeNextCooldown(history, now)
        const expected = n >= COOLDOWN_SCHEDULE_MS.length
        return result.escalate === expected
      }),
      { numRuns: 200 }
    )
  })

  it('PROP-A) 200 random uninterrupted re-fail sequences → cooldown sequence monotonic', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), n => {
        // Build cumulative cooldowns: at step 1, step 2, ..., step n.
        const cooldowns = []
        for (let k = 1; k <= n; k += 1) {
          const history = buildRefailHistory(k)
          const now = history.at(-1).resume_at + 1
          const result = computeNextCooldown(history, now)
          if (result.escalate) break
          cooldowns.push(result.cooldown_ms)
        }
        if (cooldowns.length < 2) return true
        try {
          assertMonotonic(cooldowns, 'increasing')
          return true
        } catch {
          return false
        }
      }),
      { numRuns: 200 }
    )
  })

  it('PROP-B) 200 random sequences → escalate flag is always boolean', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pause_at: fc.integer({ min: 0, max: 1_000_000_000 }),
            resume_at: fc.integer({ min: 0, max: 1_000_000_000 }),
            refailed: fc.boolean(),
          }),
          { maxLength: 20 }
        ),
        fc.integer({ min: 0, max: 10_000_000_000 }),
        (history, now) => {
          const result = computeNextCooldown(history, now)
          return typeof result.escalate === 'boolean' && result.escalate !== null
        }
      ),
      { numRuns: 200 }
    )
  })
})
