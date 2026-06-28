// I8 — Invariant violations trigger heal-rollback.
// Composes invariant() with HealTransaction so any heal action that violates
// a state-machine or business invariant during VERIFY phase auto-rolls back.

import { HealTransaction, HealStrategyScorer } from './heal-rollback.js'
import { invariant, InvariantViolation } from './invariant.js'
import { guardMailboxTransition } from './heal-state-guard.js'

/**
 * Compose: heal action wrapped with invariant verification.
 * If any invariant fires during verify(), transaction rolls back automatically.
 *
 * Usage:
 *   const result = await healWithInvariantRollback({
 *     strategy: 'mailbox_auto_pause',
 *     entity_id: 3,
 *     apply: async (state) => { ... return newState },
 *     metric: (state) => state.health_score,
 *     invariants: [
 *       (state) => invariant(state.status !== 'undefined', 'status must be set'),
 *       (state) => guardMailboxTransition(state.prev_status, state.status, ...),
 *     ],
 *     observationWindowMs: 5 * 60 * 1000,
 *   })
 *   // result: { committed: bool, rolled_back: bool, reason?, delta? }
 */
export async function healWithInvariantRollback({
  strategy,
  entity_id,
  initialState,
  apply,
  metric,
  invariants = [],
  observationWindowMs = 5 * 60 * 1000,
  scorer = null,
} = {}) {
  if (typeof apply !== 'function') throw new Error('healWithInvariantRollback: apply required')
  if (typeof metric !== 'function') throw new Error('healWithInvariantRollback: metric required')

  const tx = new HealTransaction({
    snapshotter: (s) => structuredClone(s),
    metric,
    observationWindow_ms: observationWindowMs,
  })

  // Phase 1: APPLY heal action
  const handle = tx.begin(initialState, { strategy, entity_id })
  let appliedState
  try {
    appliedState = await apply(initialState)
  } catch (e) {
    return { committed: false, rolled_back: false, reason: 'apply_threw', error: e?.message }
  }

  // Phase 2: VERIFY — run invariants + measure metric delta
  let invariantFailure = null
  for (const check of invariants) {
    try {
      check(appliedState)
    } catch (e) {
      if (e instanceof InvariantViolation) {
        invariantFailure = e.message
        break
      }
      throw e  // unexpected error — bubble up
    }
  }

  if (invariantFailure) {
    // Auto-rollback
    const restored = tx.rollback(handle)
    if (scorer) scorer.recordOutcome(strategy, 'rollback')
    return {
      committed: false,
      rolled_back: true,
      reason: 'invariant_violation',
      invariant: invariantFailure,
      restored_state: restored,
    }
  }

  // Phase 3: VERIFY metric delta after observation window
  const verdict = tx.verify(handle, appliedState)
  if (verdict.decision === 'rollback') {
    const restored = tx.rollback(handle)
    if (scorer) scorer.recordOutcome(strategy, 'rollback')
    return {
      committed: false,
      rolled_back: true,
      reason: 'metric_degradation',
      delta: verdict.delta,
      restored_state: restored,
    }
  }

  if (verdict.decision === 'commit') {
    tx.commit(handle)
    if (scorer) scorer.recordOutcome(strategy, 'commit')
    return { committed: true, rolled_back: false, delta: verdict.delta }
  }

  // pending — caller decides what to do
  return { committed: false, rolled_back: false, reason: 'pending', delta: verdict.delta }
}

export { HealStrategyScorer }
