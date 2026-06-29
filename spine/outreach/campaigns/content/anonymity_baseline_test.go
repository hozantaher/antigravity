//go:build integration
// +build integration

package content

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

// TestAnonymityBaseline_RatchetScoreDrop is an opt-in integration test
// that guards against unintended anonymity score regressions.
//
// The test reads all anonymity_test_messages rows from the past 7 days,
// groups them by (sender_mailbox_id, template_name), computes the median
// anonymity_score per group, and fails if any group's current run drops
// more than 5 points below the 7-day median.
//
// The test is safe to run on a fresh checkout: if the anonymity_test_messages
// table is empty or has no baseline data, the test logs and passes early.
//
// Run with:
//
//	DATABASE_URL=postgres://... go test -tags=integration \
//	  -run TestAnonymityBaseline_RatchetScoreDrop \
//	  ./content/ -count=1
//
// Use case: part of the CI suite to lock anonymity scores as part of
// the cross-mailbox anonymity test initiative (S6).
func TestAnonymityBaseline_RatchetScoreDrop(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping anonymity baseline ratchet")
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("db.Ping: %v", err)
	}

	// Check if table exists and has data.
	var tableExists bool
	err = db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_name = 'anonymity_test_messages'
		)
	`).Scan(&tableExists)
	if err != nil {
		t.Fatalf("check table existence: %v", err)
	}

	if !tableExists {
		t.Log("anonymity_test_messages table does not exist; skipping baseline check")
		return
	}

	// Fetch baseline data: median score per (sender_mailbox_id, template_name)
	// from the past 7 days.
	type baselineKey struct {
		senderMailboxID int64
		templateName    string
	}
	baseline := make(map[baselineKey]int) // group key -> median score

	rows, err := db.QueryContext(ctx, `
		SELECT
			sender_mailbox_id,
			template_name,
			PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY anonymity_score)::int
		FROM anonymity_test_messages
		WHERE anonymity_score IS NOT NULL
			AND scored_at >= now() - interval '7 days'
		GROUP BY sender_mailbox_id, template_name
	`)
	if err != nil {
		t.Fatalf("query baseline data: %v", err)
	}
	defer rows.Close()

	var rowCount int
	for rows.Next() {
		var senderID int64
		var templateName string
		var medianScore int
		if err := rows.Scan(&senderID, &templateName, &medianScore); err != nil {
			t.Fatalf("scan baseline row: %v", err)
		}
		baseline[baselineKey{senderID, templateName}] = medianScore
		rowCount++
	}

	if err := rows.Err(); err != nil {
		t.Fatalf("baseline query error: %v", err)
	}

	if rowCount == 0 {
		t.Logf("no baseline data in past 7 days; skipping check (table has %d scored rows total)",
			countScoredRows(ctx, t, db))
		return
	}

	slog.Info("baseline anonymity ratchet",
		"op", "baseline.load",
		"baseline_groups", rowCount)

	// Now check current run: for each (sender, template) group, verify
	// that the latest run's average score is not more than 5 points below
	// the baseline median.
	type groupStats struct {
		senderMailboxID int64
		templateName    string
		avgScore        float64
		count           int
		minScore        int
	}
	var violations []groupStats

	// Select the most recent test_run_id and check its scores.
	var latestRunID *string
	err = db.QueryRowContext(ctx, `
		SELECT test_run_id
		FROM anonymity_test_messages
		WHERE anonymity_score IS NOT NULL
		ORDER BY scored_at DESC
		LIMIT 1
	`).Scan(&latestRunID)
	if err != nil && err != sql.ErrNoRows {
		t.Fatalf("query latest run_id: %v", err)
	}

	if latestRunID == nil {
		t.Log("no recent scored messages; skipping check")
		return
	}

	// Get stats for the latest run, grouped by (sender, template).
	currentRows, err := db.QueryContext(ctx, `
		SELECT
			sender_mailbox_id,
			template_name,
			AVG(anonymity_score)::float8,
			COUNT(*),
			MIN(anonymity_score)
		FROM anonymity_test_messages
		WHERE test_run_id = $1
			AND anonymity_score IS NOT NULL
		GROUP BY sender_mailbox_id, template_name
	`, latestRunID)
	if err != nil {
		t.Fatalf("query current run stats: %v", err)
	}
	defer currentRows.Close()

	const threshold = 5

	for currentRows.Next() {
		var senderID int64
		var templateName string
		var avgScore float64
		var count int
		var minScore int

		if err := currentRows.Scan(&senderID, &templateName, &avgScore, &count, &minScore); err != nil {
			t.Fatalf("scan current row: %v", err)
		}

		key := baselineKey{senderID, templateName}
		baselineMedian, exists := baseline[key]

		if !exists {
			// New group, no baseline to compare against.
			slog.Info("new anonymity group (no baseline)",
				"op", "baseline.newgroup",
				"sender_mailbox_id", senderID,
				"template_name", templateName,
				"avg_score", avgScore)
			continue
		}

		// Check if current average is more than 5 points below baseline.
		if int(avgScore) < baselineMedian-threshold {
			violations = append(violations, groupStats{
				senderMailboxID: senderID,
				templateName:    templateName,
				avgScore:        avgScore,
				count:           count,
				minScore:        minScore,
			})
		}
	}

	if err := currentRows.Err(); err != nil {
		t.Fatalf("current query error: %v", err)
	}

	// Report results.
	if len(violations) > 0 {
		var msg strings.Builder
		fmt.Fprintf(&msg, "anonymity score drop detected (threshold > 5 points):\n")
		for _, v := range violations {
			baselineMedian := baseline[baselineKey{v.senderMailboxID, v.templateName}]
			drop := baselineMedian - int(v.avgScore)
			fmt.Fprintf(&msg,
				"  sender=%d template=%q baseline_median=%d current_avg=%.1f drop=%d min=%d\n",
				v.senderMailboxID, v.templateName, baselineMedian, v.avgScore, drop, v.minScore)
		}
		t.Errorf("%s\nRun diagnostics from docs/playbooks/anonymity-baseline.md", msg.String())
	}
}

// countScoredRows returns the total number of rows with non-NULL anonymity_score.
// Used for logging context when no 7-day baseline exists.
func countScoredRows(ctx context.Context, t *testing.T, db *sql.DB) int {
	var count int
	err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM anonymity_test_messages
		WHERE anonymity_score IS NOT NULL
	`).Scan(&count)
	if err != nil {
		t.Logf("count scored rows error: %v", err)
		return 0
	}
	return count
}
