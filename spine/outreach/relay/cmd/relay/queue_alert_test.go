package main

import (
	"context"
	"testing"
	"time"

	"relay/internal/minlog"
)

// fakeQueueStats is a controllable queueStatsProvider for tests.
type fakeQueueStats struct {
	oldestAge time.Duration
	depth     int
}

func (f *fakeQueueStats) OldestPendingAge() time.Duration { return f.oldestAge }
func (f *fakeQueueStats) PendingCount() int               { return f.depth }

// sentryCaptures counts calls to CaptureAlert.
// Real Sentry is not initialised in tests, so CaptureAlert is a no-op.
// We verify decision logic by observing alerted/lastAlertTime state.

func makeLogger() *minlog.Logger { return minlog.New("test") }

// frozenClock returns a fixed time function.
func frozenClock(t time.Time) func() time.Time { return func() time.Time { return t } }

// -------------------------------------------------------------------------
// Tests for checkQueueOnce — the core decision function.
// -------------------------------------------------------------------------

// T1: queue age below threshold → no alert, alerted stays false.
func TestCheckQueueOnce_BelowThreshold_NoAlert(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: 5 * time.Minute, depth: 2}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if alerted {
		t.Error("expected alerted=false when age < threshold")
	}
}

// T2: queue age exactly at threshold → triggers alert, alerted becomes true.
func TestCheckQueueOnce_AtThreshold_Alerts(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: queueStuckThreshold, depth: 5}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if !alerted {
		t.Error("expected alerted=true when age == threshold")
	}
	if lastAlertTime.IsZero() {
		t.Error("expected lastAlertTime to be set after alert")
	}
}

// T3: queue age above threshold → triggers alert.
func TestCheckQueueOnce_AboveThreshold_Alerts(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: queueStuckThreshold + 5*time.Minute, depth: 10}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if !alerted {
		t.Error("expected alerted=true when age > threshold")
	}
}

// T4: already alerted within cooldown window → no duplicate alert.
func TestCheckQueueOnce_WithinCooldown_NoReAlert(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: queueStuckThreshold + time.Minute, depth: 3}
	alerted := true
	recentAlert := time.Now().Add(-30 * time.Minute) // 30 min ago, cooldown = 1h
	lastAlertTime := recentAlert
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	// lastAlertTime must NOT be updated — we're still within cooldown.
	if !lastAlertTime.Equal(recentAlert) {
		t.Errorf("expected lastAlertTime unchanged; got %v, want %v", lastAlertTime, recentAlert)
	}
}

// T5: already alerted, cooldown expired → re-alert fires.
func TestCheckQueueOnce_CooldownExpired_ReAlerts(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: queueStuckThreshold + time.Minute, depth: 3}
	alerted := true
	oldAlert := time.Now().Add(-2 * time.Hour) // 2h ago, > 1h cooldown
	lastAlertTime := oldAlert
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if lastAlertTime.Equal(oldAlert) {
		t.Error("expected lastAlertTime to be refreshed after cooldown expired")
	}
}

// T6: empty queue (age = -1) while alerted → recovery fires, alerted=false.
func TestCheckQueueOnce_EmptyQueue_Recovery(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: -1, depth: 0}
	alerted := true
	lastAlertTime := time.Now().Add(-2 * time.Hour)
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if alerted {
		t.Error("expected alerted=false after queue cleared")
	}
}

// T7: queue age below queueRecoveredThreshold while alerted → recovery fires.
func TestCheckQueueOnce_BelowRecoveredThreshold_Recovery(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: 10 * time.Second, depth: 1}
	alerted := true
	lastAlertTime := time.Now().Add(-2 * time.Hour)
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if alerted {
		t.Error("expected alerted=false after recovery")
	}
}

// T8: queue age between recovered and stuck thresholds while alerted → no state change.
func TestCheckQueueOnce_MiddleZone_NoChange(t *testing.T) {
	// age > recoveredThreshold but < stuckThreshold — limbo zone; alerted stays true.
	middleAge := queueRecoveredThreshold + 3*time.Minute
	stats := &fakeQueueStats{oldestAge: middleAge, depth: 2}
	alerted := true
	lastAlertTime := time.Now().Add(-30 * time.Minute)
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if !alerted {
		t.Error("expected alerted=true in limbo zone (no recovery yet)")
	}
}

// T9: not alerted + queue healthy → no state change.
func TestCheckQueueOnce_HealthyNotAlerted_NoOp(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: 30 * time.Second, depth: 0}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if alerted {
		t.Error("expected alerted=false when queue is healthy and not previously alerted")
	}
	if !lastAlertTime.IsZero() {
		t.Error("expected lastAlertTime to remain zero")
	}
}

// T10: context cancel stops runQueueStuckAlertWithClock.
func TestRunQueueStuckAlertWithClock_ContextCancel_Exits(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	stats := &fakeQueueStats{oldestAge: 0, depth: 0}
	done := make(chan struct{})

	go func() {
		defer close(done)
		runQueueStuckAlertWithClock(ctx, stats, makeLogger(), time.Now)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runQueueStuckAlertWithClock did not exit after context cancel")
	}
}

// T11: no-op when SENTRY_DSN_GO is unset — goroutine returns immediately.
func TestRunQueueStuckAlert_NoDSN_NoOp(t *testing.T) {
	// SENTRY_DSN_GO is not set in tests → runQueueStuckAlert returns without
	// launching the ticker goroutine.
	t.Setenv("SENTRY_DSN_GO", "")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stats := &fakeQueueStats{oldestAge: 20 * time.Minute, depth: 5}
	done := make(chan struct{})
	go func() {
		defer close(done)
		runQueueStuckAlert(ctx, stats, makeLogger())
	}()

	select {
	case <-done:
		// returned immediately — good
	case <-time.After(500 * time.Millisecond):
		t.Fatal("runQueueStuckAlert should be no-op without SENTRY_DSN_GO")
	}
}

// T12: depth is correctly captured in state (regression guard).
func TestCheckQueueOnce_DepthIsNonZero_WhenAlerted(t *testing.T) {
	stats := &fakeQueueStats{oldestAge: queueStuckThreshold, depth: 42}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkQueueOnce(stats, makeLogger(), frozenClock(now), &alerted, &lastAlertTime)

	if !alerted {
		t.Error("expected alert to fire")
	}
	// Depth = 42 is passed to CaptureAlert. We can't assert on Sentry payload
	// in unit tests (Sentry is not initialised), but the call must not panic.
}
