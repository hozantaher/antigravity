package enrich

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── RecalculateOne via sqlmock ──

func TestRecalculateOne_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT c.email, c.industry_tags`).
		WillReturnError(errEnrich("no contact"))

	_, err = RecalculateOne(context.Background(), db, 99, []string{"machinery"})
	if err == nil { t.Error("expected error") }
}

func TestRecalculateOne_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// QueryRow for contact data.
	// industry_tags must be in Postgres array format {tag} NOT JSON ["tag"] —
	// parseIndustryTagsFromDB expects the PG wire format.
	mock.ExpectQuery(`SELECT c.email, c.industry_tags`).
		WillReturnRows(sqlmock.NewRows([]string{
			"email", "industry_tags", "industry_confidence", "company_size", "targeting_score",
			"total_sent", "total_opened", "total_replied", "total_bounced",
			"last_contacted",
			"domain_type", "bounce_rate", "is_suppressed",
			"domain_complaint_rate", "email_status", "honeypot_count",
		}).AddRow(
			"jan@firma.cz", `{machinery}`, 0.8, "20 - 24 zaměstnanci", 0.30,
			5, 2, 1, 0,
			nil,
			"corporate", 0.02, false,
			0.0, "valid", 0,
		))

	// UPDATE outreach_contacts
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Score should be boosted by industry match + corporate + company size + reply bonus.
	// old_score=0.30, new score should be significantly higher → diff > 0.01 → history INSERT.
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	score, err := RecalculateOne(context.Background(), db, 1, []string{"machinery"})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	// With industry match (0.24) + corporate (0.1) + company size (0.2) + reply bonus
	// base 0.5 → should be well above 0.7
	if score < 0.7 {
		t.Errorf("score = %f, expected >= 0.7 for machinery corporate with reply history", score)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRecalculateOne_UpdateError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT c.email, c.industry_tags`).
		WillReturnRows(sqlmock.NewRows([]string{
			"email", "industry_tags", "industry_confidence", "company_size", "targeting_score",
			"total_sent", "total_opened", "total_replied", "total_bounced",
			"last_contacted",
			"domain_type", "bounce_rate", "is_suppressed",
			"domain_complaint_rate", "email_status", "honeypot_count",
		}).AddRow(
			"jan@firma.cz", nil, nil, nil, 0.5,
			0, 0, 0, 0,
			nil, nil, nil, nil, 0.0, "valid", 0,
		))

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnError(errEnrich("update failed"))

	_, err = RecalculateOne(context.Background(), db, 2, []string{})
	if err == nil { t.Error("expected error from update") }
}
