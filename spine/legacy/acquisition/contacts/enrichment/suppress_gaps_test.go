package enrich

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── SuppressEmail: thread cascade error (line 61-63) ──
// The thread status UPDATE fails — non-fatal, just a warning.

func TestSuppressEmail_ThreadCascadeError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// INSERT suppression succeeds
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// UPDATE outreach_contacts succeeds
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Thread cascade fails — non-fatal (logs warning only)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("thread table unavailable"))

	err = SuppressEmail(context.Background(), db, "test@firma.cz", SuppressHardBounce, nil)
	if err != nil {
		t.Errorf("expected nil error (thread cascade is non-fatal), got: %v", err)
	}
}

// AutoSuppressFromEvents has 3 queries:
//  1. SELECT DISTINCT c.email, e.id FROM outreach_events e JOIN... (bounced contacts)
//  2. SELECT domain FROM outreach_domains WHERE bounce_rate > 0.10 (bad domains)
//  3. SELECT domain FROM outreach_domains WHERE complaint_rate > 0.001 (complaint domains)

// ── AutoSuppressFromEvents: complaint domain scan error (line 214-215) ──

func TestAutoSuppressFromEvents_ComplaintScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Q1: bounced contacts — empty
	mock.ExpectQuery(`SELECT DISTINCT`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))
	// Q2: bad bounce-rate domains — empty
	mock.ExpectQuery(`SELECT domain`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	// Q3: complaint domains — nil value → Scan fails → continue
	mock.ExpectQuery(`SELECT domain`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}).AddRow(nil))

	result, err := AutoSuppressFromEvents(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = result
}

// ── AutoSuppressFromEvents: SuppressDomain error (line 217-219) ──

func TestAutoSuppressFromEvents_SuppressDomainError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Q1: bounced contacts — empty
	mock.ExpectQuery(`SELECT DISTINCT`).
		WillReturnRows(sqlmock.NewRows([]string{"email", "id"}))
	// Q2: bad bounce-rate domains — empty
	mock.ExpectQuery(`SELECT domain`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))
	// Q3: complaint domains — one domain
	mock.ExpectQuery(`SELECT domain`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}).AddRow("badactor.cz"))

	// SuppressDomain internal queries — INSERT fails → non-fatal
	mock.ExpectExec(`INSERT INTO outreach_domain_suppressions`).
		WillReturnError(errors.New("insert failed"))

	result, err := AutoSuppressFromEvents(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = result
}
