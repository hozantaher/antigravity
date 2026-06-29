// AW7-3 — watchdog reaper for stuck campaign_contacts.status='in_flight'
// rows (issue #1182 follow-up; AW7 atomicity gap identified in PR #1194).
//
// AW7 split runner-engine state ownership: Runner.RunCampaign reserves a
// contact with status='in_flight', the engine's onSent callback finalizes
// to 'in_sequence'/'completed' (success) or reverts to 'pending' (fail).
// If the engine never invokes the callback (process crash mid-send,
// panic in engine.Run, network hang, container OOM-kill, abrupt shutdown
// before the queue drains), the row stays 'in_flight' forever — the
// next-tick eligibility filter (`status IN ('pending', 'in_sequence')`)
// excludes it, so it never re-enters the pipeline. The contact becomes
// dark inventory.
//
// This reaper sweeps stuck rows back to 'pending' so the next tick picks
// them up. Threshold default is 24h, override via
// IN_FLIGHT_STUCK_THRESHOLD_HOURS. The CAS predicate `status='in_flight'`
// makes the UPDATE idempotent across concurrent reaper invocations.
//
// Scope notes:
//   - Reaper does NOT touch send_events. If the engine partially delivered
//     (SMTP 250 received but callback dropped), the operator will see a
//     duplicate send on the next tick. This is acceptable: AW7's design
//     premise is that 'in_flight' without callback is rarer than the
//     phantom-completed bug it closes. Recipients seeing 1.5 mails per
//     step is a smaller blast radius than 0 mails per step.
//   - One audit log row per reaped contact (action='in_flight_reaped',
//     entity_type='campaign_contact', entity_id=cc_id, details captures
//     campaign_id + contact_id + stuck_for_hours). Operators query
//     operator_audit_log to attribute traffic blips.
//   - 1h cron tick is conservative — at 24h threshold there's no race
//     pressure to react faster.

package campaign

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"campaigns/sender"
	"common/audit"
	"common/envconfig"
)

// DefaultInFlightStuckThreshold is the age above which an 'in_flight'
// row is considered stuck. The 24h figure is conservative — production
// sends complete within seconds; the only scenarios producing >1h
// duration are full-process death between Enqueue and callback. 24h
// gives operators a full business day to triage a deploy-time hang
// without the reaper papering over the symptom.
const DefaultInFlightStuckThreshold = 24 * time.Hour

// inFlightReaperActor is the value written to operator_audit_log.actor
// for reaper-emitted rows. Distinct from "cli" / human operators so
// operators can filter daemon-driven cleanups.
const inFlightReaperActor = "watchdog_reaper"

// stuckCandidate captures the minimum fields the reaper needs to emit
// one audit row per reaped contact. Selected pre-UPDATE so we can join
// the row's pre-reap state into the audit details payload.
type stuckCandidate struct {
	id         int64
	campaignID int64
	contactID  int64
	createdAt  time.Time
}

// InFlightReaper sweeps stuck 'in_flight' rows back to 'pending' so the
// next tick re-picks them. Constructed once at boot, Run() is invoked
// per cron tick. Constructor accepts a *sql.DB rather than the campaign
// DB interface because the reaper opens its own logical "transaction"
// scope (SELECT then UPDATE) and needs concrete *sql.DB for audit.Log's
// Execer interface. Tests pass sqlmock-wrapped *sql.DB so the contract
// is observable.
type InFlightReaper struct {
	db        *sql.DB
	threshold time.Duration
}

// NewInFlightReaper creates a reaper with the threshold loaded from
// env (IN_FLIGHT_STUCK_THRESHOLD_HOURS, integer hours; falls back to
// 24h on missing/invalid). The threshold is fixed at construction —
// changing the env var requires a restart, which is fine because this
// is a daemon-level knob, not a per-tick decision.
func NewInFlightReaper(db *sql.DB) *InFlightReaper {
	return &InFlightReaper{
		db:        db,
		threshold: loadStuckThreshold(),
	}
}

// NewInFlightReaperWithThreshold is the constructor used by tests so
// they can pin the threshold without touching env. Production code
// should use NewInFlightReaper; this variant exists to keep test
// mocks free of os.Setenv side-effects.
func NewInFlightReaperWithThreshold(db *sql.DB, threshold time.Duration) *InFlightReaper {
	return &InFlightReaper{db: db, threshold: threshold}
}

// loadStuckThreshold reads IN_FLIGHT_STUCK_THRESHOLD_HOURS via the
// canonical envconfig.GetOr API. Invalid integers (negative, garbage
// strings, "0") fall back to the default — operators cannot accidentally
// disable the reaper by mistyping the value.
func loadStuckThreshold() time.Duration {
	raw := envconfig.GetOr("IN_FLIGHT_STUCK_THRESHOLD_HOURS", "")
	if raw == "" {
		return DefaultInFlightStuckThreshold
	}
	hours, err := strconv.Atoi(raw)
	if err != nil || hours <= 0 {
		slog.Warn("IN_FLIGHT_STUCK_THRESHOLD_HOURS invalid — using default",
			"op", "campaign.InFlightReaper.loadThreshold/parse",
			"raw", raw,
			"default_hours", int(DefaultInFlightStuckThreshold/time.Hour),
		)
		return DefaultInFlightStuckThreshold
	}
	return time.Duration(hours) * time.Hour
}

// Threshold returns the configured stuck threshold (test introspection).
func (r *InFlightReaper) Threshold() time.Duration { return r.threshold }

// Run executes a single reaper sweep:
//  1. SELECT candidate rows older than threshold (campaign_id +
//     contact_id + cc_id + created_at).
//  2. UPDATE matched rows back to status='pending', current_step rolled
//     back by one (clamped at 0), next_send_at=NULL — CAS gated on
//     status='in_flight' so a concurrent reaper or a late callback cannot
//     double-reap.
//  3. INSERT one audit log row per actually-reaped contact via the
//     shared audit.Log helper.
//
// Returns (reapedCount, err). reapedCount is the number of rows
// matched by the SELECT (the count CAS-gated UPDATE actually flipped
// may be smaller if a concurrent path won the race). err is non-nil
// only on DB-level failures; an empty SELECT is success.
func (r *InFlightReaper) Run(ctx context.Context) (int, error) {
	if r.db == nil {
		return 0, fmt.Errorf("InFlightReaper.Run: db is nil")
	}

	cutoff := time.Now().Add(-r.threshold)

	// Step 1: enumerate candidates. We could fold SELECT + UPDATE into
	// a single UPDATE ... RETURNING clause, but we want the pre-reap
	// created_at for the audit details (stuck_for_hours), and
	// PostgreSQL UPDATE...RETURNING gives the post-update row only
	// for explicit columns. Two-step is simpler and the candidate set
	// is bounded (< a few hundred even on 100k-contact campaigns).
	candidates, err := r.selectStuckCandidates(ctx, cutoff)
	if err != nil {
		return 0, fmt.Errorf("InFlightReaper.Run: %w", err)
	}
	if len(candidates) == 0 {
		return 0, nil
	}

	reaped := 0
	for _, c := range candidates {
		ok, err := r.reapOne(ctx, c)
		if err != nil {
			// Per-row failure is not fatal — log and continue with
			// the next candidate. A persistent failure mode (e.g.
			// schema drift) will surface via repeated warnings.
			slog.Warn("InFlightReaper: per-row reap failed",
				"op", "campaign.InFlightReaper.Run/reapOne",
				"campaign_contact_id", c.id,
				"campaign_id", c.campaignID,
				"contact_id", c.contactID,
				"error", err,
			)
			continue
		}
		if !ok {
			// CAS lost — another path (callback, concurrent reaper)
			// already finalized this row. Skip, no audit row.
			continue
		}
		reaped++
		// Couple the send-claim ledger (migration 171): a contact reset
		// from a stuck in_flight lease must also have its 'claiming'
		// send-claim expired, else the stale claim blocks the next send
		// attempt forever. Best-effort — a failure here just delays
		// re-claim until the next sweep.
		if _, cerr := sender.ExpireClaimForContact(ctx, r.db, c.campaignID, c.contactID); cerr != nil {
			slog.Warn("InFlightReaper: expire send-claim failed",
				"op", "campaign.InFlightReaper.Run/expireClaim",
				"campaign_id", c.campaignID,
				"contact_id", c.contactID,
				"error", cerr)
		}
		// Audit row records the reap. audit.Log swallows DB errors
		// internally so a failed audit insert does not block the
		// reap loop — observability over correctness here.
		stuckFor := time.Since(c.createdAt)
		audit.Log(ctx, r.db,
			"in_flight_reaped",
			inFlightReaperActor,
			"campaign_contact",
			strconv.FormatInt(c.id, 10),
			map[string]any{
				"reason":          "stuck_in_flight_past_threshold",
				"campaign_id":     c.campaignID,
				"contact_id":      c.contactID,
				"stuck_for_hours": stuckFor.Hours(),
				"threshold_hours": r.threshold.Hours(),
			},
		)
	}

	if reaped > 0 {
		slog.Info("InFlightReaper sweep complete",
			"op", "campaign.InFlightReaper.Run/done",
			"candidates", len(candidates),
			"reaped", reaped,
			"threshold_hours", r.threshold.Hours(),
		)
	}

	return reaped, nil
}

// selectStuckCandidates returns the set of campaign_contacts rows whose
// status='in_flight' AND updated_at < cutoff. Bounded by a defensive
// LIMIT so a single tick cannot pull millions of rows into memory if
// the threshold was misconfigured.
//
// Filters on updated_at (the LEASE timestamp, stamped by the runner's
// reservation UPDATE) — NOT created_at (row/enrollment age). created_at was a
// bug: every in_flight row on an old enrollment looked "stuck" regardless of
// how long the lease was actually held, while a genuinely stuck lease on a
// freshly-enrolled row was missed. updated_at = "how long has this lease been
// open" is the correct stuck signal (incident 2026-06-24).
func (r *InFlightReaper) selectStuckCandidates(ctx context.Context, cutoff time.Time) ([]stuckCandidate, error) {
	const stuckCandidateLimit = 1000
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, campaign_id, contact_id, updated_at
		   FROM campaign_contacts
		  WHERE status = 'in_flight'
		    AND updated_at < $1
		  ORDER BY updated_at ASC
		  LIMIT $2`,
		cutoff, stuckCandidateLimit,
	)
	if err != nil {
		return nil, fmt.Errorf("selectStuckCandidates: %w", err)
	}
	defer rows.Close()

	var out []stuckCandidate
	for rows.Next() {
		var c stuckCandidate
		if err := rows.Scan(&c.id, &c.campaignID, &c.contactID, &c.createdAt); err != nil {
			return nil, fmt.Errorf("selectStuckCandidates scan: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("selectStuckCandidates rows: %w", err)
	}
	return out, nil
}

// reapOne flips one stuck row back to pending. Returns (true, nil) if
// the CAS won (RowsAffected=1), (false, nil) if another path already
// transitioned the row (RowsAffected=0), or (false, err) on a DB error.
//
// Resets:
//   - status='pending'
//   - current_step = GREATEST(current_step - 1, 0)  — roll back the single
//     interrupted step (clamped at 0), matching BulkRevertInFlight. The runner
//     reserves a contact with current_step advanced to step+1, so decrementing
//     by one re-points the next tick at the SAME step whose send was
//     interrupted. Resetting to a flat 0 (the prior behaviour) would replay the
//     ENTIRE sequence from the initial mail — a duplicate-send hazard for any
//     contact reaped past step 0.
//   - next_send_at=NULL  (re-eligible immediately on next tick)
func (r *InFlightReaper) reapOne(ctx context.Context, c stuckCandidate) (bool, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE campaign_contacts
		    SET status       = 'pending',
		        current_step = GREATEST(current_step - 1, 0),
		        next_send_at = NULL
		  WHERE id     = $1
		    AND status = 'in_flight'`,
		c.id,
	)
	if err != nil {
		return false, fmt.Errorf("reapOne UPDATE: %w", err)
	}
	rows, _ := res.RowsAffected()
	return rows > 0, nil
}
