package enrich

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// recalcAllColumns lists the column names returned by the RecalculateAll query.
var recalcAllColumns = []string{
	"id", "email", "industry_tags", "industry_confidence", "company_size",
	"targeting_score", "total_sent", "total_opened", "total_replied", "total_bounced",
	"last_contacted", "status",
	"domain_type", "bounce_rate", "is_suppressed", "domain_complaint_rate",
	"email_status", "honeypot_count",
}

func TestRecalculateAll_OneRow_ScoreChanges(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns).AddRow(
			1, "jan@firma.cz", "{machinery}", 0.8, "25 - 49 zaměstnanců",
			0.10,
			0, 0, 0, 0,
			nil, "active",
			"corporate", 0.02, false, 0.0, "valid", 0,
		))

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("Total = %d, want 1", result.Total)
	}
	if result.Updated != 1 {
		t.Errorf("Updated = %d, want 1", result.Updated)
	}
}

func TestRecalculateAll_MultipleRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	rows := sqlmock.NewRows(recalcAllColumns).
		AddRow(
			1, "high@firma.cz", "{machinery}", 0.9, "25 - 49 zaměstnanců",
			0.10,
			0, 0, 0, 0,
			nil, "active",
			"corporate", 0.01, false, 0.0, "valid", 0,
		).
		AddRow(
			2, "bounced@firma.cz", "{}", 0.0, "",
			0.80,
			5, 0, 0, 3,
			nil, "active",
			nil, nil, nil, 0.0, "valid", 0,
		)

	mock.ExpectQuery(`SELECT c.id, c.email`).WillReturnRows(rows)

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 2 {
		t.Errorf("Total = %d, want 2", result.Total)
	}
	if result.Updated != 2 {
		t.Errorf("Updated = %d, want 2", result.Updated)
	}
	if result.Promoted < 1 {
		t.Errorf("Promoted = %d, want >= 1", result.Promoted)
	}
}

func TestRecalculateAll_PrepareUpdateError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns))

	mock.ExpectPrepare(`UPDATE outreach_contacts`).
		WillReturnError(errEnrich("prepare update failed"))

	_, err = RecalculateAll(context.Background(), db, []string{"machinery"})
	if err == nil {
		t.Error("expected error from prepare update")
	}
}

func TestRecalculateAll_HistoryTableMissing_ContinuesWithoutHistory(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns).AddRow(
			1, "jan@firma.cz", "{machinery}", 0.9, "25 - 49 zaměstnanců",
			0.10,
			0, 0, 0, 0,
			nil, "active",
			"corporate", 0.01, false, 0.0, "valid", 0,
		))

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`).
		WillReturnError(errEnrich("table does not exist"))

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Updated != 1 {
		t.Errorf("Updated = %d, want 1", result.Updated)
	}
}

func TestRecalculateAll_ScoreUnchanged_NoUpdate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// base=0.5, no industry match, no size bonus, freemail=0 → ~0.5
	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns).AddRow(
			1, "someone@seznam.cz", "{}", 0.0, "",
			0.50,
			0, 0, 0, 0,
			nil, "active",
			"freemail", 0.0, false, 0.0, "valid", 0,
		))

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("Total = %d, want 1", result.Total)
	}
	if result.Updated != 0 {
		t.Errorf("Updated = %d, want 0 (score unchanged)", result.Updated)
	}
}

func TestRecalculateAll_WithLastContacted(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	recentTime := time.Now().Add(-15 * 24 * time.Hour)

	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns).AddRow(
			1, "jan@firma.cz", "{machinery}", 0.8, "25 - 49 zaměstnanců",
			0.10,
			5, 3, 1, 0,
			recentTime, "active",
			"corporate", 0.01, false, 0.0, "valid", 0,
		))

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Updated != 1 {
		t.Errorf("Updated = %d, want 1", result.Updated)
	}
}

func TestRecalculateAll_DemotedAndBlocked(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Domain suppressed → score drops from 0.50 to ~0.0
	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns).AddRow(
			1, "user@bad.cz", "{}", 0.0, "",
			0.50,
			0, 0, 0, 0,
			nil, "active",
			"corporate", 0.5, true, 0.0, "valid", 0,
		))

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Demoted < 1 {
		t.Errorf("Demoted = %d, want >= 1", result.Demoted)
	}
	if result.Blocked < 1 {
		t.Errorf("Blocked = %d, want >= 1", result.Blocked)
	}
}

func TestRecalculateAll_RoleBasedEmail(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns).AddRow(
			1, "info@firma.cz", "{machinery}", 0.8, "25 - 49 zaměstnanců",
			0.10,
			0, 0, 0, 0,
			nil, "active",
			"corporate", 0.01, false, 0.0, "valid", 0,
		))

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Updated != 1 {
		t.Errorf("Updated = %d, want 1", result.Updated)
	}
}

// ── Helper tests for recalc utility functions (not duplicated from enrich_test.go) ──

func TestBuildPGArray_Escaping(t *testing.T) {
	tests := []struct {
		input []string
		want  string
	}{
		{nil, "ARRAY[]::text[]"},
		{[]string{}, "ARRAY[]::text[]"},
		{[]string{"machinery"}, "ARRAY['machinery']"},
		{[]string{"machinery", "metalwork"}, "ARRAY['machinery','metalwork']"},
		{[]string{"it's"}, "ARRAY['it''s']"},
	}
	for _, tt := range tests {
		if got := buildPGArray(tt.input); got != tt.want {
			t.Errorf("buildPGArray(%v) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestNullHelpers_AllTypes(t *testing.T) {
	if got := nullString(sql.NullString{String: "hello", Valid: true}); got != "hello" {
		t.Errorf("nullString valid = %q", got)
	}
	if got := nullString(sql.NullString{}); got != "" {
		t.Errorf("nullString invalid = %q", got)
	}
	if got := nullFloat(sql.NullFloat64{Float64: 1.5, Valid: true}); got != 1.5 {
		t.Errorf("nullFloat valid = %f", got)
	}
	if got := nullFloat(sql.NullFloat64{}); got != 0 {
		t.Errorf("nullFloat invalid = %f", got)
	}
	if got := nullBool(sql.NullBool{Bool: true, Valid: true}); !got {
		t.Error("nullBool valid true = false")
	}
	if got := nullBool(sql.NullBool{}); got {
		t.Error("nullBool invalid = true")
	}
}
