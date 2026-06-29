package campaign

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"testing/quick"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── Tick (exported wrapper) ────────────────────────────────────────────────

// TestTick_DelegatesTo_tick verifies that Tick() exercises the same code path
// as the internal tick() — if the DB is down, the error is logged but no panic.
func TestTick_NoPanic_DBDown(t *testing.T) {
	locker := newMockLocker()
	db := &mockSchedDB{queryErr: errCampaign("connection refused")}
	runner := &mockRunner{}
	s := NewScheduler(db, runner, locker)

	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Tick panicked on DB down: %v", r)
		}
	}()
	s.Tick(context.Background())

	if runner.callCount() != 0 {
		t.Errorf("expected 0 runner calls when DB down, got %d", runner.callCount())
	}
}

// TestTick_RunsCampaigns confirms Tick is not a no-op — it actually runs campaigns.
func TestTick_RunsCampaigns(t *testing.T) {
	locker := newMockLocker()
	db := &mockSchedDB{campaigns: campaigns(10, 20)}
	runner := &mockRunner{}
	s := NewScheduler(db, runner, locker)

	s.Tick(context.Background())

	if runner.callCount() != 2 {
		t.Errorf("expected 2 runs via Tick, got %d", runner.callCount())
	}
}

// TestTick_LockDenied_NoRun confirms Tick respects advisory locking.
func TestTick_LockDenied_NoRun(t *testing.T) {
	locker := newMockLocker()
	locker.lockDenied[55] = true
	db := &mockSchedDB{campaigns: campaigns(55)}
	runner := &mockRunner{}
	s := NewScheduler(db, runner, locker)

	s.Tick(context.Background())

	if runner.callCount() != 0 {
		t.Errorf("expected 0 calls when lock denied, got %d", runner.callCount())
	}
}

// TestTick_Idempotent confirms calling Tick twice with the same locker runs
// each campaign at most once (lock prevents double-run).
func TestTick_CalledTwice_NilSafeLocker(t *testing.T) {
	locker := newMockLocker()
	db := &mockSchedDB{campaigns: campaigns(7)}
	runner := &mockRunner{}
	s := NewScheduler(db, runner, locker)

	s.Tick(context.Background())
	s.Tick(context.Background()) // second tick — lock already claimed

	// After first tick the mockLocker has claimed[7]=true → second tick skips.
	if runner.callCount() != 1 {
		t.Errorf("expected 1 total run across 2 ticks, got %d", runner.callCount())
	}
}

// TestTick_Property_NeverPanics verifies Tick never panics regardless of
// the error injected in the runner.
func TestTick_Property_NeverPanics(t *testing.T) {
	f := func(failFirst bool) bool {
		defer func() { recover() }()
		locker := newMockLocker()
		db := &mockSchedDB{campaigns: campaigns(1)}
		runner := &mockRunner{}
		if failFirst {
			runner.err = errCampaign("simulated failure")
		}
		s := NewScheduler(db, runner, locker)
		s.Tick(context.Background())
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("Tick panicked: %v", err)
	}
}

// ── defaultInterval ────────────────────────────────────────────────────────

func TestDefaultInterval_NoEnvVar_Returns60s(t *testing.T) {
	os.Unsetenv("SCHEDULER_INTERVAL_SEC")
	d := defaultInterval()
	if d != 60*time.Second {
		t.Errorf("defaultInterval() = %v, want 60s", d)
	}
}

func TestDefaultInterval_ValidEnvVar(t *testing.T) {
	os.Setenv("SCHEDULER_INTERVAL_SEC", "30")
	defer os.Unsetenv("SCHEDULER_INTERVAL_SEC")
	d := defaultInterval()
	if d != 30*time.Second {
		t.Errorf("defaultInterval() = %v, want 30s", d)
	}
}

func TestDefaultInterval_EnvVar_Zero_Fallback(t *testing.T) {
	os.Setenv("SCHEDULER_INTERVAL_SEC", "0")
	defer os.Unsetenv("SCHEDULER_INTERVAL_SEC")
	d := defaultInterval()
	if d != 60*time.Second {
		t.Errorf("0 value should fall back to default 60s, got %v", d)
	}
}

func TestDefaultInterval_EnvVar_Negative_Fallback(t *testing.T) {
	os.Setenv("SCHEDULER_INTERVAL_SEC", "-5")
	defer os.Unsetenv("SCHEDULER_INTERVAL_SEC")
	d := defaultInterval()
	if d != 60*time.Second {
		t.Errorf("negative value should fall back to default 60s, got %v", d)
	}
}

func TestDefaultInterval_EnvVar_NonNumeric_Fallback(t *testing.T) {
	os.Setenv("SCHEDULER_INTERVAL_SEC", "notanumber")
	defer os.Unsetenv("SCHEDULER_INTERVAL_SEC")
	d := defaultInterval()
	if d != 60*time.Second {
		t.Errorf("non-numeric should fall back to default 60s, got %v", d)
	}
}

func TestDefaultInterval_EnvVar_Large(t *testing.T) {
	os.Setenv("SCHEDULER_INTERVAL_SEC", "3600")
	defer os.Unsetenv("SCHEDULER_INTERVAL_SEC")
	d := defaultInterval()
	if d != 3600*time.Second {
		t.Errorf("defaultInterval() = %v, want 3600s", d)
	}
}

// TestDefaultInterval_Property_ValidPositive checks that any positive integer
// parses to that many seconds.
func TestDefaultInterval_Property_ValidPositive(t *testing.T) {
	f := func(sec uint16) bool {
		if sec == 0 {
			return true // skip 0, handled separately
		}
		os.Setenv("SCHEDULER_INTERVAL_SEC", itoa(int(sec)))
		defer os.Unsetenv("SCHEDULER_INTERVAL_SEC")
		d := defaultInterval()
		return d == time.Duration(sec)*time.Second
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("defaultInterval property failed: %v", err)
	}
}

// itoa converts int to string without importing strconv in test.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	buf := [20]byte{}
	pos := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// ── PostgresLocker via sqlmock ─────────────────────────────────────────────

func TestPostgresLocker_NewPostgresLocker(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	l := NewPostgresLocker(db)
	if l == nil {
		t.Fatal("NewPostgresLocker returned nil")
	}
	if l.db == nil {
		t.Error("db field not set")
	}
}

func TestPostgresLocker_TryAdvisoryLock_Success_True(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))

	l := NewPostgresLocker(db)
	ok, err := l.TryAdvisoryLock(context.Background(), 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Error("expected lock acquired (true)")
	}
}

func TestPostgresLocker_TryAdvisoryLock_Success_False(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(false))

	l := NewPostgresLocker(db)
	ok, err := l.TryAdvisoryLock(context.Background(), 99)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("expected lock NOT acquired (false)")
	}
}

func TestPostgresLocker_TryAdvisoryLock_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WillReturnError(errCampaign("connection refused"))

	l := NewPostgresLocker(db)
	_, err = l.TryAdvisoryLock(context.Background(), 1)
	if err == nil {
		t.Error("expected error when DB fails")
	}
}

func TestPostgresLocker_ReleaseAdvisoryLock_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`SELECT pg_advisory_unlock`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	l := NewPostgresLocker(db)
	err = l.ReleaseAdvisoryLock(context.Background(), 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPostgresLocker_ReleaseAdvisoryLock_DBError(t *testing.T) {
	// F2-3: Release now uses a pinned *sql.Conn. To exercise the unlock
	// error path, first acquire (which pins a conn) then expect unlock
	// to fail on the SAME pinned conn.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Acquire path
	mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
	mock.ExpectExec(`INSERT INTO campaign_lock_audit`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Release path: unlock fails
	mock.ExpectExec(`SELECT pg_advisory_unlock`).
		WillReturnError(errCampaign("unlock failed"))

	l := NewPostgresLocker(db)
	if _, err := l.TryAdvisoryLock(context.Background(), 42); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	err = l.ReleaseAdvisoryLock(context.Background(), 42)
	if err == nil {
		t.Error("expected error when DB fails on unlock")
	}
}

func TestPostgresLocker_ReleaseAdvisoryLock_NotAcquiredViaThisLocker_IsNoop(t *testing.T) {
	// F2-3: When ReleaseAdvisoryLock is called on an id this locker
	// instance never acquired (e.g. process restart, second locker
	// instance, double-release after restart), Release should not error
	// — it issues a best-effort unlock on the pool and returns nil.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`SELECT pg_advisory_unlock`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	l := NewPostgresLocker(db)
	if err := l.ReleaseAdvisoryLock(context.Background(), 7); err != nil {
		t.Errorf("release without prior acquire should be no-op, got: %v", err)
	}
}

// ── PostgresSchedulerDB via sqlmock ───────────────────────────────────────

func TestNewPostgresSchedulerDB_NotNil(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	sdb := NewPostgresSchedulerDB(db)
	if sdb == nil {
		t.Fatal("NewPostgresSchedulerDB returned nil")
	}
}

func TestPostgresSchedulerDB_ListRunningCampaigns_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id FROM campaigns WHERE status IN`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).
			AddRow(int64(1)).
			AddRow(int64(2)).
			AddRow(int64(3)))

	sdb := NewPostgresSchedulerDB(db)
	cs, err := sdb.ListRunningCampaigns(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cs) != 3 {
		t.Fatalf("expected 3 campaigns, got %d", len(cs))
	}
	for _, c := range cs {
		if c.Status != "running" {
			t.Errorf("status = %q, want running", c.Status)
		}
	}
}

func TestPostgresSchedulerDB_ListRunningCampaigns_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id FROM campaigns WHERE status IN`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))

	sdb := NewPostgresSchedulerDB(db)
	cs, err := sdb.ListRunningCampaigns(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cs) != 0 {
		t.Errorf("expected 0 campaigns, got %d", len(cs))
	}
}

func TestPostgresSchedulerDB_ListRunningCampaigns_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id FROM campaigns WHERE status IN`).
		WillReturnError(sql.ErrConnDone)

	sdb := NewPostgresSchedulerDB(db)
	_, err = sdb.ListRunningCampaigns(context.Background())
	if err == nil {
		t.Error("expected error when query fails")
	}
}

// TestPostgresSchedulerDB_IDs verifies the correct IDs are returned.
func TestPostgresSchedulerDB_ListRunningCampaigns_IDs(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id FROM campaigns WHERE status IN`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).
			AddRow(int64(100)).
			AddRow(int64(200)))

	sdb := NewPostgresSchedulerDB(db)
	cs, err := sdb.ListRunningCampaigns(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cs[0].ID != 100 || cs[1].ID != 200 {
		t.Errorf("IDs = %v/%v, want 100/200", cs[0].ID, cs[1].ID)
	}
}

// ── Monkey tests ──────────────────────────────────────────────────────────

// TestPostgresLocker_NeverPanics_Property verifies the locker never panics on
// arbitrary campaign IDs.
func TestPostgresLocker_NeverPanics_Property(t *testing.T) {
	f := func(id int64) bool {
		defer func() { recover() }()

		db, mock, err := sqlmock.New()
		if err != nil {
			return true
		}
		defer db.Close()

		mock.ExpectQuery(`SELECT pg_try_advisory_lock`).
			WillReturnRows(sqlmock.NewRows([]string{"result"}).AddRow(true))
		mock.ExpectExec(`SELECT pg_advisory_unlock`).
			WillReturnResult(sqlmock.NewResult(0, 1))

		l := NewPostgresLocker(db)
		l.TryAdvisoryLock(context.Background(), id)     //nolint:errcheck
		l.ReleaseAdvisoryLock(context.Background(), id) //nolint:errcheck
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("PostgresLocker panicked: %v", err)
	}
}

// TestSchedulerDB_NeverPanics_Property checks ListRunningCampaigns doesn't
// panic under arbitrary DB error conditions.
func TestSchedulerDB_NeverPanics_Property(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }()

		db, mock, err := sqlmock.New()
		if err != nil {
			return true
		}
		defer db.Close()

		mock.ExpectQuery(`SELECT id FROM campaigns`).
			WillReturnError(errCampaign(s))

		sdb := NewPostgresSchedulerDB(db)
		sdb.ListRunningCampaigns(context.Background()) //nolint:errcheck
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("PostgresSchedulerDB panicked: %v", err)
	}
}
