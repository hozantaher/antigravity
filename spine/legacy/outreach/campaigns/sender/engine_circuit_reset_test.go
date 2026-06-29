package sender

import (
	"testing"
	"time"

	"common/config"
)

// TestEngine_GlobalCircuit_ResetsOnHourlyRollover locks the contract that
// the global circuit breaker, once tripped by a high bounce rate, returns
// to the closed state when the hourly window rolls over. Without this,
// e.circuitOpen latches true forever — the Run loop sleeps on
// isCircuitOpen() with no path back to false except process restart.
//
// Background: recordSendResult sets e.circuitOpen=true when bounce rate
// exceeds e.safety.MaxBounceRate. resetCountersIfNeeded already zeroes
// totalSent/bounceCount/domainBounces when an hour elapses; it must also
// flip the circuit back so the next 10 sends can re-evaluate. If the
// underlying conditions persist, the breaker re-trips after the next 10
// attempts; otherwise the engine recovers without operator intervention.
func TestEngine_GlobalCircuit_ResetsOnHourlyRollover(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	// Trip the circuit and rewind lastReset by >1h so the next call to
	// resetCountersIfNeeded executes the hourly reset branch.
	e.mu.Lock()
	e.circuitOpen = true
	e.totalSent = 100
	e.bounceCount = 50
	e.domainSent["t.cz"] = 100
	e.domainBounces["t.cz"] = 50
	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.mu.Unlock()

	if !e.isCircuitOpen() {
		t.Fatal("setup: expected circuit open")
	}

	e.resetCountersIfNeeded()

	if e.isCircuitOpen() {
		t.Error("circuit should be closed after hourly window rollover — was latched open")
	}
	e.mu.Lock()
	if e.totalSent != 0 || e.bounceCount != 0 {
		t.Errorf("counters not reset: totalSent=%d, bounceCount=%d", e.totalSent, e.bounceCount)
	}
	e.mu.Unlock()
}

// TestEngine_GlobalCircuit_NoResetWithinHour — a reset call inside the
// current 1h window must NOT re-arm the circuit. Otherwise the breaker
// becomes a cosmetic flicker rather than a window-locked safety net.
func TestEngine_GlobalCircuit_NoResetWithinHour(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	e.mu.Lock()
	e.circuitOpen = true
	e.totalSent = 100
	e.bounceCount = 50
	e.lastReset = time.Now().Add(-30 * time.Minute) // within the hour
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	if !e.isCircuitOpen() {
		t.Error("circuit should still be open inside the 1h window — only the hourly rollover may reset")
	}
	e.mu.Lock()
	if e.totalSent == 0 || e.bounceCount == 0 {
		t.Error("counters should NOT be reset within the 1h window")
	}
	e.mu.Unlock()
}

// TestEngine_GlobalCircuit_ResetIsIdempotent — calling reset on an
// already-closed circuit during a rollover must remain a no-op (no panic,
// no metric flip-flop). Encodes the "if e.circuitOpen { ... }" guard.
func TestEngine_GlobalCircuit_ResetIsIdempotent(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	e.mu.Lock()
	e.circuitOpen = false
	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.mu.Unlock()

	// Should not panic; should remain closed.
	e.resetCountersIfNeeded()
	e.resetCountersIfNeeded()

	if e.isCircuitOpen() {
		t.Error("circuit should remain closed across repeated resets")
	}
}
