package watchdog

import (
	"math/rand"
	"testing"
	"testing/quick"
	"time"
)

// Property-based invariants for ShouldAlertOnAuthFail. These complement the
// table-driven unit tests in auth_fail_alert_test.go with randomized input
// so regressions that skip our specific table cases still get caught.
//
// Invariants tested:
//
//   I1 — FEW EVENTS: len(events) < threshold ⇒ never alert (regardless of
//        timestamps or cooldown state).
//
//   I2 — STALE EVENTS: no event strictly newer than now-window ⇒ never alert.
//
//   I3 — COOLDOWN: if lastAlertedAt is inside the cooldown window, never
//        alert (regardless of how many recent events there are).
//
//   I4 — DETERMINISTIC: calling the primitive twice with the same inputs
//        must yield the same answer (no hidden mutation or RNG).
//
//   I5 — PURE: the function must not mutate its input slice.

const propertyRuns = 500

// genEvents returns a random event sequence with `count` events whose
// FailedAt timestamps are uniformly distributed in [now-spread, now].
// Some fraction are injected as zero-time ("unknown") to exercise the
// defensive branch at auth_fail_alert.go:55.
func genEvents(r *rand.Rand, count int, now time.Time, spread time.Duration) []AuthFailEvent {
	out := make([]AuthFailEvent, count)
	for i := range out {
		if r.Float64() < 0.15 {
			// zero-value: represent malformed DB row
			continue
		}
		// offset in [0, spread]; result in [now-spread, now]
		offset := time.Duration(r.Int63n(int64(spread) + 1))
		out[i] = AuthFailEvent{FailedAt: now.Add(-offset)}
	}
	return out
}

// TestProperty_FewEventsNeverAlert encodes I1.
func TestProperty_FewEventsNeverAlert(t *testing.T) {
	// Using rapid-like loop instead of full quick.Check because we need
	// correlated inputs (count < threshold constrained).
	r := rand.New(rand.NewSource(1))
	now := time.Date(2026, 4, 22, 14, 0, 0, 0, time.UTC)
	for i := 0; i < propertyRuns; i++ {
		count := r.Intn(AuthFailAlertThreshold) // 0..threshold-1
		events := genEvents(r, count, now, 2*AuthFailAlertWindow)
		// lastAlertedAt random: sometimes nil, sometimes in cooldown, sometimes old
		var lastPtr *time.Time
		switch r.Intn(3) {
		case 0:
			// nil
		case 1:
			old := now.Add(-AuthFailAlertCooldown - time.Hour)
			lastPtr = &old
		case 2:
			recent := now.Add(-time.Minute)
			lastPtr = &recent
		}
		if ShouldAlertOnAuthFail(events, now, lastPtr) {
			t.Fatalf("I1 violated: alerted with count=%d events=%v", count, events)
		}
	}
}

// TestProperty_StaleEventsNeverAlert encodes I2.
func TestProperty_StaleEventsNeverAlert(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	now := time.Date(2026, 4, 22, 14, 0, 0, 0, time.UTC)
	for i := 0; i < propertyRuns; i++ {
		count := AuthFailAlertThreshold + r.Intn(20) // always ≥ threshold
		events := make([]AuthFailEvent, count)
		for j := range events {
			// All events are OLDER than window (at least window + 1s old).
			offset := AuthFailAlertWindow + time.Duration(r.Int63n(int64(2*time.Hour)))
			events[j] = AuthFailEvent{FailedAt: now.Add(-offset)}
		}
		if ShouldAlertOnAuthFail(events, now, nil) {
			t.Fatalf("I2 violated: alerted on fully-stale events (window=%v)", AuthFailAlertWindow)
		}
	}
}

// TestProperty_CooldownSuppresses encodes I3.
func TestProperty_CooldownSuppresses(t *testing.T) {
	r := rand.New(rand.NewSource(3))
	now := time.Date(2026, 4, 22, 14, 0, 0, 0, time.UTC)
	for i := 0; i < propertyRuns; i++ {
		// Enough recent events to trigger absent cooldown
		events := []AuthFailEvent{
			{FailedAt: now.Add(-1 * time.Minute)},
			{FailedAt: now.Add(-5 * time.Minute)},
			{FailedAt: now.Add(-14 * time.Minute)},
			{FailedAt: now.Add(-2 * time.Minute)},
		}
		// lastAlertedAt strictly inside cooldown: in [0, cooldown) ago.
		backoff := time.Duration(r.Int63n(int64(AuthFailAlertCooldown)))
		last := now.Add(-backoff)
		if ShouldAlertOnAuthFail(events, now, &last) {
			t.Fatalf("I3 violated: alerted inside cooldown (backoff=%v, cooldown=%v)", backoff, AuthFailAlertCooldown)
		}
	}
}

// TestProperty_Deterministic encodes I4.
func TestProperty_Deterministic(t *testing.T) {
	config := &quick.Config{MaxCount: 200}
	f := func(seed int64, eventCount uint8, cooldownMode uint8) bool {
		r := rand.New(rand.NewSource(seed))
		now := time.Date(2026, 4, 22, 14, 0, 0, 0, time.UTC)
		events := genEvents(r, int(eventCount)%30, now, AuthFailAlertWindow*3)
		var lastPtr *time.Time
		switch cooldownMode % 3 {
		case 1:
			t := now.Add(-AuthFailAlertCooldown - time.Second)
			lastPtr = &t
		case 2:
			t := now.Add(-time.Minute)
			lastPtr = &t
		}
		a := ShouldAlertOnAuthFail(events, now, lastPtr)
		b := ShouldAlertOnAuthFail(events, now, lastPtr)
		return a == b
	}
	if err := quick.Check(f, config); err != nil {
		t.Fatal(err)
	}
}

// TestProperty_PureNoMutation encodes I5 — input slice must not be reordered
// or modified. We snapshot before/after and compare byte-for-byte.
func TestProperty_PureNoMutation(t *testing.T) {
	r := rand.New(rand.NewSource(4))
	now := time.Date(2026, 4, 22, 14, 0, 0, 0, time.UTC)
	for i := 0; i < propertyRuns; i++ {
		count := r.Intn(50)
		events := genEvents(r, count, now, AuthFailAlertWindow*2)
		// Snapshot by copy.
		before := make([]AuthFailEvent, len(events))
		copy(before, events)
		_ = ShouldAlertOnAuthFail(events, now, nil)
		for j := range events {
			if !events[j].FailedAt.Equal(before[j].FailedAt) {
				t.Fatalf("I5 violated: event[%d] mutated (before=%v, after=%v)", j, before[j], events[j])
			}
		}
	}
}

// TestProperty_ThresholdBoundary confirms the open/closed boundary is
// respected. Exactly AuthFailAlertThreshold recent events ⇒ alert;
// AuthFailAlertThreshold-1 ⇒ no alert.
func TestProperty_ThresholdBoundary(t *testing.T) {
	now := time.Date(2026, 4, 22, 14, 0, 0, 0, time.UTC)

	// Exactly threshold events, all recent
	atThreshold := make([]AuthFailEvent, AuthFailAlertThreshold)
	for i := range atThreshold {
		atThreshold[i] = AuthFailEvent{FailedAt: now.Add(-time.Duration(i+1) * time.Minute)}
	}
	if !ShouldAlertOnAuthFail(atThreshold, now, nil) {
		t.Errorf("threshold boundary: expected alert at exactly %d events, got none", AuthFailAlertThreshold)
	}

	// One fewer → no alert
	belowThreshold := atThreshold[:AuthFailAlertThreshold-1]
	if ShouldAlertOnAuthFail(belowThreshold, now, nil) {
		t.Errorf("threshold boundary: expected no alert at %d events, got alert", AuthFailAlertThreshold-1)
	}
}

// TestProperty_WindowBoundary — event at exactly windowStart is expired;
// event 1ns newer is recent.
func TestProperty_WindowBoundary(t *testing.T) {
	now := time.Date(2026, 4, 22, 14, 0, 0, 0, time.UTC)
	windowStart := now.Add(-AuthFailAlertWindow)

	// 3 events: one at exact boundary, two newer. Only the 2 newer count.
	events := []AuthFailEvent{
		{FailedAt: windowStart},                 // expired by spec
		{FailedAt: windowStart.Add(time.Nanosecond)}, // recent
		{FailedAt: now.Add(-5 * time.Minute)},   // recent
	}
	// 2 recent < threshold(3) → no alert
	if ShouldAlertOnAuthFail(events, now, nil) {
		t.Errorf("window boundary: event at exactly windowStart should be treated as expired")
	}

	// Add a 3rd strictly-recent event → alert
	events = append(events, AuthFailEvent{FailedAt: now.Add(-1 * time.Minute)})
	if !ShouldAlertOnAuthFail(events, now, nil) {
		t.Errorf("window boundary: 3 strictly-recent events should alert")
	}
}
