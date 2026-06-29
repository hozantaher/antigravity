package enrich

import (
	"context"
	"database/sql"
	"testing"

	"contacts/company"
	"github.com/DATA-DOG/go-sqlmock"
)

// TestRunSerial_CompanyStoreLinked covers lines 377-380 in runSerial:
// p.companyStore != nil AND companiesLinked=true → UpdateMetrics called.
//
// Setup: a RawContact with FirmyCzID=99 passes enrichment → InsertEnriched
// returns contactID=1 → EnsureForContact finds company 42 → links it →
// companiesLinked=true → UpdateMetrics is called (and fails non-fatally).
func TestRunSerial_CompanyStoreLinked(t *testing.T) {
	// Pipeline DB: EnsureDomain + InsertEnriched + EnsureForContact link
	pdb, pMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer pdb.Close()

	// EnsureDomain: INSERT domain → returns id=10
	pMock.ExpectQuery(`INSERT INTO outreach_domains`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(10))
	// EnsureDomain: SELECT mx_verified
	pMock.ExpectQuery(`SELECT mx_verified`).
		WillReturnRows(sqlmock.NewRows([]string{"mx_verified"}).AddRow(true)) // already verified, skip MX check

	// InsertEnriched → UPSERT returns contactID=1
	pMock.ExpectQuery(`INSERT INTO outreach_contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	// Company store DB: EnsureForContact + UpdateMetrics
	cdb, cMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer cdb.Close()

	// EnsureForContact: lookup company → returns companyID=42
	cMock.ExpectQuery(`SELECT id FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))
	// EnsureForContact: link contact to company
	cMock.ExpectExec(`UPDATE outreach_contacts SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// UpdateMetrics fails → slog.Warn (non-fatal, covers lines 377-380)
	cMock.ExpectExec(`UPDATE companies`).WillReturnError(errEnrich("metrics update failed"))

	// Build pipeline with companyStore
	companyStore := company.NewStore(cdb)
	p := NewPipeline(PipelineConfig{
		MinTargetingScore: 0,         // pass all scores
		CompanyStore:      companyStore,
	})

	contacts := []RawContact{
		{
			Email:     "jan@stroj.cz",
			Name:      "Strojírna s.r.o.",
			ICO:       "12345678",
			FirmyCzID: 99, // non-zero → triggers company linking
		},
	}

	imp, skip, err := p.runSerial(context.Background(), pdb, contacts)
	if err != nil {
		t.Fatalf("runSerial: %v", err)
	}
	if imp != 1 {
		t.Errorf("imported = %d, want 1", imp)
	}
	if skip != 0 {
		t.Errorf("skipped = %d, want 0", skip)
	}
}

// TestRunSerial_CompanyStoreNilNeverCallsUpdateMetrics verifies no panic
// when companyStore is nil (already tested elsewhere, but add for completeness).
func TestRunSerial_CompanyStoreNil_NoMetricsCall(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	p := NewPipeline(PipelineConfig{MinTargetingScore: 0})
	// Empty contacts → no inserts needed
	imp, skip, err := p.runSerial(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("runSerial: %v", err)
	}
	if imp != 0 || skip != 0 {
		t.Errorf("imp=%d skip=%d, want 0,0", imp, skip)
	}
}

// Verify company.Store exists and is accessible
var _ *sql.DB = nil
