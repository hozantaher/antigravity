package intelligence

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── CheckDomainHealth via sqlmock ──

func TestCheckDomainHealth_NoDomains(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}))

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 0 { t.Errorf("checked = %d, want 0", checked) }
	if flagged != 0 { t.Errorf("flagged = %d, want 0", flagged) }
}

func TestCheckDomainHealth_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnError(errIntelligence("db error"))

	_, _, err = CheckDomainHealth(context.Background(), db)
	if err == nil { t.Error("expected error") }
}

func TestCheckDomainHealth_HighBounceRate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Domain with bounce rate > 0.15 and total_sent >= 5 → suppress
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(1, "badomain.cz", 10, 2, 0, 0.20, 5, false))

	// Expect UPDATE for suppression
	mock.ExpectExec(`UPDATE outreach_domains SET is_suppressed`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 1 { t.Errorf("flagged = %d, want 1", flagged) }
	// Verify UPDATE is_suppressed was actually called (catches `> → <` on bounceRate > 0.15)
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

func TestCheckDomainHealth_MediumBounceRate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Domain with bounce rate > 0.08 and total_sent >= 10 → reduce cap
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(2, "middomain.cz", 15, 1, 0, 0.10, 4, false))

	// Expect UPDATE for cap change
	mock.ExpectExec(`UPDATE outreach_domains SET daily_send_cap`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 1 { t.Errorf("flagged = %d, want 1 (cap reduced)", flagged) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("cap-reduce UPDATE must be called: %v", err)
	}
}

func TestCheckDomainHealth_GoodPerformance(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Domain with bounce rate < 0.02 and total_sent >= 20, low cap → increase cap
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(3, "gooddomain.cz", 25, 0, 0, 0.01, 2, false))

	// Expect UPDATE for cap increase
	mock.ExpectExec(`UPDATE outreach_domains SET daily_send_cap`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 0 { t.Errorf("flagged = %d, want 0 (good domain)", flagged) }
	// Verify cap-increase UPDATE was called (catches `< → >` on bounceRate < 0.02)
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("cap-increase UPDATE must be called for good domain: %v", err)
	}
}

func TestCheckDomainHealth_WithComplaints(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Domain with complaints > 0 → cap set to 1
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(4, "complaintdomain.cz", 5, 0, 2, 0.0, 5, false))

	// Expect UPDATE for cap = 1
	mock.ExpectExec(`UPDATE outreach_domains SET daily_send_cap`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 1 { t.Errorf("flagged = %d, want 1 (complaint)", flagged) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("cap=1 UPDATE must be called on complaint: %v", err)
	}
}

func TestCheckDomainHealth_MultipleDomains(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).
			AddRow(1, "ok1.cz", 3, 0, 0, 0.0, 3, false).   // low sent, no change
			AddRow(2, "ok2.cz", 5, 0, 0, 0.05, 3, false))   // bounceRate > 0.08? no, 0.05 < 0.08

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 2 { t.Errorf("checked = %d, want 2", checked) }
	if flagged != 0 { t.Errorf("flagged = %d, want 0", flagged) }
}

// ── CheckDomainHealth — boundary tests ──
// These test the exact threshold boundaries, not just values far from them.

// TestCheckDomainHealth_BounceRateExactAtHighThreshold: bounceRate=0.15 is NOT > 0.15 →
// domain must NOT be suppressed. Tests the strict inequality boundary.
func TestCheckDomainHealth_BounceRateExactAtHighThreshold(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// totalSent=9 avoids the medium-bounce branch (which requires totalSent >= 10)
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(10, "boundary.cz", 9, 0, 0, 0.15, 5, false))
	// No UPDATE expected — exactly 0.15 is not > 0.15, and totalSent=9 < 10 skips medium branch

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 0 { t.Errorf("flagged = %d, want 0 (0.15 is not > 0.15)", flagged) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("no UPDATE expected at exact threshold: %v", err)
	}
}

// TestCheckDomainHealth_LowTotalSentBlocksHighBounceSuppress: bounceRate=0.20 but
// totalSent=4 (< 5) → suppress condition not met. Tests the totalSent >= 5 guard.
func TestCheckDomainHealth_LowTotalSentBlocksHighBounceSuppress(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(11, "lowsent.cz", 4, 1, 0, 0.20, 5, false))
	// totalSent=4 < 5 → high-bounce branch skipped

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 0 { t.Errorf("flagged = %d, want 0 (totalSent < 5 blocks suppression)", flagged) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("no UPDATE expected when totalSent < 5: %v", err)
	}
}

// TestCheckDomainHealth_BounceRateExactAtMediumThreshold: bounceRate=0.08 is NOT > 0.08 →
// cap must NOT be reduced.
func TestCheckDomainHealth_BounceRateExactAtMediumThreshold(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(12, "medboundary.cz", 15, 0, 0, 0.08, 4, false))
	// No UPDATE expected — 0.08 is not > 0.08

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 0 { t.Errorf("flagged = %d, want 0 (0.08 is not > 0.08)", flagged) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("no UPDATE expected at medium threshold boundary: %v", err)
	}
}

// TestCheckDomainHealth_GoodDomainCapAlreadyAtCeiling: bounceRate=0.01 and totalSent=25
// but dailyCap=5 (at ceiling) → NO cap-increase UPDATE.
// Tests the dailyCap < 5 guard in the good-performance branch.
func TestCheckDomainHealth_GoodDomainCapAlreadyAtCeiling(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(13, "maxcap.cz", 30, 0, 0, 0.01, 5, false))
	// dailyCap=5 is not < 5 → no increase

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 0 { t.Errorf("flagged = %d, want 0", flagged) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("no UPDATE expected when cap already at ceiling: %v", err)
	}
}

// TestCheckDomainHealth_HighBounceRateWithArgCheck verifies the suppression UPDATE
// is called with the correct domain ID (catches wrong-row bugs).
func TestCheckDomainHealth_HighBounceRateWithArgCheck(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(42, "target.cz", 10, 2, 0, 0.20, 5, false))

	// UPDATE must be called with id=42 specifically
	mock.ExpectExec(`UPDATE outreach_domains SET is_suppressed`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if checked != 1 { t.Errorf("checked = %d, want 1", checked) }
	if flagged != 1 { t.Errorf("flagged = %d, want 1", flagged) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("UPDATE with id=42 must be called: %v", err)
	}
}

// ── DetectZeroEngagement via sqlmock ──

func TestDetectZeroEngagement_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 5))

	n, err := DetectZeroEngagement(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 5 { t.Errorf("n = %d, want 5", n) }
}

func TestDetectZeroEngagement_ZeroAffected(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	n, err := DetectZeroEngagement(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 0 { t.Errorf("n = %d, want 0", n) }
}

func TestDetectZeroEngagement_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_honeypot_signals`).
		WillReturnError(errIntelligence("exec failed"))

	_, err = DetectZeroEngagement(context.Background(), db)
	if err == nil { t.Error("expected error") }
}

// ── TopDomains via sqlmock ──

func TestTopDomains_WithRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT domain, domain_type`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "domain_type", "total_sent", "bounce_rate", "total_complained",
			"daily_send_cap", "is_suppressed", "active_contacts",
		}).
			AddRow("firma.cz", "b2b", 100, 0.02, 0, 5, false, 50).
			AddRow("test.cz", "b2b", 80, 0.05, 1, 3, false, 30))

	reports, err := TopDomains(context.Background(), db, 10)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(reports) != 2 { t.Errorf("expected 2 reports, got %d", len(reports)) }
	if reports[0].Domain != "firma.cz" { t.Error("first domain") }
	if reports[0].TotalSent != 100 { t.Errorf("TotalSent = %d, want 100", reports[0].TotalSent) }
	if reports[1].Complaints != 1 { t.Errorf("Complaints = %d, want 1", reports[1].Complaints) }
}

func TestTopDomains_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT domain, domain_type`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "domain_type", "total_sent", "bounce_rate", "total_complained",
			"daily_send_cap", "is_suppressed", "active_contacts",
		}))

	reports, err := TopDomains(context.Background(), db, 5)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(reports) != 0 { t.Errorf("expected 0, got %d", len(reports)) }
}

func TestTopDomains_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT domain, domain_type`).
		WillReturnError(errIntelligence("query failed"))

	_, err = TopDomains(context.Background(), db, 10)
	if err == nil { t.Error("expected error") }
}

type errIntelligence string
func (e errIntelligence) Error() string { return string(e) }

// ── RecoverSuppressedDomains — domain derivation regression tests ──
//
// History:
//   1. Original code referenced se.domain, which doesn't exist in production
//      (migration 033 only declares campaign_id, contact_id, sent_at, etc.).
//      Intelligence loop logged `pq: column se.domain does not exist` every
//      6h.
//   2. Earlier tests pinned the literal `se.domain` string under the
//      assumption a migration would add the column. The migration never
//      shipped, so the runtime bug stayed.
//   3. Fix: derive the recipient domain from contacts via send_events.contact_id
//      using `lower(split_part(c.email, '@', 2)) = d.domain`. Regression
//      pinning is now on that contacts join — not the missing column.

// TestRecoverSuppressedDomains_QueryCompiles exercises the full happy-path
// flow of RecoverSuppressedDomains via sqlmock. The mock expects the SELECT
// that contains the se.domain reference and then the UPDATE to lift suppression.
// Passing confirms that the SQL structure is coherent.
func TestRecoverSuppressedDomains_QueryCompiles(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// The SELECT query in RecoverSuppressedDomains contains se.domain — we
	// match on the outer SELECT pattern that sqlmock will see.
	mock.ExpectQuery(`SELECT d\.id, d\.domain`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}).
			AddRow(30, "recover2.cz", 0.0)) // recent_bounce_rate = 0.0 → safe to recover

	// Expect the UPDATE to un-suppress the domain
	mock.ExpectExec(`UPDATE outreach_domains`).
		WithArgs(30).
		WillReturnResult(sqlmock.NewResult(0, 1))

	n, err := RecoverSuppressedDomains(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 1 {
		t.Errorf("recovered = %d, want 1", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// TestRecoverSuppressedDomains_DerivesDomainViaContacts is a regression guard
// for the post-fix query: domain must come from a contacts join, never from
// a non-existent send_events.domain column. If a future refactor reintroduces
// se.domain, the pattern below won't match and sqlmock will fail the test.
func TestRecoverSuppressedDomains_DerivesDomainViaContacts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Must reference contacts via send_events.contact_id and split_part on
	// the email address. The pattern below requires both signals.
	mock.ExpectQuery(`(?s)JOIN contacts c\s+ON c\.id = se\.contact_id.*split_part\(c\.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}))

	n, err := RecoverSuppressedDomains(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("recovered = %d, want 0", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("contacts join must drive the domain derivation: %v", err)
	}
}

// ── RecoverSuppressedDomains via sqlmock ──

func TestRecoverSuppressedDomains_NoneToRecover(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT d.id, d.domain`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}))

	n, err := RecoverSuppressedDomains(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 0 { t.Errorf("recovered = %d, want 0", n) }
	if err := mock.ExpectationsWereMet(); err != nil { t.Errorf("unmet: %v", err) }
}

func TestRecoverSuppressedDomains_RecoversBelowThreshold(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// One suppressed domain with recent bounce rate 0.01 (below 3% threshold)
	mock.ExpectQuery(`SELECT d.id, d.domain`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}).
			AddRow(7, "healed.cz", 0.01))

	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	n, err := RecoverSuppressedDomains(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 1 { t.Errorf("recovered = %d, want 1", n) }
	if err := mock.ExpectationsWereMet(); err != nil { t.Errorf("unmet: %v", err) }
}

func TestRecoverSuppressedDomains_KeepsHighBounceRate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// recent bounce rate 0.08 — still above 3% threshold, should NOT recover
	mock.ExpectQuery(`SELECT d.id, d.domain`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}).
			AddRow(8, "stillbad.cz", 0.08))

	// No UPDATE expected

	n, err := RecoverSuppressedDomains(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 0 { t.Errorf("recovered = %d, want 0 (bounce rate too high)", n) }
	if err := mock.ExpectationsWereMet(); err != nil { t.Errorf("unmet: %v", err) }
}

// TestRecoverSuppressedDomains_NoRecentSends_NoRecovery verifies that a domain
// with zero recent sends (NULL recent_bounce_rate from NULLIF(COUNT(...),0))
// is NOT auto-recovered. Recovery must require recent evidence the domain has
// healed, not an absence of data — otherwise a long-dormant suppressed domain
// would silently un-suppress on no signal at all. No UPDATE is expected.
func TestRecoverSuppressedDomains_NoRecentSends_NoRecovery(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT d.id, d.domain`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}).
			AddRow(40, "dormant.cz", nil)) // NULL rate → no recent sends

	// No UPDATE expected — domain stays suppressed.

	n, err := RecoverSuppressedDomains(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("recovered = %d, want 0 (no recent sends → no evidence)", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("a domain with no recent sends must not be recovered: %v", err)
	}
}

func TestRecoverSuppressedDomains_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT d.id, d.domain`).
		WillReturnError(errIntelligence("db down"))

	_, err = RecoverSuppressedDomains(context.Background(), db)
	if err == nil { t.Error("expected error") }
}

// TestRecoverSuppressedDomains_ExactlyAtThreshold verifies that a domain with
// exactly 3% recent bounce rate IS recovered — the guard is `> 0.03`, so
// 0.03 (not > 0.03) passes through and triggers the UPDATE.
// This is a mutation-resistant boundary test: swapping `>` to `>=` would break it.
func TestRecoverSuppressedDomains_ExactlyAtThreshold(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT d.id, d.domain`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}).
			AddRow(20, "exact.cz", 0.03))

	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	n, err := RecoverSuppressedDomains(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 1 {
		t.Errorf("recovered = %d, want 1 (0.03 is not > 0.03)", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("UPDATE must be called for rate=0.03: %v", err)
	}
}

// TestRecoverSuppressedDomains_MultipleDomainsPartialRecovery verifies that when
// two suppressed domains are returned, only the one with rate ≤ 3% is recovered.
func TestRecoverSuppressedDomains_MultipleDomainsPartialRecovery(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT d.id, d.domain`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "domain", "recent_bounce_rate"}).
			AddRow(21, "recover.cz", 0.02).   // rate 2% → below threshold → recover
			AddRow(22, "keep.cz", 0.05))       // rate 5% → above threshold → skip

	mock.ExpectExec(`UPDATE outreach_domains`).
		WithArgs(21).
		WillReturnResult(sqlmock.NewResult(0, 1))

	n, err := RecoverSuppressedDomains(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 1 {
		t.Errorf("recovered = %d, want 1 (only recover.cz qualifies)", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("UPDATE called with wrong id or extra calls: %v", err)
	}
}
