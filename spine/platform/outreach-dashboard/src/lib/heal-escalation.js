// HX9 — Manual escalation logic for self-healing.
// Pure functions — no side effects, no I/O.
//
// State `escalated: true` is TERMINAL until manual ACK by operator. Auto-heal
// loop must consult `isAutoHealAllowed(state)` before each heal attempt.

export const ESCALATION_REASONS = {
  THRASH_30MIN:   'thrash_in_30min',
  SUSTAINED_24H:  'sustained_24h_pattern',
}

const THRASH_WINDOW_MS = 30 * 60 * 1000   // 30 min
const SUSTAINED_WINDOW_MS = 24 * 60 * 60 * 1000
const THRASH_CYCLE_THRESHOLD = 3
const SUSTAINED_CYCLE_THRESHOLD = 5

export function detectEscalation(history, now) {
  if (!Array.isArray(history) || history.length === 0) {
    return { escalate: false, reason: null }
  }
  // Filter to re-fails only, sorted ascending by pause_at.
  const refails = history
    .filter(h => h && h.refailed === true && Number.isFinite(h.pause_at))
    .sort((a, b) => a.pause_at - b.pause_at)
  if (refails.length === 0) return { escalate: false, reason: null }

  // Thrash detection: ≥3 re-fails inside the last 30min window.
  const thrashWindowStart = now - THRASH_WINDOW_MS
  const inThrashWindow = refails.filter(h => h.pause_at >= thrashWindowStart)
  if (inThrashWindow.length >= THRASH_CYCLE_THRESHOLD) {
    return { escalate: true, reason: ESCALATION_REASONS.THRASH_30MIN }
  }

  // Sustained detection: ≥5 re-fails inside the last 24h window.
  const sustainedWindowStart = now - SUSTAINED_WINDOW_MS
  const inSustainedWindow = refails.filter(h => h.pause_at >= sustainedWindowStart)
  if (inSustainedWindow.length >= SUSTAINED_CYCLE_THRESHOLD) {
    return { escalate: true, reason: ESCALATION_REASONS.SUSTAINED_24H }
  }

  return { escalate: false, reason: null }
}

export function isAutoHealAllowed(state) {
  if (!state) return true
  // HARDEN-4: escalation is a hard latch. Once `escalated=true`, auto-heal
  // is disabled until the operator EXPLICITLY clears it via clearEscalation().
  // ACK alone is just "operator saw it" (audit trail) — it does NOT authorize
  // resuming auto-heal. The previous semantics ("escalated && !acked") let
  // auto-heal silently re-engage on the same mailbox after a single click.
  return !state.escalated
}

export function acknowledgeEscalation(state, { operator, at }) {
  if (!operator) {
    throw new Error('acknowledgeEscalation: operator required (audit)')
  }
  if (!state || !state.escalated) {
    // No-op when not escalated; preserves caller's state shape.
    return { ...state }
  }
  return {
    ...state,
    acknowledged_by: operator,
    acknowledged_at: at,
  }
}

// HARDEN-4: explicit operator-driven exit from the escalated state.
// Called when the operator has investigated the root cause and decided
// auto-heal can safely resume. Audit fields are preserved (ack_by, ack_at)
// and the cleared decision itself is recorded.
export function clearEscalation(state, { operator, at, reason }) {
  if (!operator) {
    throw new Error('clearEscalation: operator required (audit)')
  }
  if (!state || !state.escalated) {
    return { ...state }
  }
  return {
    ...state,
    escalated: false,
    cleared_by: operator,
    cleared_at: at,
    cleared_reason: reason || null,
  }
}
