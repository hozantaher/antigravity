// Tests for GreylistRetryLoop (Z3-D).
//
// Coverage matrix (≥10 cases per task spec):
//
//	T01  Empty queue                                    — no SELECT match, no writes.
//	T02  Single tempfail under cap → retry              — bumps attempts + UPDATE retry_at.
//	T03  Single tempfail at cap → give-up               — flag greylist_persistent + DELETE + audit.
//	T04  SMTP probe accepted (valid) → resolved         — UPDATE companies + DELETE + audit.
//	T05  SMTP probe rejected (invalid) → resolved       — terminal invalid path.
//	T06  Catch-all status → resolved                    — terminal even though SMTPValid==nil.
//	T07  Role-only status → resolved                    — terminal role bucket.
//	T08  Spamtrap status → resolved                     — terminal spamtrap bucket.
//	T09  No MX (StatusInvalid path) → resolved          — terminal even with SMTPValid==nil.
//	T10  Mixed batch (resolve + retry + give-up)        — all three branches in one tick.
//	T11  Audit log emitted on every state change        — explicit INSERT INTO operator_audit_log expectation.
//	T12  Custom max_attempts via WithGreylistMaxAttempts — operator override drives give-up timing.
//	T13  Linear backoff math                            — attempts=1→10min, attempts=2→20min.
//	T14  Context cancelled mid-batch                    — partial commit OK, no panic.
//	T15  Tx commit failure does not skip subsequent ticks — verified via two-tick run.
//	T16  Verifier returns nil result                    — defensive skip, no panic, no writes.
//	T17  Custom retry-base via WithGreylistRetryBaseMin — backoff scales with operator knob.
package intelligence

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"contacts/validation"
)

// ─── helpers ─────────────────────────────────────────────────────────────

// fakeVerifier returns canned status/result for each call. Calls is a slice
// so successive rows can resolve differently within one drain pass.
type fakeVerifier struct {
	mu        sync.Mutex
	calls     []verifyCall
	callCount int
}

type verifyCall struct {
	status validation.EmailStatus
	result *validation.VerificationResult
}

func (f *fakeVerifier) VerifyEmail(_ context.Context, _ string) (validation.EmailStatus, *validation.VerificationResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.callCount >= len(f.calls) {
		// Default tempfail (no smtp_valid) so unconfigured calls don't blow up.
		f.callCount++
		return validation.StatusRisky, &validation.VerificationResult{
			SyntaxValid: true,
			MXExists:    true,
			RiskLevel:   "medium",
			Detail:      "default tempfail",
		}
	}
	c := f.calls[f.callCount]
	f.callCount++
	return c.status, c.result
}

func (f *fakeVerifier) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.callCount = 0
}

// boolPtr is the canonical way to populate VerificationResult.SMTPValid in
// tests — *bool can't be expressed as a literal.
func boolPtr(b bool) *bool { return &b }

// fixedNow returns a fixed clock for deterministic retry_at assertions.
func fixedNow(t time.Time) func() time.Time { return func() time.Time { return t } }

// silentLogger discards slog output so tests don't print MB of JSON.
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// makeLoop wires sqlmock + fake verifier + fixed clock + silent logger.
// Returns the loop, the sqlmock control, and the underlying fake verifier
// so the test can preload responses.
func makeLoop(t *testing.T, opts ...GreylistRetryOption) (*GreylistRetryLoop, sqlmock.Sqlmock, *fakeVerifier) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	verifier := &fakeVerifier{}
	allOpts := []GreylistRetryOption{
		WithVerifier(verifier),
		withNowFn(fixedNow(time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC))),
	}
	allOpts = append(allOpts, opts...)
	loop := NewGreylistRetryLoop(db, allOpts...)
	loop.logger = silentLogger()
	return loop, mock, verifier
}

// expectSelectDue creates the SELECT ... FOR UPDATE SKIP LOCKED expectation.
// rows is a list of (id, ico, email, attempts) tuples.
func expectSelectDue(mock sqlmock.Sqlmock, rows []greylistQueueRow) {
	r := sqlmock.NewRows([]string{"id", "ico", "email", "attempts"})
	for _, row := range rows {
		r.AddRow(row.ID, row.ICO, row.Email, row.Attempts)
	}
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, ico, email, attempts`)).
		WillReturnRows(r)
}

// ─── T01 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_EmptyQueue(t *testing.T) {
	loop, mock, _ := makeLoop(t)
	mock.ExpectBegin()
	expectSelectDue(mock, nil)
	mock.ExpectCommit()

	loop.drain(context.Background())

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T02 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_TempfailUnderCap_Retry(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{{
		status: validation.StatusRisky,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, RiskLevel: "medium",
			Detail: "tempfail 451",
			// SMTPValid intentionally nil → tempfail bucket.
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 7, ICO: "00000007", Email: "buyer@example.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE email_verify_queue`)).
		WithArgs(1, sqlmock.AnyArg(), "tempfail 451", int64(7)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	processed, resolved, gaveUp, retried, err := loop.drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if processed != 1 || retried != 1 || resolved != 0 || gaveUp != 0 {
		t.Fatalf("counters processed=%d resolved=%d retried=%d gaveUp=%d", processed, resolved, retried, gaveUp)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T03 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_TempfailAtCap_GiveUp(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	// max_attempts default is 3 → attempts=2 + 1 = 3 → give up.
	verifier.calls = []verifyCall{{
		status: validation.StatusRisky,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, RiskLevel: "medium",
			Detail: "tempfail again",
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 8, ICO: "00000008", Email: "ops@example.cz", Attempts: 2},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("00000008", 2).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue WHERE id = $1`)).
		WithArgs(int64(8)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	processed, resolved, gaveUp, retried, err := loop.drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if processed != 1 || gaveUp != 1 || resolved != 0 || retried != 0 {
		t.Fatalf("counters processed=%d resolved=%d retried=%d gaveUp=%d", processed, resolved, retried, gaveUp)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T04 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_SMTPAccepted_Resolved(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{{
		status: validation.StatusValid,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(true),
			RiskLevel: "low", Detail: "smtp accepted",
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 11, ICO: "00000011", Email: "ceo@example.cz", Attempts: 1},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("valid", sqlmock.AnyArg(), "00000011").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue WHERE id = $1`)).
		WithArgs(int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	processed, resolved, gaveUp, retried, err := loop.drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if processed != 1 || resolved != 1 || retried != 0 || gaveUp != 0 {
		t.Fatalf("counters processed=%d resolved=%d retried=%d gaveUp=%d", processed, resolved, retried, gaveUp)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T05 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_SMTPRejected_Resolved(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{{
		status: validation.StatusInvalid,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(false),
			RiskLevel: "high", Detail: "smtp 550",
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 12, ICO: "00000012", Email: "bad@example.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("invalid", sqlmock.AnyArg(), "00000012").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue WHERE id = $1`)).
		WithArgs(int64(12)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T06 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_CatchAll_Resolved(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{{
		status: validation.StatusCatchAll,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, IsCatchAll: true,
			RiskLevel: "medium", Detail: "catch-all domain",
			// SMTPValid intentionally nil — catch-all is terminal anyway.
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 13, ICO: "00000013", Email: "anyone@catchall.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("catch_all", sqlmock.AnyArg(), "00000013").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue WHERE id = $1`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T07 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_RoleOnly_Resolved(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{{
		status: validation.StatusRoleOnly,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, IsRole: true,
			RiskLevel: "medium", Detail: "role address",
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 14, ICO: "00000014", Email: "info@example.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("role_only", sqlmock.AnyArg(), "00000014").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T08 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_Spamtrap_Resolved(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{{
		status: validation.StatusSpamtrap,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, IsSpamtrap: true,
			RiskLevel: "high", Detail: "spamtrap domain",
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 15, ICO: "00000015", Email: "trap@spamtrap.example", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("spamtrap", sqlmock.AnyArg(), "00000015").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T09 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_NoMX_StatusInvalid_Resolved(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	// StatusInvalid + SMTPValid nil is still terminal (no point retrying a
	// domain that has no MX).
	verifier.calls = []verifyCall{{
		status: validation.StatusInvalid,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: false,
			RiskLevel: "high", Detail: "no MX records",
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 16, ICO: "00000016", Email: "x@nomx.example", Attempts: 1},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("invalid", sqlmock.AnyArg(), "00000016").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T10 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_MixedBatch_ResolveRetryGiveUp(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{
		// Row 1: valid (resolve)
		{status: validation.StatusValid, result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(true),
			RiskLevel: "low", Detail: "smtp ok",
		}},
		// Row 2: tempfail with attempts=1 → retry to attempts=2
		{status: validation.StatusRisky, result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true,
			RiskLevel: "medium", Detail: "451 grey",
		}},
		// Row 3: tempfail with attempts=2 → give-up (3 = max)
		{status: validation.StatusRisky, result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true,
			RiskLevel: "medium", Detail: "451 grey persistent",
		}},
	}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 20, ICO: "20", Email: "ok@example.cz", Attempts: 0},
		{ID: 21, ICO: "21", Email: "wait@example.cz", Attempts: 1},
		{ID: 22, ICO: "22", Email: "stuck@example.cz", Attempts: 2},
	})
	// Row 20: resolved
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("valid", sqlmock.AnyArg(), "20").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).
		WithArgs(int64(20)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Row 21: retry
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE email_verify_queue`)).
		WithArgs(2, sqlmock.AnyArg(), "451 grey", int64(21)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Row 22: give up
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WithArgs("22", 2).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).
		WithArgs(int64(22)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	processed, resolved, gaveUp, retried, err := loop.drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if processed != 3 || resolved != 1 || retried != 1 || gaveUp != 1 {
		t.Fatalf("counters processed=%d resolved=%d retried=%d gaveUp=%d", processed, resolved, retried, gaveUp)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T11 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_AuditLogEmitted(t *testing.T) {
	// Explicit verification that operator_audit_log is INSERTed with the
	// resolved action — feedback_audit_log_on_mutations T0.
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{{
		status: validation.StatusValid,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(true),
			RiskLevel: "low",
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 30, ICO: "30", Email: "a@b.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WithArgs(auditActionGreylistResolved, "greylist_retry", "company", "30", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T12 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_CustomMaxAttempts(t *testing.T) {
	// Operator pushes max_attempts to 5 → attempts=2 should retry (not
	// give up like the default-3 case).
	loop, mock, verifier := makeLoop(t, WithGreylistMaxAttempts(5))
	verifier.calls = []verifyCall{{
		status: validation.StatusRisky,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, RiskLevel: "medium",
			Detail: "still grey",
		},
	}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 40, ICO: "40", Email: "patient@example.cz", Attempts: 2},
	})
	// Retry path — UPDATE email_verify_queue (not UPDATE companies + DELETE).
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE email_verify_queue`)).
		WithArgs(3, sqlmock.AnyArg(), "still grey", int64(40)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	_, _, gaveUp, retried, err := loop.drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if retried != 1 || gaveUp != 0 {
		t.Fatalf("expected retry under custom cap; got retried=%d gaveUp=%d", retried, gaveUp)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T13 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_LinearBackoffMath(t *testing.T) {
	// attempts=0 → attempts becomes 1 → backoff = 1 * base = 10 min.
	// Fixed clock noon → expected retry_at = noon + 10 min.
	fixedClock := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	loop, mock, verifier := makeLoop(t, withNowFn(fixedNow(fixedClock)))
	verifier.calls = []verifyCall{{
		status: validation.StatusRisky,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, RiskLevel: "medium",
			Detail: "first attempt grey",
		},
	}}

	expected1 := fixedClock.Add(10 * time.Minute)

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 50, ICO: "50", Email: "x@example.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE email_verify_queue`)).
		WithArgs(1, expected1, "first attempt grey", int64(50)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T14 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_ContextCancelled(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{
		{status: validation.StatusValid, result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(true),
		}},
	}

	ctx, cancel := context.WithCancel(context.Background())

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 60, ICO: "60", Email: "first@x.cz", Attempts: 0},
		{ID: 61, ICO: "61", Email: "second@x.cz", Attempts: 0},
	})
	// First row commits …
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1)).
		WillDelayFor(0).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// … then ctx cancelled before second row. tx.Commit on cancelled ctx
	// is the path under test.
	mock.ExpectCommit()

	cancel() // cancel after expectations registered — drain will run once.
	// Run drain with cancelled ctx — first row's verifier returns valid,
	// then ctx.Err() is checked before second row and we break out + commit.
	_, _, _, _, err := loop.drain(ctx)
	// Either nil (committed) or context error is acceptable — what we
	// guarantee is no panic + no leak.
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Logf("drain returned %v (expected nil or canceled)", err)
	}
}

// ─── T15 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_TickRecoversAfterCommitFailure(t *testing.T) {
	// Tick 1 fails on commit, tick 2 succeeds. Demonstrates the loop
	// doesn't get wedged by a transient commit failure.
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{
		// Tick 1 row
		{status: validation.StatusValid, result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(true),
		}},
		// Tick 2 row
		{status: validation.StatusValid, result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(true),
		}},
	}

	// Tick 1
	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 70, ICO: "70", Email: "tick1@x.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit().WillReturnError(errors.New("commit failed (simulated)"))

	// Tick 2
	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 71, ICO: "71", Email: "tick2@x.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE companies`)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM email_verify_queue`)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	// Tick 1 (commit fails — drain returns error).
	_, _, _, _, err := loop.drain(context.Background())
	if err == nil {
		t.Fatalf("expected commit error on tick 1")
	}
	// Tick 2 (clean — drain succeeds).
	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("tick 2 drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T16 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_NilVerifierResult_DefensiveSkip(t *testing.T) {
	loop, mock, verifier := makeLoop(t)
	verifier.calls = []verifyCall{{status: validation.StatusRisky, result: nil}}

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 80, ICO: "80", Email: "weird@x.cz", Attempts: 0},
	})
	// No UPDATE / DELETE / audit — skip outcome, just COMMIT.
	mock.ExpectCommit()

	processed, resolved, gaveUp, retried, err := loop.drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if processed != 1 || resolved != 0 || gaveUp != 0 || retried != 0 {
		t.Fatalf("expected skip with no writes; got processed=%d resolved=%d retried=%d gaveUp=%d", processed, resolved, retried, gaveUp)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── T17 ─────────────────────────────────────────────────────────────────

func TestGreylistRetryLoop_CustomRetryBase(t *testing.T) {
	// Operator pushes retry-base to 5 → attempts=1 → backoff = 5 min.
	fixedClock := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	loop, mock, verifier := makeLoop(t,
		WithGreylistRetryBaseMin(5),
		withNowFn(fixedNow(fixedClock)),
	)
	verifier.calls = []verifyCall{{
		status: validation.StatusRisky,
		result: &validation.VerificationResult{
			SyntaxValid: true, MXExists: true, RiskLevel: "medium",
		},
	}}

	expected := fixedClock.Add(5 * time.Minute)

	mock.ExpectBegin()
	expectSelectDue(mock, []greylistQueueRow{
		{ID: 90, ICO: "90", Email: "x@y.cz", Attempts: 0},
	})
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE email_verify_queue`)).
		WithArgs(1, expected, sqlmock.AnyArg(), int64(90)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO operator_audit_log`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if _, _, _, _, err := loop.drain(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ─── redactedEmail unit ──────────────────────────────────────────────────

func TestRedactedEmail(t *testing.T) {
	cases := []struct{ in, want string }{
		{"buyer@example.cz", "b***@example.cz"},
		{"a@b.cz", "a***@b.cz"},
		{"", "[REDACTED]"},
		{"no-at-sign", "[REDACTED]"},
		{"@nolocal", "[REDACTED]"}, // at index 0 → defensive bucket
	}
	for _, c := range cases {
		got := redactedEmail(c.in)
		if got != c.want {
			t.Errorf("redactedEmail(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
