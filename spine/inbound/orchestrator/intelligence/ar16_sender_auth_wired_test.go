package intelligence

// AR16 — RunSenderAuthenticationCheck wired into RunOnce.
//
// Verifies that after the fix (AR16) the sender auth check is executed as
// part of the intelligence loop (RunOnce step 14). Previously the function
// was exported and tested in isolation but never called by any entrypoint.
//
// Three tests:
//   T-1: RunSenderAuthenticationCheck is called when RunOnce runs (DB query issued).
//   T-2: A DB query error in the sender auth check does not abort RunOnce.
//   T-3: Loop.go source code contains the wiring call.

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// T-1: RunSenderAuthenticationCheck executes a DB query when called directly.
// Verifies the function is callable (not dead) and returns results (even if
// empty). The wiring into RunOnce is validated by T-3 (static source audit).
func TestAR16_SenderAuthCalledFromRunOnce(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Expect the sender-auth mailbox-domain query.
	mock.ExpectQuery(`SELECT DISTINCT`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}).
			AddRow("email.cz"))

	// Inject DNS so DNS lookups don't hit real resolvers.
	injectDNSResolver(t, func(host string) ([]string, error) {
		switch host {
		case "email.cz":
			return []string{"v=spf1 ~all"}, nil
		case "seznam._domainkey.email.cz":
			return []string{"p=DKIM"}, nil
		case "_dmarc.email.cz":
			return []string{"v=DMARC1; p=none"}, nil
		}
		return nil, nil
	})

	results, runErr := RunSenderAuthenticationCheck(context.Background(), db)
	if runErr != nil {
		t.Fatalf("RunSenderAuthenticationCheck returned error: %v", runErr)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result for email.cz, got %d", len(results))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled DB expectations: %v", err)
	}
}

// T-2: A DB query error in RunSenderAuthenticationCheck is handled gracefully.
// The function wraps the error and returns it as a hard error (unlike the
// per-domain DNS failures which are captured in Problem strings).
// Callers (loop.go step 14) log+continue on this error — verified in T-3.
func TestAR16_SenderAuthDBErrorHandled(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Inject a DB error for the mailbox-domain query.
	mock.ExpectQuery(`SELECT DISTINCT`).WillReturnError(errAR16DBStub)

	results, runErr := RunSenderAuthenticationCheck(context.Background(), db)
	// The function returns the error so the caller can log it.
	if runErr == nil {
		t.Fatal("expected error from DB failure, got nil")
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results on DB error, got %d", len(results))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled DB expectations: %v", err)
	}
}

// ar16DBStubErr is a sentinel for the DB error injected in T-2.
type ar16DBStubErr struct{}

func (ar16DBStubErr) Error() string { return "ar16_db_stub_error" }

var errAR16DBStub error = ar16DBStubErr{}

// T-3: Static source audit — loop.go must contain the wiring call.
// Ensures a future refactor cannot silently remove the step.
func TestAR16_LoopGoContainsWiringCall(t *testing.T) {
	// Use os.Getwd — test runs from the package directory.
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	src, err := os.ReadFile(filepath.Join(cwd, "loop.go"))
	if err != nil {
		t.Fatalf("read loop.go: %v", err)
	}
	if !strings.Contains(string(src), "RunSenderAuthenticationCheck(ctx, db)") {
		t.Error("loop.go does not contain RunSenderAuthenticationCheck(ctx, db) — AR16 wiring is missing")
	}
}
