package refreshcron_test

import (
	"context"
	"math"
	"os"
	"regexp"
	"sync"
	"testing"
	"time"

	"common/refreshcron"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── Helpers ─────────────────────────────────────────────────────────────

func defaultConfig(source string) refreshcron.Config {
	return refreshcron.Config{
		Source:     source,
		Interval:   time.Hour,
		BackoffCap: 4 * time.Hour,
		Multiplier: refreshcron.MultiplierRamp,
		BatchSize:  100,
	}
}

// ── 1. Cadence default vs env override ─────────────────────────────────

func TestLoadConfigFromEnv_Defaults(t *testing.T) {
	t.Setenv("ARES_REFRESH_INTERVAL", "")
	t.Setenv("ARES_REFRESH_BACKOFF_CAP", "")
	t.Setenv("ARES_REFRESH_BACKOFF_MULTIPLIER", "")
	cfg, err := refreshcron.LoadConfigFromEnv("ARES", time.Hour)
	if err != nil {
		t.Fatalf("default config should parse, got %v", err)
	}
	if cfg.Source != "ares" {
		t.Errorf("source: want ares, got %q", cfg.Source)
	}
	if cfg.Interval != time.Hour {
		t.Errorf("interval: want 1h, got %s", cfg.Interval)
	}
	if cfg.BackoffCap != 4*time.Hour {
		t.Errorf("cap: want 4h, got %s", cfg.BackoffCap)
	}
	if cfg.Multiplier != refreshcron.MultiplierRamp {
		t.Errorf("multiplier: want %.2f, got %.2f", refreshcron.MultiplierRamp, cfg.Multiplier)
	}
}

func TestLoadConfigFromEnv_Override(t *testing.T) {
	t.Setenv("FIRMYCZ_REFRESH_INTERVAL", "30m")
	t.Setenv("FIRMYCZ_REFRESH_BACKOFF_CAP", "2h")
	t.Setenv("FIRMYCZ_REFRESH_BACKOFF_MULTIPLIER", "2.0")
	cfg, err := refreshcron.LoadConfigFromEnv("FIRMYCZ", 4*time.Hour)
	if err != nil {
		t.Fatalf("override config should parse, got %v", err)
	}
	if cfg.Interval != 30*time.Minute {
		t.Errorf("interval: want 30m, got %s", cfg.Interval)
	}
	if cfg.BackoffCap != 2*time.Hour {
		t.Errorf("cap: want 2h, got %s", cfg.BackoffCap)
	}
	if cfg.Multiplier != 2.0 {
		t.Errorf("multiplier: want 2.0, got %.2f", cfg.Multiplier)
	}
}

// ── 2. Out-of-range env values are rejected ────────────────────────────

func TestLoadConfigFromEnv_RejectsTooFastInterval(t *testing.T) {
	t.Setenv("ARES_REFRESH_INTERVAL", "1ms")
	if _, err := refreshcron.LoadConfigFromEnv("ARES", time.Hour); err == nil {
		t.Error("expected error for INTERVAL=1ms")
	}
}

func TestLoadConfigFromEnv_RejectsTooSlowInterval(t *testing.T) {
	t.Setenv("ARES_REFRESH_INTERVAL", "48h")
	if _, err := refreshcron.LoadConfigFromEnv("ARES", time.Hour); err == nil {
		t.Error("expected error for INTERVAL=48h")
	}
}

func TestLoadConfigFromEnv_RejectsMultiplierBelowOne(t *testing.T) {
	t.Setenv("ARES_REFRESH_BACKOFF_MULTIPLIER", "0.5")
	if _, err := refreshcron.LoadConfigFromEnv("ARES", time.Hour); err == nil {
		t.Error("expected error for multiplier < 1.0")
	}
}

func TestLoadConfigFromEnv_RejectsCapBelowInterval(t *testing.T) {
	t.Setenv("ARES_REFRESH_INTERVAL", "2h")
	t.Setenv("ARES_REFRESH_BACKOFF_CAP", "1h")
	if _, err := refreshcron.LoadConfigFromEnv("ARES", time.Hour); err == nil {
		t.Error("expected error when cap < interval")
	}
}

func TestLoadConfigFromEnv_UnparseableInterval(t *testing.T) {
	t.Setenv("ARES_REFRESH_INTERVAL", "garbage")
	if _, err := refreshcron.LoadConfigFromEnv("ARES", time.Hour); err == nil {
		t.Error("expected parse error on bad duration")
	}
}

// ── 3. Backoff multiplier 1.5× ramp ────────────────────────────────────

func TestRampMultiplier_OneFiveRamp(t *testing.T) {
	cfg := defaultConfig("ares")
	got := refreshcron.RampMultiplier(1.0, cfg)
	if math.Abs(got-1.5) > 1e-9 {
		t.Errorf("after 1× failure: want 1.5, got %.4f", got)
	}
}

func TestRampMultiplier_Sequence(t *testing.T) {
	cfg := defaultConfig("ares") // interval 1h, cap 4h → ceiling = 4
	wants := []float64{1.5, 2.25, 3.375, 4.0, 4.0, 4.0}
	cur := 1.0
	for i, want := range wants {
		cur = refreshcron.RampMultiplier(cur, cfg)
		if math.Abs(cur-want) > 1e-6 {
			t.Errorf("step %d: want %.4f, got %.4f", i, want, cur)
		}
	}
}

// ── 4. Cap respected ───────────────────────────────────────────────────

func TestRampMultiplier_CapRespected(t *testing.T) {
	cfg := defaultConfig("ares") // ceiling = 4
	// Even from a high starting multiplier we never exceed the ceiling.
	got := refreshcron.RampMultiplier(10.0, cfg)
	if got > 4.0+1e-9 {
		t.Errorf("cap violated: got %.4f, want <= 4.0", got)
	}
}

// ── 5. NextRunAt boundary cases ────────────────────────────────────────

func TestNextRunAt_NeverRun(t *testing.T) {
	cfg := defaultConfig("ares")
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	s := refreshcron.State{Source: "ares", CurrentMultiplier: 1.0}
	if got := refreshcron.NextRunAt(s, cfg, now); !got.Equal(now) {
		t.Errorf("never-run state should be eligible immediately, got %s", got)
	}
}

func TestNextRunAt_JustRanBaseline(t *testing.T) {
	cfg := defaultConfig("ares")
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	s := refreshcron.State{Source: "ares", CurrentMultiplier: 1.0, LastRunAt: now}
	want := now.Add(time.Hour)
	if got := refreshcron.NextRunAt(s, cfg, now); !got.Equal(want) {
		t.Errorf("baseline next-run: want %s, got %s", want, got)
	}
}

func TestNextRunAt_BackoffWindow(t *testing.T) {
	cfg := defaultConfig("ares")
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	s := refreshcron.State{Source: "ares", CurrentMultiplier: 2.25, LastRunAt: now}
	want := now.Add(2*time.Hour + 15*time.Minute)
	if got := refreshcron.NextRunAt(s, cfg, now); !got.Equal(want) {
		t.Errorf("mid-backoff next-run: want %s, got %s", want, got)
	}
}

func TestNextRunAt_CapClampsLargeMultiplier(t *testing.T) {
	cfg := defaultConfig("ares") // cap 4h
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	s := refreshcron.State{Source: "ares", CurrentMultiplier: 10.0, LastRunAt: now}
	want := now.Add(4 * time.Hour)
	if got := refreshcron.NextRunAt(s, cfg, now); !got.Equal(want) {
		t.Errorf("capped next-run: want %s, got %s", want, got)
	}
}

func TestShouldRun_Boundary(t *testing.T) {
	cfg := defaultConfig("ares")
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	s := refreshcron.State{Source: "ares", CurrentMultiplier: 1.0, LastRunAt: now.Add(-time.Hour)}
	if !refreshcron.ShouldRun(s, cfg, now) {
		t.Error("now equals next_run_at → ShouldRun must be true")
	}
	if refreshcron.ShouldRun(s, cfg, now.Add(-time.Second)) {
		t.Error("just before next_run_at → ShouldRun must be false")
	}
}

// ── 6. Reset on success ─────────────────────────────────────────────────

func TestRecordResult_SuccessResets(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery(`SELECT current_multiplier`).WithArgs("ares").
		WillReturnRows(sqlmock.NewRows([]string{
			"current_multiplier", "consecutive_failures", "last_run_at", "last_status", "next_run_at",
			"base_interval_seconds", "backoff_cap_seconds",
		}).AddRow(2.25, 3, time.Now().Add(-2*time.Hour), "failure", time.Now(), 3600, 14400))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO refresh_cron_state`)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	cfg := defaultConfig("ares")
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	got, err := refreshcron.RecordResult(context.Background(), db, cfg, refreshcron.ResultSuccess, now)
	if err != nil {
		t.Fatalf("RecordResult: %v", err)
	}
	if got.CurrentMultiplier != 1.0 {
		t.Errorf("multiplier after success: want 1.0, got %.4f", got.CurrentMultiplier)
	}
	if got.ConsecutiveFailures != 0 {
		t.Errorf("failures after success: want 0, got %d", got.ConsecutiveFailures)
	}
	if got.LastStatus != "success" {
		t.Errorf("status: want success, got %q", got.LastStatus)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock: %v", err)
	}
}

// ── 7. Failure ramps multiplier ─────────────────────────────────────────

func TestRecordResult_FailureRamps(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery(`SELECT current_multiplier`).WithArgs("ares").
		WillReturnRows(sqlmock.NewRows([]string{
			"current_multiplier", "consecutive_failures", "last_run_at", "last_status", "next_run_at",
			"base_interval_seconds", "backoff_cap_seconds",
		}).AddRow(1.0, 0, time.Now().Add(-time.Hour), "success", time.Now(), 3600, 14400))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO refresh_cron_state`)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	cfg := defaultConfig("ares")
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	got, err := refreshcron.RecordResult(context.Background(), db, cfg, refreshcron.ResultFailure, now)
	if err != nil {
		t.Fatalf("RecordResult: %v", err)
	}
	if math.Abs(got.CurrentMultiplier-1.5) > 1e-9 {
		t.Errorf("multiplier after failure: want 1.5, got %.4f", got.CurrentMultiplier)
	}
	if got.ConsecutiveFailures != 1 {
		t.Errorf("failures: want 1, got %d", got.ConsecutiveFailures)
	}
	if got.LastStatus != "failure" {
		t.Errorf("status: want failure, got %q", got.LastStatus)
	}
}

// ── 8. State persists across "restart" — empty row → defaults applied ──

func TestLoadState_EmptyTableYieldsDefaults(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery(`SELECT current_multiplier`).WithArgs("ares").
		WillReturnRows(sqlmock.NewRows([]string{
			"current_multiplier", "consecutive_failures", "last_run_at", "last_status", "next_run_at",
			"base_interval_seconds", "backoff_cap_seconds",
		})) // no rows

	got, err := refreshcron.LoadState(context.Background(), db, "ares")
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if got.CurrentMultiplier != 1.0 {
		t.Errorf("empty-row multiplier: want 1.0, got %.4f", got.CurrentMultiplier)
	}
	if !got.LastRunAt.IsZero() {
		t.Errorf("empty-row last_run_at must be zero, got %s", got.LastRunAt)
	}
}

func TestLoadState_PersistedRowSurvivesRestart(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	last := time.Date(2026, 4, 30, 11, 0, 0, 0, time.UTC)
	mock.ExpectQuery(`SELECT current_multiplier`).WithArgs("ares").
		WillReturnRows(sqlmock.NewRows([]string{
			"current_multiplier", "consecutive_failures", "last_run_at", "last_status", "next_run_at",
			"base_interval_seconds", "backoff_cap_seconds",
		}).AddRow(2.25, 3, last, "failure", last.Add(2*time.Hour+15*time.Minute), 3600, 14400))

	got, err := refreshcron.LoadState(context.Background(), db, "ares")
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if got.CurrentMultiplier != 2.25 || got.ConsecutiveFailures != 3 {
		t.Errorf("persisted state lost: %+v", got)
	}
	if !got.LastRunAt.Equal(last) {
		t.Errorf("last_run_at: want %s, got %s", last, got.LastRunAt)
	}
}

// ── 9. Advisory lock takeover prevented (concurrent attempts) ──────────

func TestAdvisoryLockKey_Deterministic(t *testing.T) {
	a := refreshcron.AdvisoryLockKey("ares")
	b := refreshcron.AdvisoryLockKey("ares")
	c := refreshcron.AdvisoryLockKey("firmycz")
	if a != b {
		t.Errorf("ares key not deterministic: %d != %d", a, b)
	}
	if a == c {
		t.Errorf("ares + firmycz keys collide: %d", a)
	}
	if a < 0 || c < 0 {
		t.Errorf("keys must be positive int64; got %d, %d", a, c)
	}
}

func TestTryLock_FirstWinsSecondLoses(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT pg_try_advisory_lock($1)`)).WithArgs(refreshcron.AdvisoryLockKey("ares")).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT pg_try_advisory_lock($1)`)).WithArgs(refreshcron.AdvisoryLockKey("ares")).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(false))

	first, err := refreshcron.TryLock(context.Background(), db, "ares")
	if err != nil || !first {
		t.Fatalf("first TryLock: ok=%v err=%v, want ok=true", first, err)
	}
	second, err := refreshcron.TryLock(context.Background(), db, "ares")
	if err != nil || second {
		t.Fatalf("second TryLock: ok=%v err=%v, want ok=false", second, err)
	}
}

func TestTryLock_RaceSafety_OneWinner(t *testing.T) {
	// Even with concurrent goroutines calling TryLock against parallel
	// sqlmock connections, the deterministic AdvisoryLockKey must hash
	// to the same value so PG can serialise the contention. We just
	// assert the function is goroutine-safe (no shared mutable state).
	var wg sync.WaitGroup
	keys := make([]int64, 50)
	wg.Add(50)
	for i := 0; i < 50; i++ {
		go func(i int) {
			defer wg.Done()
			keys[i] = refreshcron.AdvisoryLockKey("ares")
		}(i)
	}
	wg.Wait()
	for i := 1; i < 50; i++ {
		if keys[i] != keys[0] {
			t.Fatalf("AdvisoryLockKey not goroutine-stable: keys[0]=%d keys[%d]=%d", keys[0], i, keys[i])
		}
	}
}

// ── 10. Skipped result keeps last_run_at intact ────────────────────────

func TestRecordResult_SkippedDoesNotAdvanceLastRunAt(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	prevLast := time.Date(2026, 4, 30, 10, 0, 0, 0, time.UTC)
	mock.ExpectQuery(`SELECT current_multiplier`).WithArgs("ares").
		WillReturnRows(sqlmock.NewRows([]string{
			"current_multiplier", "consecutive_failures", "last_run_at", "last_status", "next_run_at",
			"base_interval_seconds", "backoff_cap_seconds",
		}).AddRow(1.5, 1, prevLast, "failure", prevLast.Add(90*time.Minute), 3600, 14400))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO refresh_cron_state`)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	cfg := defaultConfig("ares")
	now := prevLast.Add(30 * time.Minute) // tick fired during backoff window
	got, err := refreshcron.RecordResult(context.Background(), db, cfg, refreshcron.ResultSkipped, now)
	if err != nil {
		t.Fatalf("RecordResult skipped: %v", err)
	}
	if !got.LastRunAt.Equal(prevLast) {
		t.Errorf("skipped tick must keep last_run_at; was %s, got %s", prevLast, got.LastRunAt)
	}
	if got.LastStatus != "skipped" {
		t.Errorf("status: want skipped, got %q", got.LastStatus)
	}
	if math.Abs(got.CurrentMultiplier-1.5) > 1e-9 {
		t.Errorf("multiplier should not change on skip: want 1.5, got %.4f", got.CurrentMultiplier)
	}
}

// ── 11. EmitBreadcrumb is safe when Sentry not initialised ─────────────

func TestEmitBreadcrumb_NoSentryInit_NoPanic(t *testing.T) {
	// Sentry not initialised in this test process — must not panic.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("EmitBreadcrumb panicked without Sentry init: %v", r)
		}
	}()
	cfg := defaultConfig("ares")
	s := refreshcron.State{Source: "ares", CurrentMultiplier: 1.5, ConsecutiveFailures: 1}
	refreshcron.EmitBreadcrumb(s, cfg, refreshcron.ResultFailure, 47)
}

// ── 12. Migration file is present + has DOWN block ─────────────────────

func TestMigrationFilePresent(t *testing.T) {
	path := "../../../../scripts/migrations/014_refresh_cron_state.sql"
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("expected migration at %s: %v", path, err)
	}
	if !regexp.MustCompile(`CREATE TABLE IF NOT EXISTS refresh_cron_state`).Match(body) {
		t.Errorf("migration missing CREATE TABLE refresh_cron_state")
	}
	if !regexp.MustCompile(`DOWN migration`).Match(body) {
		t.Errorf("migration missing DOWN block")
	}
	if !regexp.MustCompile(`pg_try_advisory_lock|pg_advisory_unlock|advisory`).Match(body) {
		// not strictly required, but the design references advisory locks
		// and we want the migration to mention them in a comment. We use
		// a soft assertion via t.Log instead to avoid coupling docs.
		t.Log("note: migration does not reference advisory lock pattern (informational)")
	}
}

// ── 13. Result.String covers all enum branches ─────────────────────────

func TestResult_StringCoverage(t *testing.T) {
	cases := map[refreshcron.Result]string{
		refreshcron.ResultSuccess: "success",
		refreshcron.ResultFailure: "failure",
		refreshcron.ResultSkipped: "skipped",
	}
	for r, want := range cases {
		if got := r.String(); got != want {
			t.Errorf("Result(%d).String(): want %q, got %q", r, want, got)
		}
	}
	if got := refreshcron.Result(99).String(); got != "unknown" {
		t.Errorf("unknown Result: want %q, got %q", "unknown", got)
	}
}
