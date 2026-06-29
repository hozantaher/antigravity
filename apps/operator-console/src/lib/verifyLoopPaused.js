// verifyLoopPaused.js — Sprint AM3
// ─────────────────────────────────────────────────────────────────────────────
// In-memory pause flag for contact verify loop. Prevents operator from triggering
// verifications while under investigation or during credential rotation.
//
// State is NOT persisted to DB — restart clears the flag. Operator must
// manually resume or deploy again to re-enable.

let _verifyLoopPaused = false
let _pausedReason = null

/**
 * @returns {{ paused: boolean, reason: string | null }}
 */
export function getPaused() {
  return {
    paused: _verifyLoopPaused,
    reason: _pausedReason,
  }
}

/**
 * @param {string | null} reason - reason for pausing (e.g., "credential rotation")
 */
export function setPaused(reason = null) {
  _verifyLoopPaused = true
  _pausedReason = reason
}

/**
 * Clear pause flag
 */
export function clearPaused() {
  _verifyLoopPaused = false
  _pausedReason = null
}

/**
 * @returns {boolean} true if paused
 */
export function isPaused() {
  return _verifyLoopPaused
}
