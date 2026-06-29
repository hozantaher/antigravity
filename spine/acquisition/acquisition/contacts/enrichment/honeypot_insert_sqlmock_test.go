package enrich

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestInsertHoneypotSignals_SingleSignal(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	signals := []HoneypotSignal{
		{Type: "typo_domain", Severity: "medium", Details: "gmial.com -> gmail.com", Fix: "user@gmail.com"},
	}

	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WithArgs(42, "typo_domain", "medium", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err = InsertHoneypotSignals(context.Background(), db, 42, signals)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestInsertHoneypotSignals_MultipleSignals(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	signals := []HoneypotSignal{
		{Type: "typo_domain", Severity: "medium", Details: "gmial.com -> gmail.com", Fix: "user@gmail.com"},
		{Type: "role_based", Severity: "low", Details: "role-based prefix: admin"},
		{Type: "suspicious_pattern", Severity: "high", Details: "suspicious local part: test"},
	}

	for range signals {
		mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
			WillReturnResult(sqlmock.NewResult(1, 1))
	}

	err = InsertHoneypotSignals(context.Background(), db, 10, signals)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestInsertHoneypotSignals_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	signals := []HoneypotSignal{
		{Type: "typo_domain", Severity: "medium", Details: "test", Fix: "fixed"},
	}

	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnError(errEnrich("db error"))

	err = InsertHoneypotSignals(context.Background(), db, 1, signals)
	if err == nil {
		t.Error("expected error from DB insert")
	}
}

func TestInsertHoneypotSignals_SecondSignalFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	signals := []HoneypotSignal{
		{Type: "typo_domain", Severity: "medium", Details: "ok", Fix: "ok"},
		{Type: "role_based", Severity: "low", Details: "admin"},
	}

	// First insert succeeds
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// Second insert fails
	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnError(errEnrich("second insert failed"))

	err = InsertHoneypotSignals(context.Background(), db, 5, signals)
	if err == nil {
		t.Error("expected error from second signal insert")
	}
}

func TestInsertHoneypotSignals_EmptyFixField(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	signals := []HoneypotSignal{
		{Type: "role_based", Severity: "low", Details: "admin prefix", Fix: ""},
	}

	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err = InsertHoneypotSignals(context.Background(), db, 99, signals)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
