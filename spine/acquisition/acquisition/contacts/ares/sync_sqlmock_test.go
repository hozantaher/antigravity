package ares

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── persistARES via sqlmock ──

func TestPersistARES_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	data := &SubjectData{
		ICO:         "12345678",
		NACECodes:   []string{"2841", "2899"},
		NACEPrimary: "2841",
		DatumVzniku: "2001-01-01",
	}

	err = persistARES(context.Background(), db, 1, data)
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

func TestPersistARES_NoNACE(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	data := &SubjectData{
		ICO:         "99999999",
		NACECodes:   nil,
		NACEPrimary: "",
		DatumVzniku: "",
	}

	err = persistARES(context.Background(), db, 2, data)
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

func TestPersistARES_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errAres("update failed"))

	data := &SubjectData{ICO: "11111111"}
	err = persistARES(context.Background(), db, 3, data)
	if err == nil { t.Error("expected error") }
}

// ── markSynced via sqlmock ──

func TestMarkSynced_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies SET ares_synced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Should not panic
	markSynced(context.Background(), db, 42)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestMarkSynced_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies SET ares_synced_at`).
		WillReturnError(errAres("update failed"))

	// Should not panic — errors are logged
	markSynced(context.Background(), db, 99)
}

// ── RunSync via sqlmock ──

func TestRunSync_EmptyBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Empty first batch → loop ends
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient()
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Total != 0 { t.Errorf("Total = %d, want 0", result.Total) }
}

func TestRunSync_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnError(errAres("query failed"))

	client := NewClient()
	_, err = RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10})
	if err == nil { t.Error("expected error") }
}

func TestRunSync_DefaultBatchSize(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// BatchSize=0 → defaults to 1000
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient()
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 0})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result == nil { t.Fatal("result nil") }
}

// ── batchUpdate via sqlmock ──

func TestBatchUpdate_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies AS c`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	batch := []resBatchRow{
		{ico: "12345678", nace: "2841", datumVzniku: "2001-01-01", legalForm: ""},
		{ico: "87654321", nace: "2899", datumVzniku: "", legalForm: "111"},
	}

	updated, notFound, err := batchUpdate(context.Background(), db, batch)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if updated != 2 { t.Errorf("updated = %d, want 2", updated) }
	if notFound != 0 { t.Errorf("notFound = %d, want 0", notFound) }
}

func TestBatchUpdate_PartialUpdate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies AS c`).
		WillReturnResult(sqlmock.NewResult(0, 1)) // only 1 of 2 found

	batch := []resBatchRow{
		{ico: "11111111", nace: "2841"},
		{ico: "22222222", nace: "2899"},
	}

	updated, notFound, err := batchUpdate(context.Background(), db, batch)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if updated != 1 { t.Errorf("updated = %d, want 1", updated) }
	if notFound != 1 { t.Errorf("notFound = %d, want 1", notFound) }
}

func TestBatchUpdate_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies AS c`).
		WillReturnError(errAres("batch update failed"))

	batch := []resBatchRow{{ico: "12345678", nace: "2841"}}
	_, _, err = batchUpdate(context.Background(), db, batch)
	if err == nil { t.Error("expected error") }
}

type errAres string
func (e errAres) Error() string { return string(e) }
