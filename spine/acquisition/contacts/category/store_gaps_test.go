package category

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func newCategoryMock(t *testing.T) (*Store, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return NewStore(db), mock
}

// ── RefreshCounts: leaf upsert error (line 188-190) ──

func TestRefreshCounts_LeafUpsertError(t *testing.T) {
	s, mock := newCategoryMock(t)

	mock.ExpectExec(`INSERT INTO categories`).
		WillReturnError(errors.New("leaf upsert failed"))

	_, err := s.RefreshCounts(context.Background())
	if err == nil {
		t.Error("expected error from leaf upsert")
	}
}

// ── RefreshCounts: ancestor upsert error (line 224-226) ──

func TestRefreshCounts_AncestorUpsertError(t *testing.T) {
	s, mock := newCategoryMock(t)

	mock.ExpectExec(`INSERT INTO categories`).
		WillReturnResult(sqlmock.NewResult(0, 0)) // leaf succeeds
	mock.ExpectExec(`WITH RECURSIVE ancestors`).
		WillReturnError(errors.New("ancestor upsert failed"))

	_, err := s.RefreshCounts(context.Background())
	if err == nil {
		t.Error("expected error from ancestor upsert")
	}
}

// ── query (scan error in List-like function) — line 334 ──

func TestQuery_ScanError(t *testing.T) {
	s, mock := newCategoryMock(t)

	// Return wrong columns → Scan fails
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	_, err := s.query(context.Background(), `SELECT id FROM categories`, nil)
	if err == nil {
		t.Error("expected scan error from query")
	}
}
