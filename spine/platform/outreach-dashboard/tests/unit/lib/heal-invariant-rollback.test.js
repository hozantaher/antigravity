// I8 — heal-invariant-rollback tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { healWithInvariantRollback, HealStrategyScorer } from '../../../src/lib/heal-invariant-rollback.js'
import { invariant } from '../../../src/lib/invariant.js'

const ORIGINAL_THROW = process.env.INVARIANT_THROW

beforeEach(() => {
  process.env.INVARIANT_THROW = '1'
})

afterEach(() => {
  if (ORIGINAL_THROW === undefined) delete process.env.INVARIANT_THROW
  else process.env.INVARIANT_THROW = ORIGINAL_THROW
})

describe('I8 — healWithInvariantRollback', () => {
  it('happy path: invariants pass + metric improves → committed', async () => {
    const result = await healWithInvariantRollback({
      strategy: 'mailbox_pause',
      entity_id: 1,
      initialState: { score: 50 },
      apply: async (s) => ({ ...s, score: 100 }),
      metric: (s) => s.score,
      observationWindowMs: 0,
      invariants: [
        (s) => invariant(s.score >= 0, 'score must be non-negative'),
      ],
    })
    expect(result.committed).toBe(true)
    expect(result.rolled_back).toBe(false)
    expect(result.delta).toBe(50)
  })

  it('invariant violation → auto-rollback', async () => {
    const result = await healWithInvariantRollback({
      strategy: 'bad_heal',
      entity_id: 2,
      initialState: { score: 50, status: 'active' },
      apply: async (s) => ({ ...s, status: 'undefined' }),  // invalid status
      metric: (s) => s.score,
      invariants: [
        (s) => invariant(s.status !== 'undefined', 'status invalid'),
      ],
    })
    expect(result.committed).toBe(false)
    expect(result.rolled_back).toBe(true)
    expect(result.reason).toBe('invariant_violation')
    expect(result.invariant).toMatch(/status invalid/)
  })

  it('metric degradation → rollback', async () => {
    const result = await healWithInvariantRollback({
      strategy: 'backfire_heal',
      entity_id: 3,
      initialState: { score: 50 },
      apply: async (s) => ({ ...s, score: 10 }),  // worse
      metric: (s) => s.score,
      observationWindowMs: 0,  // immediate verify
    })
    expect(result.rolled_back).toBe(true)
    expect(result.reason).toBe('metric_degradation')
  })

  it('apply throws → no rollback (apply never completed)', async () => {
    const result = await healWithInvariantRollback({
      strategy: 'broken_heal',
      entity_id: 4,
      initialState: { score: 50 },
      apply: async () => { throw new Error('boom') },
      metric: (s) => s.score,
    })
    expect(result.committed).toBe(false)
    expect(result.rolled_back).toBe(false)
    expect(result.reason).toBe('apply_threw')
    expect(result.error).toMatch(/boom/)
  })

  it('scorer integration: rollback records outcome', async () => {
    const scorer = new HealStrategyScorer()
    await healWithInvariantRollback({
      strategy: 'tracked',
      entity_id: 5,
      initialState: { score: 50 },
      apply: async (s) => ({ ...s, score: 10 }),
      metric: (s) => s.score,
      observationWindowMs: 0,
      scorer,
    })
    expect(scorer.rollbackRate('tracked')).toBeGreaterThan(0)
  })

  it('scorer integration: commit records outcome', async () => {
    const scorer = new HealStrategyScorer()
    await healWithInvariantRollback({
      strategy: 'good',
      entity_id: 6,
      initialState: { score: 50 },
      apply: async (s) => ({ ...s, score: 100 }),
      metric: (s) => s.score,
      observationWindowMs: 0,
      scorer,
    })
    expect(scorer.rollbackRate('good')).toBe(0)
  })

  it('multiple invariants checked in order — first failure wins', async () => {
    let secondCalled = false
    const result = await healWithInvariantRollback({
      strategy: 'multi-check',
      entity_id: 7,
      initialState: { a: 1, b: 2 },
      apply: async (s) => ({ ...s, a: -1, b: -2 }),
      metric: (s) => s.a + s.b,
      invariants: [
        (s) => invariant(s.a > 0, 'a must be positive'),
        (s) => { secondCalled = true; invariant(s.b > 0, 'b must be positive') },
      ],
      observationWindowMs: 0,
    })
    expect(result.invariant).toMatch(/a must be positive/)
    expect(secondCalled).toBe(false)  // short-circuited
  })

  it('throws when apply missing', async () => {
    await expect(healWithInvariantRollback({ metric: () => 0 })).rejects.toThrow(/apply required/i)
  })

  it('throws when metric missing', async () => {
    await expect(healWithInvariantRollback({ apply: async () => ({}) })).rejects.toThrow(/metric required/i)
  })
})
