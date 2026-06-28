// Self-healing backoff schedule (HX2).
//
// Pure JS, no I/O — given the same `history` and `now` the result is
// deterministic. Used by the mailbox auto-pause / cooldown loop and the
// proxy pool watchdog to compute exponential cooldowns and decide when a
// human should be paged.
//
// Schedule (defensive — see also tests in heal-backoff.test.js):
//   step 0: 30 minutes
//   step 1: 1 hour
//   step 2: 4 hours
//   step 3: 12 hours
//   step 4: 24 hours
//   step ≥5: escalate (manual_review_required)
//
// Reset semantics:
//   When ≥ RESET_AFTER_MS have elapsed since the most recent re-fail
//   resume_at, the step counter resets to 0 — but only if escalation has
//   not already been reached. Once escalated, the state is sticky and
//   will not auto-revert (operations must clear the manual-review flag
//   explicitly).

/**
 * Backoff schedule, milliseconds. Frozen so callers can't mutate it.
 * @type {ReadonlyArray<number>}
 */
export const COOLDOWN_SCHEDULE_MS = Object.freeze([
  30 * 60 * 1000,        // 30 min  (step 0)
  60 * 60 * 1000,        // 1 hour  (step 1)
  4 * 60 * 60 * 1000,    // 4 hours (step 2)
  12 * 60 * 60 * 1000,   // 12 hours (step 3)
  24 * 60 * 60 * 1000,   // 24 hours (step 4)
])

export const RESET_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {object} BackoffCycle
 * @property {number} pause_at  ms epoch when mailbox was paused
 * @property {number} resume_at ms epoch when mailbox resumed (cooldown end)
 * @property {boolean} refailed true if the mailbox failed again after resume
 */

/**
 * @typedef {object} BackoffResult
 * @property {number} cooldown_ms how long the next pause should last
 * @property {boolean} escalate whether the schedule has been exhausted
 */

/**
 * Returns the *effective* re-fail step count given the history and the
 * current time. Re-fails older than RESET_AFTER_MS contiguous gap are
 * cleared, mirroring the production reset rule.
 *
 * @param {ReadonlyArray<BackoffCycle>} history
 * @param {number} now
 * @returns {number}
 */
function effectiveStepCount(history, now) {
  if (!Array.isArray(history) || history.length === 0) return 0

  // Filter cycles to only those known to have happened by `now`.
  const past = history.filter(c => Number.isFinite(c?.pause_at) && c.pause_at <= now)
  if (past.length === 0) return 0

  // Walk forward, counting consecutive re-fails. A clean resume followed by
  // a gap ≥ RESET_AFTER_MS resets the counter. Re-fails closer than that
  // accumulate.
  let step = 0
  /** @type {number|null} */
  let lastRefailResumeAt = null

  for (const cycle of past) {
    const refailed = cycle?.refailed === true
    if (lastRefailResumeAt !== null) {
      const gap = (cycle.pause_at ?? cycle.resume_at) - lastRefailResumeAt
      if (gap >= RESET_AFTER_MS) {
        step = 0
        lastRefailResumeAt = null
      }
    }
    if (refailed) {
      step += 1
      lastRefailResumeAt = cycle.resume_at
    }
  }

  // Final reset check against `now`: if the most recent re-fail's
  // resume_at is ≥ RESET_AFTER_MS in the past, the next pause starts
  // fresh. (Pre-escalation only — escalation stickiness is enforced in
  // computeNextCooldown / shouldEscalate.)
  if (lastRefailResumeAt !== null && now - lastRefailResumeAt >= RESET_AFTER_MS) {
    if (step < COOLDOWN_SCHEDULE_MS.length) {
      return 0
    }
  }

  return step
}

/**
 * Compute the next cooldown duration based on a mailbox's pause-resume
 * history. Single source of truth for the backoff schedule.
 *
 * @param {ReadonlyArray<BackoffCycle>|null|undefined} history
 * @param {number} now ms epoch (typically `Date.now()`)
 * @returns {BackoffResult}
 */
export function computeNextCooldown(history, now) {
  const safeHistory = Array.isArray(history) ? history : []
  const safeNow = Number.isFinite(now) ? now : 0

  const step = effectiveStepCount(safeHistory, safeNow)

  if (step >= COOLDOWN_SCHEDULE_MS.length) {
    // Sticky escalation: return the maximum (24h) cooldown alongside the
    // escalate flag. Operators handle the manual review; auto-loop must
    // not silently downgrade.
    return {
      cooldown_ms: COOLDOWN_SCHEDULE_MS[COOLDOWN_SCHEDULE_MS.length - 1],
      escalate: true,
    }
  }

  return {
    cooldown_ms: COOLDOWN_SCHEDULE_MS[step],
    escalate: false,
  }
}

/**
 * @param {ReadonlyArray<BackoffCycle>|null|undefined} history
 * @param {number} now ms epoch
 * @returns {boolean}
 */
export function shouldEscalate(history, now) {
  const safeHistory = Array.isArray(history) ? history : []
  const safeNow = Number.isFinite(now) ? now : 0
  const step = effectiveStepCount(safeHistory, safeNow)
  return step >= COOLDOWN_SCHEDULE_MS.length
}
