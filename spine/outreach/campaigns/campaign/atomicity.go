// AW7 — runner-engine state atomicity helpers (issue #1182).
//
// These helpers run in the engine's onSent callback (one per dispatched
// SendRequest) and finalize the contact's per-step state ONLY after a
// confirmed send_events INSERT (success branch) or revert it on a confirmed
// failure. The split closes the phantom-completed window introduced by the
// runner advancing status='in_sequence'/'completed' before the async engine
// actually delivered.
//
// Pre-conditions (set by Runner.RunCampaign):
//   - The campaign_contact has been reserved with status='in_flight' and
//     current_step=Step+1 (the post-send step).
//   - SendRequest.Step is the step that just got attempted (the OLD step
//     before reservation).
//   - SendRequest.NextSendAt and IsFinalStep capture the runner's view of
//     the sequence configuration at enqueue time.
//
// Post-conditions:
//   - FinalizeSentStep: status flips in_flight -> in_sequence (or completed
//     when IsFinalStep). next_send_at is re-asserted for clarity.
//   - RevertFailedStep: status flips in_flight -> pending and current_step
//     is rolled back to Step (so the next tick re-attempts the same step).
//
// Both helpers gate on `status='in_flight' AND current_step=Step+1` so
// they are idempotent: a duplicate callback invocation (engine quirk,
// retry harness, watchdog reaper) cannot double-finalize, double-revert,
// or stomp a contact whose state has already been moved by another path.

package campaign

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"campaigns/sender"
)

// FinalizeSentStep transitions a reserved contact from in_flight to its
// next stable state (in_sequence or completed) after a confirmed
// send_events INSERT. The CAS predicate
// `status='in_flight' AND current_step = $advancedStep` makes the helper
// idempotent: if another path (concurrent callback, watchdog reaper)
// already finalized the row, RowsAffected=0 and we return rows=0
// without error so the caller can log without escalating.
//
// advancedStep is the post-reservation current_step (req.Step + 1). We
// pass it explicitly rather than reading from the row to avoid a
// read-modify-write race against the watchdog or operator manual edits.
func FinalizeSentStep(ctx context.Context, db DB, req sender.SendRequest) (int64, error) {
	if db == nil {
		return 0, fmt.Errorf("FinalizeSentStep: db is nil")
	}
	advancedStep := req.Step + 1
	var (
		query string
		args  []any
	)
	if req.IsFinalStep {
		query = `UPDATE campaign_contacts
		            SET status = 'completed'
		          WHERE campaign_id = $1
		            AND contact_id  = $2
		            AND current_step = $3
		            AND status      = 'in_flight'`
		args = []any{req.CampaignID, req.ContactID, advancedStep}
	} else {
		// next_send_at re-assertion: the runner already wrote it during
		// reservation, but writing again ensures the value matches the
		// sequence config the runner saw at enqueue (defensive: if the
		// row was edited mid-flight by an operator, the sender's view
		// wins because the send already left).
		var nextSendAt time.Time
		if req.NextSendAt != nil {
			nextSendAt = *req.NextSendAt
		}
		query = `UPDATE campaign_contacts
		            SET status       = 'in_sequence',
		                next_send_at = $4
		          WHERE campaign_id = $1
		            AND contact_id  = $2
		            AND current_step = $3
		            AND status      = 'in_flight'`
		args = []any{req.CampaignID, req.ContactID, advancedStep, nextSendAt}
	}
	res, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("FinalizeSentStep: %w", err)
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		// Idempotency observability: nothing was finalized. Most likely
		// causes: (1) the runner's reservation never ran (test setup),
		// (2) another callback already finalized this row, (3) operator
		// edited the contact mid-flight. None of these should escalate
		// because the send already happened — drop a debug-friendly
		// log so ops can correlate later.
		slog.Info("FinalizeSentStep matched 0 rows (idempotent no-op)",
			"op", "campaign.FinalizeSentStep/zeroRows",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"advanced_step", advancedStep,
			"is_final_step", req.IsFinalStep)
	}
	return rows, nil
}

// BulkRevertInFlight rolls back EVERY contact left in `status='in_flight'`
// state regardless of campaign or step. This is the panic-safe escape valve
// for AW7-4: if the engine.Run goroutine itself panics — not a single
// callback, but the Run loop or a layer underneath (anti-trace dial, header
// builder, mailbox picker) — every contact the runner reserved before the
// crash would otherwise stay `in_flight` forever, blocked by the next-tick
// eligibility filter (`cc.status IN ('pending','in_sequence')`).
//
// The query flips status -> 'pending' and decrements current_step by 1 so
// the next runner tick re-evaluates the SAME step the panic interrupted.
// `current_step > 0` guards against rolling step 0 below zero (a contact
// reserved at fresh-enrollment has current_step=1 so the decrement lands on
// the original step 0).
//
// Returns the number of rows reverted so callers can audit-log the blast
// radius. Empty fleet (rows=0) returns nil error — common during normal
// operation when the panic happens before any reservation.
//
// Idempotent: only `in_flight` rows are touched; a second call after the
// first succeeded is a no-op.
func BulkRevertInFlight(ctx context.Context, db DB) (int64, error) {
	if db == nil {
		return 0, fmt.Errorf("BulkRevertInFlight: db is nil")
	}
	res, err := db.ExecContext(ctx,
		`UPDATE campaign_contacts
		    SET status       = 'pending',
		        current_step = current_step - 1,
		        next_send_at = NULL
		  WHERE status      = 'in_flight'
		    AND current_step > 0`,
	)
	if err != nil {
		return 0, fmt.Errorf("BulkRevertInFlight: %w", err)
	}
	rows, _ := res.RowsAffected()
	if rows > 0 {
		slog.Warn("BulkRevertInFlight reverted stuck contacts after engine panic",
			"op", "campaign.BulkRevertInFlight/recovery",
			"reverted", rows)
	}
	return rows, nil
}

// RevertFailedStep rolls back a reserved contact when the engine reports a
// permanent failure. Status flips in_flight -> pending and current_step
// is decremented from req.Step+1 back to req.Step so the next tick
// re-evaluates the SAME step.
//
// We deliberately do NOT advance to a "failed" status: a failure here is
// per-attempt (SMTP 4xx/5xx, connection blip, breaker open), not
// per-contact. Persistent failures are caught by the per-mailbox /
// per-domain breakers in the engine itself — those layers prevent the
// same contact from being retried into oblivion.
//
// CAS predicate gates on advancedStep (=req.Step+1) so a duplicate
// revert is a no-op. RowsAffected=0 is logged but not escalated.
func RevertFailedStep(ctx context.Context, db DB, req sender.SendRequest) (int64, error) {
	if db == nil {
		return 0, fmt.Errorf("RevertFailedStep: db is nil")
	}
	advancedStep := req.Step + 1
	res, err := db.ExecContext(ctx,
		`UPDATE campaign_contacts
		    SET status       = 'pending',
		        current_step = $3,
		        next_send_at = NULL
		  WHERE campaign_id = $1
		    AND contact_id  = $2
		    AND current_step = $4
		    AND status      = 'in_flight'`,
		req.CampaignID, req.ContactID, req.Step, advancedStep,
	)
	if err != nil {
		return 0, fmt.Errorf("RevertFailedStep: %w", err)
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		slog.Info("RevertFailedStep matched 0 rows (idempotent no-op)",
			"op", "campaign.RevertFailedStep/zeroRows",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"step", req.Step)
	}
	return rows, nil
}
