package warmup

import (
	"context"
	"errors"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// Tests for Daemon.Pause and Daemon.Resume. Prior to this file these two
// methods were 0% covered — the only callers are admin CLIs, so neither
// unit tests nor integration paths exercised them.
//
// Pattern mirrors the PR #5 MarkBounced regression tests: exact-regex SQL
// text + WithArgs positional check so a placeholder-ordering regression
// (e.g. swapping $1 and $2 between UPDATE target and WHERE key) fails here
// rather than shipping silently.

func TestDaemon_Pause_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE mailbox_warmup\n\t\t\t   SET is_paused = true, pause_reason = $2\n\t\t\t WHERE mailbox_address = $1",
	)).
		WithArgs("a@x.test", "imap bounce spike").
		WillReturnResult(sqlmock.NewResult(0, 1))

	d := NewDaemon(db, map[string]Plan{})
	if err := d.Pause(context.Background(), "a@x.test", "imap bounce spike"); err != nil {
		t.Fatalf("Pause: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestDaemon_Pause_PlaceholderOrder_Regression(t *testing.T) {
	// Locks in $1=address, $2=reason. If a future refactor swaps these
	// (making $1=reason, $2=address), WithArgs fails — so a silent
	// argument-swap bug gets caught here, not discovered via a paused
	// mailbox with its reason stored in the address column.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	matcher := regexp.MustCompile(
		`UPDATE mailbox_warmup\s+SET is_paused = true, pause_reason = \$2\s+WHERE mailbox_address = \$1`,
	)
	mock.ExpectExec(matcher.String()).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	d := NewDaemon(db, map[string]Plan{})
	if err := d.Pause(context.Background(), "addr@test", "reason"); err != nil {
		t.Fatalf("Pause: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("SQL deviated from locked pattern: %v", err)
	}
}

func TestDaemon_Pause_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	boom := errors.New("connection refused")
	mock.ExpectExec(regexp.QuoteMeta("UPDATE mailbox_warmup")).
		WithArgs("a@x.test", "reason").
		WillReturnError(boom)

	d := NewDaemon(db, map[string]Plan{})
	if err := d.Pause(context.Background(), "a@x.test", "reason"); err == nil {
		t.Error("expected error from DB to bubble up")
	}
}

func TestDaemon_Resume_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE mailbox_warmup\n\t\t\t   SET is_paused = false, pause_reason = NULL\n\t\t\t WHERE mailbox_address = $1",
	)).
		WithArgs("a@x.test").
		WillReturnResult(sqlmock.NewResult(0, 1))

	d := NewDaemon(db, map[string]Plan{})
	if err := d.Resume(context.Background(), "a@x.test"); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestDaemon_Resume_SetsPauseReasonNULL_Regression(t *testing.T) {
	// The business contract is: Resume must clear pause_reason back to NULL,
	// not merely flip is_paused. Operators rely on `WHERE pause_reason IS NULL`
	// queries to tell a currently-active mailbox from a historically-paused
	// one. A regression that drops `pause_reason = NULL` from the UPDATE
	// would leave stale reasons in the DB and break those operator queries.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	matcher := regexp.MustCompile(
		`UPDATE mailbox_warmup\s+SET is_paused = false, pause_reason = NULL\s+WHERE mailbox_address = \$1`,
	)
	mock.ExpectExec(matcher.String()).
		WithArgs("a@x.test").
		WillReturnResult(sqlmock.NewResult(0, 1))

	d := NewDaemon(db, map[string]Plan{})
	if err := d.Resume(context.Background(), "a@x.test"); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("SQL deviated — pause_reason = NULL is load-bearing: %v", err)
	}
}

func TestDaemon_Resume_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	boom := errors.New("constraint violation")
	mock.ExpectExec(regexp.QuoteMeta("UPDATE mailbox_warmup")).
		WithArgs("a@x.test").
		WillReturnError(boom)

	d := NewDaemon(db, map[string]Plan{})
	if err := d.Resume(context.Background(), "a@x.test"); err == nil {
		t.Error("expected error from DB to bubble up")
	}
}
