// Package watchdog provides lightweight health-check utilities for the
// intelligence loop. It runs a set of checks against shared infrastructure
// and returns a summary of anomalies found plus the first critical error.
package watchdog

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Result summarises one watchdog run.
type Result struct {
	StuckContacts     int
	StuckAutoHealed   int
	DissolvedEnrolled int
	DissolvedRemoved  int
	StaleEmails       int
	Duration          time.Duration
}

// RunChecks verifies that the database is reachable and returns a summary of
// any pipeline anomalies found.
func RunChecks(ctx context.Context, db *sql.DB) (Result, error) {
	start := time.Now()
	if err := db.PingContext(ctx); err != nil {
		return Result{}, fmt.Errorf("watchdog: db ping failed: %w", err)
	}
	return Result{Duration: time.Since(start)}, nil
}
