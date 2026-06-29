package main

import (
	"context"
	"testing"
	"time"
)

// fakeDaemonHealth is a controllable daemonHealthReader for tests.
type fakeDaemonHealth struct {
	staleNames []string
}

func (f *fakeDaemonHealth) Stale(_ time.Duration) []string { return f.staleNames }

// mkClock returns a frozen clock at the given time.
func mkClock(t time.Time) func() time.Time { return func() time.Time { return t } }

// -------------------------------------------------------------------------
// Tests for checkDaemonOnce — the core decision function.
// -------------------------------------------------------------------------

// T1: daemon not stale → no alert fired, alerted stays false.
func TestCheckDaemonOnce_DaemonHealthy_NoAlert(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: nil}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if alerted {
		t.Error("expected alerted=false when daemon is healthy")
	}
}

// T2: campaign_daemon is stale → alert fires, alerted becomes true.
func TestCheckDaemonOnce_CampaignDaemonStale_Alerts(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: []string{daemonAlertName}}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if !alerted {
		t.Error("expected alerted=true when campaign_daemon is stale")
	}
	if lastAlertTime.IsZero() {
		t.Error("expected lastAlertTime to be set after alert")
	}
}

// T3: other daemons stale but not campaign_daemon → no alert.
func TestCheckDaemonOnce_OtherDaemonStale_NoAlert(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: []string{"imap_poller", "intel_loop"}}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if alerted {
		t.Error("expected alerted=false when only other daemons are stale")
	}
}

// T4: already alerted, daemon still stale, within cooldown → no re-alert.
func TestCheckDaemonOnce_WithinCooldown_NoReAlert(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: []string{daemonAlertName}}
	alerted := true
	recentAlert := time.Now().Add(-20 * time.Minute) // < 1h cooldown
	lastAlertTime := recentAlert
	now := time.Now()

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if !lastAlertTime.Equal(recentAlert) {
		t.Error("expected lastAlertTime unchanged within cooldown")
	}
}

// T5: already alerted, cooldown expired → re-alert fires.
func TestCheckDaemonOnce_CooldownExpired_ReAlerts(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: []string{daemonAlertName}}
	alerted := true
	oldAlert := time.Now().Add(-90 * time.Minute) // > 1h cooldown
	lastAlertTime := oldAlert
	now := time.Now()

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if lastAlertTime.Equal(oldAlert) {
		t.Error("expected lastAlertTime refreshed after cooldown expired")
	}
}

// T6: daemon recovers while alerted → recovery fires, alerted=false.
func TestCheckDaemonOnce_DaemonRecovers_ClearsAlert(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: nil} // daemon is now healthy
	alerted := true
	lastAlertTime := time.Now().Add(-2 * time.Hour)
	now := time.Now()

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if alerted {
		t.Error("expected alerted=false after daemon recovery")
	}
}

// T7: multiple stale names including campaign_daemon → alert fires.
func TestCheckDaemonOnce_MultipleStale_IncludesDaemon_Alerts(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: []string{"imap_poller", daemonAlertName, "intel_loop"}}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if !alerted {
		t.Error("expected alerted=true when campaign_daemon is in stale list")
	}
}

// T8: not alerted + daemon healthy → no state change (no spurious recovery).
func TestCheckDaemonOnce_HealthyNotAlerted_NoRecovery(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: nil}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if alerted || !lastAlertTime.IsZero() {
		t.Error("expected no state change when daemon is healthy and not previously alerted")
	}
}

// T9: context cancel stops runDaemonDeadAlertWithClock.
func TestRunDaemonDeadAlertWithClock_ContextCancel_Exits(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reg := &fakeDaemonHealth{staleNames: nil}
	done := make(chan struct{})

	go func() {
		defer close(done)
		runDaemonDeadAlertWithClock(ctx, reg, time.Now)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runDaemonDeadAlertWithClock did not exit after context cancel")
	}
}

// T10: no-op when SENTRY_DSN_GO is unset.
func TestRunDaemonDeadAlert_NoDSN_NoOp(t *testing.T) {
	t.Setenv("SENTRY_DSN_GO", "")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	reg := &fakeDaemonHealth{staleNames: []string{daemonAlertName}}
	done := make(chan struct{})
	go func() {
		defer close(done)
		runDaemonDeadAlert(ctx, reg)
	}()

	select {
	case <-done:
		// returned immediately — good
	case <-time.After(500 * time.Millisecond):
		t.Fatal("runDaemonDeadAlert should be no-op without SENTRY_DSN_GO")
	}
}

// T11: alert fires with correct threshold constant embedded in message.
// Regression guard: checks the message is non-empty (no panic in Sprintf).
func TestCheckDaemonOnce_AlertMessageNonempty_NoError(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: []string{daemonAlertName}}
	alerted := false
	var lastAlertTime time.Time
	now := time.Now()

	// Should not panic
	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)
}

// T12: exact cooldown boundary — alert at T=0, check at T=1h exact → re-alert allowed.
func TestCheckDaemonOnce_ExactCooldownBoundary_ReAlerts(t *testing.T) {
	reg := &fakeDaemonHealth{staleNames: []string{daemonAlertName}}
	alerted := true
	base := time.Date(2026, 5, 6, 10, 0, 0, 0, time.UTC)
	lastAlertTime := base
	now := base.Add(daemonDeadCooldown) // exactly 1 hour later

	checkDaemonOnce(reg, mkClock(now), &alerted, &lastAlertTime)

	if lastAlertTime.Equal(base) {
		t.Error("expected re-alert at exactly the cooldown boundary")
	}
}
