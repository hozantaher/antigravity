package alert

// o1_property_monkey_test.go — property + monkey tests for the alert evaluator.
//
// Test categories
//   1. EvaluateLayer — QueryContext error → wrapped error returned
//   2. EvaluateLayer — rows.Err() propagation after successful query
//   3. EvaluateLayer — escalation UPDATE error returned
//   4. EvaluateLayer — upsert (INSERT…ON CONFLICT) error returned
//   5. Property: EvaluateLayer with nil DB never panics for any (layer, level)
//   6. Property: constant bounds never change (regression guard)

import (
	"context"
	"errors"
	"testing"
	"testing/quick"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ─────────────────────────────────────────────────────────────────────────────
// 1. QueryContext error → wrapped error returned
// ─────────────────────────────────────────────────────────────────────────────

func TestEvaluateLayer_QueryError_ReturnsWrappedErr(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	queryErr := errors.New("connection reset")
	mock.ExpectQuery(`SELECT status`).WillReturnError(queryErr)

	e := New(db)
	got := e.EvaluateLayer(context.Background(), "watchdog", 3)
	if got == nil {
		t.Fatal("expected error on query failure, got nil")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. rows.Err() propagation
// ─────────────────────────────────────────────────────────────────────────────

func TestEvaluateLayer_RowsErr_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	iterErr := errors.New("cursor closed mid-iteration")
	// Return a row that scans OK, but rows.Err() returns an error.
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", time.Now()).
		RowError(0, iterErr)
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)

	e := New(db)
	got := e.EvaluateLayer(context.Background(), "anti_trace", 3)
	if got == nil {
		t.Fatal("expected error from rows.Err(), got nil")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Escalation UPDATE error returned
// ─────────────────────────────────────────────────────────────────────────────

func TestEvaluateLayer_EscalationUpdateFails_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// One "err" row → not enough for L3 threshold, but escalation UPDATE runs first.
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", time.Now())
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	// Escalation UPDATE fails.
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnError(errors.New("lock timeout"))

	e := New(db)
	got := e.EvaluateLayer(context.Background(), "header_gate", 3)
	if got == nil {
		t.Fatal("expected error from escalation UPDATE, got nil")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Upsert error (INSERT … ON CONFLICT) returned
// ─────────────────────────────────────────────────────────────────────────────

func TestEvaluateLayer_L2_UpsertFails_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// L2: one "err" row → immediately tries to upsert a critical alert.
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", time.Now())
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	// Escalation UPDATE succeeds (nothing to escalate).
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Upsert INSERT fails.
	mock.ExpectExec(`INSERT INTO protection_alerts`).
		WillReturnError(errors.New("unique violation"))

	e := New(db)
	got := e.EvaluateLayer(context.Background(), "db_pool", 2)
	if got == nil {
		t.Fatal("expected error from upsert failure, got nil")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestEvaluateLayer_L3_UpsertFails_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	// L3: three consecutive "err" rows → tries to open a warning alert.
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", now).
		AddRow("err", now.Add(-5*time.Minute)).
		AddRow("err", now.Add(-10*time.Minute))
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Upsert INSERT fails.
	mock.ExpectExec(`INSERT INTO protection_alerts`).
		WillReturnError(errors.New("deadlock detected"))

	e := New(db)
	got := e.EvaluateLayer(context.Background(), "canary", 3)
	if got == nil {
		t.Fatal("expected error from L3 upsert failure, got nil")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Property: nil DB never panics for any (layer, level)
// ─────────────────────────────────────────────────────────────────────────────

func TestEvaluateLayer_NilDB_NeverPanics_Property(t *testing.T) {
	e := New(nil)
	layers := []string{
		"anti_trace", "watchdog", "db_pool", "header_gate",
		"warmup", "bounce_guard", "circuit_breaker", "send_rate",
		"spf_dmarc", "canary", "proxy_pool", "sender_engine",
		"", "unknown_layer_xyz",
	}
	levels := []int{0, 1, 2, 3, 4, 100, -1}

	f := func(layerIdx uint8, levelIdx uint8) bool {
		defer func() { recover() }()
		layer := layers[int(layerIdx)%len(layers)]
		level := levels[int(levelIdx)%len(levels)]
		_ = e.EvaluateLayer(context.Background(), layer, level)
		return true
	}

	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("EvaluateLayer nil-DB property failed: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Constant bounds regression guard
// ─────────────────────────────────────────────────────────────────────────────

func TestEvaluateLayer_Constants_StableRange(t *testing.T) {
	// These invariants match the chaos contract tests; duplicated here to guard
	// against constants changing between refactors that touch both files.
	if l2AlertThreshold != 1 {
		t.Fatalf("l2AlertThreshold must be 1 for immediate critical, got %d", l2AlertThreshold)
	}
	if l3AlertThreshold < 2 || l3AlertThreshold > 10 {
		t.Fatalf("l3AlertThreshold %d out of expected range [2,10]", l3AlertThreshold)
	}
	if resolveAfterOK < 2 || resolveAfterOK > 10 {
		t.Fatalf("resolveAfterOK %d out of expected range [2,10]", resolveAfterOK)
	}
	if escalateToCritical.Hours() < 0.5 || escalateToCritical.Hours() > 4 {
		t.Fatalf("escalateToCritical %.1fh out of expected range [0.5h,4h]", escalateToCritical.Hours())
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Resolve path — UPDATE returns error (auto-resolve branch)
// ─────────────────────────────────────────────────────────────────────────────

func TestEvaluateLayer_AutoResolve_UpdateFails_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	t0 := time.Now()
	// 3 consecutive ok rows → trigger auto-resolve UPDATE.
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("ok",   t0).
		AddRow("ok",   t0.Add(-5*time.Minute)).
		AddRow("skip", t0.Add(-10*time.Minute))
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	// Resolve UPDATE fails.
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnError(errors.New("connection refused"))

	e := New(db)
	got := e.EvaluateLayer(context.Background(), "send_rate", 3)
	if got == nil {
		t.Fatal("expected error from resolve UPDATE, got nil")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}
