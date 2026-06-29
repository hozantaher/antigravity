// I3 — Pre/post conditions on heal API boundary.
// Wraps heal-budget.allow + heal-permissions.canPerform with invariant checks.
// Single entry point for any heal action — enforces all preconditions before
// the action and verifies postconditions after.

import { invariant } from './invariant.js'
import { canPerform, auditPermission } from './heal-permissions.js'
import { HealBudget } from './heal-budget.js'

const DEFAULT_BUDGET_OPTS = { perEntityHourly: 30, systemHourly: 1000 }

let sharedBudget = null
function getBudget(now = () => Date.now()) {
  if (!sharedBudget) {
    sharedBudget = new HealBudget({ ...DEFAULT_BUDGET_OPTS, now })
  }
  return sharedBudget
}

/**
 * Guarded heal-action invocation.
 * Pre: permission check + budget check
 * Post: outcome logged
 *
 * @param {object} args
 * @param {string} args.strategy   — 'mailbox_heal' | 'cron_heal' | 'engine_heal' | 'proxy_heal'
 * @param {string} args.operation  — 'pause' | 'resume' | 'restart_cron' | …
 * @param {string} args.scope      — 'mailbox' | 'cron' | 'engine' | 'proxy'
 * @param {string} args.entity_id  — for budget tracking
 * @param {function} args.action   — async () => result
 * @param {object} [args.params]   — extra params for audit log
 * @returns {Promise<{ allowed: boolean, denied_reason?: string, result?: any, error?: string }>}
 */
export async function guardedHealAction({
  strategy,
  operation,
  scope,
  entity_id,
  action,
  params = {},
} = {}) {
  // Pre-1: input invariants
  invariant(typeof strategy === 'string' && strategy.length > 0, 'strategy required')
  invariant(typeof operation === 'string' && operation.length > 0, 'operation required')
  invariant(typeof scope === 'string', 'scope required')
  invariant(entity_id != null, 'entity_id required')
  invariant(typeof action === 'function', 'action must be async fn')

  // Pre-2: permission check
  if (!canPerform(strategy, operation, scope)) {
    const audit = auditPermission(strategy, operation, scope, params)
    return { allowed: false, denied_reason: audit.reason || 'permission_denied' }
  }

  // Pre-3: budget check
  const budget = getBudget()
  if (!budget.allow(String(entity_id), 1)) {
    return { allowed: false, denied_reason: 'budget_exhausted' }
  }

  // Execute action
  let result, error
  try {
    result = await action()
  } catch (e) {
    error = e?.message || String(e)
  }

  // Post: outcome invariant — result must be defined when no error
  if (!error) {
    invariant(result !== undefined, `${strategy}.${operation} returned undefined — must return result or throw`)
  }

  return error ? { allowed: true, error } : { allowed: true, result }
}

/**
 * Reset shared budget (for tests). Production never calls this.
 */
export function _resetBudget() {
  sharedBudget = null
}
