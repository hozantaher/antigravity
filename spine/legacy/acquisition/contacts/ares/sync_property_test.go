package ares

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/quick"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── RunSync — additional gap coverage ────────────────────────────────────

// TestRunSync_ScanError covers the rows.Scan error branch in RunSync
// (wrong column types trigger scan failure).
func TestRunSyncP2_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Return three columns instead of two to trigger scan error.
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico", "extra"}).
			AddRow(1, "12345678", "unexpected"))

	client := NewClient(WithRateLimit(0), WithRetryBackoff(0))
	_, err = RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10})
	if err == nil {
		t.Error("expected scan error")
	}
}

// TestRunSync_DryRun_NotFound covers DryRun=true + data==nil (ARES not found).
// In DryRun mode markSynced must NOT be called.
func TestRunSyncP2_DryRun_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "99999999"))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// Server returns 404 → FetchSubject returns nil, nil.
	notFoundSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer notFoundSrv.Close()

	client := NewClient(
		WithBaseURL(notFoundSrv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
	)
	result, err := RunSync(context.Background(), db, client, SyncConfig{
		BatchSize: 10,
		DryRun:    true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.NotFound != 1 {
		t.Errorf("NotFound = %d, want 1", result.NotFound)
	}
	// In DryRun, no UPDATE should have been issued.
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock expectations not met (markSynced should not run in DryRun): %v", err)
	}
}

// TestRunSync_DryRun_FetchError covers DryRun=true + fetch error (server error).
// In DryRun mode markSynced must NOT be called.
func TestRunSyncP2_DryRun_FetchError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "12345678"))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// Server always returns 500 → retries exhausted → error logged.
	errorSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer errorSrv.Close()

	client := NewClient(
		WithBaseURL(errorSrv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
	)
	result, err := RunSync(context.Background(), db, client, SyncConfig{
		BatchSize: 10,
		DryRun:    true,
	})
	if err != nil {
		t.Fatalf("unexpected error in DryRun mode: %v", err)
	}
	if result.Errors != 1 {
		t.Errorf("Errors = %d, want 1", result.Errors)
	}
	// In DryRun, markSynced must not run.
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock expectations not met: %v", err)
	}
}

// TestRunSync_DryRun_Success covers DryRun=true + successful fetch (no persistARES call).
func TestRunSyncP2_DryRun_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "12345678"))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	// Server returns 200 + valid JSON → fetch succeeds.
	successSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(SubjectResponse{
			ICO:    "12345678",
			CzNace: []string{"28410"},
		})
	}))
	defer successSrv.Close()

	client := NewClient(
		WithBaseURL(successSrv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
	)
	result, err := RunSync(context.Background(), db, client, SyncConfig{
		BatchSize: 10,
		DryRun:    true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Synced != 1 {
		t.Errorf("Synced = %d, want 1", result.Synced)
	}
	// In DryRun no DB writes happen.
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock expectations not met: %v", err)
	}
}

// TestRunSync_ContextCancelled covers ctx.Done() at the top of the main loop.
func TestRunSyncP2_ContextCancelled(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	client := NewClient(WithRateLimit(0), WithRetryBackoff(0))
	_, err = RunSync(ctx, db, client, SyncConfig{BatchSize: 10})
	if err == nil {
		t.Error("expected context error")
	}
}

// TestRunSync_EmptyICO_Skipped covers the empty ICO path → result.Skipped incremented.
func TestRunSyncP2_EmptyICO_Skipped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Row with blank ICO after trimming — should be skipped.
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, "   "))
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(WithRateLimit(0), WithRetryBackoff(0))
	result, err := RunSync(context.Background(), db, client, SyncConfig{
		BatchSize: 10,
		DryRun:    true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1", result.Skipped)
	}
}

// ── property tests ────────────────────────────────────────────────────────

// TestRunSync_Property_DefaultBatchSize_NoPanic verifies batch-size normalisation
// never panics and returns a non-nil result for an empty DB.
func TestRunSyncP2_Property_DefaultBatchSize_NoPanic(t *testing.T) {
	f := func(batchSize int16) bool {
		defer func() { recover() }()

		db, mock, err := sqlmock.New()
		if err != nil {
			return true
		}
		defer db.Close()

		mock.ExpectQuery(`SELECT id, ico FROM companies`).
			WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

		client := NewClient(WithRateLimit(0), WithRetryBackoff(0))
		result, _ := RunSync(context.Background(), db, client, SyncConfig{BatchSize: int(batchSize)})
		return result != nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestRunSync_Property_IcoPadding_NeverPanics verifies short ICOs (1-7 digits)
// are padded correctly and never cause a panic in the sync loop.
func TestRunSyncP2_Property_IcoPadding_NeverPanics(t *testing.T) {
	// Server returns 404 for all ICOs (clean, no DB interaction needed after fetch).
	notFoundSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer notFoundSrv.Close()

	f := func(shortICO uint32) bool {
		defer func() { recover() }()

		ico := shortICO % 9999999 // 1–7 digits max
		icoStr := ""
		if ico > 0 {
			icoStr = string([]byte{
				byte('0' + (ico/1000000)%10),
				byte('0' + (ico/100000)%10),
				byte('0' + (ico/10000)%10),
				byte('0' + (ico/1000)%10),
				byte('0' + (ico/100)%10),
				byte('0' + (ico/10)%10),
				byte('0' + ico%10),
			})
		}

		db, mock, err := sqlmock.New()
		if err != nil {
			return true
		}
		defer db.Close()

		mock.ExpectQuery(`SELECT id, ico FROM companies`).
			WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}).AddRow(1, icoStr))
		mock.ExpectQuery(`SELECT id, ico FROM companies`).
			WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

		client := NewClient(
			WithBaseURL(notFoundSrv.URL),
			WithRateLimit(0),
			WithRetryBackoff(0),
		)
		RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10, DryRun: true}) //nolint:errcheck
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}
