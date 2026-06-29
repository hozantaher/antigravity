package intelligence

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"contacts/enrichment"
)

// IndustrySegment summarizes auto-queue contacts for one industry.
type IndustrySegment struct {
	Industry  string
	AutoCount int
	AvgScore  float64
}

// WeeklyReport contains aggregated intelligence for the past 7 days.
type WeeklyReport struct {
	Period           string
	ContactStats     map[string]int
	ScoreDistrib     map[string]int
	SuppressStats    map[string]int
	TopDomains       []DomainReport
	IndustrySegments []IndustrySegment
	EngagementRate   float64
	ReplyRate        float64
	BounceRate       float64
	NewLast7Days     int
}

// GenerateWeeklyReport builds a comprehensive report.
func GenerateWeeklyReport(ctx context.Context, db *sql.DB) (*WeeklyReport, error) {
	report := &WeeklyReport{
		Period: fmt.Sprintf("%s — %s",
			time.Now().AddDate(0, 0, -7).Format("2006-01-02"),
			time.Now().Format("2006-01-02")),
	}

	// Contact stats
	stats, err := enrich.Stats(ctx, db)
	if err != nil {
		return nil, fmt.Errorf("contact stats: %w", err)
	}
	report.ContactStats = stats

	// Score distribution
	report.ScoreDistrib = map[string]int{
		"auto":   stats["score_auto"],
		"low":    stats["score_low"],
		"manual": stats["score_manual"],
		"block":  stats["score_block"],
	}

	// Suppression stats
	suppStats, err := enrich.SuppressionStats(ctx, db)
	if err == nil {
		report.SuppressStats = suppStats
	}

	// Top domains
	domains, err := TopDomains(ctx, db, 10)
	if err == nil {
		report.TopDomains = domains
	}

	// Industry segment breakdown (auto-queue)
	segRows, err := db.QueryContext(ctx, `
		SELECT unnest(industry_tags) as ind, COUNT(*), ROUND(AVG(targeting_score)::numeric, 3)
		FROM outreach_contacts
		WHERE targeting_score >= 0.7
		GROUP BY 1 ORDER BY 2 DESC LIMIT 15
	`)
	if err == nil {
		defer segRows.Close()
		for segRows.Next() {
			var seg IndustrySegment
			if err := segRows.Scan(&seg.Industry, &seg.AutoCount, &seg.AvgScore); err == nil {
				report.IndustrySegments = append(report.IndustrySegments, seg)
			}
		}
	}

	// New contacts added in last 7 days
	db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM outreach_contacts WHERE created_at >= now() - interval '7 days'
	`).Scan(&report.NewLast7Days) //nolint:errcheck

	// Weekly engagement rates
	var sent, opened, replied, bounced int
	db.QueryRowContext(ctx, `
		SELECT
			COUNT(CASE WHEN event_type = 'sent' THEN 1 END),
			COUNT(CASE WHEN event_type = 'opened' THEN 1 END),
			COUNT(CASE WHEN event_type = 'replied' THEN 1 END),
			COUNT(CASE WHEN event_type = 'bounced' THEN 1 END)
		FROM outreach_events
		WHERE created_at >= now() - interval '7 days'
	`).Scan(&sent, &opened, &replied, &bounced)

	if sent > 0 {
		report.EngagementRate = float64(opened) / float64(sent)
		report.ReplyRate = float64(replied) / float64(sent)
		report.BounceRate = float64(bounced) / float64(sent)
	}

	return report, nil
}

// FormatReport renders the report as a text string.
func FormatReport(r *WeeklyReport) string {
	var b strings.Builder

	b.WriteString("╔══════════════════════════════════════════════╗\n")
	b.WriteString("║    Weekly Intelligence Report                ║\n")
	b.WriteString(fmt.Sprintf("║    %s            ║\n", r.Period))
	b.WriteString("╠══════════════════════════════════════════════╣\n")

	b.WriteString("║  CONTACTS                                    ║\n")
	b.WriteString(fmt.Sprintf("║  Total:       %6d                         ║\n", r.ContactStats["total"]))
	b.WriteString(fmt.Sprintf("║  Active:      %6d                         ║\n", r.ContactStats["active"]))
	b.WriteString(fmt.Sprintf("║  New (7d):    %6d                         ║\n", r.NewLast7Days))
	b.WriteString(fmt.Sprintf("║  Suppressed:  %6d                         ║\n", r.ContactStats["suppressed"]))
	b.WriteString("╠══════════════════════════════════════════════╣\n")

	b.WriteString("║  TARGETING SCORES                            ║\n")
	b.WriteString(fmt.Sprintf("║  Auto (≥0.7):    %6d                      ║\n", r.ScoreDistrib["auto"]))
	b.WriteString(fmt.Sprintf("║  Low (0.4-0.7):  %6d                      ║\n", r.ScoreDistrib["low"]))
	b.WriteString(fmt.Sprintf("║  Manual (0.2-4): %6d                      ║\n", r.ScoreDistrib["manual"]))
	b.WriteString(fmt.Sprintf("║  Blocked (<0.2): %6d                      ║\n", r.ScoreDistrib["block"]))
	b.WriteString("╠══════════════════════════════════════════════╣\n")

	b.WriteString("║  WEEKLY ENGAGEMENT                           ║\n")
	b.WriteString(fmt.Sprintf("║  Open rate:   %5.1f%%                         ║\n", r.EngagementRate*100))
	b.WriteString(fmt.Sprintf("║  Reply rate:  %5.1f%%                         ║\n", r.ReplyRate*100))
	b.WriteString(fmt.Sprintf("║  Bounce rate: %5.1f%%                         ║\n", r.BounceRate*100))

	if len(r.SuppressStats) > 0 {
		b.WriteString("╠══════════════════════════════════════════════╣\n")
		b.WriteString("║  SUPPRESSIONS                                ║\n")
		for reason, count := range r.SuppressStats {
			b.WriteString(fmt.Sprintf("║  %-18s %4d                      ║\n", reason, count))
		}
	}

	if len(r.TopDomains) > 0 {
		b.WriteString("╠══════════════════════════════════════════════╣\n")
		b.WriteString("║  TOP DOMAINS                                 ║\n")
		for _, d := range r.TopDomains {
			flag := " "
			if d.IsSuppressed { flag = "!" }
			b.WriteString(fmt.Sprintf("║  %s %-20s sent:%-4d br:%.0f%%    ║\n",
				flag, d.Domain, d.TotalSent, d.BounceRate*100))
		}
	}

	if len(r.IndustrySegments) > 0 {
		b.WriteString("╠══════════════════════════════════════════════╣\n")
		b.WriteString("║  AUTO-QUEUE BY INDUSTRY                      ║\n")
		for _, seg := range r.IndustrySegments {
			b.WriteString(fmt.Sprintf("║  %-18s %6d  avg:%.2f             ║\n",
				seg.Industry, seg.AutoCount, seg.AvgScore))
		}
	}

	b.WriteString("╚══════════════════════════════════════════════╝\n")

	return b.String()
}
