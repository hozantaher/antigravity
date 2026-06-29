// HXX9 — Heal-action permission boundary library.
//
// Each heal strategy has a scope-bounded permissions row in HEAL_PERMISSIONS.
// Default-deny: an operation only succeeds if BOTH:
//   - operation appears in `actions`
//   - scope appears in `scopes`
// AND the operation is NOT in `blocked` (defense-in-depth — blocked always wins).
//
// Unknown strategies, unknown operations, or unknown scopes are denied.
// Prototype-pollution surfaces (`__proto__`, `constructor`, `toString`) cannot
// be used as strategy keys because we look up via Object.hasOwn on a frozen
// null-prototype-like contract: only own enumerable rows count as valid.
//
// auditPermission(...) returns the canPerform decision plus a JSON-serializable
// audit_log entry suitable for forensics / Sentry breadcrumbs.

/**
 * @typedef {Object} HealPermissionRow
 * @property {string[]} actions   - Allowed operations.
 * @property {string[]} scopes    - Allowed target scopes.
 * @property {string[]} blocked   - Operations that MUST always deny, even if
 *                                  added to `actions` by mistake.
 */

/** @type {Readonly<Record<string, Readonly<HealPermissionRow>>>} */
export const HEAL_PERMISSIONS = Object.freeze({
  mailbox_heal: Object.freeze({
    actions: Object.freeze(['pause', 'resume', 'reset_breaker']),
    scopes: Object.freeze(['mailbox']),
    blocked: Object.freeze(['drop_campaign', 'delete_db_row', 'modify_creds', 'rotate_secrets']),
  }),
  cron_heal: Object.freeze({
    actions: Object.freeze(['restart_cron', 'log_stall']),
    scopes: Object.freeze(['cron']),
    blocked: Object.freeze(['mutate_db_schema', 'drop_table', 'modify_mailbox']),
  }),
  engine_heal: Object.freeze({
    actions: Object.freeze(['restart_engine', 'reset_supervisor']),
    scopes: Object.freeze(['engine']),
    blocked: Object.freeze(['modify_mailbox_creds', 'alter_campaign']),
  }),
  proxy_heal: Object.freeze({
    actions: Object.freeze(['rotate_proxy', 'refresh_pool']),
    scopes: Object.freeze(['proxy']),
    blocked: Object.freeze(['mutate_anti_trace_config', 'change_relay_endpoint']),
  }),
})

// Cache of valid strategy names — own enumerable keys only. This prevents
// `__proto__`, `constructor`, `toString`, etc. from accidentally matching via
// the prototype chain.
const VALID_STRATEGIES = new Set(Object.keys(HEAL_PERMISSIONS))

function lookupRow(strategy) {
  if (typeof strategy !== 'string') return null
  if (!VALID_STRATEGIES.has(strategy)) return null
  // Object.hasOwn ensures we don't traverse the prototype chain.
  if (!Object.hasOwn(HEAL_PERMISSIONS, strategy)) return null
  return HEAL_PERMISSIONS[strategy]
}

function whyDenied(strategy, operation, scope) {
  const row = lookupRow(strategy)
  if (!row) return 'unknown_strategy'
  if (typeof operation !== 'string' || operation.length === 0) return 'invalid_operation'
  if (typeof scope !== 'string' || scope.length === 0) return 'invalid_scope'
  if (row.blocked.includes(operation)) return 'operation_blocked'
  if (!row.actions.includes(operation)) return 'operation_not_in_actions'
  if (!row.scopes.includes(scope)) return 'scope_not_in_scopes'
  return null
}

/**
 * canPerform returns true iff the (strategy, operation, scope) triple is
 * explicitly allowed by HEAL_PERMISSIONS. Default-deny.
 *
 * @param {string} strategy
 * @param {string} operation
 * @param {string} scope
 * @returns {boolean}
 */
export function canPerform(strategy, operation, scope) {
  return whyDenied(strategy, operation, scope) === null
}

/**
 * Sanitize params so the audit log is always JSON-serializable and free of
 * inherited or pollution surfaces.
 */
function sanitizeParams(params) {
  if (params === null || typeof params !== 'object') return {}
  const out = {}
  for (const key of Object.keys(params)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const v = params[key]
    if (typeof v === 'function') continue
    if (v === undefined) continue
    out[key] = v
  }
  return out
}

/**
 * auditPermission returns { allowed, reason, audit_log } where audit_log is
 * always JSON-serializable. Used for forensics + Sentry breadcrumbs.
 *
 * @param {string} strategy
 * @param {string} operation
 * @param {string} scope
 * @param {Record<string, unknown>} [params]
 * @returns {{ allowed: boolean, reason: string|null, audit_log: object }}
 */
export function auditPermission(strategy, operation, scope, params) {
  const reason = whyDenied(strategy, operation, scope)
  const allowed = reason === null
  const safeParams = sanitizeParams(params)
  const audit_log = {
    strategy: typeof strategy === 'string' ? strategy : String(strategy),
    operation: typeof operation === 'string' ? operation : String(operation),
    scope: typeof scope === 'string' ? scope : String(scope),
    decision: allowed ? 'allowed' : 'denied',
    reason: allowed ? null : reason,
    timestamp: new Date().toISOString(),
    params: safeParams,
  }
  return { allowed, reason: allowed ? null : reason, audit_log }
}
