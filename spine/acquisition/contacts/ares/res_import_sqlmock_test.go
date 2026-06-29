package ares

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── RunRESImport (DataReader path) ────────────────────────────────────────────

func TestRunRESImport_DryRun(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	csv := "ICO,DDATVZN,DDATZAN,FORMA,NACE\n12345678,2001-01-01,,111,2841\n87654321,2010-05-20,2020-01-01,112,2899\n"

	cfg := RESImportConfig{
		DataReader: strings.NewReader(csv),
		DryRun:     true,
	}

	result, err := RunRESImport(context.Background(), db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Parsed != 2 {
		t.Errorf("Parsed = %d, want 2", result.Parsed)
	}
	// DryRun accumulates updated count without touching DB
	if result.Updated != 2 {
		t.Errorf("Updated = %d, want 2 (dry-run)", result.Updated)
	}
}

func TestRunRESImport_SkipClosed(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	csv := "ICO,DDATVZN,DDATZAN,FORMA,NACE\n12345678,2001-01-01,,111,2841\n87654321,2010-05-20,2020-01-01,112,2899\n"

	cfg := RESImportConfig{
		DataReader: strings.NewReader(csv),
		DryRun:     true,
		SkipClosed: true,
	}

	result, err := RunRESImport(context.Background(), db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Parsed != 2 {
		t.Errorf("Parsed = %d, want 2", result.Parsed)
	}
	if result.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1 (closed company)", result.Skipped)
	}
	if result.Updated != 1 {
		t.Errorf("Updated = %d, want 1", result.Updated)
	}
}

func TestRunRESImport_SkipEmptyICO(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	csv := "ICO,DDATVZN,DDATZAN,FORMA,NACE\n,2001-01-01,,111,2841\n12345678,2001-01-01,,111,2841\n"

	cfg := RESImportConfig{
		DataReader: strings.NewReader(csv),
		DryRun:     true,
	}

	result, err := RunRESImport(context.Background(), db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1 (empty ICO)", result.Skipped)
	}
}

func TestRunRESImport_MissingRequiredColumn(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// No NACE column → should fail resolveColumns
	csv := "ICO,DDATVZN\n12345678,2001-01-01\n"

	cfg := RESImportConfig{
		DataReader: strings.NewReader(csv),
	}

	_, err = RunRESImport(context.Background(), db, cfg)
	if err == nil {
		t.Fatal("expected error for missing NACE column")
	}
	if !strings.Contains(err.Error(), "NACE") {
		t.Errorf("error should mention NACE: %v", err)
	}
}

func TestRunRESImport_InvalidHeader(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Empty reader → Read() on header will hit EOF
	cfg := RESImportConfig{
		DataReader: strings.NewReader(""),
	}

	_, err = RunRESImport(context.Background(), db, cfg)
	if err == nil {
		t.Fatal("expected error for empty CSV")
	}
}

func TestRunRESImport_WithDBUpdate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	csv := "ICO,DDATVZN,DDATZAN,FORMA,NACE\n12345678,2001-01-01,,111,2841\n"

	mock.ExpectExec(`UPDATE companies AS c`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	cfg := RESImportConfig{
		DataReader: strings.NewReader(csv),
		DryRun:     false,
		BatchSize:   10,
	}

	result, err := RunRESImport(context.Background(), db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Updated != 1 {
		t.Errorf("Updated = %d, want 1", result.Updated)
	}
}

func TestRunRESImport_ContextCancelled(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Build a CSV with many rows so the context fires mid-stream
	var sb strings.Builder
	sb.WriteString("ICO,DDATVZN,DDATZAN,FORMA,NACE\n")
	for i := 0; i < 5; i++ {
		sb.WriteString("12345678,2001-01-01,,111,2841\n")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	cfg := RESImportConfig{
		DataReader: strings.NewReader(sb.String()),
		DryRun:     true,
	}

	_, err = RunRESImport(ctx, db, cfg)
	if err == nil {
		t.Fatal("expected context cancellation error")
	}
}

func TestRunRESImport_SmallBatchFlush(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 3 rows with batch size 2 → 2 flushes
	csv := "ICO,DDATVZN,DDATZAN,FORMA,NACE\n" +
		"11111111,2001-01-01,,111,2841\n" +
		"22222222,2002-02-02,,112,2899\n" +
		"33333333,2003-03-03,,113,4520\n"

	mock.ExpectExec(`UPDATE companies AS c`).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectExec(`UPDATE companies AS c`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	cfg := RESImportConfig{
		DataReader: strings.NewReader(csv),
		DryRun:     false,
		BatchSize:   2,
	}

	result, err := RunRESImport(context.Background(), db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Updated != 3 {
		t.Errorf("Updated = %d, want 3", result.Updated)
	}
}

// ── parseAndImport error path ─────────────────────────────────────────────────

func TestParseAndImport_DBFlushError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	csv := "ICO,DDATVZN,DDATZAN,FORMA,NACE\n12345678,2001-01-01,,111,2841\n"

	mock.ExpectExec(`UPDATE companies AS c`).
		WillReturnError(errAres("db failure"))

	cfg := RESImportConfig{
		DataReader: strings.NewReader(csv),
		DryRun:     false,
		BatchSize:   10,
	}

	_, err = RunRESImport(context.Background(), db, cfg)
	if err == nil {
		t.Fatal("expected error from DB flush failure")
	}
}

// ── RunSync additional branches ───────────────────────────────────────────────

func TestRunSync_ContextCancelledAtStart(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	client := NewClient()
	result, err := RunSync(ctx, db, client, SyncConfig{BatchSize: 10})
	if err == nil {
		t.Fatal("expected context error")
	}
	_ = result
}

func TestRunSync_FetchErrorIncrementsErrors(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Server always returns 500 → all retries fail → Errors++
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	// One company with ICO
	rows := sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "99999999")
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(rows)
	// markSynced is called after error (DryRun=false path)
	mock.ExpectExec(`UPDATE companies SET ares_synced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Second query → empty, ends loop
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10, DryRun: false})
	if err != nil {
		t.Fatalf("RunSync should not return error on fetch errors: %v", err)
	}
	if result.Errors != 1 {
		t.Errorf("Errors = %d, want 1", result.Errors)
	}
}

func TestRunSync_EmptyICOSkipped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Row with blank ICO → skipped
	rows := sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "   ")
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(rows)
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient()
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1", result.Skipped)
	}
}

func TestRunSync_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Return row with wrong column types to trigger scan error
	rows := sqlmock.NewRows([]string{"id", "ico"}).
		AddRow("not_an_int", "12345678")
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(rows)

	client := NewClient()
	_, err = RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10})
	if err == nil {
		t.Fatal("expected scan error")
	}
}

func TestRunSync_NotFoundPath(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	rows := sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "00000001")
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(rows)
	mock.ExpectExec(`UPDATE companies SET ares_synced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0))
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10, DryRun: false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.NotFound != 1 {
		t.Errorf("NotFound = %d, want 1", result.NotFound)
	}
}

func TestRunSync_DryRun_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	rows := sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "00000001")
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(rows)
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0))
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10, DryRun: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.NotFound != 1 {
		t.Errorf("NotFound (dry-run) = %d, want 1", result.NotFound)
	}
}

func TestRunSync_DryRun_Error(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	rows := sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "12345678")
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(rows)
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10, DryRun: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Errors != 1 {
		t.Errorf("Errors (dry-run) = %d, want 1", result.Errors)
	}
}

func TestRunSync_SuccessfulSync(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ico":"12345678","czNace":["2841","2899"],"datumVzniku":"2001-01-01","pravniForma":"112"}`))
	}))
	defer srv.Close()

	rows := sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "12345678")
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(rows)
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0))
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10, DryRun: false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Synced != 1 {
		t.Errorf("Synced = %d, want 1", result.Synced)
	}
}

func TestRunSync_PersistError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ico":"12345678","czNace":["2841"]}`))
	}))
	defer srv.Close()

	rows := sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "12345678")
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(rows)
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errAres("db error"))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0))
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10, DryRun: false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Errors != 1 {
		t.Errorf("Errors = %d, want 1 (persist error)", result.Errors)
	}
}

// ── tokenBucket stop channel ──────────────────────────────────────────────────

func TestTokenBucket_StopChannel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tb := newTokenBucket(ctx, 1, 1)

	// Drain burst token
	if err := tb.Wait(ctx); err != nil {
		t.Fatal("first wait:", err)
	}

	// Directly close stop to simulate goroutine exit
	cancel()

	// Wait should return error via ctx.Done or stop channel
	err := tb.Wait(ctx)
	if err == nil {
		t.Error("expected error after cancel")
	}
}
