// HX9 — Manual escalation when self-heal fails.
// Pure logic for deciding when to mark a mailbox 'needs_human' (escalation).
// After 3 cycles of auto_pause/resume with re-fail in a 30min window, escalate.
// Once escalated, auto-heal disabled until manual ACK.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  detectEscalation,
  isAutoHealAllowed,
  acknowledgeEscalation,
  ESCALATION_REASONS,
} from '../../../src/lib/heal-escalation.js'

describe('HX9 — detectEscalation', () => {
  it('healthy history (no cycles) → no escalate', () => {
    expect(detectEscalation([], 0)).toEqual({ escalate: false, reason: null })
  })

  it('1 pause-resume cycle without re-fail → no escalate', () => {
    const history = [
      { pause_at: 1000, resume_at: 2000, refailed: false },
    ]
    expect(detectEscalation(history, 3000).escalate).toBe(false)
  })

  it('3 cycles in 30min window with re-fails → escalate', () => {
    const history = [
      { pause_at: 0,    resume_at: 60_000,  refailed: true },
      { pause_at: 70_000,  resume_at: 130_000, refailed: true },
      { pause_at: 140_000, resume_at: 200_000, refailed: true },
    ]
    expect(detectEscalation(history, 200_001).escalate).toBe(true)
  })

  it('3 cycles spread over 2h → no escalate (window stretched)', () => {
    const history = [
      { pause_at: 0,            resume_at: 60_000,        refailed: true },
      { pause_at: 30 * 60_000,  resume_at: 32 * 60_000,   refailed: true },
      { pause_at: 60 * 60_000,  resume_at: 62 * 60_000,   refailed: true },
    ]
    // Window = 30min; oldest cycle is 60+ min ago → only 1 cycle in window
    expect(detectEscalation(history, 70 * 60_000).escalate).toBe(false)
  })

  it('escalation reason is "thrash_in_30min"', () => {
    const history = [
      { pause_at: 0,    resume_at: 60_000,  refailed: true },
      { pause_at: 70_000,  resume_at: 130_000, refailed: true },
      { pause_at: 140_000, resume_at: 200_000, refailed: true },
    ]
    expect(detectEscalation(history, 200_001).reason).toBe(ESCALATION_REASONS.THRASH_30MIN)
  })

  it('5 cycles in 24h (sustained pattern) → escalate (different reason)', () => {
    // Spread 5 cycles over 20h (every 5h), now = 21h → all 5 in 24h window.
    // Crucially these 5 cycles are NOT clustered in 30min, so they hit the
    // sustained branch instead of the thrash branch.
    const history = []
    for (let i = 0; i < 5; i++) {
      const t = i * 5 * 60 * 60_000
      history.push({ pause_at: t, resume_at: t + 60_000, refailed: true })
    }
    const r = detectEscalation(history, 21 * 60 * 60_000)
    expect(r.escalate).toBe(true)
    expect(r.reason).toBe(ESCALATION_REASONS.SUSTAINED_24H)
  })

  it('cycles without refailed=true do not count', () => {
    const history = [
      { pause_at: 0,      resume_at: 60_000,  refailed: false },
      { pause_at: 70_000, resume_at: 130_000, refailed: false },
      { pause_at: 140_000, resume_at: 200_000, refailed: false },
    ]
    expect(detectEscalation(history, 200_001).escalate).toBe(false)
  })

  it('mixed clean and re-fail → only re-fails counted', () => {
    const history = [
      { pause_at: 0,       resume_at: 60_000,  refailed: false },  // clean
      { pause_at: 70_000,  resume_at: 130_000, refailed: true },   // re-fail 1
      { pause_at: 140_000, resume_at: 200_000, refailed: true },   // re-fail 2
    ]
    // 2 re-fails in window, < 3 → no escalate
    expect(detectEscalation(history, 200_001).escalate).toBe(false)
  })

  it('boundary: 3 cycles tightly packed → escalate', () => {
    // 3 re-fails within 5min — well inside 30min window.
    const history = [
      { pause_at: 100_000, resume_at: 120_000, refailed: true },
      { pause_at: 130_000, resume_at: 140_000, refailed: true },
      { pause_at: 150_000, resume_at: 160_000, refailed: true },
    ]
    expect(detectEscalation(history, 200_000).escalate).toBe(true)
  })

  it('handles non-array input safely', () => {
    expect(detectEscalation(null, 0).escalate).toBe(false)
    expect(detectEscalation(undefined, 0).escalate).toBe(false)
    expect(detectEscalation('garbage', 0).escalate).toBe(false)
  })
})

describe('HX9 — isAutoHealAllowed (terminal latch)', () => {
  it('not escalated → auto-heal allowed', () => {
    expect(isAutoHealAllowed({ escalated: false })).toBe(true)
  })

  it('escalated without ACK → auto-heal disabled', () => {
    expect(isAutoHealAllowed({ escalated: true })).toBe(false)
  })

  it('escalated then ACK → auto-heal STAYS disabled (HARDEN-4: hard latch)', () => {
    // ACK is "operator saw the alert" — it does NOT authorize auto-heal
    // resumption. Operator must call clearEscalation() once they've
    // verified root cause is safe.
    const state = { escalated: true }
    const next = acknowledgeEscalation(state, { operator: 'ops@example.com', at: 1000 })
    expect(isAutoHealAllowed(next)).toBe(false)
  })

  it('escalated → clearEscalation → auto-heal re-enabled', async () => {
    const { clearEscalation } = await import('../../../src/lib/heal-escalation.js')
    const state = { escalated: true, acknowledged_by: 'ops@x.cz', acknowledged_at: 100 }
    const next = clearEscalation(state, { operator: 'ops@x.cz', at: 200, reason: 'config fixed' })
    expect(next.escalated).toBe(false)
    expect(next.cleared_by).toBe('ops@x.cz')
    expect(next.cleared_at).toBe(200)
    expect(next.cleared_reason).toBe('config fixed')
    expect(isAutoHealAllowed(next)).toBe(true)
  })

  it('clearEscalation without operator throws (audit)', async () => {
    const { clearEscalation } = await import('../../../src/lib/heal-escalation.js')
    expect(() => clearEscalation({ escalated: true }, { at: 1, reason: 'r' })).toThrow(/operator/i)
  })

  it('clearEscalation on non-escalated state is no-op', async () => {
    const { clearEscalation } = await import('../../../src/lib/heal-escalation.js')
    const state = { escalated: false }
    const next = clearEscalation(state, { operator: 'x@y.cz', at: 1, reason: 'r' })
    expect(next.escalated).toBe(false)
    expect(next.cleared_by).toBeUndefined()
  })

  it('ACK records operator + timestamp', () => {
    const state = { escalated: true }
    const next = acknowledgeEscalation(state, { operator: 'ops@x.cz', at: 12345 })
    expect(next.acknowledged_by).toBe('ops@x.cz')
    expect(next.acknowledged_at).toBe(12345)
  })

  it('ACK without operator throws (audit requirement)', () => {
    expect(() => acknowledgeEscalation({ escalated: true }, { at: 1000 })).toThrow(/operator/i)
  })

  it('ACK on non-escalated state is no-op', () => {
    const state = { escalated: false }
    const next = acknowledgeEscalation(state, { operator: 'x@y.cz', at: 1000 })
    expect(next.escalated).toBe(false)
  })
})

describe('HX9 — Properties', () => {
  it('escalate flag is sticky until ACK (no auto-revert)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 100 })), { minLength: 5, maxLength: 30 }),
        (sequence) => {
          let state = { escalated: true }
          for (const [doAck, _] of sequence) {
            if (!doAck) {
              // Without ACK, escalated stays true
              if (!state.escalated) return false
            } else {
              state = acknowledgeEscalation(state, { operator: 'x', at: 1 })
            }
          }
          return true
        }
      ),
      { numRuns: 100 }
    )
  })

  it('detectEscalation: random history bound check', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({
          pause_at: fc.integer({ min: 0, max: 10_000_000 }),
          resume_at: fc.integer({ min: 0, max: 10_000_000 }),
          refailed: fc.boolean(),
        }), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        (history, now) => {
          const r = detectEscalation(history, now)
          return typeof r.escalate === 'boolean' && (r.reason === null || typeof r.reason === 'string')
        }
      ),
      { numRuns: 200 }
    )
  })

  it('handles negative timestamps gracefully', () => {
    expect(() => detectEscalation([{ pause_at: -1, resume_at: 0, refailed: true }], 0)).not.toThrow()
  })

  it('handles future-dated history (clock skew)', () => {
    const history = [{ pause_at: 1_000_000, resume_at: 2_000_000, refailed: true }]
    const r = detectEscalation(history, 0)  // now < first pause
    expect(r.escalate).toBe(false)
  })
})
