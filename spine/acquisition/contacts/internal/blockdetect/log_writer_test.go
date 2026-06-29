package blockdetect

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// healingLogInsertPattern matches the parameterised INSERT issued by Record.
// Using regexp escape on parens because sqlmock.ExpectExec treats the input
// as a regex by default.
const healingLogInsertPattern = `INSERT INTO healing_log`

// newWriterMock spins up a sqlmock-backed LogWriter for a single test.
func newWriterMock(t *testing.T) (*LogWriter, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	w := NewLogWriter(db)
	cleanup := func() {
		_ = db.Close()
	}
	return w, mock, cleanup
}

// 1. INSERT happens for rate_limit.
func TestLogWriter_Record_RateLimit_InsertsRow(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	mock.ExpectExec(healingLogInsertPattern).
		WithArgs("ares", "rate_limit", 429, "https://ares.gov.cz/27082440", "Too Many Requests").
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), BlockEvent{
		SourceName:    "ares",
		BlockType:     BlockTypeRateLimit,
		HTTPStatus:    429,
		TargetURL:     "https://ares.gov.cz/27082440",
		BodySignature: "Too Many Requests",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 2. INSERT happens for captcha.
func TestLogWriter_Record_Captcha_InsertsRow(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	mock.ExpectExec(healingLogInsertPattern).
		WithArgs("firmy_cz", "captcha", 200, "https://firmy.cz/abc", "g-recaptcha").
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), BlockEvent{
		SourceName:    "firmy_cz",
		BlockType:     BlockTypeCaptcha,
		HTTPStatus:    200,
		TargetURL:     "https://firmy.cz/abc",
		BodySignature: "g-recaptcha",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 3. INSERT happens for cloudflare.
func TestLogWriter_Record_Cloudflare_InsertsRow(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	mock.ExpectExec(healingLogInsertPattern).
		WithArgs("ares", "cloudflare", 200, "https://ares.gov.cz/27082440", "Just a moment...").
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), BlockEvent{
		SourceName:    "ares",
		BlockType:     BlockTypeCloudflare,
		HTTPStatus:    200,
		TargetURL:     "https://ares.gov.cz/27082440",
		BodySignature: "Just a moment...",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 4. INSERT happens for forbidden.
func TestLogWriter_Record_Forbidden_InsertsRow(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	mock.ExpectExec(healingLogInsertPattern).
		WithArgs("firmy_cz", "forbidden", 403, "https://firmy.cz/x", "<h1>403</h1>").
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), BlockEvent{
		SourceName:    "firmy_cz",
		BlockType:     BlockTypeForbidden,
		HTTPStatus:    403,
		TargetURL:     "https://firmy.cz/x",
		BodySignature: "<h1>403</h1>",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 5. DB error surfaces but caller can ignore (graceful — fetch must not fail).
func TestLogWriter_Record_DBError_ReturnsErrorButDoesNotPanic(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	mock.ExpectExec(healingLogInsertPattern).
		WillReturnError(errors.New("connection refused"))

	err := w.Record(context.Background(), BlockEvent{
		SourceName: "ares",
		BlockType:  BlockTypeRateLimit,
		HTTPStatus: 429,
		TargetURL:  "https://ares.gov.cz/x",
	})
	if err == nil {
		t.Fatal("expected DB error to surface")
	}
	if !strings.Contains(err.Error(), "healing_log insert") {
		t.Errorf("error %q should be wrapped with healing_log insert prefix", err.Error())
	}
}

// 6. BlockTypeNone short-circuits — no DB round-trip.
func TestLogWriter_Record_BlockTypeNone_NoInsert(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	// No ExpectExec — sqlmock will fail if Record hits the DB.
	err := w.Record(context.Background(), BlockEvent{
		SourceName: "ares",
		BlockType:  BlockTypeNone,
		HTTPStatus: 200,
		TargetURL:  "https://ares.gov.cz/27082440",
	})
	if err != nil {
		t.Fatalf("unexpected error on none: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet (or unexpected) expectations: %v", err)
	}
}

// 7. Empty source name is normalised to "unknown".
func TestLogWriter_Record_EmptySource_NormalisedToUnknown(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	mock.ExpectExec(healingLogInsertPattern).
		WithArgs("unknown", "rate_limit", 429, "https://x/y", "body").
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), BlockEvent{
		SourceName:    "",
		BlockType:     BlockTypeRateLimit,
		HTTPStatus:    429,
		TargetURL:     "https://x/y",
		BodySignature: "body",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 8. SQL-injection attempt in target_url is passed through as a parameter,
// not concatenated into the SQL string. sqlmock checks args verbatim — if
// the writer ever switched to fmt.Sprintf the args would not match.
func TestLogWriter_Record_SQLInjection_PassedAsParameter(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	hostile := "https://evil/'); DROP TABLE healing_log;--"
	mock.ExpectExec(healingLogInsertPattern).
		WithArgs("ares", "forbidden", 403, hostile, "x").
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), BlockEvent{
		SourceName:    "ares",
		BlockType:     BlockTypeForbidden,
		HTTPStatus:    403,
		TargetURL:     hostile,
		BodySignature: "x",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 9. Concurrent INSERTs — no race on the writer / observer wiring.
// Run with: go test -race
func TestLogWriter_Record_ConcurrentInsertsNoRace(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	const n = 20
	mock.MatchExpectationsInOrder(false)
	for i := 0; i < n; i++ {
		mock.ExpectExec(healingLogInsertPattern).
			WillReturnResult(sqlmock.NewResult(int64(i+1), 1))
	}

	w := NewLogWriter(db)

	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			_ = w.Record(context.Background(), BlockEvent{
				SourceName:    "ares",
				BlockType:     BlockTypeRateLimit,
				HTTPStatus:    429,
				TargetURL:     "https://ares.gov.cz/27082440",
				BodySignature: "rate-limit",
			})
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent Record calls did not complete in 5s")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// 10. Nil writer is a no-op-error (not a panic). Important because
// ARES client_blockdetect tests + production wiring may pass a nil writer
// when DATABASE_URL is unset.
func TestLogWriter_Record_NilWriter_ReturnsErrorWithoutPanic(t *testing.T) {
	var w *LogWriter
	err := w.Record(context.Background(), BlockEvent{
		SourceName: "ares",
		BlockType:  BlockTypeRateLimit,
	})
	if err == nil {
		t.Error("expected error from nil writer")
	}
}

// 11. Nil DB handle inside writer also errors cleanly.
func TestLogWriter_Record_NilDB_ReturnsErrorWithoutPanic(t *testing.T) {
	w := &LogWriter{db: nil}
	err := w.Record(context.Background(), BlockEvent{
		SourceName: "ares",
		BlockType:  BlockTypeRateLimit,
	})
	if err == nil {
		t.Error("expected error from nil DB")
	}
}

// 12. Context cancellation is propagated to the DB driver.
func TestLogWriter_Record_ContextCancelled_PropagatesError(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	mock.ExpectExec(healingLogInsertPattern).
		WillReturnError(context.Canceled)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := w.Record(ctx, BlockEvent{
		SourceName: "ares",
		BlockType:  BlockTypeRateLimit,
		HTTPStatus: 429,
		TargetURL:  "https://x",
	})
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
}

// 13. Zero HTTP status + empty body still inserts (we let the DB store NULL
// via NULLIF in the SQL — no client-side filtering required).
func TestLogWriter_Record_ZeroStatusEmptyBody_StillInserts(t *testing.T) {
	w, mock, cleanup := newWriterMock(t)
	defer cleanup()

	mock.ExpectExec(healingLogInsertPattern).
		WithArgs("ares", "forbidden", 0, "https://x", "").
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := w.Record(context.Background(), BlockEvent{
		SourceName: "ares",
		BlockType:  BlockTypeForbidden,
		// HTTPStatus / BodySignature intentionally zero/empty.
		TargetURL: "https://x",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}
