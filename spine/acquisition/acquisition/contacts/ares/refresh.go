// Package ares — KT-A10 refresh cron wrapper.
//
// RefreshLoop is the long-lived periodic refresh worker. It pulls the
// per-source state from refresh_cron_state, checks the next_run_at
// guard, acquires a pg_try_advisory_lock, runs SyncSubjects (the
// existing fetch fáze), records success/failure, and sleeps until the
// next heartbeat.
//
// Designed to be invoked from main() in the contacts service:
//
//	cfg, err := refreshcron.LoadConfigFromEnv("ARES", time.Hour)
//	if err != nil { telemetry.FatalExitFn(err, 1)() }
//	go ares.RefreshLoop(ctx, db, client, cfg, ares.SyncConfig{BatchSize: 100})

package ares

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"common/refreshcron"
	"common/telemetry"
)

// HeartbeatInterval is how often the loop wakes up to check whether
// the cron is due. Must be smaller than the smallest expected base
// interval; 1 minute matches the design doc.
const HeartbeatInterval = 1 * time.Minute

// RefreshLoop runs the ARES refresh cron until ctx is cancelled.
// Each tick is wrapped in telemetry.MonitoredJob("refresh-ares", ...)
// so Sentry receives in_progress / ok / error check-ins.
func RefreshLoop(ctx context.Context, db *sql.DB, client *Client, cfg refreshcron.Config, sync SyncConfig) error {
	if cfg.Source == "" {
		cfg.Source = "ares"
	}
	ticker := time.NewTicker(HeartbeatInterval)
	defer ticker.Stop()

	// Initial tick on boot so a fresh deploy doesn't wait a full
	// heartbeat before checking next_run_at.
	if err := tickARES(ctx, db, client, cfg, sync); err != nil && !errors.Is(err, context.Canceled) {
		slog.Warn("refresh tick selhal",
			"op", "ares.RefreshLoop/initial",
			"source", cfg.Source,
			"error", err)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := tickARES(ctx, db, client, cfg, sync); err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("refresh tick selhal",
					"op", "ares.RefreshLoop/heartbeat",
					"source", cfg.Source,
					"error", err)
			}
		}
	}
}

// tickARES is a single iteration of the refresh loop. Exported
// indirectly via RefreshLoop; kept package-private so tests can
// drive it deterministically.
func tickARES(ctx context.Context, db *sql.DB, client *Client, cfg refreshcron.Config, sync SyncConfig) error {
	return telemetry.MonitoredJob("refresh-"+cfg.Source, func() error {
		now := time.Now().UTC()

		state, err := refreshcron.LoadState(ctx, db, cfg.Source)
		if err != nil {
			return err
		}

		if !refreshcron.ShouldRun(state, cfg, now) {
			refreshcron.EmitBreadcrumb(state, cfg, refreshcron.ResultSkipped, sync.BatchSize)
			slog.Debug("refresh tick mimo backoff okno",
				"op", "ares.tickARES/backoff",
				"source", cfg.Source,
				"next_run_at", refreshcron.NextRunAt(state, cfg, now),
				"current_multiplier", state.CurrentMultiplier)
			return nil
		}

		locked, err := refreshcron.TryLock(ctx, db, cfg.Source)
		if err != nil {
			return fmt.Errorf("acquire advisory lock: %w", err)
		}
		if !locked {
			slog.Info("refresh tick preskocen — paralelni hold",
				"op", "ares.tickARES/skip_overlap",
				"source", cfg.Source,
				"event", "skip_overlap")
			refreshcron.EmitBreadcrumb(state, cfg, refreshcron.ResultSkipped, sync.BatchSize)
			if _, err := refreshcron.RecordResult(ctx, db, cfg, refreshcron.ResultSkipped, now); err != nil {
				return err
			}
			return nil
		}
		defer refreshcron.Unlock(ctx, db, cfg.Source)

		// Honour the operator-supplied batch size; SyncConfig sourced
		// the same value during construction.
		result, fetchErr := client.refreshSync(ctx, db, sync)

		if _, err := refreshcron.RecordResult(ctx, db, cfg, result, now); err != nil {
			slog.Warn("ulozeni stavu refresh selhalo",
				"op", "ares.tickARES/record",
				"source", cfg.Source,
				"error", err)
		}

		// Reload to emit a breadcrumb with post-update multiplier.
		updated, _ := refreshcron.LoadState(ctx, db, cfg.Source)
		refreshcron.EmitBreadcrumb(updated, cfg, result, sync.BatchSize)

		switch result {
		case refreshcron.ResultSuccess:
			slog.Info("refresh tick uspesny",
				"op", "ares.tickARES/success",
				"source", cfg.Source,
				"event", "success",
				"multiplier", updated.CurrentMultiplier,
				"consecutive_failures", updated.ConsecutiveFailures)
		case refreshcron.ResultFailure:
			slog.Warn("refresh tick neuspesny",
				"op", "ares.tickARES/failure",
				"source", cfg.Source,
				"event", "failure",
				"multiplier", updated.CurrentMultiplier,
				"consecutive_failures", updated.ConsecutiveFailures,
				"error", fetchErr)
		}

		return fetchErr
	})
}

// refreshSync wraps RunSync and translates the SyncResult into a
// refreshcron.Result. Per design semantics: success = ≥1 fetched, even
// if other items errored; failure = 0 fetched AND ≥1 errored. A run
// with 0 total rows is success (nothing to do, source is reachable).
func (c *Client) refreshSync(ctx context.Context, db *sql.DB, sync SyncConfig) (refreshcron.Result, error) {
	r, err := RunSync(ctx, db, c, sync)
	if err != nil {
		return refreshcron.ResultFailure, err
	}
	if r == nil {
		return refreshcron.ResultFailure, fmt.Errorf("nil sync result")
	}
	if r.Total == 0 {
		return refreshcron.ResultSuccess, nil
	}
	if r.Synced == 0 && r.NotFound == 0 && r.Errors > 0 {
		return refreshcron.ResultFailure, nil
	}
	return refreshcron.ResultSuccess, nil
}
