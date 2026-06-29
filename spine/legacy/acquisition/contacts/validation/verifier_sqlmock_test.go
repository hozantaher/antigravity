package validation

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── LoadDomainCache via sqlmock ──

func TestLoadDomainCache_NilDB(t *testing.T) {
	v := NewVerifier(nil)
	if err := v.LoadDomainCache(context.Background()); err != nil {
		t.Errorf("unexpected error with nil DB: %v", err)
	}
}

func TestLoadDomainCache_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}))

	v := NewVerifier(db)
	if err := v.LoadDomainCache(context.Background()); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestLoadDomainCache_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnError(errValidation("db error"))

	v := NewVerifier(db)
	if err := v.LoadDomainCache(context.Background()); err == nil {
		t.Error("expected error from query failure")
	}
}

func TestLoadDomainCache_WithRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "mx_exists", "mx_host", "is_catch_all",
			"is_disposable", "is_spamtrap", "smtp_connectable", "checked_at",
		}).
			AddRow("firma.cz", true, "mx.firma.cz", false, false, false, true, now).
			AddRow("spam.cz", false, "", true, true, false, false, now))

	v := NewVerifier(db)
	if err := v.LoadDomainCache(context.Background()); err != nil {
		t.Errorf("unexpected error: %v", err)
	}

	// Verify cache was populated
	entry, ok := v.cache.Get("firma.cz")
	if !ok { t.Error("firma.cz should be cached") }
	if !entry.mxExists { t.Error("mxExists should be true") }
}

// ── SaveCompanyResult via sqlmock ──

func TestSaveCompanyResult_NilDB(t *testing.T) {
	v := NewVerifier(nil)
	err := v.SaveCompanyResult(context.Background(), 1, StatusValid, &VerificationResult{})
	if err != nil { t.Errorf("unexpected error with nil DB: %v", err) }
}

func TestSaveCompanyResult_DryRun(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	v := NewVerifier(db)
	v.DryRun = true
	// DryRun=true → no DB call expected
	err = v.SaveCompanyResult(context.Background(), 1, StatusValid, &VerificationResult{})
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

func TestSaveCompanyResult_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	v := NewVerifier(db)
	err = v.SaveCompanyResult(context.Background(), 42, StatusValid, &VerificationResult{
		RiskLevel:   "low",
		MXExists:    true,
		SyntaxValid: true,
	})
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

func TestSaveCompanyResult_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies`).
		WillReturnError(errValidation("exec failed"))

	v := NewVerifier(db)
	err = v.SaveCompanyResult(context.Background(), 1, StatusInvalid, &VerificationResult{})
	if err == nil { t.Error("expected error") }
}

func TestSaveDomainEntry_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO email_domains`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	v := NewVerifier(db)
	entry := &domainEntry{
		mxExists:    true,
		mxHost:      "mx.firma.cz",
		isDisposable: false,
		isSpamtrap:  false,
		checkedAt:   time.Now(),
	}
	v.saveDomainEntry(context.Background(), "firma.cz", entry)
	// saveDomainEntry swallows errors — we verify the query was issued
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestSaveDomainEntry_DBError_NoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO email_domains`).
		WillReturnError(errValidation("upsert failed"))

	v := NewVerifier(db)
	entry := &domainEntry{mxExists: false, checkedAt: time.Now()}
	// Must not panic; error is logged but swallowed
	v.saveDomainEntry(context.Background(), "bad.cz", entry)
}

func TestSaveDomainEntry_DryRun_NoDBCall(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	v := NewVerifier(db)
	v.DryRun = true
	// No mock expectations — if the DB is called it will fail unexpectedly
	v.saveDomainEntry(context.Background(), "dryrun.cz", &domainEntry{checkedAt: time.Now()})
}

func TestCheckDomain_CacheHit(t *testing.T) {
	v := NewVerifier(nil) // nil DB — cache hit must not reach DB
	expected := &domainEntry{mxExists: true, mxHost: "mx.cached.cz"}
	v.cache.Set("cached.cz", expected)

	got := v.checkDomain(context.Background(), "cached.cz")
	if got != expected {
		t.Error("checkDomain should return the cached entry")
	}
}

// ── SaveCompanyResultBatch ──────────────────────────────────────

func TestSaveCompanyResultBatch_NilDB(t *testing.T) {
	v := NewVerifier(nil)
	rows := []CompanyVerifyRow{
		{ID: 1, Status: StatusValid, Result: &VerificationResult{}},
	}
	if err := v.SaveCompanyResultBatch(context.Background(), rows); err != nil {
		t.Errorf("unexpected error with nil DB: %v", err)
	}
}

func TestSaveCompanyResultBatch_DryRun(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	v := NewVerifier(db)
	v.DryRun = true
	rows := []CompanyVerifyRow{
		{ID: 1, Status: StatusValid, Result: &VerificationResult{}},
		{ID: 2, Status: StatusInvalid, Result: &VerificationResult{}},
	}
	if err := v.SaveCompanyResultBatch(context.Background(), rows); err != nil {
		t.Errorf("unexpected error in DryRun: %v", err)
	}
}

func TestSaveCompanyResultBatch_Empty(t *testing.T) {
	v := NewVerifier(nil)
	if err := v.SaveCompanyResultBatch(context.Background(), nil); err != nil {
		t.Errorf("unexpected error for empty rows: %v", err)
	}
	if err := v.SaveCompanyResultBatch(context.Background(), []CompanyVerifyRow{}); err != nil {
		t.Errorf("unexpected error for empty slice: %v", err)
	}
}

func TestSaveCompanyResultBatch_SingleRow_FallsBackToSingle(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Single row → falls back to SaveCompanyResult → uses UPDATE companies WHERE id = $3
	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	v := NewVerifier(db)
	rows := []CompanyVerifyRow{
		{ID: 42, Status: StatusValid, Result: &VerificationResult{RiskLevel: "low"}},
	}
	if err := v.SaveCompanyResultBatch(context.Background(), rows); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestSaveCompanyResultBatch_MultiRow_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	v := NewVerifier(db)
	rows := []CompanyVerifyRow{
		{ID: 1, Status: StatusValid, Result: &VerificationResult{RiskLevel: "low", MXExists: true}},
		{ID: 2, Status: StatusInvalid, Result: &VerificationResult{RiskLevel: "high"}},
		{ID: 3, Status: StatusCatchAll, Result: &VerificationResult{IsCatchAll: true}},
	}
	if err := v.SaveCompanyResultBatch(context.Background(), rows); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestSaveCompanyResultBatch_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE companies`).
		WillReturnError(errValidation("batch exec failed"))

	v := NewVerifier(db)
	rows := []CompanyVerifyRow{
		{ID: 1, Status: StatusValid, Result: &VerificationResult{}},
		{ID: 2, Status: StatusInvalid, Result: &VerificationResult{}},
	}
	if err := v.SaveCompanyResultBatch(context.Background(), rows); err == nil {
		t.Error("expected error from DB failure")
	}
}

// ── pqArray ────────────────────────────────────────────────────

func TestPqArray_Int64(t *testing.T) {
	got := pqArray([]int64{1, 2, 3})
	want := "{1,2,3}"
	if got != want {
		t.Fatalf("pqArray int64: got %q, want %q", got, want)
	}
}

func TestPqArray_String(t *testing.T) {
	got := pqArray([]string{"valid", "invalid", "risky"})
	want := `{"valid","invalid","risky"}`
	if got != want {
		t.Fatalf("pqArray string: got %q, want %q", got, want)
	}
}

func TestPqArray_Empty(t *testing.T) {
	if got := pqArray([]int64{}); got != "{}" {
		t.Fatalf("pqArray empty int64: got %q", got)
	}
	if got := pqArray([]string{}); got != "{}" {
		t.Fatalf("pqArray empty string: got %q", got)
	}
}

func TestPqArray_StringWithQuotes(t *testing.T) {
	got := pqArray([]string{`say "hello"`})
	if got != `{"say \"hello\""}` {
		t.Fatalf("pqArray quote escape: got %q", got)
	}
}

type errValidation string

func (e errValidation) Error() string { return string(e) }
