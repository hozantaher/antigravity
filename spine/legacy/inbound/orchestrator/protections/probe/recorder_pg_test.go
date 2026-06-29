package probe

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

func TestPGRecorder_NilDB_Write_Noop(t *testing.T) {
	r := NewPGRecorder(nil)
	if err := r.Write(context.Background(), Result{Layer: "watchdog", Status: StatusOK}); err != nil {
		t.Fatal(err)
	}
}

func TestPGRecorder_NilDB_Matrix_Noop(t *testing.T) {
	r := NewPGRecorder(nil)
	rows, err := r.Matrix(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rows != nil {
		t.Fatal("expected nil rows from nil-db matrix")
	}
}

func TestPGRecorder_Write_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO protection_probes`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	rec := NewPGRecorder(db)
	res := Result{
		Layer:   "watchdog",
		Level:   LevelAlive,
		Status:  StatusOK,
		Detail:  "age=1s",
		Latency: 42 * time.Millisecond,
		Expected: map[string]any{"age_max_sec": 900},
		Actual:   map[string]any{"age_sec": 1},
	}
	if err := rec.Write(context.Background(), res); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPGRecorder_Write_NilMaps_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO protection_probes`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	rec := NewPGRecorder(db)
	res := Result{
		Layer:  "db_pool",
		Level:  LevelAlive,
		Status: StatusSkip,
	}
	if err := rec.Write(context.Background(), res); err != nil {
		t.Fatal(err)
	}
}

func TestPGRecorder_Matrix_ReturnsRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cols := []string{"layer", "level", "status", "detail", "latency_ms", "expected", "actual", "checked_at"}
	rows := sqlmock.NewRows(cols).
		AddRow("watchdog", 2, "ok", "age=1s", 42, `{"age_max_sec":900}`, `{"age_sec":1}`, "2026-04-20T10:00:00Z").
		AddRow("db_pool", 2, "skip", "", 0, `{}`, `{}`, "2026-04-20T10:00:01Z")
	mock.ExpectQuery(`SELECT DISTINCT ON`).WillReturnRows(rows)

	rec := NewPGRecorder(db)
	out, err := rec.Matrix(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(out))
	}
	if out[0].Layer != "watchdog" {
		t.Fatalf("unexpected layer: %s", out[0].Layer)
	}
	if out[0].Level != LevelAlive {
		t.Fatalf("unexpected level: %d", out[0].Level)
	}
	if out[1].Status != StatusSkip {
		t.Fatalf("unexpected status: %s", out[1].Status)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
