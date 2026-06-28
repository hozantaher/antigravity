// I2 — State machine guards for mailbox lifecycle.
// Wraps state transitions in invariant() checks; logs violations to
// healing_log + Sentry. Used by heal-action callers to ensure transitions
// follow the StateGraph defined in tests/chaos/mailbox-state-invariants.test.js.

import { StateGraph } from './state-machine.js'
import { invariant, InvariantViolation, guardTransition } from './invariant.js'

// Mailbox state machine — single source of truth.
// Mirrors the test in tests/chaos/mailbox-state-invariants.test.js (HX8).
export function buildMailboxStateGraph() {
  const sg = new StateGraph(['active', 'paused', 'warming', 'retired', 'needs_human'])
  sg.addEdge('active', 'paused', { trigger: 'breaker_tripped' })
  sg.addEdge('paused', 'active', { trigger: 'cooldown_expired' })
  sg.addEdge('paused', 'needs_human', { trigger: 'escalation_threshold' })
  sg.addEdge('active', 'warming', { trigger: 'warmup_required' })
  sg.addEdge('warming', 'active', { trigger: 'warmup_complete' })
  sg.addEdge('warming', 'retired', { trigger: 'retired_by_operator' })
  sg.addEdge('active', 'retired', { trigger: 'retired_by_operator' })
  sg.addEdge('paused', 'retired', { trigger: 'retired_by_operator' })
  sg.markAbsorbing('retired')
  sg.markAbsorbing('needs_human')
  return sg
}

let cachedGraph = null
function getGraph() {
  if (!cachedGraph) cachedGraph = buildMailboxStateGraph()
  return cachedGraph
}

/**
 * Validate a mailbox state transition.
 * Logs invariant violation on illegal transition. Throws InvariantViolation
 * in dev/test (INVARIANT_THROW=1); in prod, logs Sentry breadcrumb only.
 *
 * @param {string} from — current state
 * @param {string} to   — desired state
 * @param {object} ctx  — { mailboxId, trigger, operator? }
 * @returns {boolean} true on valid transition
 */
export function guardMailboxTransition(from, to, ctx = {}) {
  const sg = getGraph()
  invariant(
    typeof from === 'string' && typeof to === 'string',
    `guardMailboxTransition: from/to must be strings (got from=${typeof from}, to=${typeof to})`,
    ctx
  )
  if (!sg.canTransition(from, to)) {
    invariant(
      false,
      `Invalid mailbox transition: ${from} → ${to}`,
      { ...ctx, from, to, reason: 'state_graph_violation' }
    )
    return false
  }
  return true
}

/**
 * Log healing_log row for a state transition (success or violation).
 * Persists to DB when pool provided; no-op otherwise (test mode).
 */
export async function logTransition(pool, { mailboxId, from, to, reason, valid }) {
  if (!pool || !pool.query) return
  try {
    await pool.query(
      `INSERT INTO healing_log (entity_type, entity_id, action, reason, created_at)
       VALUES ('mailbox', $1, $2, $3, now())`,
      [mailboxId, valid ? `transition:${from}→${to}` : `invalid_transition:${from}→${to}`, reason || '']
    )
  } catch (e) {
    // Best-effort — don't break callers
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[heal-state-guard] logTransition failed: ${e?.message || e}`)
    }
  }
}

/**
 * Combined: guard + log. Returns { ok, error? }.
 */
export async function guardedTransition(pool, { mailboxId, from, to, reason, trigger }) {
  let ok = true
  let error = null
  try {
    guardMailboxTransition(from, to, { mailboxId, trigger })
  } catch (e) {
    ok = false
    error = e instanceof InvariantViolation ? e.message : String(e)
  }
  await logTransition(pool, { mailboxId, from, to, reason, valid: ok })
  return { ok, error }
}

// Re-export for convenience
