package ares

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// TestRunSync_FetchError covers line 90-92 (FetchSubject error → result.Errors++).
// The ARES mock server returns 500 so FetchSubject fails.
func TestRunSync_FetchError(t *testing.T) {
	// Mock ARES server that always returns 500
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// One company with ICO → fetch will fail
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}).
			AddRow(1, "12345678"))
	// Second batch → empty (end of loop)
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0), // no rate limiting
		WithRetryBackoff(0),
	)
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 10})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Errors < 1 {
		t.Errorf("Errors = %d, want >= 1 (fetch failed)", result.Errors)
	}
}

// TestRunSync_Progress100 covers line 122-130 (progress log at Total%100==0).
// Requires >=100 records to trigger.
func TestRunSync_Progress100(t *testing.T) {
	// Mock ARES server that returns empty JSON
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json"); w.WriteHeader(http.StatusOK); w.Write([]byte(`{"ico":"12345678","obchodniJmeno":"Test s.r.o.","sidlo":{}}`))
	}))
	defer srv.Close()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Add 100 rows to trigger the progress log
	batchRows := sqlmock.NewRows([]string{"id", "ico"})
	for i := 1; i <= 100; i++ {
		batchRows.AddRow(i, "12345678")
	}
	mock.ExpectQuery(`SELECT id, ico FROM companies`).WillReturnRows(batchRows)
	mock.ExpectQuery(`SELECT id, ico FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "ico"}))

	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
	)
	result, err := RunSync(context.Background(), db, client, SyncConfig{BatchSize: 200, DryRun: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total < 100 {
		t.Errorf("Total = %d, want >= 100", result.Total)
	}
}
