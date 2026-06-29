// AW7-4 — engine panic atomic rollback tests for the orchestrator-side
// callback wrapper.
//
// These tests cover wrapSendCallbackWithRecover — the inner defer-recover
// shield that keeps a panicking onSent callback from leaving a contact
// stuck in `status='in_flight'`.
//
// Coverage required by HARD memory feedback_extreme_testing (≥10 cases):
//
//  1. Wrapper invokes the inner callback on the happy path.
//  2. Wrapper recovers a panic on the success branch.
//  3. Wrapper recovers a panic on the error branch.
//  4. Wrapper calls RevertFailedStep with the SendRequest's CAS predicate.
//  5. Wrapper writes an `engine.panic_recovered` audit row.
//  6. Wrapper does not re-raise the panic to the outer goroutine.
//  7. Wrapper tolerates nil DB (test mode) without crashing.
//  8. Wrapper passes the campaign_id correctly to the audit entry.
//  9. Wrapper passes the contact_id + step correctly.
// 10. Wrapper handles a panic value of nil (recover() returns nil for
//     the no-panic case — guard against accidental triggering).
// 11. Wrapper continues invoking subsequent callbacks after a recovered
//     panic (loop survives across iterations).

package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"campaigns/sender"
)

// ── 1. Wrapper happy-path: inner callback runs, no recovery fires ───────────

func TestAW7_4_Wrapper_HappyPath_InnerRuns(t *testing.T) {
	var ran atomic.Bool
	wrap := wrapSendCallbackWithRecover(context.Background(), nil, "test/scope",
		func(req sender.SendRequest, result sender.SendResult) {
			ran.Store(true)
		})
	wrap(sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}, sender.SendResult{})
	if !ran.Load() {
		t.Fatal("inner callback never ran on happy path")
	}
}

// ── 2. Wrapper recovers a panic on the success branch ───────────────────────

func TestAW7_4_Wrapper_PanicOnSuccess_Recovered(t *testing.T) {
	wrap := wrapSendCallbackWithRecover(context.Background(), nil, "test/success",
		func(req sender.SendRequest, result sender.SendResult) {
			// result.Error == nil → success branch
			if result.Error != nil {
				t.Fatal("test setup error: expected success branch")
			}
			panic("simulated success-path panic")
		})

	// Must not propagate.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic propagated to caller: %v", r)
		}
	}()
	wrap(sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}, sender.SendResult{})
}

// ── 3. Wrapper recovers a panic on the error branch ─────────────────────────

func TestAW7_4_Wrapper_PanicOnError_Recovered(t *testing.T) {
	wrap := wrapSendCallbackWithRecover(context.Background(), nil, "test/error",
		func(req sender.SendRequest, result sender.SendResult) {
			if result.Error == nil {
				t.Fatal("test setup error: expected error branch")
			}
			panic("simulated error-path panic")
		})

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic propagated to caller: %v", r)
		}
	}()
	failed := sender.SendResult{Error: errSimulated}
	wrap(sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}, failed)
}

// errSimulated is a sentinel error injected into SendResult to drive the
// error branch in tests.
var errSimulated = simErr("simulated SMTP failure")

type simErr string

func (e simErr) Error() string { return string(e) }

// ── 4. Wrapper calls RevertFailedStep with CAS predicate ────────────────────

func TestAW7_4_Wrapper_CallsRevertFailedStep_CASPredicate(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// RevertFailedStep gates on advancedStep=Step+1=1.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'pending'`).
		WithArgs(int64(77), int64(8888), 0, 1).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// audit.Log INSERT
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	wrap := wrapSendCallbackWithRecover(context.Background(), db, "outreach.main/test",
		func(req sender.SendRequest, result sender.SendResult) {
			panic("trip the recovery path")
		})

	wrap(sender.SendRequest{CampaignID: 77, ContactID: 8888, Step: 0}, sender.SendResult{})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// ── 5. Wrapper writes an `engine.panic_recovered` audit row ─────────────────

func TestAW7_4_Wrapper_WritesAuditRow(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Revert noop.
	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Audit row WHERE action='engine.panic_recovered'.
	mock.ExpectExec(`INSERT INTO operator_audit_log\s*\(\s*action\s*,\s*actor\s*,\s*entity_type\s*,\s*entity_id\s*,\s*details\s*\)\s+VALUES`).
		WithArgs("engine.panic_recovered", "engine.callback", "campaign", "55", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	wrap := wrapSendCallbackWithRecover(context.Background(), db, "outreach.main/test-audit",
		func(req sender.SendRequest, result sender.SendResult) {
			panic("audit-row trip")
		})
	wrap(sender.SendRequest{CampaignID: 55, ContactID: 999, Step: 1}, sender.SendResult{})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// ── 6. Wrapper does not re-raise the panic ──────────────────────────────────

func TestAW7_4_Wrapper_DoesNotRepanic(t *testing.T) {
	wrap := wrapSendCallbackWithRecover(context.Background(), nil, "test/norepanic",
		func(req sender.SendRequest, result sender.SendResult) {
			panic("should be swallowed")
		})

	// If the wrapper repanicked, the deferred recover below would catch
	// it. We assert that the deferred recover sees nil.
	got := func() (recovered any) {
		defer func() { recovered = recover() }()
		wrap(sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}, sender.SendResult{})
		return nil
	}()
	if got != nil {
		t.Fatalf("wrapper repanicked: %v", got)
	}
}

// ── 7. Wrapper tolerates nil DB ─────────────────────────────────────────────

func TestAW7_4_Wrapper_NilDB_NoCrash(t *testing.T) {
	wrap := wrapSendCallbackWithRecover(context.Background(), nil, "test/niDB",
		func(req sender.SendRequest, result sender.SendResult) {
			panic("nilDB-trip")
		})

	// Should not crash; recovery path skips Revert + audit when db is nil.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("wrapper crashed with nil DB: %v", r)
		}
	}()
	wrap(sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}, sender.SendResult{})
}

// ── 8. Wrapper passes campaign_id correctly to audit entry ──────────────────

func TestAW7_4_Wrapper_AuditEntityID_FromCampaignID(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// EntityID column (4th arg) must equal "12345" — string-formatted
	// campaign_id 12345.
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WithArgs("engine.panic_recovered", "engine.callback", "campaign", "12345", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	wrap := wrapSendCallbackWithRecover(context.Background(), db, "outreach.main/test-id",
		func(req sender.SendRequest, result sender.SendResult) {
			panic("trip")
		})
	wrap(sender.SendRequest{CampaignID: 12345, ContactID: 1, Step: 0}, sender.SendResult{})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// ── 9. Wrapper passes contact_id + step into audit details JSON ─────────────

func TestAW7_4_Wrapper_AuditDetails_IncludeContactAndStep(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Match the details JSON via a custom argument matcher.
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WithArgs("engine.panic_recovered", "engine.callback", "campaign", "9", auditDetailsContains{"\"contact_id\":777", "\"step\":3"}).
		WillReturnResult(sqlmock.NewResult(0, 1))

	wrap := wrapSendCallbackWithRecover(context.Background(), db, "outreach.main/test-details",
		func(req sender.SendRequest, result sender.SendResult) {
			panic("trip")
		})
	wrap(sender.SendRequest{CampaignID: 9, ContactID: 777, Step: 3}, sender.SendResult{})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// auditDetailsContains is a sqlmock argument matcher: the marshalled
// details JSON must contain every supplied substring. Implements
// sqlmock.Argument (Match(v driver.Value) bool).
type auditDetailsContains []string

func (a auditDetailsContains) Match(v driver.Value) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, sub := range a {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}

// ── 10. Wrapper does NOT call Revert/audit when no panic occurs ─────────────

// recover() returns nil when the deferred function is invoked normally —
// we assert no DB activity happens in the happy path. If a refactor
// accidentally emits an audit row on every callback, sqlmock fails.
func TestAW7_4_Wrapper_HappyPath_NoDBCalls(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Deliberately set ZERO expectations. ExpectationsWereMet passes
	// only if no UPDATE/INSERT was issued.
	wrap := wrapSendCallbackWithRecover(context.Background(), db, "test/no-db",
		func(req sender.SendRequest, result sender.SendResult) {})
	wrap(sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}, sender.SendResult{})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("happy path triggered DB activity: %v", err)
	}
}

// ── 11. Wrapper survives across multiple callback invocations ───────────────

// In production the engine.Run loop calls onSent once per dispatched
// envelope. A panic on iteration N must not break iteration N+1. Locks
// the contract via two back-to-back calls, the second one expected to
// run cleanly.
func TestAW7_4_Wrapper_LoopSurvivesAcrossIterations(t *testing.T) {
	var calls atomic.Int32

	wrap := wrapSendCallbackWithRecover(context.Background(), nil, "test/loop",
		func(req sender.SendRequest, result sender.SendResult) {
			n := calls.Add(1)
			if n == 1 {
				panic("trip on first iteration only")
			}
		})

	// Iter 1: panic.
	wrap(sender.SendRequest{CampaignID: 1, ContactID: 1, Step: 0}, sender.SendResult{})
	// Iter 2: should still run.
	wrap(sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}, sender.SendResult{})

	if calls.Load() != 2 {
		t.Errorf("calls = %d, want 2 (loop must survive iter-1 panic)", calls.Load())
	}
}

// ── 12. Wrapper respects a cancelled context for revert/audit ───────────────

// If the engine.Run goroutine is being shut down, the context passed
// into the wrapper may already be cancelled. The wrapper must NOT block
// or hang; sqlmock returns the cancellation error from ExecContext and
// the wrapper logs/swallows it.
func TestAW7_4_Wrapper_CancelledContext_NoHang(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnError(context.Canceled)
	// audit.Log should still be attempted; sqlmock returns canceled too.
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnError(context.Canceled)

	wrap := wrapSendCallbackWithRecover(ctx, db, "test/cancel",
		func(req sender.SendRequest, result sender.SendResult) {
			panic("trip")
		})

	done := make(chan struct{})
	go func() {
		defer close(done)
		wrap(sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}, sender.SendResult{})
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("wrapper hung on cancelled context")
	}
}

// ── 13. campaign.DB satisfies audit.Execer (compile-time guard) ─────────────

// If a future refactor changes campaign.DB.ExecContext or audit.Execer
// signatures so they diverge, this test fails to compile — surfacing
// the regression instead of a silent type-mismatch at runtime.
var _ = func(d *sql.DB) {
	wrapSendCallbackWithRecover(context.Background(), d, "compile-guard",
		func(req sender.SendRequest, result sender.SendResult) {})
}
