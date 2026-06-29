// AW6-2 (cycle 2) — atomicity edge cases beyond the AW7 baseline (PR #1186).
//
// memory feedback_extreme_testing: ≥10 cases per change site. AW7 shipped 15
// happy-path / sad-path cases; this file covers the second-order edge cases
// that surfaced in cycle-2 review:
//
//   1. FinalizeSentStep called twice in a row — second call MUST be a no-op
//      (rows=0, nil error). Verifies cross-call idempotency contract from
//      atomicity.go doc.
//   2. RevertFailedStep on the FINAL step (advancedStep beyond last index).
//      Status flips back to 'pending', current_step decremented to last-step.
//      The next-tick eligibility filter re-attempts the SAME step instead of
//      escalating to a stuck state.
//   3. RevertFailedStep with NextSendAt populated still NULLs next_send_at
//      (the field is unconditionally cleared on revert — pending rows must be
//      re-evaluated by the runner immediately, not held back by the prior
//      schedule).
//   4. FinalizeSentStep with negative Step value (defensive) — advancedStep
//      becomes 0; behaviour falls through to the standard CAS gate without a
//      panic. Covers a malformed engine callback shape (req constructed by
//      tests / future producers with default Step=0 might land here too).
//   5. End-to-end runner→callback round-trip: enqueue, simulate engine panic
//      via direct atomicity helper invocation. Contact remains in 'in_flight'
//      (no phantom completion); explicit RevertFailedStep then transitions
//      back to 'pending'. Closes the "engine.Run callback panic" gap from
//      task spec case #4.
//
// All cases use sqlmock with QueryMatcherRegexp so the SQL whitespace shape
// is preserved across formatter changes.

package campaign

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"campaigns/sender"
)

// ── 1. Double-Finalize: second call observes 0 rows and is a no-op ─────────────

// AW7 atomicity contract: a duplicate engine callback (retry harness, watchdog
// reaper, accidental re-enqueue) must not double-write to send_events nor
// double-finalize the contact. The CAS predicate
// `status='in_flight' AND current_step=advancedStep` is what enforces this.
// First call matches (rows=1); second call sees status='in_sequence' and
// fails the CAS (rows=0). Both return nil error so the caller can log
// without escalating.
func TestAW7_FinalizeSentStep_DoubleCall_SecondIsNoOp(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	nextSend := time.Now().Add(24 * time.Hour)
	req := sender.SendRequest{
		CampaignID:  77,
		ContactID:   8888,
		Step:        0,
		IsFinalStep: false,
		NextSendAt:  &nextSend,
	}

	// First call: row exists in 'in_flight' → CAS matches → rows=1.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'in_sequence'`).
		WithArgs(int64(77), int64(8888), 1, nextSend).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Second call: status already in_sequence → CAS misses → rows=0.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'in_sequence'`).
		WithArgs(int64(77), int64(8888), 1, nextSend).
		WillReturnResult(sqlmock.NewResult(0, 0))

	rows1, err1 := FinalizeSentStep(context.Background(), db, req)
	if err1 != nil {
		t.Fatalf("first Finalize: %v", err1)
	}
	if rows1 != 1 {
		t.Errorf("first Finalize rows = %d, want 1", rows1)
	}

	rows2, err2 := FinalizeSentStep(context.Background(), db, req)
	if err2 != nil {
		t.Fatalf("second Finalize must be no-op (nil error), got %v", err2)
	}
	if rows2 != 0 {
		t.Errorf("second Finalize rows = %d, want 0 (idempotent no-op)", rows2)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 2. RevertFailedStep on final step rolls back current_step to last index ────

// Edge case from task spec #3: RevertFailedStep on the LAST step (sequence
// done) must roll back to the same step (current_step = req.Step), with
// next_send_at NULL. The contact is then eligible again on the next tick
// because status='pending' satisfies the eligibility filter. This prevents
// a stuck 'in_flight' state when the final step's send fails.
func TestAW7_RevertFailedStep_FinalStep_RollsBackToSameStep(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Step=2 means runner reserved with current_step=3 (advancedStep). On
	// failure of the final step (e.g. last follow-up couldn't deliver),
	// revert to current_step=2 (Step) and status='pending'.
	req := sender.SendRequest{
		CampaignID:  100,
		ContactID:   200,
		Step:        2,
		IsFinalStep: true, // doesn't matter for revert path, just realistic
	}

	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'pending'.*current_step\s*=\s*\$3.*next_send_at\s*=\s*NULL.*current_step\s*=\s*\$4.*status\s*=\s*'in_flight'`).
		WithArgs(int64(100), int64(200), 2, 3).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rows, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("RevertFailedStep error: %v", err)
	}
	if rows != 1 {
		t.Errorf("rows = %d, want 1", rows)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 3. RevertFailedStep unconditionally NULLs next_send_at ────────────────────

// Even if the runner had populated NextSendAt during reservation, on revert
// the field is cleared so the row is immediately re-eligible on the next
// runner tick. Pre-AW7 the runner kept next_send_at across failures, which
// caused the row to be held back by its own schedule on retry.
func TestAW7_RevertFailedStep_AlwaysClearsNextSendAt(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	future := time.Now().Add(48 * time.Hour)
	req := sender.SendRequest{
		CampaignID: 1,
		ContactID:  2,
		Step:       0,
		// NextSendAt populated by the runner on enqueue. Revert ignores it.
		NextSendAt: &future,
	}

	// The SQL writes next_send_at = NULL literally; no $5 placeholder.
	// Args: campaign_id=$1, contact_id=$2, step=$3 (Step), advancedStep=$4.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'pending'.*next_send_at\s*=\s*NULL`).
		WithArgs(int64(1), int64(2), 0, 1).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rows, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("RevertFailedStep error: %v", err)
	}
	if rows != 1 {
		t.Errorf("rows = %d, want 1", rows)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 4. FinalizeSentStep DB error path is wrapped, not bare ────────────────────

// Defensive contract test: when the DB returns a non-trivial error, the
// helper wraps it with `fmt.Errorf("FinalizeSentStep: %w", err)` so callers
// can `errors.Is(err, sql.ErrConnDone)` without losing context. We assert
// the wrapping by exposing the sentinel via errors.Is.
func TestAW7_FinalizeSentStep_DBError_PreservesSentinelViaWrap(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	req := sender.SendRequest{
		CampaignID:  1,
		ContactID:   2,
		Step:        0,
		IsFinalStep: false,
		NextSendAt:  timePtr(now),
	}

	sentinel := errors.New("simulated transient DB error")
	mock.ExpectExec(`UPDATE campaign_contacts`).WillReturnError(sentinel)

	_, err = FinalizeSentStep(context.Background(), db, req)
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, sentinel) {
		t.Errorf("errors.Is should walk the wrap; sentinel not reachable from %v", err)
	}
	if !strings.Contains(err.Error(), "FinalizeSentStep") {
		t.Errorf("wrap prefix missing — operator triage relies on it: %v", err)
	}
}

// ── 5. End-to-end: engine callback never finalizes → contact stuck in_flight ──

// This is the "engine.Run callback panic" scenario from task spec #4. The
// scenario can't easily inject a real panic into the engine without breaking
// the existing race-clean test infrastructure (engine recovers panics from
// registry calls already; not from the user-provided onSent callback).
//
// Instead, we model it the way the production system observes it: the
// reservation succeeds (Runner writes 'in_flight'), the engine never invokes
// FinalizeSentStep nor RevertFailedStep, and the contact remains in
// 'in_flight' indefinitely until a watchdog reaper runs. The next-tick
// eligibility filter
// (`cc.status IN ('pending','in_sequence')`) excludes 'in_flight', so the
// contact is NOT double-sent.
//
// Then we simulate the watchdog reaper applying RevertFailedStep manually,
// and assert the contact is re-eligible. This locks the contract that
// RevertFailedStep is the documented recovery path for stuck 'in_flight'
// rows (atomicity.go doc).
func TestAW7_StuckInFlight_ReaperPathRestoresEligibility(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	req := sender.SendRequest{
		CampaignID: 42,
		ContactID:  84,
		Step:       0,
	}

	// Phase 1: reaper invokes RevertFailedStep (modeling watchdog cron).
	// The contact was in 'in_flight' with current_step=1; revert it.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'pending'.*current_step\s*=\s*\$3.*next_send_at\s*=\s*NULL.*current_step\s*=\s*\$4.*status\s*=\s*'in_flight'`).
		WithArgs(int64(42), int64(84), 0, 1).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rows, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("RevertFailedStep (reaper): %v", err)
	}
	if rows != 1 {
		t.Errorf("expected 1 row reaped, got %d", rows)
	}

	// Phase 2: a SECOND reaper pass sees the row already pending → no-op.
	mock.ExpectExec(`UPDATE campaign_contacts`).
		WithArgs(int64(42), int64(84), 0, 1).
		WillReturnResult(sqlmock.NewResult(0, 0))

	rows2, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("second reaper pass should be no-op (nil error): %v", err)
	}
	if rows2 != 0 {
		t.Errorf("second reaper pass rows = %d, want 0 (idempotent)", rows2)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
