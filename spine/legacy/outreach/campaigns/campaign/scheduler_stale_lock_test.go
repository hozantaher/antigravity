package campaign

import (
	"context"
	"errors"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// BF-E4 — StaleLockCheck contract.
//
// Returns campaign IDs with locked_at older than the TTL passed in.
// Operator policy decides what to do with the list (warn, page,
// force-cleanup via campaign_lock_audit_cleanup_stale).

func TestStaleLockCheck_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery(`SELECT campaign_id FROM campaign_lock_audit`).
		WithArgs("600").
		WillReturnRows(sqlmock.NewRows([]string{"campaign_id"}))

	l := NewPostgresLocker(db)
	ids, err := l.StaleLockCheck(context.Background(), 10*time.Minute)
	if err != nil {
		t.Fatalf("StaleLockCheck: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty, got %v", ids)
	}
}

func TestStaleLockCheck_ReportsStaleIDs(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery(`SELECT campaign_id FROM campaign_lock_audit`).
		WithArgs("300").
		WillReturnRows(sqlmock.NewRows([]string{"campaign_id"}).
			AddRow(int64(101)).AddRow(int64(202)).AddRow(int64(303)))

	l := NewPostgresLocker(db)
	ids, err := l.StaleLockCheck(context.Background(), 5*time.Minute)
	if err != nil {
		t.Fatalf("StaleLockCheck: %v", err)
	}
	if len(ids) != 3 || ids[0] != 101 || ids[2] != 303 {
		t.Errorf("got %v, want [101 202 303]", ids)
	}
}

func TestStaleLockCheck_DBError_Wrapped(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery(`SELECT campaign_id FROM campaign_lock_audit`).
		WithArgs("60").
		WillReturnError(errors.New("connection refused"))

	l := NewPostgresLocker(db)
	if _, err := l.StaleLockCheck(context.Background(), 1*time.Minute); err == nil {
		t.Error("expected error, got nil")
	}
}

// Lock acquisition writes the audit row (BF-E4).
func TestTryAdvisoryLock_WritesAuditRowOnSuccess(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows([]string{"ok"}).AddRow(true))
	mock.ExpectExec(`INSERT INTO campaign_lock_audit`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	l := NewPostgresLocker(db)
	ok, err := l.TryAdvisoryLock(context.Background(), 42)
	if err != nil || !ok {
		t.Fatalf("TryAdvisoryLock: ok=%v err=%v", ok, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("audit insert not exercised: %v", err)
	}
}

// Lock denial does NOT write the audit row.
func TestTryAdvisoryLock_NoAuditOnDeny(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows([]string{"ok"}).AddRow(false))
	// No INSERT INTO campaign_lock_audit expected.

	l := NewPostgresLocker(db)
	ok, err := l.TryAdvisoryLock(context.Background(), 42)
	if err != nil || ok {
		t.Fatalf("TryAdvisoryLock denied: ok=%v err=%v", ok, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unexpected audit insert: %v", err)
	}
}

// Audit insert failure must NOT propagate — the lock is already held.
func TestTryAdvisoryLock_AuditInsertFailure_Swallowed(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WithArgs(int64(99)).
		WillReturnRows(sqlmock.NewRows([]string{"ok"}).AddRow(true))
	mock.ExpectExec(`INSERT INTO campaign_lock_audit`).
		WillReturnError(errors.New("disk full"))

	l := NewPostgresLocker(db)
	ok, err := l.TryAdvisoryLock(context.Background(), 99)
	if err != nil {
		t.Errorf("audit failure should be swallowed, got err=%v", err)
	}
	if !ok {
		t.Errorf("lock was acquired but TryAdvisoryLock returned false")
	}
}

// Release also DELETEs the audit row.
// F2-3: Release runs on a pinned conn, so we first acquire (which pins
// a conn + INSERTs the audit row) then release (which UNLOCKs +
// DELETEs the audit row on the same conn).
func TestReleaseAdvisoryLock_DeletesAuditRow(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Acquire path
	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
	mock.ExpectExec(`INSERT INTO campaign_lock_audit`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Release path
	mock.ExpectExec(`SELECT pg_advisory_unlock`).
		WithArgs(int64(7)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`DELETE FROM campaign_lock_audit`).
		WithArgs(int64(7)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	l := NewPostgresLocker(db)
	if _, err := l.TryAdvisoryLock(context.Background(), 7); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := l.ReleaseAdvisoryLock(context.Background(), 7); err != nil {
		t.Errorf("ReleaseAdvisoryLock: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("audit delete not exercised: %v", err)
	}
}
