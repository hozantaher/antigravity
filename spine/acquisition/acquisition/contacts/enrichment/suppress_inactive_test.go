package enrich

import (
	"context"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

func TestRunSuppressInactive_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WithArgs(90).
		WillReturnResult(sqlmock.NewResult(0, 7))

	n, err := RunSuppressInactive(context.Background(), db, 90)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 7 {
		t.Errorf("n = %d, want 7", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet: %v", err)
	}
}

func TestRunSuppressInactive_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnError(errEnrich("db down"))

	_, err = RunSuppressInactive(context.Background(), db, 30)
	if err == nil {
		t.Fatal("expected error from DB failure")
	}
}

func TestRunSuppressInactive_ZeroRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WithArgs(180).
		WillReturnResult(sqlmock.NewResult(0, 0))

	n, err := RunSuppressInactive(context.Background(), db, 180)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("n = %d, want 0", n)
	}
}
