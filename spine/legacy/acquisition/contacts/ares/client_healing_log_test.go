package ares

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"contacts/internal/blockdetect"
)

// TestFetchSubject_HealingLog_WriterFiresOnRateLimit verifies the KT-A8.1
// wiring: a 429 response triggers blockdetect, which fires the LogWriter
// observer, which inserts a healing_log row.
func TestFetchSubject_HealingLog_WriterFiresOnRateLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("Too Many Requests"))
	}))
	defer srv.Close()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 4 expected inserts — 1 initial + maxRetries (3) — sustained block.
	mock.MatchExpectationsInOrder(false)
	for i := 0; i < 1+maxRetries; i++ {
		mock.ExpectExec(`INSERT INTO healing_log`).
			WithArgs("ares", "rate_limit", 429, sqlmock.AnyArg(), sqlmock.AnyArg()).
			WillReturnResult(sqlmock.NewResult(int64(i+1), 1))
	}

	writer := blockdetect.NewLogWriter(db)
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithHealingLog(writer),
	)

	_, err = client.FetchSubject(context.Background(), "12345678")
	if err == nil {
		t.Fatal("expected block error from sustained 429")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock expectations: %v", err)
	}
}

// TestFetchSubject_HealingLog_DBErrorDoesNotFailFetch verifies the contract
// that an INSERT failure must NOT abort the fetch. The fetch itself still
// returns a block error (because the upstream is genuinely blocked) but the
// audit-row failure is swallowed by AsObserver.
func TestFetchSubject_HealingLog_DBErrorDoesNotFailFetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cf-Ray", "abc-PRG")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<title>Just a moment...</title>`))
	}))
	defer srv.Close()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.MatchExpectationsInOrder(false)
	for i := 0; i < 1+maxRetries; i++ {
		mock.ExpectExec(`INSERT INTO healing_log`).
			WillReturnError(errors.New("connection refused"))
	}

	writer := blockdetect.NewLogWriter(db)
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithHealingLog(writer),
	)

	_, err = client.FetchSubject(context.Background(), "27082440")
	if err == nil {
		t.Fatal("expected block error from Cloudflare 200")
	}
	if !IsBlock(err) {
		t.Errorf("err should be a block error, got %T: %v", err, err)
	}
}

// TestFetchSubject_HealingLog_NoInsertOn200 verifies that a clean 200 OK
// response does NOT touch healing_log. sqlmock will fail if any unexpected
// Exec is issued.
func TestFetchSubject_HealingLog_NoInsertOn200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ico":"27082440","obchodniJmeno":"Alza.cz a.s."}`))
	}))
	defer srv.Close()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()
	// No ExpectExec — any call to ExecContext will fail the test.

	writer := blockdetect.NewLogWriter(db)
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithHealingLog(writer),
	)

	data, err := client.FetchSubject(context.Background(), "27082440")
	if err != nil {
		t.Fatalf("unexpected error on clean 200: %v", err)
	}
	if data == nil || data.ICO != "27082440" {
		t.Fatalf("unexpected data: %+v", data)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unexpected sqlmock state: %v", err)
	}
}

// TestFetchSubject_HealingLog_ChainsExistingObserver verifies that wiring
// WithHealingLog after WithBlockObserver preserves both callbacks — the
// audit row gets written AND the user observer fires.
func TestFetchSubject_HealingLog_ChainsExistingObserver(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Server", "nginx")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.MatchExpectationsInOrder(false)
	for i := 0; i < 1+maxRetries; i++ {
		mock.ExpectExec(`INSERT INTO healing_log`).
			WithArgs("ares", "forbidden", 403, sqlmock.AnyArg(), sqlmock.AnyArg()).
			WillReturnResult(sqlmock.NewResult(int64(i+1), 1))
	}

	var userObserved atomic.Int32
	writer := blockdetect.NewLogWriter(db)

	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, _ blockdetect.BlockType, _ int, _ []byte) {
			userObserved.Add(1)
		}),
		WithHealingLog(writer),
	)

	_, err = client.FetchSubject(context.Background(), "27082440")
	if err == nil {
		t.Fatal("expected block error")
	}
	if userObserved.Load() == 0 {
		t.Error("user-supplied observer was never invoked — chain broken")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock expectations: %v", err)
	}
}

// TestFetchSubject_HealingLog_NilWriterIsNoop verifies the safety contract
// that passing a nil writer (e.g. when DATABASE_URL is unset in tests)
// disables wiring without panicking. The fetch still works.
func TestFetchSubject_HealingLog_NilWriterIsNoop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ico":"27082440","obchodniJmeno":"X"}`))
	}))
	defer srv.Close()

	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithHealingLog(nil),
	)

	data, err := client.FetchSubject(context.Background(), "27082440")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data == nil {
		t.Fatal("expected data on clean 200")
	}
}
