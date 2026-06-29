// Z3 Bundle C — mailbox-healing cron ported from BFF
// (apps/outreach-dashboard/src/crons/runMailboxHealingCron.js +
// runMailboxHealthCycleCron auto-resume block).
//
// Why a Go port:
//   the BFF copy stops running whenever the operator turns off their
//   laptop (the BFF runs locally per the Z initiative). Mailbox healing
//   must run 24/7 so an auto-paused mailbox does not stay paused for
//   hours after the underlying SMTP issue clears.
//
// What it does:
//   every MailboxHealingInterval (default 15 min) the cron scans
//   outreach_mailboxes for rows with status='paused' and a
//   status_reason that starts with "auto:" (the BFF + orchestrator
//   convention for "the platform paused this, not a human"). For each
//   row the recovery rule in EvaluateAutoResume decides whether the
//   mailbox can come back to status='active'. Rows that pass:
//     - get UPDATEd back to active (with a guard clause so an operator
//       who manually re-paused mid-tick is not silently overwritten),
//     - get one operator_audit_log row each (audit_log_on_mutations
//       HARD RULE).
//
// What it intentionally does NOT do:
//   no SMTP probing, no IMAP probing, no relay full-check call. The
//   BFF version proxied to `/api/mailboxes/:id/full-check` which lives
//   in the BFF. The Go-runner port relies on the mailbox-score loop
//   (intelligence.MailboxScoreLoop in main.go) to refresh last_score /
//   last_score_at; this cron purely reads those columns.
//
// Per Z2 audit: runMailboxHealthCycleCron is a superset that adds
// "trigger full-check on degraded mailboxes" plus the same auto-resume
// block. The full-check trigger has been retired (the Go-side score
// loop owns that responsibility now). The auto-resume body is what
// migrates here.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"common/audit"
	"common/envconfig"
)

// MailboxHealingConfig keeps the tunables out of magic numbers so an
// operator can adjust them without redeploying (env-var bootstraps the
// defaults; future work can sink these into operator_settings — see
// feedback_env_var_needs_db_fallback for the longer-term plan).
type MailboxHealingConfig struct {
	// Interval between ticks. BFF default: 15 min.
	Interval time.Duration
	// Mailboxes whose last_score is below this floor stay paused.
	// BFF default: 80.
	ScoreFloor float64
	// Maximum allowed staleness for last_score_at. If the score is
	// older than this we cannot trust it and stay paused. BFF default:
	// 10 min.
	ScoreFreshness time.Duration
	// Per-UPDATE timeout — protects against a DB session getting stuck.
	UpdateTimeout time.Duration
	// Per-tick total timeout — bounds one full sweep.
	TickTimeout time.Duration
}

// WithDefaults fills in the BFF defaults so callers can pass a zero
// value and still get production-shaped behaviour.
func (c MailboxHealingConfig) WithDefaults() MailboxHealingConfig {
	if c.Interval <= 0 {
		c.Interval = 15 * time.Minute
	}
	if c.ScoreFloor <= 0 {
		c.ScoreFloor = 80
	}
	if c.ScoreFreshness <= 0 {
		c.ScoreFreshness = 10 * time.Minute
	}
	if c.UpdateTimeout <= 0 {
		c.UpdateTimeout = 10 * time.Second
	}
	if c.TickTimeout <= 0 {
		c.TickTimeout = 2 * time.Minute
	}
	return c
}

// loadMailboxHealingConfig reads the BFF-compatible env vars
// (MAILBOX_HEALING_INTERVAL, MAILBOX_HEALING_SCORE_FLOOR,
// MAILBOX_HEALING_SCORE_FRESHNESS) and falls back to defaults.
//
// Per feedback_no_magic_thresholds: each knob has a named constant
// inside WithDefaults plus an env bootstrap; longer term the operator
// will tune these from the dashboard via operator_settings.
func loadMailboxHealingConfig() MailboxHealingConfig {
	cfg := MailboxHealingConfig{}
	if v := envconfig.GetOr("MAILBOX_HEALING_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.Interval = d
		}
	}
	if v := envconfig.GetOr("MAILBOX_HEALING_SCORE_FLOOR", ""); v != "" {
		var f float64
		if _, err := fmt.Sscanf(v, "%f", &f); err == nil && f > 0 {
			cfg.ScoreFloor = f
		}
	}
	if v := envconfig.GetOr("MAILBOX_HEALING_SCORE_FRESHNESS", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.ScoreFreshness = d
		}
	}
	return cfg.WithDefaults()
}

// PausedMailbox is the per-row payload the SELECT in
// findPausedAutoCandidates produces. Pulled to its own type so
// EvaluateAutoResume can stay pure (no sql.Rows scanning).
type PausedMailbox struct {
	ID            int64
	Status        string
	StatusReason  sql.NullString
	LastScore     sql.NullFloat64
	LastScoreAt   sql.NullTime
}

// AutoResumeDecision is the result of EvaluateAutoResume. ShouldResume
// is the single boolean callers branch on; Reason is the human-readable
// justification we persist into operator_audit_log so an operator can
// audit "why did the platform unpause this mailbox at 03:17?".
type AutoResumeDecision struct {
	ShouldResume bool
	Reason       string
}

// EvaluateAutoResume mirrors the JS function evaluateMailboxAutoResume
// in apps/outreach-dashboard/src/lib/automation.js verbatim — same
// gates, same defaults, same skip reasons — so the BFF and Go
// implementations behave identically while the migration is in flight.
//
// Pure function on purpose: every interesting case can be unit-tested
// without touching a database, an env var, or a clock other than the
// one the caller passes in.
func EvaluateAutoResume(mb PausedMailbox, cfg MailboxHealingConfig, now time.Time) AutoResumeDecision {
	cfg = cfg.WithDefaults()

	if mb.Status != "paused" {
		return AutoResumeDecision{ShouldResume: false, Reason: "not paused"}
	}
	if !mb.StatusReason.Valid || mb.StatusReason.String == "" {
		return AutoResumeDecision{ShouldResume: false, Reason: "no status_reason — assume manual pause, preserve"}
	}
	if !strings.HasPrefix(mb.StatusReason.String, "auto:") {
		return AutoResumeDecision{ShouldResume: false, Reason: "not auto-paused (manual reason preserved)"}
	}
	if !mb.LastScore.Valid {
		return AutoResumeDecision{ShouldResume: false, Reason: "no last_score — cannot evaluate"}
	}
	if mb.LastScore.Float64 < cfg.ScoreFloor {
		return AutoResumeDecision{
			ShouldResume: false,
			Reason:       fmt.Sprintf("score %.1f < floor %.0f", mb.LastScore.Float64, cfg.ScoreFloor),
		}
	}
	if !mb.LastScoreAt.Valid {
		return AutoResumeDecision{ShouldResume: false, Reason: "no last_score_at — cannot trust freshness"}
	}
	age := now.Sub(mb.LastScoreAt.Time)
	if age > cfg.ScoreFreshness {
		return AutoResumeDecision{
			ShouldResume: false,
			Reason:       fmt.Sprintf("score stale: %s old", age.Round(time.Minute)),
		}
	}
	return AutoResumeDecision{
		ShouldResume: true,
		Reason:       fmt.Sprintf("score %.1f >= floor %.0f and fresh (%s old)", mb.LastScore.Float64, cfg.ScoreFloor, age.Round(time.Minute)),
	}
}

// findPausedAutoCandidates pulls every mailbox that is currently
// auto-paused, regardless of whether it is eligible for release — the
// eligibility decision happens in pure code on the way out. Bounding
// the WHERE here to "auto:" + paused means we never even consider
// manually-paused rows (HARD RULE: preserve operator intent).
//
// Columns referenced were verified against
// scripts/migrations/029_legacy_outreach_mailboxes_schema.sql:
//   id (PK), status, status_reason, last_score, last_score_at.
// (feedback_schema_verify_before_sql)
func findPausedAutoCandidates(ctx context.Context, db *sql.DB) ([]PausedMailbox, error) {
	if db == nil {
		return nil, fmt.Errorf("cron_mailbox_healing: nil DB")
	}
	rows, err := db.QueryContext(ctx, `
		SELECT id, status, status_reason, last_score, last_score_at
		FROM outreach_mailboxes
		WHERE status = 'paused'
		  AND status_reason LIKE 'auto:%'
	`)
	if err != nil {
		return nil, fmt.Errorf("cron_mailbox_healing: query paused: %w", err)
	}
	defer rows.Close()

	var out []PausedMailbox
	for rows.Next() {
		var mb PausedMailbox
		if err := rows.Scan(&mb.ID, &mb.Status, &mb.StatusReason, &mb.LastScore, &mb.LastScoreAt); err != nil {
			return nil, fmt.Errorf("cron_mailbox_healing: scan: %w", err)
		}
		out = append(out, mb)
	}
	return out, rows.Err()
}

// resumeMailbox runs the actual UPDATE. The WHERE clause re-asserts
// status='paused' AND status_reason LIKE 'auto:%' so a concurrent
// operator manual re-pause is not silently overwritten. RowsAffected
// drives the "did anyone actually flip?" branch.
//
// Audit log is INSERTed only when the UPDATE flipped a row — silent
// no-ops are not surfaced (matches the JS path which only logs healing
// when rowCount > 0).
func resumeMailbox(ctx context.Context, db *sql.DB, mb PausedMailbox, decision AutoResumeDecision, cfg MailboxHealingConfig) (bool, error) {
	updCtx, cancel := context.WithTimeout(ctx, cfg.UpdateTimeout)
	defer cancel()

	res, err := db.ExecContext(updCtx, `
		UPDATE outreach_mailboxes
		SET status         = 'active',
		    status_reason  = NULL,
		    released_at    = now(),
		    updated_at     = now()
		WHERE id = $1
		  AND status = 'paused'
		  AND status_reason LIKE 'auto:%'
	`, mb.ID)
	if err != nil {
		return false, fmt.Errorf("cron_mailbox_healing: update mailbox %d: %w", mb.ID, err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("cron_mailbox_healing: rows affected mailbox %d: %w", mb.ID, err)
	}
	if rows == 0 {
		return false, nil
	}

	// feedback_audit_log_on_mutations T0: every mutation that flips
	// operator-visible state writes an audit row in the same overall
	// flow. audit.Log swallows its own errors (best-effort) so the
	// healing path is not blocked by a flaky audit table.
	previousReason := ""
	if mb.StatusReason.Valid {
		previousReason = mb.StatusReason.String
	}
	audit.Log(updCtx, db,
		ActionMailboxAutoResumed,
		"cron.mailbox_healing",
		"mailbox",
		fmt.Sprintf("%d", mb.ID),
		map[string]any{
			"previous_status":        "paused",
			"previous_status_reason": previousReason,
			"reason":                 decision.Reason,
			"last_score":             mb.LastScore.Float64,
			"score_age_seconds":      int(time.Since(mb.LastScoreAt.Time).Seconds()),
		},
	)
	return true, nil
}

// ActionMailboxAutoResumed is the canonical audit action string for
// "cron unpaused an auto-paused mailbox". Lives in this file (not
// services/common/audit/entry.go) because it is mailbox-cron-private
// while the cron lives in cmd/outreach.
const ActionMailboxAutoResumed = "mailbox.auto_resumed"

// MailboxHealingStats captures one tick's outcome — exposed as a
// return value so the daemon loop can log it and tests can assert on
// it without parsing logs.
type MailboxHealingStats struct {
	Candidates int
	Skipped    int
	Resumed    int
	Errors     int
}

// RunMailboxHealingOnce executes exactly one healing sweep. Returns
// stats and any *terminal* error (a SELECT failure aborts the tick; a
// single mailbox UPDATE failure is counted in stats.Errors and the
// sweep continues — matches the BFF behavior).
//
// Pulled out from the daemon goroutine so tests can drive a single
// tick deterministically and assert on the resulting state.
func RunMailboxHealingOnce(ctx context.Context, db *sql.DB, cfg MailboxHealingConfig, now time.Time) (MailboxHealingStats, error) {
	cfg = cfg.WithDefaults()
	stats := MailboxHealingStats{}

	tickCtx, cancel := context.WithTimeout(ctx, cfg.TickTimeout)
	defer cancel()

	candidates, err := findPausedAutoCandidates(tickCtx, db)
	if err != nil {
		return stats, err
	}
	stats.Candidates = len(candidates)

	for _, mb := range candidates {
		decision := EvaluateAutoResume(mb, cfg, now)
		if !decision.ShouldResume {
			stats.Skipped++
			continue
		}
		flipped, err := resumeMailbox(tickCtx, db, mb, decision, cfg)
		if err != nil {
			slog.Warn("mailbox healing resume failed",
				"op", "outreach.cronMailboxHealing/resume",
				"mailbox_id", mb.ID,
				"error", err)
			stats.Errors++
			continue
		}
		if flipped {
			stats.Resumed++
			slog.Info("mailbox auto-resumed",
				"op", "outreach.cronMailboxHealing/resume",
				"mailbox_id", mb.ID,
				"reason", decision.Reason)
		} else {
			// Lost the race to an operator manual re-pause between
			// SELECT and UPDATE — count as skipped, not error.
			stats.Skipped++
		}
	}
	return stats, nil
}

// startMailboxHealingDaemon spawns the long-running healing goroutine.
// One immediate tick at start (so operators don't wait 15 min after a
// boot for the first sweep) followed by ticker.
//
// Panic-recovery wraps each tick: a bad SQL plan or a panic in
// audit.Log must not kill the whole cron, only this one tick.
//
// Returns nothing — the goroutine lifetime is bound to ctx.
func startMailboxHealingDaemon(ctx context.Context, db *sql.DB, cfg MailboxHealingConfig) {
	cfg = cfg.WithDefaults()
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("mailbox healing daemon panic recovered",
					"op", "outreach.cronMailboxHealing/daemonPanic",
					"recover", r)
			}
		}()
		slog.Info("mailbox healing daemon started",
			"interval", cfg.Interval,
			"score_floor", cfg.ScoreFloor,
			"score_freshness", cfg.ScoreFreshness)

		tick := func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("mailbox healing tick panic recovered",
						"op", "outreach.cronMailboxHealing/tickPanic",
						"recover", r)
				}
			}()
			start := time.Now()
			stats, err := RunMailboxHealingOnce(ctx, db, cfg, time.Now())
			if err != nil {
				slog.Warn("mailbox healing tick failed",
					"op", "outreach.cronMailboxHealing/tick",
					"error", err,
					"duration_ms", time.Since(start).Milliseconds())
				return
			}
			slog.Info("mailbox healing tick",
				"op", "outreach.cronMailboxHealing/tick",
				"candidates", stats.Candidates,
				"resumed", stats.Resumed,
				"skipped", stats.Skipped,
				"errors", stats.Errors,
				"duration_ms", time.Since(start).Milliseconds())
		}

		tick()
		t := time.NewTicker(cfg.Interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				slog.Info("mailbox healing daemon stopped")
				return
			case <-t.C:
				tick()
			}
		}
	}()
}
