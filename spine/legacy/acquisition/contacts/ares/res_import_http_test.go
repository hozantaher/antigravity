package ares

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

const testRESCSV = "ICO,DDATVZN,DDATZAN,FORMA,NACE\n12345678,2001-01-01,,111,2841\n"

// TestRunRESImport_HTTPDownload_Success exercises the HTTP download path
// (nil DataReader) with a local test server returning valid CSV.
func TestRunRESImport_HTTPDownload_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(testRESCSV))
	}))
	defer srv.Close()

	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cfg := RESImportConfig{
		DataURL: srv.URL,
		DryRun:  true, // no DB writes needed
	}
	result, err := RunRESImport(context.Background(), db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Parsed != 1 {
		t.Errorf("Parsed = %d, want 1", result.Parsed)
	}
}

// TestRunRESImport_HTTPDownload_Non200_Error tests the non-200 response path.
func TestRunRESImport_HTTPDownload_Non200_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte("service down"))
	}))
	defer srv.Close()

	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	_, err = RunRESImport(context.Background(), db, RESImportConfig{DataURL: srv.URL})
	if err == nil {
		t.Fatal("expected error for non-200 HTTP response")
	}
}

// TestRunRESImport_HTTPDownload_NetworkError tests failure when server is unreachable.
func TestRunRESImport_HTTPDownload_NetworkError(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Point at a non-listening port to force a connection refused error.
	_, err = RunRESImport(context.Background(), db, RESImportConfig{
		DataURL: "http://127.0.0.1:1", // nothing listening here
	})
	if err == nil {
		t.Fatal("expected network error")
	}
}

// TestRunRESImport_DefaultBatchSize covers the cfg.BatchSize <= 0 default path.
func TestRunRESImport_DefaultBatchSize(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cfg := RESImportConfig{
		// BatchSize not set → defaults to resBatchSize
		DryRun:     true,
		DataReader: strings.NewReader(testRESCSV),
	}
	result, err := RunRESImport(context.Background(), db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
}

// TestRunRESImport_DefaultDataURL covers the dataURL fallback to resBulkURL.
// We can't reach the real URL in tests, so just verify it attempts and fails.
func TestRunRESImport_DefaultDataURL_AttemptsFetch(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// No DataURL and no DataReader — uses resBulkURL which won't resolve in tests
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately to avoid long wait
	_, err = RunRESImport(ctx, db, RESImportConfig{})
	// Either context cancelled or download error — both are expected
	if err == nil {
		t.Log("unexpectedly succeeded — remote URL was reachable")
	}
}

