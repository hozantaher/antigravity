package enrich

import (
	"context"
	"database/sql"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── SuppressEmail via sqlmock ──

func TestSuppressEmail_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'suppressed'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// G11 cascade: close open threads for suppressed contact
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err = SuppressEmail(context.Background(), db, "bad@firma.cz", SuppressHardBounce, nil)
	if err != nil { t.Errorf("unexpected error: %v", err) }
	if err := mock.ExpectationsWereMet(); err != nil { t.Errorf("unmet expectations: %v", err) }
}

func TestSuppressEmail_CascadesThreadClose(t *testing.T) {
	// Dedicated test verifying that SuppressEmail closes active/paused threads.
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'suppressed'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Cascade must close thread (1 row affected)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := SuppressEmail(context.Background(), db, "contact@test.cz", SuppressUnsubscribe, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("thread cascade not called: %v", err)
	}
}

func TestSuppressEmail_WithEventID(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'suppressed'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	eventID := 42
	err = SuppressEmail(context.Background(), db, "bad@firma.cz", SuppressComplaint, &eventID)
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

func TestSuppressEmail_InsertError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnError(errEnrich("insert failed"))

	err = SuppressEmail(context.Background(), db, "bad@firma.cz", SuppressHardBounce, nil)
	if err == nil { t.Error("expected error from insert") }
}

func TestSuppressEmail_UpdateContactStatusError(t *testing.T) {
	// Suppression insert succeeds but updating contact status fails — error must propagate.
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'suppressed'`).
		WillReturnError(errEnrich("update failed"))

	err = SuppressEmail(context.Background(), db, "bad@firma.cz", SuppressHardBounce, nil)
	if err == nil {
		t.Error("expected error when updating contact status fails")
	}
}

func TestSuppressEmail_NormalizesEmail(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'suppressed'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Thread cascade must also be expected after normalization
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// uppercase + whitespace → should be normalized to bad@firma.cz
	err = SuppressEmail(context.Background(), db, "  BAD@Firma.CZ  ", SuppressManual, nil)
	if err != nil { t.Errorf("unexpected error: %v", err) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("normalization or thread cascade not called correctly: %v", err)
	}
}

// ── SuppressDomain via sqlmock ──

func TestSuppressDomain_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_domains SET is_suppressed = true`).
		WillReturnResult(sqlmock.NewResult(0, 5))

	err = SuppressDomain(context.Background(), db, "spammer.cz", SuppressHardBounce)
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

func TestSuppressDomain_InsertError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnError(errEnrich("conflict"))

	err = SuppressDomain(context.Background(), db, "bad.cz", SuppressComplaint)
	if err == nil { t.Error("expected error") }
}

// ── IsSuppressed via sqlmock ──

func TestIsSuppressed_EmailFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT reason FROM outreach_suppressions WHERE email`).
		WillReturnRows(sqlmock.NewRows([]string{"reason"}).AddRow("hard_bounce"))

	suppressed, reason := IsSuppressed(context.Background(), db, "bad@firma.cz")
	if !suppressed { t.Error("expected suppressed = true") }
	if reason != "hard_bounce" { t.Errorf("reason = %q, want %q", reason, "hard_bounce") }
}

func TestIsSuppressed_DomainFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Email not found
	mock.ExpectQuery(`SELECT reason FROM outreach_suppressions WHERE email`).
		WillReturnError(sql.ErrNoRows)

	// Domain found
	mock.ExpectQuery(`SELECT reason FROM outreach_suppressions WHERE domain`).
		WillReturnRows(sqlmock.NewRows([]string{"reason"}).AddRow("complaint"))

	suppressed, reason := IsSuppressed(context.Background(), db, "user@bad-domain.cz")
	if !suppressed { t.Error("expected suppressed = true") }
	if reason != "domain:complaint" { t.Errorf("reason = %q, want %q", reason, "domain:complaint") }
}

func TestIsSuppressed_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT reason FROM outreach_suppressions WHERE email`).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`SELECT reason FROM outreach_suppressions WHERE domain`).
		WillReturnError(sql.ErrNoRows)

	suppressed, _ := IsSuppressed(context.Background(), db, "good@safe.cz")
	if suppressed { t.Error("expected not suppressed") }
}

// ── SuppressionStats via sqlmock ──

func TestSuppressionStats_WithData(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT reason, COUNT\(\*\) FROM outreach_suppressions GROUP BY reason`).
		WillReturnRows(sqlmock.NewRows([]string{"reason", "count"}).
			AddRow("hard_bounce", 10).
			AddRow("complaint", 3).
			AddRow("unsubscribe", 25))

	stats, err := SuppressionStats(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if stats["hard_bounce"] != 10 { t.Errorf("hard_bounce = %d, want 10", stats["hard_bounce"]) }
	if stats["complaint"] != 3 { t.Errorf("complaint = %d, want 3", stats["complaint"]) }
	if stats["unsubscribe"] != 25 { t.Errorf("unsubscribe = %d, want 25", stats["unsubscribe"]) }
}

func TestSuppressionStats_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT reason, COUNT\(\*\) FROM outreach_suppressions GROUP BY reason`).
		WillReturnRows(sqlmock.NewRows([]string{"reason", "count"}))

	stats, err := SuppressionStats(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(stats) != 0 { t.Errorf("expected empty, got %v", stats) }
}

func TestSuppressionStats_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT reason, COUNT\(\*\) FROM outreach_suppressions GROUP BY reason`).
		WillReturnError(errEnrich("db error"))

	_, err = SuppressionStats(context.Background(), db)
	if err == nil { t.Error("expected error") }
}

// ── AutoSuppressFromEvents via sqlmock ──

func TestAutoSuppressFromEvents_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Bounced query → empty
	mock.ExpectQuery(`SELECT DISTINCT c.email, e.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))

	// Bad-bounce-rate domains → empty
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// Complaint-rate domains → empty
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	n, err := AutoSuppressFromEvents(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 0 { t.Errorf("n = %d, want 0", n) }
}

func TestAutoSuppressFromEvents_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT c.email, e.id`).
		WillReturnError(errEnrich("bounced query failed"))

	_, err = AutoSuppressFromEvents(context.Background(), db)
	if err == nil { t.Error("expected error") }
}

func TestAutoSuppressFromEvents_WithBounced(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Bounced query → 1 email
	mock.ExpectQuery(`SELECT DISTINCT c.email, e.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}).
			AddRow("bounce@firma.cz", 10))

	// SuppressEmail: insert suppression record
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// SuppressEmail: update contact status
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'suppressed'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// SuppressEmail: thread cascade (G11)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Bad-bounce-rate domains → empty
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// Complaint-rate domains → empty
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	n, err := AutoSuppressFromEvents(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 1 { t.Errorf("n = %d, want 1", n) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("thread cascade expectation not met: %v", err)
	}
}

func TestAutoSuppressFromEvents_WithBadBounceDomain(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Bounced emails → empty
	mock.ExpectQuery(`SELECT DISTINCT c.email, e.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))

	// Bad-bounce-rate domains → 1 domain
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}).AddRow("bad-bounce.test"))

	// SuppressDomain: INSERT INTO outreach_suppressions
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// SuppressDomain: UPDATE outreach_domains
	mock.ExpectExec(`UPDATE outreach_domains SET is_suppressed`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Complaint-rate domains → empty
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	n, err := AutoSuppressFromEvents(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 1 { t.Errorf("n = %d, want 1", n) }
}

func TestAutoSuppressFromEvents_SecondQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Bounced → empty
	mock.ExpectQuery(`SELECT DISTINCT c.email, e.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))

	// Bad-bounce-rate domains → error
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnError(errEnrich("bad domains query failed"))

	_, err = AutoSuppressFromEvents(context.Background(), db)
	if err == nil { t.Error("expected error from second query") }
}

func TestAutoSuppressFromEvents_ThirdQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Bounced → empty
	mock.ExpectQuery(`SELECT DISTINCT c.email, e.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))

	// Bad-bounce-rate domains → empty
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// Complaint-rate domains → error
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnError(errEnrich("complaint query failed"))

	_, err = AutoSuppressFromEvents(context.Background(), db)
	if err == nil { t.Error("expected error from third query") }
}

func TestAutoSuppressFromEvents_WithComplaintDomain(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Bounced → empty
	mock.ExpectQuery(`SELECT DISTINCT c.email, e.id`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))

	// Bad-bounce-rate domains → empty
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	// Complaint-rate domains → 1 domain
	mock.ExpectQuery(`SELECT domain FROM outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}).AddRow("complaint.test"))

	// SuppressDomain: INSERT INTO outreach_suppressions
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// SuppressDomain: UPDATE outreach_domains
	mock.ExpectExec(`UPDATE outreach_domains SET is_suppressed`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	n, err := AutoSuppressFromEvents(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if n != 1 { t.Errorf("n = %d, want 1", n) }
}

type errEnrich string
func (e errEnrich) Error() string { return string(e) }
