// Z3-B: tests for cron_mailbox_bounce_throttle.go.

package main

import (
	"context"
	"testing"
	"time"

	"common/operatorconfig"
	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// defaultThresholds returns the same defaults used by production code.
func defaultThresholds() bounceThrottleThresholds {
	return bounceThrottleThresholds{
		PauseRate:        defaultBounceRatePauseThreshold,
		ThrottleRate:     defaultBounceRateThrottleThreshold,
		ConsecutivePause: defaultConsecutiveBouncesPauseThresh,
		MinVolume:        defaultMailboxMinVolumeForRateCheck,
	}
}

// ── 1: total_sent < min_volume → noop ──

func TestBounceThrottle_UnderMinVolumeIsNoop(t *testing.T) {
	d := EvaluateBounceThrottle(50.0, 0, 5, 90, defaultThresholds())
	if d.Action != "noop" {
		t.Errorf("Action = %q, want noop", d.Action)
	}
}

// ── 2: bounce_rate >= 10% triggers pause ──

func TestBounceThrottle_HighRatePauses(t *testing.T) {
	d := EvaluateBounceThrottle(12.0, 0, 50, 90, defaultThresholds())
	if d.Action != "pause" {
		t.Errorf("Action = %q, want pause", d.Action)
	}
}

// ── 3: consecutive >= 5 triggers pause even with low rate ──

func TestBounceThrottle_ConsecutiveBouncesPauses(t *testing.T) {
	d := EvaluateBounceThrottle(2.0, 5, 50, 90, defaultThresholds())
	if d.Action != "pause" {
		t.Errorf("Action = %q, want pause", d.Action)
	}
}

// ── 4: rate >= 5% but < 10% triggers throttle ──

func TestBounceThrottle_MidRateThrottles(t *testing.T) {
	d := EvaluateBounceThrottle(6.0, 0, 50, 90, defaultThresholds())
	if d.Action != "throttle" {
		t.Errorf("Action = %q, want throttle", d.Action)
	}
	if d.NewCap >= 90 {
		t.Errorf("NewCap = %d, expected halved (< 90)", d.NewCap)
	}
}

// ── 5: cap already at floor → at_floor (separate metric per BF-A4) ──

func TestBounceThrottle_AlreadyAtFloorEmitsAtFloor(t *testing.T) {
	d := EvaluateBounceThrottle(6.0, 0, 50, bounceThrottleFloorCap, defaultThresholds())
	if d.Action != "at_floor" {
		t.Errorf("Action = %q, want at_floor", d.Action)
	}
}

// ── 6: under all thresholds → noop ──

func TestBounceThrottle_UnderAllThresholdsIsNoop(t *testing.T) {
	d := EvaluateBounceThrottle(1.0, 1, 50, 90, defaultThresholds())
	if d.Action != "noop" {
		t.Errorf("Action = %q, want noop", d.Action)
	}
}

// ── 7: integration — pause is race-safe (UPDATE WHERE status='active') ──

func TestBounceThrottle_PauseIsRaceSafe(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// One mailbox with critical bounce rate.
	mock.ExpectQuery(`FROM outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "from_address", "daily_cap_override", "consecutive_bounces", "total_sent", "bounce_rate_pct"}).
			AddRow(99, "burned@seznam.cz", 90, 5, 50, 12.0))

	// Pause UPDATE must include WHERE status='active' (matched via regex).
	mock.ExpectExec(`UPDATE outreach_mailboxes\s+SET status='paused'.+WHERE id=\$1 AND status='active'`).
		WithArgs(int64(99), "auto: bounce rate critical").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunMailboxBounceThrottleOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunMailboxBounceThrottleOnce: %v", err)
	}
	if res.Paused != 1 {
		t.Errorf("Paused = %d, want 1", res.Paused)
	}
}

// ── 8: throttle UPDATE only when daily_cap_override > new_cap (race-safe) ──

func TestBounceThrottle_ThrottleHasGuardPredicate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// One mailbox with mid-range rate → throttle 90 → 45.
	mock.ExpectQuery(`FROM outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "from_address", "daily_cap_override", "consecutive_bounces", "total_sent", "bounce_rate_pct"}).
			AddRow(100, "noisy@seznam.cz", 90, 0, 50, 6.0))

	mock.ExpectExec(`UPDATE outreach_mailboxes\s+SET daily_cap_override=\$1.+WHERE id=\$2 AND COALESCE\(daily_cap_override, 0\) > \$1`).
		WithArgs(45, int64(100)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunMailboxBounceThrottleOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunMailboxBounceThrottleOnce: %v", err)
	}
	if res.Throttled != 1 {
		t.Errorf("Throttled = %d, want 1", res.Throttled)
	}
}

// ── 9: already paused (UPDATE matches 0 rows) → not counted, no audit ──

func TestBounceThrottle_AlreadyPausedNoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`FROM outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "from_address", "daily_cap_override", "consecutive_bounces", "total_sent", "bounce_rate_pct"}).
			AddRow(101, "x@seznam.cz", 90, 5, 50, 12.0))
	mock.ExpectExec(`UPDATE outreach_mailboxes\s+SET status='paused'`).
		WillReturnResult(sqlmock.NewResult(0, 0)) // 0 rows affected → already paused

	res, err := RunMailboxBounceThrottleOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunMailboxBounceThrottleOnce: %v", err)
	}
	if res.Paused != 0 {
		t.Errorf("Paused = %d, want 0 when UPDATE matched 0 rows", res.Paused)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unexpected extra audit emission: %v", err)
	}
}

// ── 10: thresholds loaded from operator_settings override defaults ──

func TestBounceThrottle_ThresholdsLoadedFromOperatorSettings(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(sqlmock.NewRows([]string{"key", "value"}).
			AddRow("bounce_rate_pause_threshold", "0.20"). // pause @ 20% instead of 10%
			AddRow("consecutive_bounces_pause_threshold", "10"))

	loader := operatorconfig.NewWithTTL(db, 100*time.Millisecond)
	th := LoadBounceThrottleThresholds(context.Background(), loader)
	if th.PauseRate != 0.20 {
		t.Errorf("PauseRate = %f, want 0.20", th.PauseRate)
	}
	if th.ConsecutivePause != 10 {
		t.Errorf("ConsecutivePause = %d, want 10", th.ConsecutivePause)
	}

	// And the decision changes accordingly: 12% rate is no longer a pause.
	d := EvaluateBounceThrottle(12.0, 0, 50, 90, th)
	if d.Action == "pause" {
		t.Errorf("expected throttle under 20%% threshold, got pause")
	}
}

// ── 11: nil loader falls back to defaults (boot-time race) ──

func TestBounceThrottle_NilLoaderFallsBack(t *testing.T) {
	th := LoadBounceThrottleThresholds(context.Background(), nil)
	if th.PauseRate != defaultBounceRatePauseThreshold {
		t.Errorf("PauseRate = %f, want default", th.PauseRate)
	}
}
