// HXX5 — Two-phase heal-action rollback tests (≥25 cases).
//
// Spec:
//   APPLY → VERIFY (5min observation) → COMMIT or ROLLBACK if metric
//   degrades by epsilon. Metric callback receives current + baseline state
//   so caller defines what "improvement" means (positive delta).
//
// Test buckets:
//   1..15  HealTransaction lifecycle, snapshot immutability, parallel scopes
//   16..25 HealStrategyScorer rolling-window rate + demotion trigger

import { describe, it, expect, beforeEach } from 'vitest'
import { HealTransaction, HealStrategyScorer } from '../../../src/lib/heal-rollback.js'

/**
 * Deterministic clock helper — drives observationWindow_ms semantics.
 */
function makeClock(startMs = 1_000_000) {
  let cur = startMs
  return {
    now: () => cur,
    advance(ms) {
      cur += ms
    },
    set(ms) {
      cur = ms
    },
  }
}

/** Linear metric: returns numeric "health score" of state. */
function healthScore(state) {
  return state?.score ?? 0
}

describe('HealTransaction', () => {
  let clock
  beforeEach(() => {
    clock = makeClock()
  })

  // 1. begin captures snapshot
  it('begin captures the pre-heal state snapshot on the handle', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const state = { score: 0.4, mailbox_id: 7 }
    const handle = tx.begin(state, { strategy: 'restart-relay', entity_id: 7 })
    expect(handle.snapshot).toEqual({ score: 0.4, mailbox_id: 7 })
  })

  // 2. snapshot is deeply frozen (immutable)
  it('snapshot is deeply frozen — mutation attempts throw in strict mode', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const state = { score: 0.4, nested: { count: 3 } }
    const handle = tx.begin(state, { strategy: 's', entity_id: 1 })
    expect(Object.isFrozen(handle.snapshot)).toBe(true)
    expect(Object.isFrozen(handle.snapshot.nested)).toBe(true)
    expect(() => {
      handle.snapshot.score = 99
    }).toThrow()
  })

  // 3. verify with no time elapsed → decision='pending'
  it('verify before observationWindow elapses → pending', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const handle = tx.begin({ score: 0.4 }, { strategy: 's', entity_id: 1 })
    const result = tx.verify(handle, { score: 0.5 })
    expect(result.decision).toBe('pending')
  })

  // 4. verify after 5min with positive delta → 'commit'
  it('verify after 5min with strictly positive delta → commit', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const handle = tx.begin({ score: 0.4 }, { strategy: 's', entity_id: 1 })
    clock.advance(5 * 60 * 1000)
    const result = tx.verify(handle, { score: 0.6 })
    expect(result.decision).toBe('commit')
    expect(result.delta).toBeCloseTo(0.2)
  })

  // 5. verify after 5min with negative delta < -ε → 'rollback'
  it('verify after 5min with delta < -epsilon → rollback', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now, epsilon: 0.01 })
    const handle = tx.begin({ score: 0.5 }, { strategy: 's', entity_id: 1 })
    clock.advance(5 * 60 * 1000)
    const result = tx.verify(handle, { score: 0.3 })
    expect(result.decision).toBe('rollback')
    expect(result.delta).toBeLessThan(0)
  })

  // 6. verify with delta within ε → 'commit' (no-op heal still considered fine)
  it('verify with |delta| <= epsilon → commit (no-op heal acceptable)', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now, epsilon: 0.05 })
    const handle = tx.begin({ score: 0.5 }, { strategy: 's', entity_id: 1 })
    clock.advance(5 * 60 * 1000)
    // delta = -0.02 → within ±epsilon, commit
    const result = tx.verify(handle, { score: 0.48 })
    expect(result.decision).toBe('commit')
  })

  // 7. commit removes handle from active list
  it('commit removes the handle from the active set', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const handle = tx.begin({ score: 0.4 }, { strategy: 's', entity_id: 1 })
    expect(tx.activeCount()).toBe(1)
    clock.advance(5 * 60 * 1000)
    tx.verify(handle, { score: 0.6 })
    tx.commit(handle)
    expect(tx.activeCount()).toBe(0)
  })

  // 8. rollback returns original state (deepEqual to begin snapshot)
  it('rollback restores state deep-equal to the pre-heal snapshot', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const original = { score: 0.5, nested: { count: 3 }, list: [1, 2, 3] }
    const handle = tx.begin(original, { strategy: 's', entity_id: 1 })
    const restored = tx.rollback(handle)
    expect(restored).toEqual(original)
    // Restored object must be a fresh clone (not same reference as snapshot/original).
    expect(restored).not.toBe(original)
    expect(restored).not.toBe(handle.snapshot)
  })

  // 9. rollback prevents subsequent verify (handle disposed)
  it('post-rollback verify throws — handle is disposed', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const handle = tx.begin({ score: 0.5 }, { strategy: 's', entity_id: 1 })
    tx.rollback(handle)
    expect(() => tx.verify(handle, { score: 0.5 })).toThrow(/disposed|unknown handle/i)
  })

  // 10. parallel transactions track independently (different scopes)
  it('parallel transactions across scopes track independently', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const h1 = tx.begin({ score: 0.4 }, { strategy: 'a', entity_id: 1, scope: 'mailbox-1' })
    const h2 = tx.begin({ score: 0.7 }, { strategy: 'b', entity_id: 2, scope: 'mailbox-2' })
    expect(tx.activeCount()).toBe(2)
    clock.advance(5 * 60 * 1000)
    expect(tx.verify(h1, { score: 0.6 }).decision).toBe('commit')
    expect(tx.verify(h2, { score: 0.2 }).decision).toBe('rollback')
    // Independence: h1 commit should not dispose h2.
    expect(() => tx.rollback(h2)).not.toThrow()
  })

  // 11. nested begin throws (one heal at a time per scope)
  it('nested begin in same scope throws — one heal in flight per scope', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    tx.begin({ score: 0.5 }, { strategy: 'a', entity_id: 1, scope: 'mailbox-1' })
    expect(() =>
      tx.begin({ score: 0.6 }, { strategy: 'b', entity_id: 1, scope: 'mailbox-1' }),
    ).toThrow(/already in flight|nested/i)
  })

  // 12. metric callback called with current + baseline state
  it('metric callback receives both current and baseline state', () => {
    const calls = []
    const metric = (state, baseline) => {
      calls.push({ state, baseline })
      return state.score - (baseline?.score ?? 0)
    }
    const tx = new HealTransaction({ metric, now: clock.now })
    const handle = tx.begin({ score: 0.4 }, { strategy: 's', entity_id: 1 })
    clock.advance(5 * 60 * 1000)
    tx.verify(handle, { score: 0.7 })
    // At least one verify call seen with both args bound.
    const lastCall = calls[calls.length - 1]
    expect(lastCall.state).toEqual({ score: 0.7 })
    expect(lastCall.baseline).toEqual({ score: 0.4 })
  })

  // 13. observation window configurable (1min, 1h)
  it('observationWindow_ms configurable — 1min triggers earlier than default', () => {
    const tx = new HealTransaction({
      metric: healthScore,
      now: clock.now,
      observationWindow_ms: 60_000,
    })
    const handle = tx.begin({ score: 0.4 }, { strategy: 's', entity_id: 1 })
    clock.advance(60_000)
    expect(tx.verify(handle, { score: 0.6 }).decision).toBe('commit')

    const txLong = new HealTransaction({
      metric: healthScore,
      now: clock.now,
      observationWindow_ms: 60 * 60 * 1000,
    })
    const h2 = txLong.begin({ score: 0.4 }, { strategy: 's', entity_id: 2 })
    clock.advance(5 * 60 * 1000)
    expect(txLong.verify(h2, { score: 0.6 }).decision).toBe('pending')
  })

  // 14. clock skew during verify → returns 'pending' if elapsed < window
  it('clock skew (elapsed < window) keeps decision pending — never commits early', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const handle = tx.begin({ score: 0.4 }, { strategy: 's', entity_id: 1 })
    // Elapsed 4m 59s only.
    clock.advance(5 * 60 * 1000 - 1)
    expect(tx.verify(handle, { score: 0.99 }).decision).toBe('pending')
    // Negative skew (clock went backwards): elapsed becomes 0 → still pending.
    clock.set(handle.began_at_ms - 10_000)
    expect(tx.verify(handle, { score: 0.99 }).decision).toBe('pending')
  })

  // 15. handle includes strategy + entity_id + timestamp + delta history
  it('handle exposes strategy, entity_id, began_at_ms, and delta_history', () => {
    const tx = new HealTransaction({ metric: healthScore, now: clock.now })
    const handle = tx.begin({ score: 0.4 }, { strategy: 'restart-relay', entity_id: 42 })
    expect(handle.strategy).toBe('restart-relay')
    expect(handle.entity_id).toBe(42)
    expect(typeof handle.began_at_ms).toBe('number')
    expect(handle.began_at_ms).toBe(clock.now())
    expect(Array.isArray(handle.delta_history)).toBe(true)

    clock.advance(60_000)
    tx.verify(handle, { score: 0.5 })
    clock.advance(5 * 60 * 1000)
    tx.verify(handle, { score: 0.7 })
    expect(handle.delta_history.length).toBeGreaterThanOrEqual(2)
    for (const d of handle.delta_history) {
      expect(typeof d.t_ms).toBe('number')
      expect(typeof d.delta).toBe('number')
    }
  })
})

describe('HealStrategyScorer', () => {
  // 16. fresh scorer: rollbackRate=0 for all strategies
  it('fresh scorer: rollbackRate is 0 for any strategy without history', () => {
    const s = new HealStrategyScorer()
    expect(s.rollbackRate('restart-relay')).toBe(0)
    expect(s.rollbackRate('rotate-mailbox')).toBe(0)
  })

  // 17. record commit → rate stays 0
  it('committing only outcomes leaves rollbackRate at 0', () => {
    const s = new HealStrategyScorer()
    for (let i = 0; i < 5; i += 1) s.recordOutcome('a', 'commit')
    expect(s.rollbackRate('a')).toBe(0)
  })

  // 18. record rollback → rate increases
  it('every rollback increases the rate monotonically (until window saturates)', () => {
    const s = new HealStrategyScorer()
    s.recordOutcome('a', 'commit')
    const r0 = s.rollbackRate('a')
    s.recordOutcome('a', 'rollback')
    const r1 = s.rollbackRate('a')
    s.recordOutcome('a', 'rollback')
    const r2 = s.rollbackRate('a')
    expect(r1).toBeGreaterThan(r0)
    expect(r2).toBeGreaterThan(r1)
  })

  // 19. only last 10 outcomes counted (rolling window)
  it('rolling window of 10 — earliest outcomes drop off', () => {
    const s = new HealStrategyScorer()
    // 10 rollbacks → rate = 1.0
    for (let i = 0; i < 10; i += 1) s.recordOutcome('a', 'rollback')
    expect(s.rollbackRate('a')).toBe(1)
    // Push 10 commits — every old rollback is evicted.
    for (let i = 0; i < 10; i += 1) s.recordOutcome('a', 'commit')
    expect(s.rollbackRate('a')).toBe(0)
  })

  // 20. shouldDemote=true when 6/10 rollbacks
  it('shouldDemote returns true when rate > 0.5 over 10 outcomes (6/10)', () => {
    const s = new HealStrategyScorer()
    for (let i = 0; i < 6; i += 1) s.recordOutcome('a', 'rollback')
    for (let i = 0; i < 4; i += 1) s.recordOutcome('a', 'commit')
    expect(s.rollbackRate('a')).toBeCloseTo(0.6)
    expect(s.shouldDemote('a')).toBe(true)
  })

  // 21. shouldDemote=false when 4/10 rollbacks
  it('shouldDemote returns false when rate <= 0.5 (4/10)', () => {
    const s = new HealStrategyScorer()
    for (let i = 0; i < 4; i += 1) s.recordOutcome('a', 'rollback')
    for (let i = 0; i < 6; i += 1) s.recordOutcome('a', 'commit')
    expect(s.rollbackRate('a')).toBeCloseTo(0.4)
    expect(s.shouldDemote('a')).toBe(false)
  })

  // 22. Different strategies tracked independently
  it('strategies are isolated — recording on a does not affect b', () => {
    const s = new HealStrategyScorer()
    for (let i = 0; i < 10; i += 1) s.recordOutcome('a', 'rollback')
    expect(s.rollbackRate('a')).toBe(1)
    expect(s.rollbackRate('b')).toBe(0)
    expect(s.shouldDemote('a')).toBe(true)
    expect(s.shouldDemote('b')).toBe(false)
  })

  // 23. Empty history: shouldDemote=false (no signal)
  it('empty history → shouldDemote is false (refuse to demote on no data)', () => {
    const s = new HealStrategyScorer()
    expect(s.shouldDemote('never-tried')).toBe(false)
  })

  // 24. Property: rollbackRate ∈ [0, 1]
  it('property: rollbackRate stays within [0, 1] across many random outcomes', () => {
    const s = new HealStrategyScorer()
    // 50 randomized outcomes, deterministic via xorshift.
    let seed = 0xC0FFEE
    const rng = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return ((seed >>> 0) % 1000) / 1000
    }
    for (let i = 0; i < 50; i += 1) {
      const outcome = rng() < 0.5 ? 'commit' : 'rollback'
      s.recordOutcome('a', outcome)
      const r = s.rollbackRate('a')
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
    }
  })

  // 25. Property: rolling window respects max length
  it('property: rolling window length never exceeds 10', () => {
    const s = new HealStrategyScorer()
    for (let i = 0; i < 100; i += 1) {
      s.recordOutcome('a', i % 2 === 0 ? 'commit' : 'rollback')
      // Internal accessor: history length must stay <= 10.
      expect(s.historyLength('a')).toBeLessThanOrEqual(10)
    }
  })
})
