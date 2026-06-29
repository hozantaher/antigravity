// Z3-B: tests for cron_bounce_flip.go.
//
// We exercise the SQL pipeline end-to-end via sqlmock — no live DB. Each test
// asserts a single behavioural property (one-test-one-fact), and uses regex
// query matchers so PostgreSQL syntax tweaks don't crack the suite.

package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── 1: happy-path single bounced email flips one company ──

func TestBounceFlip_FlipsOneCompany(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WillReturnRows(sqlmock.NewRows([]string{"email"}).AddRow("bouncy@example.cz"))
	mock.ExpectQuery(`SELECT ico, COALESCE\(email_status, 'unverified'\)`).
		WillReturnRows(sqlmock.NewRows([]string{"ico", "email_status"}).AddRow("12345678", "unverified"))
	mock.ExpectExec(`UPDATE companies\s+SET email_status='invalid'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO email_verification_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunBounceFlipOnce(context.Background(), db)
	if err != nil {
		t.Fatalf("RunBounceFlipOnce: %v", err)
	}
	if res.Bounced != 1 {
		t.Errorf("Bounced = %d, want 1", res.Bounced)
	}
	if res.Flipped != 1 {
		t.Errorf("Flipped = %d, want 1", res.Flipped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ── 2: no bounced emails → no flips (single scan query, no watermark I/O) ──

func TestBounceFlip_NoBouncesNoFlips(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// FIX (missed async bounces): the cron no longer reads/writes an
	// outreach_config watermark — the lookback scan is the only query.
	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WillReturnRows(sqlmock.NewRows([]string{"email"}))

	res, err := RunBounceFlipOnce(context.Background(), db)
	if err != nil {
		t.Fatalf("RunBounceFlipOnce: %v", err)
	}
	if res.Bounced != 0 || res.Flipped != 0 {
		t.Errorf("expected zero bounced/flipped, got %+v", res)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations (watermark read/write must be gone): %v", err)
	}
}

// ── 3: company already invalid → no flip ──

func TestBounceFlip_SkipsAlreadyInvalid(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WillReturnRows(sqlmock.NewRows([]string{"email"}).AddRow("bad@example.cz"))
	// Returns no rows because all companies are already invalid/spamtrap.
	mock.ExpectQuery(`SELECT ico, COALESCE\(email_status, 'unverified'\)`).
		WillReturnRows(sqlmock.NewRows([]string{"ico", "email_status"}))

	res, err := RunBounceFlipOnce(context.Background(), db)
	if err != nil {
		t.Fatalf("RunBounceFlipOnce: %v", err)
	}
	if res.Flipped != 0 {
		t.Errorf("Flipped = %d, want 0", res.Flipped)
	}
}

// ── 4: multiple bounced emails → multiple flips (race-safe across ticks) ──

func TestBounceFlip_MultipleBouncesFlipMultipleCompanies(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WillReturnRows(sqlmock.NewRows([]string{"email"}).
			AddRow("a@example.cz").AddRow("b@example.cz"))
	// per-email lookup + flip
	mock.ExpectQuery(`SELECT ico, COALESCE`).
		WillReturnRows(sqlmock.NewRows([]string{"ico", "email_status"}).AddRow("111", "unverified"))
	mock.ExpectExec(`UPDATE companies`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO email_verification_log`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery(`SELECT ico, COALESCE`).
		WillReturnRows(sqlmock.NewRows([]string{"ico", "email_status"}).AddRow("222", "risky"))
	mock.ExpectExec(`UPDATE companies`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO email_verification_log`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunBounceFlipOnce(context.Background(), db)
	if err != nil {
		t.Fatalf("RunBounceFlipOnce: %v", err)
	}
	if res.Bounced != 2 || res.Flipped != 2 {
		t.Errorf("Bounced/Flipped = %d/%d, want 2/2", res.Bounced, res.Flipped)
	}
}

// ── 5: scan uses the fixed lookback constant as its interval bound ──

func TestBounceFlip_ScansFixedLookbackWindow(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// FIX (missed async bounces): the scan must bound on a fixed lookback
	// window (bounceFlipLookbackDays) passed as $1, not on an outreach_config
	// watermark — late DSNs flip status without touching sent_at, so a
	// now()-watermark would skip them permanently.
	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WithArgs(bounceFlipLookbackDays).
		WillReturnRows(sqlmock.NewRows([]string{"email"}))

	if _, err := RunBounceFlipOnce(context.Background(), db); err != nil {
		t.Fatalf("RunBounceFlipOnce: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ── 6: send_events query failure → wrapped error returned ──

func TestBounceFlip_QueryFailureReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WillReturnError(errors.New("boom"))

	if _, err := RunBounceFlipOnce(context.Background(), db); err == nil {
		t.Fatal("expected error, got nil")
	} else if !strings.Contains(err.Error(), "query bounced") {
		t.Errorf("error not wrapped: %v", err)
	}
}

// ── 7: audit log row emitted per flip (HARD rule audit_log_on_mutations) ──

func TestBounceFlip_EmitsAuditLogPerFlip(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WillReturnRows(sqlmock.NewRows([]string{"email"}).AddRow("x@example.cz"))
	mock.ExpectQuery(`SELECT ico, COALESCE`).
		WillReturnRows(sqlmock.NewRows([]string{"ico", "email_status"}).AddRow("333", "unverified"))
	mock.ExpectExec(`UPDATE companies`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO email_verification_log`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO operator_audit_log`). // ← the HARD-rule assertion
								WithArgs("bounce_flip.company", "cron", "company", "333", sqlmock.AnyArg()).
								WillReturnResult(sqlmock.NewResult(1, 1))

	if _, err := RunBounceFlipOnce(context.Background(), db); err != nil {
		t.Fatalf("RunBounceFlipOnce: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("audit row not emitted: %v", err)
	}
}

// ── 8: verification_log failure tolerated (best-effort) ──

func TestBounceFlip_VerificationLogFailureTolerated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WillReturnRows(sqlmock.NewRows([]string{"email"}).AddRow("y@example.cz"))
	mock.ExpectQuery(`SELECT ico, COALESCE`).
		WillReturnRows(sqlmock.NewRows([]string{"ico", "email_status"}).AddRow("444", "unverified"))
	mock.ExpectExec(`UPDATE companies`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO email_verification_log`).
		WillReturnError(errors.New("FK missing — table not yet migrated"))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunBounceFlipOnce(context.Background(), db)
	if err != nil {
		t.Fatalf("expected best-effort tolerate, got error: %v", err)
	}
	if res.Flipped != 1 {
		t.Errorf("Flipped = %d, want 1 even when verification_log failed", res.Flipped)
	}
}

// ── 9: company flip UPDATE failure logs + continues, doesn't fail the tick ──

func TestBounceFlip_CompanyFlipFailureTolerated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT LOWER\(ct\.email\)`).
		WillReturnRows(sqlmock.NewRows([]string{"email"}).AddRow("z@example.cz"))
	mock.ExpectQuery(`SELECT ico, COALESCE`).
		WillReturnRows(sqlmock.NewRows([]string{"ico", "email_status"}).AddRow("555", "unverified"))
	// The flip UPDATE fails — the tick must log + continue (no verlog/audit
	// for this email), not error out, and must not count a flip.
	mock.ExpectExec(`UPDATE companies`).
		WillReturnError(errors.New("deadlock detected"))

	res, err := RunBounceFlipOnce(context.Background(), db)
	if err != nil {
		t.Fatalf("RunBounceFlipOnce returned err, want nil: %v", err)
	}
	if res.Flipped != 0 {
		t.Errorf("Flipped = %d, want 0 when UPDATE failed", res.Flipped)
	}
}

// ── 10: env gate respected — DISABLE_BOUNCE_FLIP_CRON=1 → no-op start ──

func TestBounceFlip_DisableEnvGateRespected(t *testing.T) {
	t.Setenv("DISABLE_BOUNCE_FLIP_CRON", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	// We don't pass a DB — if the function does anything besides log & return,
	// it'll panic on the nil deref.
	StartBounceFlipLoop(ctx, nil)
	<-ctx.Done()
}
