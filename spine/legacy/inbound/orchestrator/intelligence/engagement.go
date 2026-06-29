package intelligence

import (
	"context"
	"database/sql"
	"log/slog"
)

// UpdateEngagementClusters aggregates engagement metrics from outreach_contacts
// into the denormalized companies columns and refreshes the engagement_cluster label.
//
// Clusters:
//   - never_contacted: total_sent = 0
//   - bounced:         any bounce recorded
//   - champion:        replied within last 30 days
//   - warm_ghost:      replied at some point, then silent > 30 days
//   - engaged_no_reply: opened at least once, never replied
//
// Returns count of company rows updated.
func UpdateEngagementClusters(ctx context.Context, db *sql.DB) (int, error) {
	res, err := db.ExecContext(ctx, `
		UPDATE companies c
		SET
			total_opened       = agg.total_opened,
			total_bounced      = agg.total_bounced,
			engagement_cluster = CASE
				WHEN agg.total_sent = 0
					THEN 'never_contacted'
				WHEN agg.total_bounced > 0
					THEN 'bounced'
				WHEN agg.total_replied >= 1
				     AND c.last_replied >= now() - interval '30 days'
					THEN 'champion'
				WHEN agg.total_replied >= 1
					THEN 'warm_ghost'
				WHEN agg.total_opened >= 1 AND agg.total_replied = 0
					THEN 'engaged_no_reply'
				ELSE 'never_contacted'
			END,
			updated_at = now()
		FROM (
			SELECT
				company_id,
				COALESCE(SUM(total_sent),    0) AS total_sent,
				COALESCE(SUM(total_opened),  0) AS total_opened,
				COALESCE(SUM(total_replied), 0) AS total_replied,
				COALESCE(SUM(total_bounced), 0) AS total_bounced
			FROM outreach_contacts
			WHERE company_id IS NOT NULL
			GROUP BY company_id
		) agg
		WHERE c.id = agg.company_id
	`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		slog.Info("engagement clusters updated", "companies", n)
	}
	return int(n), nil
}
