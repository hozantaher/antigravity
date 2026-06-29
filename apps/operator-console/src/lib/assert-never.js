// I4 — Exhaustive switch / discriminated union enforcement.
// Use assertNever in switch default to catch missing cases.
// In TypeScript, the compiler enforces exhaustiveness via never type;
// in JS this is a runtime check that throws InvariantViolation.
//
// Usage:
//   switch (action.type) {
//     case 'PAUSE': return ...
//     case 'RESUME': return ...
//     default: return assertNever(action.type, 'unhandled action')
//   }

import { InvariantViolation } from './invariant.js'

/**
 * Assert that a value is `never` (TypeScript) or throw if reached at runtime.
 * Used in default branches of exhaustive switches.
 *
 * @param {never} value — TS `never` type; runtime must never reach here
 * @param {string} [message] — custom error message
 * @returns {never} throws InvariantViolation; never returns
 */
export function assertNever(value, message) {
  const msg = message || 'assertNever: unreachable code reached'
  throw new InvariantViolation(`${msg} (got: ${JSON.stringify(value)})`)
}

/**
 * Variant: log + warn but don't throw (for prod soft-fail).
 * Used when adding new cases to enums in prod and old code paths
 * temporarily hit the default branch.
 *
 * @param {unknown} value
 * @param {string} [message]
 */
export function warnNever(value, message) {
  const msg = message || 'warnNever: unhandled case'
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(`[invariant] ${msg} (got: ${JSON.stringify(value)})`)
  }
}
