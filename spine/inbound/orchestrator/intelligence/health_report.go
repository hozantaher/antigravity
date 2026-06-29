package intelligence

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// HealthReport aggregates data health metrics across all companies and segments.
type HealthReport struct {
	GeneratedAt        string             `json:"generated_at"`
	TotalCompanies     int                `json:"total_companies"`
	EligibleCompanies  int                `json:"eligible_companies"`
	ClassifiedPct      float64            `json:"classified_pct"`
	EmailValidPct      float64            `json:"email_valid_pct"`
	AvgCompleteness    float64            `json:"avg_completeness"`
	ICPTierCounts      map[string]int     `json:"icp_tier_counts"`
	EngagementClusters map[string]int     `json:"engagement_clusters"`
	SectorDistribution map[string]int     `json:"sector_distribution"`
	SegmentHealth      []SegmentSummary   `json:"segment_health"`
}

// SegmentSummary is a single row from the segment_health view.
type SegmentSummary struct {
	ID            int64   `json:"id"`
	Name          string  `json:"name"`
	CompanyCount  int     `json:"company_count"`
	LastBuiltAt   *string `json:"last_built_at,omitempty"`
	AvgICPScore   float64 `json:"avg_icp_score"`
	EmailValidPct float64 `json:"email_valid_pct"`
	ClassifiedPct float64 `json:"classified_pct"`
	Champions     int     `json:"champions"`
	WarmGhosts    int     `json:"warm_ghosts"`
	Untouched     int     `json:"untouched"`
}

// BuildHealthReport queries the companies table and health views to build a full report.
func BuildHealthReport(ctx context.Context, db *sql.DB) (*HealthReport, error) {
	report := &HealthReport{
		GeneratedAt:        time.Now().UTC().Format(time.RFC3339),
		ICPTierCounts:      make(map[string]int),
		EngagementClusters: make(map[string]int),
		SectorDistribution: make(map[string]int),
	}

	// Overall counts and percentages.
	err := db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COUNT(*) FILTER (WHERE exclusion_status = 'pass'),
			ROUND(COUNT(*) FILTER (WHERE sector_primary IS NOT NULL AND exclusion_status = 'pass')::numeric
			      / NULLIF(COUNT(*) FILTER (WHERE exclusion_status = 'pass'), 0) * 100, 1),
			ROUND(COUNT(*) FILTER (WHERE email_status = 'valid' AND exclusion_status = 'pass')::numeric
			      / NULLIF(COUNT(*) FILTER (WHERE exclusion_status = 'pass'), 0) * 100, 1),
			ROUND(
				AVG(
					(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END +
					 CASE WHEN telephone IS NOT NULL THEN 1 ELSE 0 END +
					 CASE WHEN website IS NOT NULL THEN 1 ELSE 0 END +
					 CASE WHEN description IS NOT NULL AND description != '' THEN 1 ELSE 0 END +
					 CASE WHEN nace_codes IS NOT NULL AND nace_codes != '{}' THEN 1 ELSE 0 END +
					 CASE WHEN sector_primary IS NOT NULL THEN 1 ELSE 0 END +
					 CASE WHEN region_normalized IS NOT NULL AND region_normalized != '' THEN 1 ELSE 0 END +
					 CASE WHEN datum_vzniku IS NOT NULL THEN 1 ELSE 0 END +
					 CASE WHEN icp_factors IS NOT NULL AND icp_factors != '{}' THEN 1 ELSE 0 END +
					 CASE WHEN description_tags IS NOT NULL AND description_tags != '{}' THEN 1 ELSE 0 END
					)::numeric / 10.0
				) FILTER (WHERE exclusion_status = 'pass'), 2
			)
		FROM companies
	`).Scan(
		&report.TotalCompanies,
		&report.EligibleCompanies,
		&report.ClassifiedPct,
		&report.EmailValidPct,
		&report.AvgCompleteness,
	)
	if err != nil {
		return nil, fmt.Errorf("health report: overview: %w", err)
	}

	// ICP tier distribution.
	icpRows, err := db.QueryContext(ctx, `
		SELECT COALESCE(icp_tier, 'unscored'), COUNT(*)
		FROM companies WHERE exclusion_status = 'pass'
		GROUP BY 1 ORDER BY 2 DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("health report: icp tiers: %w", err)
	}
	defer icpRows.Close()
	for icpRows.Next() {
		var tier string
		var count int
		if err := icpRows.Scan(&tier, &count); err == nil {
			report.ICPTierCounts[tier] = count
		}
	}

	// Engagement cluster distribution.
	clusterRows, err := db.QueryContext(ctx, `
		SELECT COALESCE(engagement_cluster, 'never_contacted'), COUNT(*)
		FROM companies WHERE exclusion_status = 'pass'
		GROUP BY 1 ORDER BY 2 DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("health report: clusters: %w", err)
	}
	defer clusterRows.Close()
	for clusterRows.Next() {
		var cluster string
		var count int
		if err := clusterRows.Scan(&cluster, &count); err == nil {
			report.EngagementClusters[cluster] = count
		}
	}

	// Top sector distribution (top 15).
	sectorRows, err := db.QueryContext(ctx, `
		SELECT sector_primary, COUNT(*)
		FROM companies
		WHERE exclusion_status = 'pass' AND sector_primary IS NOT NULL
		GROUP BY 1 ORDER BY 2 DESC LIMIT 15
	`)
	if err != nil {
		return nil, fmt.Errorf("health report: sectors: %w", err)
	}
	defer sectorRows.Close()
	for sectorRows.Next() {
		var sector string
		var count int
		if err := sectorRows.Scan(&sector, &count); err == nil {
			report.SectorDistribution[sector] = count
		}
	}

	// Segment health (from view — may not exist if no segments created yet).
	segRows, err := db.QueryContext(ctx, `
		SELECT id, name, company_count, last_built_at,
		       avg_icp_score, email_valid_pct, classified_pct,
		       champions, warm_ghosts, untouched
		FROM segment_health
		ORDER BY company_count DESC
	`)
	if err == nil {
		defer segRows.Close()
		for segRows.Next() {
			var ss SegmentSummary
			var lastBuilt sql.NullTime
			var emailPct, classifiedPct sql.NullFloat64
			if err := segRows.Scan(
				&ss.ID, &ss.Name, &ss.CompanyCount, &lastBuilt,
				&ss.AvgICPScore, &emailPct, &classifiedPct,
				&ss.Champions, &ss.WarmGhosts, &ss.Untouched,
			); err != nil {
				continue
			}
			if lastBuilt.Valid {
				s := lastBuilt.Time.UTC().Format(time.RFC3339)
				ss.LastBuiltAt = &s
			}
			if emailPct.Valid {
				ss.EmailValidPct = emailPct.Float64
			}
			if classifiedPct.Valid {
				ss.ClassifiedPct = classifiedPct.Float64
			}
			report.SegmentHealth = append(report.SegmentHealth, ss)
		}
	}

	return report, nil
}

// PrintHealthReport writes the JSON report to stdout with indentation.
func PrintHealthReport(report *HealthReport) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}
