package intelligence

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// expectRunOnceCoreWithRecovery sets up the shared preamble through step 3
// (CheckDomainHealth) and then adds the RecoverSuppressedDomains expectation
// (step 3b) with the given rows.  Callers follow with the MailboxBP step (if
// any), RecalculateFast, and the rest of the tail.
func expectRunOnceCoreWithRecovery(mock sqlmock.Sqlmock, recoveryRows *sqlmock.Rows) {
	// 1. thread.ResumeExpiredPauses
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// 1b. thread.ExpireStaleThreads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 2. enrich.AutoSuppressFromEvents — 3 queries
	mock.ExpectQuery(`SELECT DISTINCT c\.email, e\.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// 3. CheckDomainHealth
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}))

	// 3b. RecoverSuppressedDomains
	mock.ExpectQuery(`SELECT d.id, d.domain`).
		WillReturnRows(recoveryRows)
}

// expectRecalcFastAndAfter sets up RecalculateFast (step 4) through the rest
// of the loop, reusing the shared helpers from runonce_coverage_test.go.
func expectRecalcFastAndAfter(mock sqlmock.Sqlmock) {
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`UPDATE contacts c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	expectRunOnceAfterRecalc(mock)
	expectRunOnceTail(mock)
}

// ── TestRunOnce_WithMailboxBP_NoCandidates ────────────────────────────────────
// cfg.MailboxBP is set but autoReleaseBounceHold returns no candidates →
// result.MailboxesReleased must remain 0.

func TestRunOnce_WithMailboxBP_NoCandidates(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Step 3b: RecoverSuppressedDomains — no recoverable domains
	recoveryRows := sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"})
	expectRunOnceCoreWithRecovery(mock, recoveryRows)

	// Step 3c: autoReleaseBounceHold — no candidates in bounce_hold
	mock.ExpectQuery(`SELECT m.id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "from_address", "consecutive_bounces", "updated_at", "sent_7d",
		}))

	// Steps 4+
	expectRecalcFastAndAfter(mock)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		MailboxBP:        &fakeHoldReleaser{},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MailboxesReleased != 0 {
		t.Errorf("MailboxesReleased = %d, want 0", result.MailboxesReleased)
	}
}

// ── TestRunOnce_WithMailboxBP_Released ───────────────────────────────────────
// cfg.MailboxBP is set and one mailbox held 200h qualifies → released = 1.

func TestRunOnce_WithMailboxBP_Released(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Step 3b: RecoverSuppressedDomains — empty
	recoveryRows := sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"})
	expectRunOnceCoreWithRecovery(mock, recoveryRows)

	// Step 3c: autoReleaseBounceHold — 1 candidate held 200h (> 168h window)
	updatedAt := time.Now().Add(-200 * time.Hour)
	mock.ExpectQuery(`SELECT m.id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "from_address", "consecutive_bounces", "updated_at", "sent_7d",
		}).AddRow(42, "jan@test.local", 3, updatedAt, 5))

	// ReleaseCandidateWithCanary — two Exec calls
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE mailbox_cooldown_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Steps 4+
	expectRecalcFastAndAfter(mock)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
		MailboxBP:        &fakeHoldReleaser{},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MailboxesReleased != 1 {
		t.Errorf("MailboxesReleased = %d, want 1", result.MailboxesReleased)
	}
}

// ── TestRunOnce_DomainsRecovered ─────────────────────────────────────────────
// No cfg.MailboxBP; RecoverSuppressedDomains returns 1 healable domain
// (recent_bounce_rate=0.01 < 0.03 threshold) → result.DomainsRecovered >= 1.

func TestRunOnce_DomainsRecovered(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Step 3b: RecoverSuppressedDomains — 1 domain with low bounce rate
	recoveryRows := sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}).
		AddRow(7, "recovered.cz", 0.01)
	expectRunOnceCoreWithRecovery(mock, recoveryRows)

	// RecoverSuppressedDomains lifts suppression with an UPDATE
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// No MailboxBP → step 3c is skipped entirely.

	// Steps 4+
	expectRecalcFastAndAfter(mock)

	result, err := RunOnce(context.Background(), db, Config{
		TargetIndustries: []string{"machinery"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.DomainsRecovered < 1 {
		t.Errorf("DomainsRecovered = %d, want >= 1", result.DomainsRecovered)
	}
}
