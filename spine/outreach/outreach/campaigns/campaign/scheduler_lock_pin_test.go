package campaign

import (
	"context"
	"sync"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// F2-3 — locks the rule that PostgresLocker pins a *sql.Conn for the
// lock lifetime. Pre-fix the locker held only *sql.DB and pulled an
// arbitrary connection per call; the lock and the unlock could land on
// different sessions, leaving the lock held on the original session
// indefinitely (until that session was closed by the pool) and letting
// the unlock silently no-op on the wrong session.

// TestPostgresLocker_AcquireAndRelease_BothExpectationsMet asserts that
// the full acquire+release lifecycle issues exactly the SQL we expect
// in the SAME connection lifecycle (sqlmock's default ordering).
func TestPostgresLocker_AcquireAndRelease_BothExpectationsMet(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WithArgs(int64(101)).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
	mock.ExpectExec(`INSERT INTO campaign_lock_audit`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`SELECT pg_advisory_unlock`).
		WithArgs(int64(101)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`DELETE FROM campaign_lock_audit`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	l := NewPostgresLocker(db)
	ctx := context.Background()

	ok, err := l.TryAdvisoryLock(ctx, 101)
	if err != nil {
		t.Fatalf("TryAdvisoryLock: %v", err)
	}
	if !ok {
		t.Fatal("expected lock acquired")
	}

	if err := l.ReleaseAdvisoryLock(ctx, 101); err != nil {
		t.Fatalf("ReleaseAdvisoryLock: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

// TestPostgresLocker_TryFalse_ReleasesConn_DoesNotPin verifies that when
// pg_try_advisory_lock returns false (lock held elsewhere), the locker
// closes the conn back to the pool and does NOT add an entry to the
// pinnedConns map (which would make the next TryAdvisoryLock for the
// same id error out as "already pinned").
func TestPostgresLocker_TryFalse_ReleasesConn_DoesNotPin(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// First attempt: lock not acquired (returns false).
	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(false))
	// Second attempt: lock acquired (proves no leftover pin from the false case).
	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
	mock.ExpectExec(`INSERT INTO campaign_lock_audit`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	l := NewPostgresLocker(db)
	ctx := context.Background()

	ok, err := l.TryAdvisoryLock(ctx, 5)
	if err != nil || ok {
		t.Fatalf("first acquire: ok=%v err=%v (expected false, nil)", ok, err)
	}

	ok, err = l.TryAdvisoryLock(ctx, 5)
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if !ok {
		t.Error("expected second acquire to succeed (no leftover pin)")
	}

	// Cleanup so the test doesn't leak the pinned conn.
	mock.ExpectExec(`SELECT pg_advisory_unlock`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`DELETE FROM campaign_lock_audit`).WillReturnResult(sqlmock.NewResult(0, 1))
	_ = l.ReleaseAdvisoryLock(ctx, 5)
}

// TestPostgresLocker_DoubleAcquire_SameID_RefusesSecond verifies that a
// second TryAdvisoryLock for the same id (when the first is still held)
// fails with an explicit error rather than silently overwriting the
// pinned conn — that would strand the original conn forever.
//
// The mock returns true for both pg_try_advisory_lock attempts (in
// reality Postgres would return false, but if any layer above us got
// confused or the lock-holding session was dropped from a different
// process, we want to defensively refuse the second pin).
func TestPostgresLocker_DoubleAcquire_SameID_DefensivelyRefuses(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// First acquire: success
	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
	mock.ExpectExec(`INSERT INTO campaign_lock_audit`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Second acquire: pg_try returns true (theoretically possible if
	// the prior session was killed), but our locker MUST refuse to
	// double-pin.
	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))

	l := NewPostgresLocker(db)
	ctx := context.Background()

	if _, err := l.TryAdvisoryLock(ctx, 12); err != nil {
		t.Fatalf("first: %v", err)
	}
	_, err = l.TryAdvisoryLock(ctx, 12)
	if err == nil {
		t.Error("expected error on double-acquire for same id (would strand the original conn)")
	}

	// Cleanup
	mock.ExpectExec(`SELECT pg_advisory_unlock`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`DELETE FROM campaign_lock_audit`).WillReturnResult(sqlmock.NewResult(0, 1))
	_ = l.ReleaseAdvisoryLock(ctx, 12)
}

// TestPostgresLocker_ConcurrentAcquireDifferentIDs verifies the mu lock
// over pinnedConns is correct: parallel acquires on different ids must
// both succeed (no deadlock, no shared-pin clobbering).
func TestPostgresLocker_ConcurrentAcquireDifferentIDs(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Allow any order — concurrent goroutines.
	mock.MatchExpectationsInOrder(false)
	for i := 0; i < 4; i++ {
		mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
			WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
		mock.ExpectExec(`INSERT INTO campaign_lock_audit`).
			WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectExec(`SELECT pg_advisory_unlock`).
			WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectExec(`DELETE FROM campaign_lock_audit`).
			WillReturnResult(sqlmock.NewResult(0, 1))
	}

	l := NewPostgresLocker(db)
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := int64(1); i <= 4; i++ {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			ok, err := l.TryAdvisoryLock(ctx, id)
			if err != nil {
				t.Errorf("acquire(%d): %v", id, err)
				return
			}
			if !ok {
				t.Errorf("acquire(%d): expected ok", id)
			}
			if err := l.ReleaseAdvisoryLock(ctx, id); err != nil {
				t.Errorf("release(%d): %v", id, err)
			}
		}(i)
	}
	wg.Wait()
}

// Source-level audit: the file MUST use db.Conn(ctx) and a pinnedConns
// map. Goes RED if anyone reverts to *sql.DB-only.
func TestPostgresLocker_SourceAudit_PinsConn(t *testing.T) {
	src := readSchedulerPostgresSource(t)
	required := []string{
		"pinnedConns",
		"l.db.Conn(",
		"conn.QueryRowContext",
		"conn.ExecContext",
		"conn.Close()",
	}
	for _, r := range required {
		if !contains(src, r) {
			t.Errorf("scheduler_postgres.go missing %q (conn-pin contract dropped?)", r)
		}
	}
	// Forbid the bare-pool form: l.db.QueryRowContext for pg_try_advisory_lock.
	if containsAll(src, "l.db.QueryRowContext", "pg_try_advisory_lock") {
		t.Error("scheduler_postgres.go still calls pg_try_advisory_lock on the pool — must be on a pinned conn")
	}
}

func readSchedulerPostgresSource(t *testing.T) string {
	t.Helper()
	b, err := readSourceFile("scheduler_postgres.go")
	if err != nil {
		t.Fatalf("read scheduler_postgres.go: %v", err)
	}
	return string(b)
}

// Tiny helpers — avoid pulling os/strings into the test imports more
// times than necessary; share these via package-private helpers.
func readSourceFile(name string) ([]byte, error) {
	return readFileBytes(name)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// containsAll returns true if `s` contains both substrings on the SAME
// line. We need both-on-same-line because l.db elsewhere in the file
// (e.g. StaleLockCheck — read-only — legitimately uses the pool) is
// fine; only pg_try_advisory_lock on the pool is wrong.
func containsAll(s, a, b string) bool {
	idx := 0
	for {
		nl := indexByte(s[idx:], '\n')
		end := len(s)
		if nl >= 0 {
			end = idx + nl
		}
		line := s[idx:end]
		if contains(line, a) && contains(line, b) {
			return true
		}
		if nl < 0 {
			return false
		}
		idx = end + 1
	}
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
