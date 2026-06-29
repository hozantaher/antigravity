// clampInt.js — shared integer clamp for query-param bounds.
//
// Consolidates the ~9 hand-rolled `Math.min(Math.max(value, min), max)`
// patterns scattered across server-routes (mailboxes, prospects, companies,
// replies, dedupGuard, leads). Pure, no coercion — callers pass an already-
// numeric value (e.g. `Number(req.query.limit) || DEFAULT`); this only bounds
// it. Centralised so limit/window bounds are auditable in one place
// (feedback_no_magic_thresholds — the min/max stay explicit at each call).

/**
 * Clamp a numeric value into [min, max].
 * @param {number} value already-numeric value (caller coerces + defaults)
 * @param {number} min   lower bound (inclusive)
 * @param {number} max   upper bound (inclusive)
 * @returns {number}
 */
export function clampInt(value, min, max) {
  return Math.min(Math.max(value, min), max)
}
