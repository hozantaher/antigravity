package watchdog

import (
	"testing"
	"testing/quick"
	"time"
)

// ── Property: EvaluateCircuit never panics ────────────────────
func TestProperty_EvaluateCircuit_NoPanic(t *testing.T) {
	f := func(trips int32, fails int32, threshold int32, windowMin int32, pauseMin int32, hasOpenedAt bool, ageSec int32) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic: %v", r)
			}
		}()
		now := time.Now().UTC()
		var openedAt *time.Time
		if hasOpenedAt {
			// Bound age to avoid int32 overflow when multiplied by seconds.
			sec := int64(ageSec) % 86400
			openingTime := now.Add(-time.Duration(sec) * time.Second)
			openedAt = &openingTime
		}
		state := CircuitBreakerState{
			MailboxID:        1,
			CircuitOpenedAt:  openedAt,
			CircuitTripCount: int(trips),
		}
		cfg := CircuitBreakerConfig{
			FailThreshold: int(threshold) % 100,
			Window:        time.Duration(windowMin) * time.Minute,
			PauseDuration: time.Duration(pauseMin) * time.Minute,
		}
		_, _ = EvaluateCircuit(state, int(fails)%1000, now, cfg)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: action always in enum {None, Trip, Close} ──────
func TestProperty_EvaluateCircuit_EnumRange(t *testing.T) {
	valid := map[CircuitAction]bool{
		CircuitNone:  true,
		CircuitTrip:  true,
		CircuitClose: true,
	}
	now := time.Now().UTC()
	cfg := CircuitBreakerConfig{FailThreshold: 5, Window: 15 * time.Minute, PauseDuration: 15 * time.Minute}
	for fails := 0; fails < 20; fails++ {
		for hasOpened := 0; hasOpened < 2; hasOpened++ {
			state := CircuitBreakerState{}
			if hasOpened == 1 {
				o := now.Add(-10 * time.Minute)
				state.CircuitOpenedAt = &o
			}
			action, _ := EvaluateCircuit(state, fails, now, cfg)
			if !valid[action] {
				t.Fatalf("invalid action %v for fails=%d hasOpened=%d", action, fails, hasOpened)
			}
		}
	}
}

// ── Property: closed + below threshold → None ─────────────────
func TestProperty_EvaluateCircuit_BelowThresholdNone(t *testing.T) {
	now := time.Now().UTC()
	cfg := CircuitBreakerConfig{FailThreshold: 5, Window: 15 * time.Minute, PauseDuration: 15 * time.Minute}
	state := CircuitBreakerState{} // closed (nil openedAt)
	for fails := 0; fails < 5; fails++ {
		action, _ := EvaluateCircuit(state, fails, now, cfg)
		if action != CircuitNone {
			t.Fatalf("fails=%d (below threshold): want None, got %v", fails, action)
		}
	}
}

// ── Property: closed + at/above threshold → Trip ─────────────
func TestProperty_EvaluateCircuit_AboveThresholdTrip(t *testing.T) {
	now := time.Now().UTC()
	cfg := CircuitBreakerConfig{FailThreshold: 5, Window: 15 * time.Minute, PauseDuration: 15 * time.Minute}
	state := CircuitBreakerState{}
	for fails := 5; fails < 20; fails++ {
		action, reason := EvaluateCircuit(state, fails, now, cfg)
		if action != CircuitTrip {
			t.Fatalf("fails=%d (at/above threshold): want Trip, got %v", fails, action)
		}
		if reason == "" {
			t.Fatalf("Trip should include non-empty reason")
		}
	}
}

// ── Property: open + cooldown elapsed → Close ────────────────
func TestProperty_EvaluateCircuit_CooldownClose(t *testing.T) {
	now := time.Now().UTC()
	cfg := CircuitBreakerConfig{FailThreshold: 5, Window: 15 * time.Minute, PauseDuration: 15 * time.Minute}
	openedAt := now.Add(-16 * time.Minute) // >15 min ago → cooled down
	state := CircuitBreakerState{CircuitOpenedAt: &openedAt}
	action, reason := EvaluateCircuit(state, 0, now, cfg)
	if action != CircuitClose {
		t.Fatalf("cooldown elapsed: want Close, got %v", action)
	}
	if reason == "" {
		t.Fatal("Close should include reason")
	}
}

// ── Property: open + cooldown not elapsed → None ─────────────
func TestProperty_EvaluateCircuit_OpenNotCooldown(t *testing.T) {
	now := time.Now().UTC()
	cfg := CircuitBreakerConfig{FailThreshold: 5, Window: 15 * time.Minute, PauseDuration: 15 * time.Minute}
	openedAt := now.Add(-5 * time.Minute) // only 5 min of 15 min cooldown
	state := CircuitBreakerState{CircuitOpenedAt: &openedAt}
	// Even with many fails, open circuit doesn't re-trip.
	for fails := 0; fails < 20; fails++ {
		action, _ := EvaluateCircuit(state, fails, now, cfg)
		if action != CircuitNone {
			t.Fatalf("open+not-cooled, fails=%d: want None, got %v", fails, action)
		}
	}
}

// ── Property: withDefaults sanity ────────────────────────────
func TestProperty_WithDefaults(t *testing.T) {
	c := CircuitBreakerConfig{}.withDefaults()
	if c.FailThreshold <= 0 {
		t.Fatalf("default FailThreshold must be positive, got %d", c.FailThreshold)
	}
	if c.Window <= 0 {
		t.Fatalf("default Window must be positive, got %v", c.Window)
	}
	if c.PauseDuration <= 0 {
		t.Fatalf("default PauseDuration must be positive, got %v", c.PauseDuration)
	}
}

// ── Property: withDefaults preserves explicit values ────────
func TestProperty_WithDefaults_Preserve(t *testing.T) {
	in := CircuitBreakerConfig{
		FailThreshold: 99,
		Window:        42 * time.Minute,
		PauseDuration: 7 * time.Hour,
	}
	out := in.withDefaults()
	if out.FailThreshold != 99 || out.Window != 42*time.Minute || out.PauseDuration != 7*time.Hour {
		t.Fatalf("withDefaults clobbered explicit values: in=%+v out=%+v", in, out)
	}
}

// ── Property: Deterministic ──────────────────────────────────
func TestProperty_EvaluateCircuit_Deterministic(t *testing.T) {
	now := time.Now().UTC()
	openedAt := now.Add(-10 * time.Minute)
	state := CircuitBreakerState{CircuitOpenedAt: &openedAt}
	cfg := CircuitBreakerConfig{FailThreshold: 5, Window: 15 * time.Minute, PauseDuration: 15 * time.Minute}
	a1, r1 := EvaluateCircuit(state, 3, now, cfg)
	a2, r2 := EvaluateCircuit(state, 3, now, cfg)
	if a1 != a2 || r1 != r2 {
		t.Fatalf("non-deterministic: %v/%q vs %v/%q", a1, r1, a2, r2)
	}
}

// ── Property: Trip reason includes failure count + window ────
func TestProperty_EvaluateCircuit_TripReasonFormat(t *testing.T) {
	now := time.Now().UTC()
	cfg := CircuitBreakerConfig{FailThreshold: 5, Window: 15 * time.Minute, PauseDuration: 15 * time.Minute}
	state := CircuitBreakerState{}
	_, reason := EvaluateCircuit(state, 7, now, cfg)
	// Format: "%d_fails_in_%s"
	if reason != "7_fails_in_15m0s" {
		t.Fatalf("trip reason format: want '7_fails_in_15m0s', got %q", reason)
	}
}
