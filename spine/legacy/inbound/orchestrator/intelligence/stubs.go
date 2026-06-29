package intelligence

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"common/envconfig"
	"common/metrics"
	"mailboxes/mailbox"
)

// autoReleaseBounceHold releases bounce_hold mailboxes whose cooldown window
// has elapsed. When WATCHDOG_ADAPTIVE_RELEASE != "0" (default), low-volume
// mailboxes (sent_7d < threshold) become eligible after FastWindow instead of
// the standard StandardWindow. Each release seeds canary state and writes a
// cooldown_log row.
func autoReleaseBounceHold(ctx context.Context, db *sql.DB, bp mailbox.HoldReleaser, holdDays int) (int, error) {
	cfg := mailbox.AdaptiveReleaseConfig{
		AdaptiveEnable: envconfig.GetOr("WATCHDOG_ADAPTIVE_RELEASE", "0") != "0",
		StandardWindow: time.Duration(holdDays) * 24 * time.Hour,
	}.WithDefaults()

	candidates, err := mailbox.CandidatesForRelease(ctx, db, cfg, time.Now())
	if err != nil {
		return 0, err
	}

	var released int
	for _, c := range candidates {
		if err := mailbox.ReleaseCandidateWithCanary(ctx, db, bp, cfg, c); err != nil {
			slog.Warn("autoReleaseBounceHold: release failed",
				"op", "intelligence.autoReleaseBounceHold/release_failed", "address", c.FromAddress, "reason", c.ReleaseReason, "error", err)
			continue
		}
		slog.Info("mailbox released from bounce_hold",
			"address", c.FromAddress,
			"reason", c.ReleaseReason,
			"held_hours", c.HeldHours,
			"sent_7d", c.Sent7d,
			"canary", cfg.CanaryCount)
		released++
	}
	return released, nil
}

// emitDeliverabilityMetrics emits current deliverability gauges to Prometheus.
func emitDeliverabilityMetrics(ctx context.Context, db *sql.DB) {
	rows, err := db.QueryContext(ctx,
		`SELECT email_status, COUNT(*) FROM companies GROUP BY email_status`)
	if err != nil {
		slog.Warn("emitDeliverabilityMetrics: query error", "op", "intelligence.emitDeliverabilityMetrics/query", "error", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			continue
		}
		metrics.EmailStatusTotal.Set(float64(count), status)
	}
}

// emitMailboxMetrics emits per-mailbox health gauges. Labeled by canonical
// from_address so dashboards can slice a single mailbox's posture over time.
// Missing canary/circuit columns (migrations not yet applied) are treated
// as zeros via COALESCE.
func emitMailboxMetrics(ctx context.Context, db *sql.DB) {
	rows, err := db.QueryContext(ctx, `
		SELECT from_address, status, consecutive_bounces,
		       COALESCE(canary_remaining, 0),
		       COALESCE((circuit_opened_at IS NOT NULL)::int, 0)
		FROM outreach_mailboxes
		WHERE environment = 'production'
	`)
	if err != nil {
		slog.Warn("emitMailboxMetrics: query error", "op", "intelligence.emitMailboxMetrics/query", "error", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var (
			addr    string
			status  string
			bounces int
			canary  int
			circuit int
		)
		if err := rows.Scan(&addr, &status, &bounces, &canary, &circuit); err != nil {
			continue
		}
		metrics.MailboxStatus.Set(float64(statusToInt(status)), addr)
		metrics.MailboxConsecutiveBounces.Set(float64(bounces), addr)
		metrics.MailboxCanaryRemaining.Set(float64(canary), addr)
		metrics.MailboxCircuitOpen.Set(float64(circuit), addr)
	}
}

func statusToInt(s string) int {
	switch s {
	case "active":
		return 1
	case "paused":
		return 2
	case "bounce_hold":
		return 3
	case "retired":
		return 4
	default:
		return 0
	}
}
