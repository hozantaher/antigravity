// Package refreshcron — KT-A10 per-source refresh cron backoff state.
//
// Design: docs/initiatives/2026-04-30-kt-a10-refresh-cron-tuning-design.md
//
// Each refresh cron (ARES, firmy.cz) reads/writes a row in
// refresh_cron_state. On consecutive failure the multiplier ramps by
// MultiplierRamp; on first success it resets to 1.0. The cron emits a
// Sentry breadcrumb per tick and acquires a Postgres advisory lock so
// two replicas can't fetch the same source in parallel.
//
// The package keeps a stable env-knob contract:
//
//	ARES_REFRESH_INTERVAL          (default 1h)
//	ARES_REFRESH_BACKOFF_CAP       (default 4h)
//	ARES_REFRESH_BACKOFF_MULTIPLIER(default 1.5)
//	FIRMYCZ_REFRESH_INTERVAL       (default 4h)
//	FIRMYCZ_REFRESH_BACKOFF_CAP    (default 4h)
//	FIRMYCZ_REFRESH_BACKOFF_MULTIPLIER (default 1.5)
package refreshcron

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"hash/fnv"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/getsentry/sentry-go"
)

// MultiplierRamp is the per-failure backoff multiplier ramp (1.5×).
const MultiplierRamp = 1.5

// MinInterval and MaxInterval bound any user-supplied cadence to keep
// operators from accidentally setting INTERVAL=1ms or INTERVAL=720h.
const (
	MinInterval = 1 * time.Minute
	MaxInterval = 24 * time.Hour
)

// Min and max ramp values.
const (
	MinMultiplier = 1.0
	MaxMultiplier = 3.0
)

// Result describes the outcome of one fetch tick.
type Result int

const (
	// ResultSuccess: at least one item in the batch fetched successfully.
	ResultSuccess Result = iota
	// ResultFailure: every item in the batch failed.
	ResultFailure
	// ResultSkipped: tick skipped (e.g. lock contention or backoff window).
	ResultSkipped
)

func (r Result) String() string {
	switch r {
	case ResultSuccess:
		return "success"
	case ResultFailure:
		return "failure"
	case ResultSkipped:
		return "skipped"
	default:
		return "unknown"
	}
}

// Config holds per-source cadence + backoff parameters.
type Config struct {
	Source        string        // "ares" | "firmycz"
	Interval      time.Duration // base cadence
	BackoffCap    time.Duration // max wall-clock between runs
	Multiplier    float64       // ramp factor on consecutive failure
	BatchSize     int           // ICO batch size (passed in breadcrumb)
}

// State is the persistent per-source row.
type State struct {
	Source              string
	CurrentMultiplier   float64
	ConsecutiveFailures int
	LastRunAt           time.Time
	LastStatus          string
	NextRunAt           time.Time
	BaseIntervalSeconds int
	BackoffCapSeconds   int
}

// LoadConfigFromEnv reads ENV with the given prefix (e.g. "ARES" or
// "FIRMYCZ"). Returns ErrInvalidConfig when a parsed value is outside
// the allowed range — callers should surface this at boot.
func LoadConfigFromEnv(prefix string, defaultInterval time.Duration) (Config, error) {
	cfg := Config{
		Source:     normalizeSource(prefix),
		Interval:   defaultInterval,
		BackoffCap: 4 * time.Hour,
		Multiplier: MultiplierRamp,
	}
	if v := os.Getenv(prefix + "_REFRESH_INTERVAL"); v != "" { // envconfig-allowed: dynamic key + time.Duration parse
		d, err := time.ParseDuration(v)
		if err != nil {
			return cfg, fmt.Errorf("%s_REFRESH_INTERVAL: %w", prefix, err)
		}
		cfg.Interval = d
	}
	if v := os.Getenv(prefix + "_REFRESH_BACKOFF_CAP"); v != "" { // envconfig-allowed: dynamic key + time.Duration parse
		d, err := time.ParseDuration(v)
		if err != nil {
			return cfg, fmt.Errorf("%s_REFRESH_BACKOFF_CAP: %w", prefix, err)
		}
		cfg.BackoffCap = d
	}
	if v := os.Getenv(prefix + "_REFRESH_BACKOFF_MULTIPLIER"); v != "" { // envconfig-allowed: dynamic key + float64 parse
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return cfg, fmt.Errorf("%s_REFRESH_BACKOFF_MULTIPLIER: %w", prefix, err)
		}
		cfg.Multiplier = f
	}

	if cfg.Interval < MinInterval || cfg.Interval > MaxInterval {
		return cfg, fmt.Errorf("%s_REFRESH_INTERVAL %s mimo rozsah [%s..%s]", prefix, cfg.Interval, MinInterval, MaxInterval)
	}
	if cfg.BackoffCap < cfg.Interval || cfg.BackoffCap > MaxInterval {
		return cfg, fmt.Errorf("%s_REFRESH_BACKOFF_CAP %s mimo rozsah [%s..%s]", prefix, cfg.BackoffCap, cfg.Interval, MaxInterval)
	}
	if cfg.Multiplier < MinMultiplier || cfg.Multiplier > MaxMultiplier {
		return cfg, fmt.Errorf("%s_REFRESH_BACKOFF_MULTIPLIER %.2f mimo rozsah [%.1f..%.1f]", prefix, cfg.Multiplier, MinMultiplier, MaxMultiplier)
	}
	return cfg, nil
}

func normalizeSource(prefix string) string {
	switch prefix {
	case "ARES":
		return "ares"
	case "FIRMYCZ":
		return "firmycz"
	default:
		return prefix
	}
}

// LoadState fetches the row for the given source. Returns a zero-value
// State (multiplier 1.0, no failures) when the row does not exist.
func LoadState(ctx context.Context, db *sql.DB, source string) (State, error) {
	var s State
	s.Source = source
	s.CurrentMultiplier = 1.0
	row := db.QueryRowContext(ctx, `
		SELECT current_multiplier, consecutive_failures, last_run_at, last_status, next_run_at,
		       base_interval_seconds, backoff_cap_seconds
		  FROM refresh_cron_state
		 WHERE source = $1
	`, source)
	var lastRun, nextRun sql.NullTime
	var lastStatus sql.NullString
	err := row.Scan(&s.CurrentMultiplier, &s.ConsecutiveFailures, &lastRun, &lastStatus, &nextRun,
		&s.BaseIntervalSeconds, &s.BackoffCapSeconds)
	if errors.Is(err, sql.ErrNoRows) {
		// No row yet — return zero-value State so the first tick can run
		// immediately. Caller will INSERT on first RecordResult.
		return s, nil
	}
	if err != nil {
		return s, fmt.Errorf("nacti refresh_cron_state pro %s: %w", source, err)
	}
	if lastRun.Valid {
		s.LastRunAt = lastRun.Time
	}
	if lastStatus.Valid {
		s.LastStatus = lastStatus.String
	}
	if nextRun.Valid {
		s.NextRunAt = nextRun.Time
	}
	return s, nil
}

// NextRunAt returns the wall-clock instant at which the next tick is
// allowed to start. Equals last_run_at + (interval × current_multiplier),
// bounded by backoff_cap.
func NextRunAt(s State, cfg Config, now time.Time) time.Time {
	if s.LastRunAt.IsZero() {
		return now // never run → eligible immediately
	}
	wait := time.Duration(float64(cfg.Interval) * s.CurrentMultiplier)
	if wait > cfg.BackoffCap {
		wait = cfg.BackoffCap
	}
	return s.LastRunAt.Add(wait)
}

// RampMultiplier returns the next multiplier after a failure, bounded
// by the cap-derived ceiling (cap / interval).
func RampMultiplier(current float64, cfg Config) float64 {
	next := current * cfg.Multiplier
	ceiling := float64(cfg.BackoffCap) / float64(cfg.Interval)
	if ceiling < 1.0 {
		ceiling = 1.0
	}
	if next > ceiling {
		next = ceiling
	}
	if next < 1.0 {
		next = 1.0
	}
	return next
}

// RecordResult updates the state row after a tick completes. Success
// resets multiplier + failure counter; failure ramps the multiplier
// and increments the counter; skipped is a no-op for state but updates
// last_status for observability.
func RecordResult(ctx context.Context, db *sql.DB, cfg Config, result Result, now time.Time) (State, error) {
	prev, err := LoadState(ctx, db, cfg.Source)
	if err != nil {
		return prev, err
	}
	next := prev
	next.BaseIntervalSeconds = int(cfg.Interval / time.Second)
	next.BackoffCapSeconds = int(cfg.BackoffCap / time.Second)

	switch result {
	case ResultSuccess:
		next.CurrentMultiplier = 1.0
		next.ConsecutiveFailures = 0
		next.LastRunAt = now
		next.LastStatus = "success"
	case ResultFailure:
		next.CurrentMultiplier = RampMultiplier(prev.CurrentMultiplier, cfg)
		next.ConsecutiveFailures = prev.ConsecutiveFailures + 1
		next.LastRunAt = now
		next.LastStatus = "failure"
	case ResultSkipped:
		// last_run_at intentionally NOT advanced — the tick didn't run.
		next.LastStatus = "skipped"
	}

	wait := time.Duration(float64(cfg.Interval) * next.CurrentMultiplier)
	if wait > cfg.BackoffCap {
		wait = cfg.BackoffCap
	}
	if !next.LastRunAt.IsZero() {
		next.NextRunAt = next.LastRunAt.Add(wait)
	}

	_, err = db.ExecContext(ctx, `
		INSERT INTO refresh_cron_state
		    (source, current_multiplier, consecutive_failures, last_run_at, last_status, next_run_at,
		     base_interval_seconds, backoff_cap_seconds, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (source) DO UPDATE SET
		    current_multiplier    = EXCLUDED.current_multiplier,
		    consecutive_failures  = EXCLUDED.consecutive_failures,
		    last_run_at           = COALESCE(EXCLUDED.last_run_at, refresh_cron_state.last_run_at),
		    last_status           = EXCLUDED.last_status,
		    next_run_at           = COALESCE(EXCLUDED.next_run_at, refresh_cron_state.next_run_at),
		    base_interval_seconds = EXCLUDED.base_interval_seconds,
		    backoff_cap_seconds   = EXCLUDED.backoff_cap_seconds,
		    updated_at            = now()
	`,
		cfg.Source,
		next.CurrentMultiplier,
		next.ConsecutiveFailures,
		nullTime(next.LastRunAt),
		next.LastStatus,
		nullTime(next.NextRunAt),
		next.BaseIntervalSeconds,
		next.BackoffCapSeconds,
	)
	if err != nil {
		return next, fmt.Errorf("uloz refresh_cron_state pro %s: %w", cfg.Source, err)
	}
	return next, nil
}

func nullTime(t time.Time) sql.NullTime {
	if t.IsZero() {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t, Valid: true}
}

// AdvisoryLockKey computes a deterministic 63-bit key for
// pg_try_advisory_lock per refresh-cron source.
func AdvisoryLockKey(source string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte("refresh-cron-" + source))
	// Mask to positive int64 (Postgres advisory lock takes signed bigint
	// but we want determinism without overflow when re-cast).
	return int64(h.Sum64() & 0x7FFFFFFFFFFFFFFF)
}

// TryLock acquires the per-source advisory lock. Returns (true, nil)
// when the lock is held by this session; (false, nil) when another
// session already holds it; (false, err) on a DB error.
func TryLock(ctx context.Context, db *sql.DB, source string) (bool, error) {
	var ok bool
	row := db.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, AdvisoryLockKey(source))
	if err := row.Scan(&ok); err != nil {
		return false, fmt.Errorf("pg_try_advisory_lock %s: %w", source, err)
	}
	return ok, nil
}

// Unlock releases the per-source advisory lock. Best-effort — errors
// are logged but not returned (the lock auto-releases on session close).
func Unlock(ctx context.Context, db *sql.DB, source string) {
	_, err := db.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, AdvisoryLockKey(source))
	if err != nil {
		slog.Warn("uvolneni advisory lock selhalo",
			"op", "refreshcron.Unlock",
			"source", source,
			"error", err)
	}
}

// EmitBreadcrumb adds a structured Sentry breadcrumb for one tick.
// Safe to call when Sentry is not initialised (no-op).
func EmitBreadcrumb(s State, cfg Config, result Result, batchSize int) {
	hub := sentry.CurrentHub()
	if hub == nil {
		return
	}
	hub.AddBreadcrumb(&sentry.Breadcrumb{
		Category:  "refresh-cron",
		Message:   fmt.Sprintf("refresh-%s tick", cfg.Source),
		Level:     sentry.LevelInfo,
		Timestamp: time.Now(),
		Data: map[string]interface{}{
			"current_multiplier":   s.CurrentMultiplier,
			"consecutive_failures": s.ConsecutiveFailures,
			"next_run_at":          s.NextRunAt,
			"base_interval":        cfg.Interval.String(),
			"cap":                  cfg.BackoffCap.String(),
			"ico_batch_size":       batchSize,
			"result":               result.String(),
		},
	}, nil)
}

// ShouldRun returns true when the current wall-clock instant is past
// the persisted next_run_at. Callers that hit `false` should record a
// ResultSkipped and idle until the next heartbeat.
func ShouldRun(s State, cfg Config, now time.Time) bool {
	return !now.Before(NextRunAt(s, cfg, now))
}
