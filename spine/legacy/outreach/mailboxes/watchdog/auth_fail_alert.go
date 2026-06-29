package watchdog

import "time"

// AuthFailAlertWindow is the sliding window over which ≥ AuthFailAlertThreshold
// events trigger a SEND-S6.3 alert. Matches the circuit-breaker short window
// but with a lower threshold — we want to tell a human BEFORE the breaker
// auto-pauses the mailbox.
const AuthFailAlertWindow = 15 * time.Minute

// AuthFailAlertThreshold is the minimum number of auth-fail events inside
// AuthFailAlertWindow required to fire an alert.
const AuthFailAlertThreshold = 3

// AuthFailAlertCooldown suppresses repeat alerts on the same mailbox for this
// duration after an alert fires. Prevents alert storms on a persistently bad
// mailbox while still re-alerting once the operator has had a realistic
// chance to react.
const AuthFailAlertCooldown = 1 * time.Hour

// AuthFailEvent is the minimum shape the alert primitive needs from a single
// row in mailbox_auth_fails. Kept narrow on purpose so callers can construct
// it from any backing store (Postgres query, in-memory fake, etc).
type AuthFailEvent struct {
	// FailedAt is when the SMTP AUTH failure was observed. Zero time is
	// treated as "unknown" and skipped so callers can pass malformed rows
	// without crashing the alert path.
	FailedAt time.Time
}

// ShouldAlertOnAuthFail reports whether the caller should emit a
// SEND-S6.3 auth-fail alert given the current event history. The primitive
// is pure: all mutable state (cooldown bookkeeping) is passed in as
// lastAlertedAt and the caller is expected to persist the trigger time.
//
// Semantics:
//   - events may be unordered; we do not mutate the slice.
//   - zero-valued FailedAt timestamps are ignored (defensive: DB rows
//     could have NULL scanned into a zero time.Time).
//   - count events whose FailedAt is strictly within the last
//     AuthFailAlertWindow (open interval, exclusive of the boundary —
//     a 15-minute-old event is "old news").
//   - if count ≥ AuthFailAlertThreshold and (lastAlertedAt == nil
//     OR now-lastAlertedAt ≥ AuthFailAlertCooldown) → alert.
//
// Callers are expected to pre-filter events per mailbox; the primitive
// itself has no mailbox awareness.
func ShouldAlertOnAuthFail(events []AuthFailEvent, now time.Time, lastAlertedAt *time.Time) bool {
	if len(events) < AuthFailAlertThreshold {
		return false
	}
	windowStart := now.Add(-AuthFailAlertWindow)
	recent := 0
	for _, e := range events {
		if e.FailedAt.IsZero() {
			continue
		}
		// Strictly after windowStart and at-or-before now. An event
		// exactly at the 15-minute boundary is treated as expired.
		if e.FailedAt.After(windowStart) && !e.FailedAt.After(now) {
			recent++
		}
	}
	if recent < AuthFailAlertThreshold {
		return false
	}
	if lastAlertedAt != nil {
		if now.Sub(*lastAlertedAt) < AuthFailAlertCooldown {
			return false
		}
	}
	return true
}
