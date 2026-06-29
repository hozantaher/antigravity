// Sprint AC6 — per-mailbox distribution audit cron.
//
// Every 6 hours, audit the last 24h of `send_events` per mailbox and emit
// a `mailbox_alerts` row (type='distribution_imbalance_24h', severity='info')
// when the spread between the busiest and quietest mailbox crosses the
// `distribution_imbalance_threshold` ratio (default 0.5 ≡ 50%).
//
// Why: when one mailbox carries 80% of a campaign's volume the cluster is
// effectively single-channel — IP+sender reputation concentrates on a single
// identity, undoing the anti-detection benefit of running multiple mailboxes.
// Surfacing this early (24h window) lets the operator rebalance before the
// reputation tax accumulates.
//
// HARD RULE compliance:
//   - feedback_no_magic_thresholds (T0)      — threshold in operator_settings
//     with named Go default.
//   - feedback_audit_log_on_mutations (T0)   — every imbalance alert ALSO
//     writes an operator_audit_log row with the per-mailbox tier breakdown
//     so a future operator can audit what state triggered the alert.
//   - feedback_schema_verify_before_sql (T0) — send_events columns
//     verified via psql \d (mailbox_used, status, sent_at). mailbox_alerts
//     columns verified (mailbox_id NULL allowed for cluster-level alerts).
//   - feedback_no_pii_in_commands (T0)       — slog uses count + ratio,
//     not addresses, in the cluster log line. Per-mailbox lines redact.
//   - feedback_external_io_backoff (T0)      — not applicable; SQL-only.

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"common/audit"
	"common/envconfig"
	"common/operatorconfig"
)

const (
	distributionAuditDefaultInterval     = 6 * time.Hour
	distributionImbalanceAlertType       = "distribution_imbalance_24h"
	distributionImbalanceDedupWindow     = 6 * time.Hour
	defaultDistributionImbalanceThreshold = 0.5
)

// distributionAuditResult tracks observability counts.
type distributionAuditResult struct {
	MailboxCount     int
	MaxSends         int
	MinSends         int
	Ratio            float64
	AlertEmitted     bool
}

// LoadDistributionImbalanceThreshold reads the operator_settings value.
// Returns the default when missing or invalid.
func LoadDistributionImbalanceThreshold(ctx context.Context, loader *operatorconfig.Loader) float64 {
	if loader == nil {
		return defaultDistributionImbalanceThreshold
	}
	if v, err := loader.Get(ctx, "distribution_imbalance_threshold"); err == nil && v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 && f < 1 {
			return f
		}
	}
	return defaultDistributionImbalanceThreshold
}

// distributionTier captures one mailbox's 24h volume — used for the audit
// payload so the operator can see exactly which mailboxes drove the alert.
type distributionTier struct {
	MailboxUsed string `json:"mailbox_used"`
	Sends       int    `json:"sends"`
}

// RunDistributionAuditOnce executes one tick. Returns the snapshot + whether
// an alert was emitted. Errors are wrapped — the caller logs.
func RunDistributionAuditOnce(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) (distributionAuditResult, error) {
	var res distributionAuditResult
	threshold := LoadDistributionImbalanceThreshold(ctx, loader)

	// SELECT only successful sends — failed/bounced rows distort the volume
	// signal (the operator cares about routed throughput, not raw attempts).
	rows, err := db.QueryContext(ctx, `
		SELECT mailbox_used, count(*) AS sends
		  FROM send_events
		 WHERE sent_at > NOW() - INTERVAL '24 hours'
		   AND status = 'sent'
		   AND mailbox_used IS NOT NULL
		 GROUP BY mailbox_used
		 ORDER BY sends DESC`)
	if err != nil {
		return res, fmt.Errorf("query distribution audit: %w", err)
	}
	defer rows.Close()

	var tiers []distributionTier
	for rows.Next() {
		var t distributionTier
		if err := rows.Scan(&t.MailboxUsed, &t.Sends); err != nil {
			return res, fmt.Errorf("scan distribution row: %w", err)
		}
		tiers = append(tiers, t)
	}
	if err := rows.Err(); err != nil {
		return res, fmt.Errorf("iterate distribution rows: %w", err)
	}
	res.MailboxCount = len(tiers)

	// Defensive: with <2 mailboxes there is no spread to measure. Single-
	// mailbox campaigns are intentional; an alert here would be noise.
	if len(tiers) < 2 {
		return res, nil
	}

	// tiers ORDER BY sends DESC → first is max, last is min.
	maxSends := tiers[0].Sends
	minSends := tiers[len(tiers)-1].Sends
	res.MaxSends = maxSends
	res.MinSends = minSends

	// All-zero defence — should never trigger because the SELECT only
	// returns rows with count(*) > 0, but a 0/0 division still warrants
	// a guard for the float64 NaN/Inf path.
	if maxSends <= 0 {
		return res, nil
	}

	res.Ratio = float64(maxSends-minSends) / float64(maxSends)
	if res.Ratio <= threshold {
		return res, nil
	}

	// Imbalance detected — emit dedup'd alert + audit row.
	tiersJSON, _ := json.Marshal(tiers)
	message := fmt.Sprintf(
		"Send distribution imbalance %.0f%% in 24h (max %d / min %d across %d mailboxes; threshold %.0f%%)",
		res.Ratio*100, maxSends, minSends, len(tiers), threshold*100,
	)

	if maybeInsertClusterAlert(ctx, db, distributionImbalanceAlertType, "info", message, distributionImbalanceDedupWindow) {
		res.AlertEmitted = true
		// HARD RULE feedback_audit_log_on_mutations T0 — the alert is the
		// operator-visible state change; pair with operator_audit_log so
		// the per-mailbox tier breakdown is searchable later.
		audit.Log(ctx, db, "distribution_audit.imbalance", "cron", "cluster", "",
			map[string]any{
				"ratio":         res.Ratio,
				"max_sends":     maxSends,
				"min_sends":     minSends,
				"mailbox_count": len(tiers),
				"threshold":     threshold,
				"tiers":         json.RawMessage(tiersJSON),
				"window":        "24h",
			})
		slog.Warn("distribution_audit: imbalance",
			"op", "outreach.distribution_audit/alert",
			"ratio", res.Ratio,
			"max_sends", maxSends, "min_sends", minSends,
			"mailbox_count", len(tiers))
	}

	return res, nil
}

// StartDistributionAuditLoop spawns the periodic cron.
func StartDistributionAuditLoop(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) {
	if envconfig.BoolOr("DISABLE_DISTRIBUTION_AUDIT_CRON", false) {
		slog.Info("distribution_audit cron disabled (DISABLE_DISTRIBUTION_AUDIT_CRON=1)")
		return
	}
	interval := distributionAuditDefaultInterval
	if v := envconfig.GetOr("DISTRIBUTION_AUDIT_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			interval = d
		}
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("distribution_audit cron panic recovered",
					"op", "outreach.distribution_audit/recover", "recover", r)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		// Initial settle so first tick doesn't collide with boot.
		select {
		case <-ctx.Done():
			return
		case <-time.After(120 * time.Second):
		}
		runTick := func() {
			start := time.Now()
			res, err := RunDistributionAuditOnce(ctx, db, loader)
			dur := time.Since(start)
			if err != nil {
				slog.Error("distribution_audit tick failed",
					"op", "outreach.distribution_audit/tick",
					"error", err, "duration_ms", dur.Milliseconds())
				return
			}
			slog.Info("distribution_audit tick",
				"op", "outreach.distribution_audit/done",
				"mailbox_count", res.MailboxCount,
				"max_sends", res.MaxSends,
				"min_sends", res.MinSends,
				"ratio", res.Ratio,
				"alert_emitted", res.AlertEmitted,
				"duration_ms", dur.Milliseconds())
		}
		runTick()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runTick()
			}
		}
	}()
	slog.Info("distribution_audit cron started", "interval", interval)
}
