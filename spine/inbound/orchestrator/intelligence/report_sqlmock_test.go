package intelligence

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── GenerateWeeklyReport via sqlmock ──

func TestGenerateWeeklyReport_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// enrich.Stats query fails → report returns error
	mock.ExpectQuery(`SELECT`).
		WillReturnError(errIntelligence("stats query failed"))

	_, err = GenerateWeeklyReport(context.Background(), db)
	if err == nil { t.Error("expected error when stats query fails") }
}

func TestGenerateWeeklyReport_EmptyDB(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// enrich.Stats
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "new", "active", "suppressed",
			"score_auto", "score_low", "score_manual", "score_block",
		}).AddRow(0, 0, 0, 0, 0, 0, 0, 0))

	// SuppressionStats
	mock.ExpectQuery(`SELECT reason, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"reason", "count"}))

	// TopDomains
	mock.ExpectQuery(`SELECT domain, domain_type`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "domain_type", "total_sent", "bounce_rate", "total_complained",
			"daily_send_cap", "is_suppressed", "active_contacts",
		}))

	// Industry segments query
	mock.ExpectQuery(`SELECT unnest`).
		WillReturnRows(sqlmock.NewRows([]string{"ind", "count", "avg_score"}))

	// New contacts last 7 days
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM outreach_contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// Engagement rates
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"sent", "opened", "replied", "bounced"}).
			AddRow(0, 0, 0, 0))

	report, err := GenerateWeeklyReport(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if report == nil { t.Fatal("report should not be nil") }
	if report.Period == "" { t.Error("period should not be empty") }
	if report.EngagementRate != 0 { t.Errorf("EngagementRate = %f, want 0 (sent=0)", report.EngagementRate) }
}

func TestGenerateWeeklyReport_WithData(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// enrich.Stats
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "new", "active", "suppressed",
			"score_auto", "score_low", "score_manual", "score_block",
		}).AddRow(500, 50, 400, 30, 200, 150, 100, 50))

	// SuppressionStats
	mock.ExpectQuery(`SELECT reason, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"reason", "count"}).
			AddRow("hard_bounce", 5))

	// TopDomains
	mock.ExpectQuery(`SELECT domain, domain_type`).
		WillReturnRows(sqlmock.NewRows([]string{
			"domain", "domain_type", "total_sent", "bounce_rate", "total_complained",
			"daily_send_cap", "is_suppressed", "active_contacts",
		}).AddRow("firma.cz", "b2b", 100, 0.02, 0, 5, false, 50))

	// Industry segments
	mock.ExpectQuery(`SELECT unnest`).
		WillReturnRows(sqlmock.NewRows([]string{"ind", "count", "avg_score"}).
			AddRow("machinery", 80, 0.75))

	// New contacts
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM outreach_contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(12))

	// Engagement
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"sent", "opened", "replied", "bounced"}).
			AddRow(100, 30, 10, 5))

	report, err := GenerateWeeklyReport(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if report.NewLast7Days != 12 { t.Errorf("NewLast7Days = %d, want 12", report.NewLast7Days) }
	if report.EngagementRate == 0 { t.Error("EngagementRate should be > 0") }
	if len(report.TopDomains) != 1 { t.Errorf("TopDomains = %d, want 1", len(report.TopDomains)) }
	if len(report.IndustrySegments) != 1 { t.Errorf("IndustrySegments = %d, want 1", len(report.IndustrySegments)) }
}
