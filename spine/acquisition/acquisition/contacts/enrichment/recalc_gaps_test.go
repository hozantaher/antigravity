package enrich

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── RecalculateFast: syncErr path (line 222-224) ──
// The score sync UPDATE fails (non-fatal: only logs a warning).

func TestRecalculateFast_SyncFails_NonFatal(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 10))
	// Second UPDATE (score sync) fails — should be non-fatal
	mock.ExpectExec(`UPDATE contacts`).
		WillReturnError(errEnrich("score sync failed"))

	result, err := RecalculateFast(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("expected non-fatal result even with sync error, got: %v", err)
	}
	if result.Updated != 10 {
		t.Errorf("Updated = %d, want 10", result.Updated)
	}
}

// ── RecalculateAll: scan error path (line 358-360) ──
// Row with wrong columns → scan fails → slog.Error; continue

func TestRecalculateAll_ScanError_Continue(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Wrong number of columns → rows.Scan fails
	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email"}).AddRow(1, "x@x.cz"))

	// PrepareContext for updateStmt
	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	// PrepareContext for historyStmt — may fail (skip table)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`).
		WillReturnError(errEnrich("no table"))

	// Final sync
	mock.ExpectExec(`UPDATE contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("expected nil error (scan errors logged and continued): %v", err)
	}
	// Total is 0 because the row was skipped due to scan error
	_ = result
}

// ── RecalculateOne: lastContacted.Valid path (line 495-498) ──
// When lastContacted is non-null in the DB row.

// ── RecalculateOne: score decreased (diff < 0, line 513-515) ──

func TestRecalculateOne_ScoreDecreased(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// oldScore = 0.9 (high), new score will be low → diff < 0
	mock.ExpectQuery(`SELECT c.email`).
		WillReturnRows(sqlmock.NewRows([]string{
			"email",
			"industry_tags", "industry_confidence", "company_size", "targeting_score",
			"total_sent", "total_opened", "total_replied", "total_bounced",
			"last_contacted",
			"domain_type", "bounce_rate", "is_suppressed",
			"domain_complaint_rate", "email_status",
			"honeypot_count",
		}).AddRow(
			"test@firma.cz",
			"{}", nil, "", 0.9, // oldScore = 0.9, no industry tags → low new score
			0, 0, 0, 0,
			nil,
			nil, nil, nil,
			0.0, "valid",
			0,
		))

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Score history for significant diff
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	_, err = RecalculateOne(context.Background(), db, 1, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRecalculateOne_LastContacted_Set(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	// RecalculateOne SELECT query — return row with valid lastContacted
	// Columns: email, industry_tags, industry_confidence, company_size, targeting_score,
	//          total_sent, total_opened, total_replied, total_bounced,
	//          last_contacted, domain_type, bounce_rate, is_suppressed,
	//          domain_complaint_rate, email_status, honeypot_count
	mock.ExpectQuery(`SELECT c.email`).
		WillReturnRows(sqlmock.NewRows([]string{
			"email",
			"industry_tags", "industry_confidence", "company_size", "targeting_score",
			"total_sent", "total_opened", "total_replied", "total_bounced",
			"last_contacted",
			"domain_type", "bounce_rate", "is_suppressed",
			"domain_complaint_rate", "email_status",
			"honeypot_count",
		}).AddRow(
			"test@firma.cz",
			"{machinery}", 0.9, "10 - 19 zaměstnanců", 0.7,
			5, 2, 1, 0,
			now, // lastContacted = non-null → triggers lines 495-498
			"business", 0.02, false,
			0.0, "valid",
			0,
		))

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Expect the score history INSERT (if diff > 0.01)
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	score, err := RecalculateOne(context.Background(), db, 1, []string{"machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if score <= 0 {
		t.Errorf("score = %v, want > 0", score)
	}
}
