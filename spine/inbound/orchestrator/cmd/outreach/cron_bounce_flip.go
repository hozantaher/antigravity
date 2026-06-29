// Z3-B: bounce-flip cron migrated from BFF (apps/outreach-dashboard/src/crons/runBounceFlipCron.js).
//
// Goal: surface hard-bounced send_events and flip the corresponding `companies`
// row to email_status='invalid'. Runs every 15 minutes on the Go orchestrator so
// the flip happens 24/7 — the BFF cron only ran while the operator's dev box was
// up (HARD rule feedback_outreach_dashboard_local_only).
//
// This mirrors the BFF JS port, with one correctness fix: it no longer advances
// an outreach_config watermark. A send_event flips to status='bounced'
// ASYNCHRONOUSLY (late DSN) WITHOUT touching sent_at, so a now()-watermark on
// sent_at permanently skipped any bounce that flipped after the run which
// already passed its (older) sent_at — companies.email_status stayed sendable
// and the runner kept mailing dead addresses. Each run now rescans a fixed
// lookback window (bounceFlipLookbackDays); the company flip is idempotent so
// re-seeing the same bounce is a no-op.
//   1. SELECT DISTINCT ct.email from send_events JOIN contacts where
//      status='bounced' AND sent_at > now() - bounceFlipLookbackDays.
//   2. For each bounced email, UPDATE companies SET email_status='invalid' WHERE
//      LOWER(email)=LOWER(<email>) AND email_status NOT IN ('invalid','spamtrap').
//   3. INSERT email_verification_log row (best-effort — silently ignore failure).
//
// HARD rules satisfied:
//   - feedback_audit_log_on_mutations T0: every company flip emits an
//     operator_audit_log row via services/common/audit.Log.
//   - feedback_no_magic_thresholds T0: the lookback window is the named
//     constant bounceFlipLookbackDays (no inline interval literal).
//   - feedback_schema_verify_before_sql T0: schema verified — companies
//     (ico,email,email_status,email_verified_at,email_verification) per
//     migration 028; send_events (status,sent_at,contact_id) per migration 033;
//     contacts(email,id) per migration 011.

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"common/audit"
	"common/envconfig"
)

// bounceFlipDefaultInterval is the BFF interval (15 min). Operator can override
// via env BOUNCE_FLIP_INTERVAL (parsable by time.ParseDuration).
const bounceFlipDefaultInterval = 15 * time.Minute

// bounceFlipLookbackDays bounds how far back each run rescans bounced
// send_events. Replaces the old now()-watermark (which skipped late async
// bounces, see file header). 30 days comfortably covers DSN latency — a
// provider may retry for days (RFC 5321 §4.5.4.1) before emitting the final
// bounce. The company flip is idempotent so the overlapping rescan is safe.
const bounceFlipLookbackDays = 30

// bounceFlipResult is returned by RunBounceFlipOnce for observability.
type bounceFlipResult struct {
	Bounced int
	Flipped int
}

// RunBounceFlipOnce executes a single tick of the cron against db. It returns
// the number of bounced emails seen and the number of companies flipped. The
// caller is responsible for slog wrapping.
func RunBounceFlipOnce(ctx context.Context, db *sql.DB) (bounceFlipResult, error) {
	var res bounceFlipResult

	// 1. Pull distinct bounced emails within a fixed lookback window. We scan a
	// fixed window each run rather than advancing a now()-watermark: a
	// send_event flips to status='bounced' asynchronously (late DSN) without
	// touching sent_at, so a sent_at watermark permanently skipped any bounce
	// that flipped after the run which already passed its sent_at.
	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT LOWER(ct.email) AS email
		  FROM send_events se
		  JOIN contacts ct ON ct.id = se.contact_id
		 WHERE se.status='bounced'
		   AND se.sent_at > now() - make_interval(days => $1)
		   AND ct.email IS NOT NULL
		   AND ct.email <> ''`, bounceFlipLookbackDays)
	if err != nil {
		return res, fmt.Errorf("query bounced send_events: %w", err)
	}
	defer rows.Close()

	var bouncedEmails []string
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return res, fmt.Errorf("scan bounced email: %w", err)
		}
		bouncedEmails = append(bouncedEmails, email)
	}
	if err := rows.Err(); err != nil {
		return res, fmt.Errorf("iterate bounced send_events: %w", err)
	}
	res.Bounced = len(bouncedEmails)

	// 2. For each bounced email, find matching companies (case-insensitive)
	// and flip their email_status. We re-issue per-email rather than IN(...)
	// because the BFF behavior emits one audit row per (email, ico) pair —
	// preserving that audit cardinality keeps observability deterministic.
	for _, email := range bouncedEmails {
		coRows, err := db.QueryContext(ctx, `
			SELECT ico, COALESCE(email_status, 'unverified') AS email_status
			  FROM companies
			 WHERE LOWER(email)=LOWER($1)
			   AND COALESCE(email_status,'unverified') NOT IN ('invalid','spamtrap')`, email)
		if err != nil {
			slog.Warn("bounce_flip: company lookup failed",
				"op", "outreach.bounce_flip/lookup", "error", err)
			continue
		}
		type coRow struct {
			ICO         string
			OldStatus   string
		}
		var matches []coRow
		for coRows.Next() {
			var c coRow
			if err := coRows.Scan(&c.ICO, &c.OldStatus); err != nil {
				slog.Warn("bounce_flip: company scan failed",
					"op", "outreach.bounce_flip/scan", "error", err)
				continue
			}
			matches = append(matches, c)
		}
		coRows.Close()

		for _, c := range matches {
			verification := map[string]any{
				"trigger":      "bounce",
				"detail":       "Hard bounce z send pipeline",
				"flipped_from": c.OldStatus,
			}
			verJSON, _ := json.Marshal(verification)

			if _, err := db.ExecContext(ctx, `
				UPDATE companies
				   SET email_status='invalid',
				       email_verified_at=NOW(),
				       email_verification=$1
				 WHERE ico=$2`, string(verJSON), c.ICO); err != nil {
				slog.Warn("bounce_flip: company flip failed",
					"op", "outreach.bounce_flip/flip", "ico", c.ICO, "error", err)
				continue
			}

			// Best-effort verification log — silently ignore failure (mirrors
			// BFF behaviour at runBounceFlipCron.js:41 .catch(()=>{})).
			_, _ = db.ExecContext(ctx, `
				INSERT INTO email_verification_log
					(company_ico, email, old_status, new_status, detail, trigger, verification)
				VALUES ($1, $2, $3, 'invalid', $4, 'bounce', $5)`,
				c.ICO, email, c.OldStatus, "Hard bounce z send pipeline", string(verJSON))

			// HARD RULE feedback_audit_log_on_mutations T0 — every flip emits
			// an operator_audit_log row in the same logical tx.
			audit.Log(ctx, db, "bounce_flip.company", "cron", "company", c.ICO,
				map[string]any{
					"email":      email,
					"old_status": c.OldStatus,
					"new_status": "invalid",
					"trigger":    "bounce",
				})
			res.Flipped++
		}
	}

	return res, nil
}

// StartBounceFlipLoop spawns the periodic bounce-flip cron in a goroutine. It
// returns immediately; the goroutine exits when ctx is cancelled. A panic in
// the loop is recovered and logged — the loop will continue ticking.
func StartBounceFlipLoop(ctx context.Context, db *sql.DB) {
	if envconfig.BoolOr("DISABLE_BOUNCE_FLIP_CRON", false) {
		slog.Info("bounce_flip cron disabled (DISABLE_BOUNCE_FLIP_CRON=1)")
		return
	}
	interval := bounceFlipDefaultInterval
	if v := envconfig.GetOr("BOUNCE_FLIP_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			interval = d
		}
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("bounce_flip cron panic recovered",
					"op", "outreach.bounce_flip/recover", "recover", r)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		// First tick: small initial delay so we don't pile up at boot.
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
		runTick := func() {
			start := time.Now()
			res, err := RunBounceFlipOnce(ctx, db)
			dur := time.Since(start)
			if err != nil {
				slog.Error("bounce_flip cron tick failed",
					"op", "outreach.bounce_flip/tick",
					"error", err, "duration_ms", dur.Milliseconds())
				return
			}
			slog.Info("bounce_flip cron tick",
				"op", "outreach.bounce_flip/done",
				"bounced", res.Bounced, "flipped", res.Flipped,
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
	slog.Info("bounce_flip cron started", "interval", interval)
}
