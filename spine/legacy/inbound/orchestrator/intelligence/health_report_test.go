package intelligence

import (
	"context"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── BuildHealthReport ─────────────────────────────────────────────────────────

func TestBuildHealthReport_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Overview query
	mock.ExpectQuery(`SELECT\s+COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "eligible", "classified_pct", "email_valid_pct", "avg_completeness",
		}).AddRow(10000, 9500, 78.5, 62.3, 0.73))

	// ICP tier distribution
	mock.ExpectQuery(`SELECT COALESCE\(icp_tier`).
		WillReturnRows(sqlmock.NewRows([]string{"tier", "count"}).
			AddRow("ideal", 1200).
			AddRow("good", 3400).
			AddRow("marginal", 2100).
			AddRow("irrelevant", 2800),
		)

	// Engagement clusters
	mock.ExpectQuery(`SELECT COALESCE\(engagement_cluster`).
		WillReturnRows(sqlmock.NewRows([]string{"cluster", "count"}).
			AddRow("never_contacted", 5000).
			AddRow("champion", 200).
			AddRow("warm_ghost", 400),
		)

	// Sector distribution
	mock.ExpectQuery(`SELECT sector_primary`).
		WillReturnRows(sqlmock.NewRows([]string{"sector", "count"}).
			AddRow("machinery", 2500).
			AddRow("metalwork", 1800).
			AddRow("construction", 1200),
		)

	// Segment health (error → silently skipped)
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnError(errIntel("segment_health view not found"))

	report, err := BuildHealthReport(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if report.TotalCompanies != 10000 {
		t.Errorf("TotalCompanies = %d, want 10000", report.TotalCompanies)
	}
	if report.EligibleCompanies != 9500 {
		t.Errorf("EligibleCompanies = %d, want 9500", report.EligibleCompanies)
	}
	if report.ClassifiedPct != 78.5 {
		t.Errorf("ClassifiedPct = %.1f, want 78.5", report.ClassifiedPct)
	}
	if report.EmailValidPct != 62.3 {
		t.Errorf("EmailValidPct = %.1f, want 62.3", report.EmailValidPct)
	}
	if report.AvgCompleteness != 0.73 {
		t.Errorf("AvgCompleteness = %.2f, want 0.73", report.AvgCompleteness)
	}

	// ICP tiers
	if report.ICPTierCounts["ideal"] != 1200 {
		t.Errorf("ideal = %d, want 1200", report.ICPTierCounts["ideal"])
	}
	if report.ICPTierCounts["good"] != 3400 {
		t.Errorf("good = %d, want 3400", report.ICPTierCounts["good"])
	}

	// Engagement clusters
	if report.EngagementClusters["never_contacted"] != 5000 {
		t.Errorf("never_contacted = %d, want 5000", report.EngagementClusters["never_contacted"])
	}
	if report.EngagementClusters["champion"] != 200 {
		t.Errorf("champion = %d, want 200", report.EngagementClusters["champion"])
	}

	// Sector distribution
	if report.SectorDistribution["machinery"] != 2500 {
		t.Errorf("machinery = %d, want 2500", report.SectorDistribution["machinery"])
	}

	// Segments silently skipped on error → nil slice
	if len(report.SegmentHealth) != 0 {
		t.Errorf("SegmentHealth = %d, want 0 (view error should be ignored)", len(report.SegmentHealth))
	}

	if !strings.Contains(report.GeneratedAt, "T") {
		t.Errorf("GeneratedAt = %q, want RFC3339 format", report.GeneratedAt)
	}
}

func TestBuildHealthReport_WithSegments(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Overview
	mock.ExpectQuery(`SELECT\s+COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "eligible", "classified_pct", "email_valid_pct", "avg_completeness",
		}).AddRow(100, 90, 80.0, 70.0, 0.65))

	// ICP tiers — empty
	mock.ExpectQuery(`SELECT COALESCE\(icp_tier`).
		WillReturnRows(sqlmock.NewRows([]string{"tier", "count"}))

	// Clusters — empty
	mock.ExpectQuery(`SELECT COALESCE\(engagement_cluster`).
		WillReturnRows(sqlmock.NewRows([]string{"cluster", "count"}))

	// Sectors — empty
	mock.ExpectQuery(`SELECT sector_primary`).
		WillReturnRows(sqlmock.NewRows([]string{"sector", "count"}))

	// Segment health — 1 row
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "company_count", "last_built_at",
			"avg_icp_score", "email_valid_pct", "classified_pct",
			"champions", "warm_ghosts", "untouched",
		}).AddRow(1, "Premium", 50, nil, 0.82, 0.75, 0.90, 5, 10, 35))

	report, err := BuildHealthReport(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(report.SegmentHealth) != 1 {
		t.Fatalf("SegmentHealth = %d, want 1", len(report.SegmentHealth))
	}
	seg := report.SegmentHealth[0]
	if seg.Name != "Premium" {
		t.Errorf("Name = %q, want Premium", seg.Name)
	}
	if seg.CompanyCount != 50 {
		t.Errorf("CompanyCount = %d, want 50", seg.CompanyCount)
	}
	if seg.LastBuiltAt != nil {
		t.Errorf("LastBuiltAt should be nil (NULL in DB)")
	}
	if seg.Champions != 5 {
		t.Errorf("Champions = %d, want 5", seg.Champions)
	}
}

func TestBuildHealthReport_OverviewQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT\s+COUNT`).
		WillReturnError(errIntel("db down"))

	_, err = BuildHealthReport(context.Background(), db)
	if err == nil {
		t.Error("expected error when overview query fails")
	}
}

func TestBuildHealthReport_ICPQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT\s+COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "eligible", "classified_pct", "email_valid_pct", "avg_completeness",
		}).AddRow(0, 0, 0.0, 0.0, 0.0))

	mock.ExpectQuery(`SELECT COALESCE\(icp_tier`).
		WillReturnError(errIntel("icp query failed"))

	_, err = BuildHealthReport(context.Background(), db)
	if err == nil {
		t.Error("expected error when ICP tier query fails")
	}
}

// ── SegmentSummary null handling ──────────────────────────────────────────────

func TestBuildHealthReport_SegmentNullEmailPct(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT\s+COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "eligible", "classified_pct", "email_valid_pct", "avg_completeness",
		}).AddRow(0, 0, 0.0, 0.0, 0.0))
	mock.ExpectQuery(`SELECT COALESCE\(icp_tier`).WillReturnRows(sqlmock.NewRows([]string{"tier", "count"}))
	mock.ExpectQuery(`SELECT COALESCE\(engagement_cluster`).WillReturnRows(sqlmock.NewRows([]string{"cluster", "count"}))
	mock.ExpectQuery(`SELECT sector_primary`).WillReturnRows(sqlmock.NewRows([]string{"sector", "count"}))
	// Null email_valid_pct and classified_pct
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "company_count", "last_built_at",
			"avg_icp_score", "email_valid_pct", "classified_pct",
			"champions", "warm_ghosts", "untouched",
		}).AddRow(1, "Empty", 0, nil, 0.0, nil, nil, 0, 0, 0))

	report, err := BuildHealthReport(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(report.SegmentHealth) != 1 {
		t.Fatalf("SegmentHealth = %d, want 1", len(report.SegmentHealth))
	}
	if report.SegmentHealth[0].EmailValidPct != 0 {
		t.Errorf("EmailValidPct = %f, want 0 for null", report.SegmentHealth[0].EmailValidPct)
	}
	if report.SegmentHealth[0].ClassifiedPct != 0 {
		t.Errorf("ClassifiedPct = %f, want 0 for null", report.SegmentHealth[0].ClassifiedPct)
	}
}
