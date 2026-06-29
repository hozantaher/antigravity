package alert

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

func TestEvaluateLayer_NilDB_NilReturn(t *testing.T) {
	e := New(nil)
	if err := e.EvaluateLayer(context.Background(), "watchdog", 2); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateLayer_EmptyRows_Noop(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT status`).
		WillReturnRows(sqlmock.NewRows([]string{"status", "checked_at"}))

	e := New(db)
	if err := e.EvaluateLayer(context.Background(), "db_pool", 2); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateLayer_L2_OneErr_OpensCritical(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", time.Now())
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	// escalation UPDATE (no open warning to escalate)
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// upsert critical alert
	mock.ExpectExec(`INSERT INTO protection_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	e := New(db)
	if err := e.EvaluateLayer(context.Background(), "anti_trace", 2); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// RCA 2026-06-01: a NULL checked_at used to fail the row Scan (NULL into
// time.Time), and that error — though logged — silently blinded the whole
// protection alert layer. The scan is now NULL-safe (sql.NullTime), so a probe
// row with a NULL checked_at must process normally on its status.
func TestEvaluateLayer_NullCheckedAt_NoScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", nil) // NULL checked_at — pre-fix this aborted with a scan error
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO protection_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	e := New(db)
	if err := e.EvaluateLayer(context.Background(), "anti_trace", 2); err != nil {
		t.Fatalf("NULL checked_at must not fail the scan: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateLayer_L3_OneErr_NoAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", time.Now())
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	// escalation UPDATE only — threshold not reached
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	e := New(db)
	if err := e.EvaluateLayer(context.Background(), "header_gate", 3); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateLayer_L3_ThreeErr_OpensWarning(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", now).
		AddRow("err", now.Add(-5*time.Minute)).
		AddRow("err", now.Add(-10*time.Minute))
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO protection_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	e := New(db)
	if err := e.EvaluateLayer(context.Background(), "header_gate", 3); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateLayer_ThreeOK_Resolves(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("ok",   now).
		AddRow("ok",   now.Add(-5*time.Minute)).
		AddRow("skip", now.Add(-10*time.Minute))
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	// resolve UPDATE
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	e := New(db)
	if err := e.EvaluateLayer(context.Background(), "watchdog", 3); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateLayer_MixedResults_NoNewAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	// most recent is ok → not enough consecutive err, not enough consecutive ok
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("ok",  now).
		AddRow("err", now.Add(-5*time.Minute)).
		AddRow("err", now.Add(-10*time.Minute))
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	// escalation UPDATE only — no INSERT because consecutiveErr=0
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	e := New(db)
	if err := e.EvaluateLayer(context.Background(), "bounce_guard", 3); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateLayer_TwoErr_ThenOK_NoResolveNoAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	rows := sqlmock.NewRows([]string{"status", "checked_at"}).
		AddRow("err", now).
		AddRow("err", now.Add(-5*time.Minute)).
		AddRow("ok",  now.Add(-10*time.Minute))
	mock.ExpectQuery(`SELECT status`).WillReturnRows(rows)
	// escalation only — 2 < 3 threshold for L3
	mock.ExpectExec(`UPDATE protection_alerts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	e := New(db)
	if err := e.EvaluateLayer(context.Background(), "canary", 3); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
