package campaign

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── VerifySegmentBatch ────────────────────────────────────────────────────────

func TestVerifySegmentBatch_ReturnsCount(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\)`).
		WithArgs(int64(3)).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(42))

	r := NewRunner(db, nil, nil)
	result, err := r.VerifySegmentBatch(context.Background(), 3)
	if err != nil {
		t.Fatalf("VerifySegmentBatch: %v", err)
	}
	if result.Count != 42 {
		t.Errorf("count = %d, want 42", result.Count)
	}
	if result.SegmentID != 3 {
		t.Errorf("segment_id = %d, want 3", result.SegmentID)
	}
}

func TestVerifySegmentBatch_ZeroCount(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\)`).
		WithArgs(int64(9)).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	r := NewRunner(db, nil, nil)
	result, err := r.VerifySegmentBatch(context.Background(), 9)
	if err != nil {
		t.Fatalf("VerifySegmentBatch: %v", err)
	}
	if result.Count != 0 {
		t.Errorf("count = %d, want 0", result.Count)
	}
	if result.Ready {
		t.Error("Ready should be false when count = 0")
	}
}

func TestVerifySegmentBatch_ReadyWhenCountPositive(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\)`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(15))

	r := NewRunner(db, nil, nil)
	result, err := r.VerifySegmentBatch(context.Background(), 1)
	if err != nil {
		t.Fatalf("VerifySegmentBatch: %v", err)
	}
	if !result.Ready {
		t.Errorf("Ready should be true when count > 0; count = %d", result.Count)
	}
}

func TestVerifySegmentBatch_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\)`).
		WillReturnError(batchErr("db down"))

	r := NewRunner(db, nil, nil)
	_, err = r.VerifySegmentBatch(context.Background(), 1)
	if err == nil {
		t.Fatal("expected error")
	}
}

// ── BatchVerifyResult ─────────────────────────────────────────────────────────

func TestBatchVerifyResult_Fields(t *testing.T) {
	r := BatchVerifyResult{SegmentID: 5, Count: 100, Ready: true}
	if r.SegmentID != 5 || r.Count != 100 || !r.Ready {
		t.Errorf("unexpected result: %+v", r)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func batchErr(s string) error { return batchErrT(s) }

type batchErrT string

func (e batchErrT) Error() string { return string(e) }
