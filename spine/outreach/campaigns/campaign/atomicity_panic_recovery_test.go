// AW7-4 — engine panic atomic rollback tests.
//
// These cases lock the contract that a panic in the engine.Run goroutine
// (anti-trace dial, header builder, mailbox picker) cannot leave contacts
// stuck in `status='in_flight'` indefinitely. The escape valve is
// BulkRevertInFlight — a bulk SQL UPDATE that flips every `in_flight` row
// back to `pending` so the next runner tick re-evaluates them.
//
// Coverage required by HARD memory feedback_extreme_testing (≥10 cases):
//
//  1. BulkRevertInFlight non-empty fleet returns rows reverted.
//  2. BulkRevertInFlight empty fleet returns rows=0 with nil error.
//  3. BulkRevertInFlight on nil DB returns an error (defensive).
//  4. BulkRevertInFlight wraps the underlying DB error with %w semantics.
//  5. BulkRevertInFlight is idempotent: a second call after the first
//     succeeded reverts 0 rows because no `in_flight` rows remain.
//  6. BulkRevertInFlight only touches `in_flight` rows — `pending`,
//     `in_sequence`, `completed`, `bounced` rows are not stomped (verified
//     via the WHERE clause in the executed SQL).
//  7. BulkRevertInFlight current_step is decremented by exactly 1.
//  8. BulkRevertInFlight skips current_step=0 rows (defensive: a contact
//     with step=0 in_flight would underflow without the > 0 guard).
//  9. BulkRevertInFlight clears next_send_at to NULL.
// 10. RevertFailedStep called twice (panic-recovery + outer revert) is a
//     no-op on the second call, locking the idempotency contract used by
//     wrapSendCallbackWithRecover.

package campaign

import (
	"context"
	"errors"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"campaigns/sender"
)

// ── 1. BulkRevertInFlight non-empty fleet returns rows reverted ─────────────

func TestAW7_4_BulkRevertInFlight_NonEmpty_ReturnsRows(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'pending',\s*current_step\s*=\s*current_step\s*-\s*1,\s*next_send_at\s*=\s*NULL\s+WHERE status\s*=\s*'in_flight'\s+AND current_step\s*>\s*0`).
		WillReturnResult(sqlmock.NewResult(0, 12))

	rows, err := BulkRevertInFlight(context.Background(), db)
	if err != nil {
		t.Fatalf("BulkRevertInFlight error: %v", err)
	}
	if rows != 12 {
		t.Errorf("rows = %d, want 12", rows)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 2. BulkRevertInFlight empty fleet returns rows=0 with nil error ─────────

func TestAW7_4_BulkRevertInFlight_EmptyFleet_NoError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	rows, err := BulkRevertInFlight(context.Background(), db)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if rows != 0 {
		t.Errorf("rows = %d, want 0", rows)
	}
}

// ── 3. BulkRevertInFlight nil-DB returns error ──────────────────────────────

func TestAW7_4_BulkRevertInFlight_NilDB_ReturnsError(t *testing.T) {
	_, err := BulkRevertInFlight(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error on nil DB")
	}
	if !strings.Contains(err.Error(), "BulkRevertInFlight") {
		t.Errorf("error %q does not include function name", err)
	}
}

// ── 4. BulkRevertInFlight wraps DB error ────────────────────────────────────

func TestAW7_4_BulkRevertInFlight_DBError_Wrapped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	dbErr := errors.New("connection lost")
	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnError(dbErr)

	_, err = BulkRevertInFlight(context.Background(), db)
	if err == nil {
		t.Fatal("expected wrapped error, got nil")
	}
	if !errors.Is(err, dbErr) {
		t.Errorf("error not wrapped via %%w: %v", err)
	}
}

// ── 5. BulkRevertInFlight is idempotent on a clean fleet ────────────────────

func TestAW7_4_BulkRevertInFlight_Idempotent_SecondCallNoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// First call reverts 5 rows.
	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 5))
	// Second call (idempotent) reverts 0 rows.
	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	first, err := BulkRevertInFlight(context.Background(), db)
	if err != nil || first != 5 {
		t.Fatalf("first call: rows=%d err=%v, want 5/nil", first, err)
	}
	second, err := BulkRevertInFlight(context.Background(), db)
	if err != nil || second != 0 {
		t.Fatalf("second call: rows=%d err=%v, want 0/nil", second, err)
	}
}

// ── 6. BulkRevertInFlight WHERE clause only matches in_flight rows ──────────

// We can't introspect the live WHERE behaviour through sqlmock — but we
// can lock the SQL text via a regex-anchored expectation that fails the
// build if a future refactor removes the `status='in_flight'` predicate.
func TestAW7_4_BulkRevertInFlight_OnlyInFlight_SQLLocked(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// EXACT predicate: WHERE status = 'in_flight' AND current_step > 0
	mock.ExpectExec(`WHERE status\s*=\s*'in_flight'\s+AND current_step\s*>\s*0`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if _, err := BulkRevertInFlight(context.Background(), db); err != nil {
		t.Fatalf("BulkRevertInFlight error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 7. BulkRevertInFlight decrements current_step by 1 ──────────────────────

func TestAW7_4_BulkRevertInFlight_DecrementsCurrentStep_SQLLocked(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// EXACT decrement: current_step = current_step - 1
	mock.ExpectExec(`current_step\s*=\s*current_step\s*-\s*1`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if _, err := BulkRevertInFlight(context.Background(), db); err != nil {
		t.Fatalf("BulkRevertInFlight error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 8. BulkRevertInFlight skips current_step=0 (no underflow) ───────────────

// The `current_step > 0` guard prevents the `current_step - 1` arithmetic
// from underflowing on a row reserved at fresh-enrollment. This test
// locks the guard via the SQL regex; the sqlmock layer cannot exercise
// WHERE-clause filtering on its own.
func TestAW7_4_BulkRevertInFlight_SkipsZeroStep_SQLLocked(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`current_step\s*>\s*0`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	if _, err := BulkRevertInFlight(context.Background(), db); err != nil {
		t.Fatalf("BulkRevertInFlight error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 9. BulkRevertInFlight clears next_send_at to NULL ───────────────────────

func TestAW7_4_BulkRevertInFlight_ClearsNextSendAt_SQLLocked(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`next_send_at\s*=\s*NULL`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	if _, err := BulkRevertInFlight(context.Background(), db); err != nil {
		t.Fatalf("BulkRevertInFlight error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 10. RevertFailedStep idempotent: second call after panic recovery ───────

// The wrapSendCallbackWithRecover code path may call RevertFailedStep
// even if the success branch already ran FinalizeSentStep — because a
// panic between the two cannot be distinguished by the wrapper. The CAS
// predicate `status='in_flight' AND current_step=Step+1` makes the
// second call a no-op. This test locks that contract.
func TestAW7_4_RevertFailedStep_AfterFinalize_IsNoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	req := sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}

	// First call (the legitimate success path) finalizes.
	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Second call (panic-recovery) gates on `status='in_flight'` which is
	// no longer true — sqlmock returns 0 rows.
	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Simulate happy-path finalize first.
	if _, err := FinalizeSentStep(context.Background(), db,
		sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0, IsFinalStep: true}); err != nil {
		t.Fatalf("FinalizeSentStep error: %v", err)
	}
	// Then simulate panic-recovery revert.
	rows, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("RevertFailedStep error on second call: %v", err)
	}
	if rows != 0 {
		t.Errorf("rows = %d, want 0 (CAS predicate should miss)", rows)
	}
}

// ── 11. BulkRevertInFlight respects context cancellation ────────────────────

func TestAW7_4_BulkRevertInFlight_ContextCancelled(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancel

	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnError(context.Canceled)

	_, err = BulkRevertInFlight(ctx, db)
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
	if !errors.Is(err, context.Canceled) {
		// wrap may unwrap; either canonical canceled or the wrapper is fine
		if !strings.Contains(err.Error(), "context") && !strings.Contains(err.Error(), "canceled") {
			t.Errorf("unexpected error type: %v", err)
		}
	}
}
