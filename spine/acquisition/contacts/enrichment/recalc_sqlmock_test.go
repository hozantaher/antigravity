package enrich

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── RecalculateFast via sqlmock ──

func TestRecalculateFast_NoIndustries_LoadsFromDB(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Config lookup for target_industries
	mock.ExpectQuery(`SELECT value FROM outreach_config WHERE key`).
		WillReturnRows(sqlmock.NewRows([]string{"value"}).AddRow("machinery,automotive"))

	// UPDATE outreach_contacts (the big score update)
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 50))

	// contacts.score sync (simple UPDATE FROM outreach_contacts)
	mock.ExpectExec(`UPDATE contacts c SET score`).
		WillReturnResult(sqlmock.NewResult(0, 45))

	result, err := RecalculateFast(context.Background(), db, nil)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Updated != 50 { t.Errorf("Updated = %d, want 50", result.Updated) }
}

func TestRecalculateFast_WithIndustries(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// No config lookup since industries provided
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 100))

	mock.ExpectExec(`UPDATE contacts c SET score`).
		WillReturnResult(sqlmock.NewResult(0, 98))

	result, err := RecalculateFast(context.Background(), db, []string{"machinery"})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Total != 100 { t.Errorf("Total = %d, want 100", result.Total) }
}

func TestRecalculateFast_UpdateError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Config lookup fails → no industries → no config either
	mock.ExpectQuery(`SELECT value FROM outreach_config WHERE key`).
		WillReturnError(errEnrich("no config"))

	// UPDATE fails
	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnError(errEnrich("update failed"))

	_, err = RecalculateFast(context.Background(), db, nil)
	if err == nil { t.Error("expected error") }
}

func TestRecalculateFast_ZeroUpdated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_contacts oc`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	mock.ExpectExec(`UPDATE contacts c SET score`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	result, err := RecalculateFast(context.Background(), db, []string{"test"})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Updated != 0 { t.Errorf("Updated = %d, want 0", result.Updated) }
}

// ── RecalculateAll error path ──

func TestRecalculateAll_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnError(errEnrich("query failed"))

	_, err = RecalculateAll(context.Background(), db, []string{"machinery"})
	if err == nil { t.Error("expected error") }
}

func TestRecalculateAll_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Empty query result
	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "email", "industry_tags", "industry_confidence", "company_size",
			"targeting_score", "total_sent", "total_opened", "total_replied", "total_bounced",
			"last_contacted", "status",
			"domain_type", "bounce_rate", "is_suppressed", "domain_complaint_rate", "honeypot_count",
		}))

	// Prepare update statement
	mock.ExpectPrepare(`UPDATE outreach_contacts`)

	// Prepare history statement (may fail, that's OK — it's optional)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Total != 0 { t.Errorf("Total = %d, want 0", result.Total) }
}
