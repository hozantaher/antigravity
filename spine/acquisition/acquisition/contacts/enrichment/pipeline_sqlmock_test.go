package enrich

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── Stats via sqlmock ──

func TestStats_WithData(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "new", "active", "suppressed",
			"score_auto", "score_low", "score_manual", "score_block",
		}).AddRow(1000, 200, 700, 70, 400, 250, 200, 150))

	stats, err := Stats(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if stats["total"] != 1000 { t.Errorf("total = %d, want 1000", stats["total"]) }
	if stats["active"] != 700 { t.Errorf("active = %d, want 700", stats["active"]) }
	if stats["score_auto"] != 400 { t.Errorf("score_auto = %d, want 400", stats["score_auto"]) }
}

func TestStats_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"total", "new", "active", "suppressed",
			"score_auto", "score_low", "score_manual", "score_block",
		}))

	stats, err := Stats(context.Background(), db)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if len(stats) != 0 { t.Errorf("expected empty stats") }
}

func TestStats_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnError(errEnrich("stats query failed"))

	_, err = Stats(context.Background(), db)
	if err == nil { t.Error("expected error") }
}

// ── LinkContactToCompany via sqlmock ──

func TestLinkContactToCompany_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_contacts SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Should not panic — errors are swallowed
	LinkContactToCompany(context.Background(), db, 42, 1001)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestLinkContactToCompany_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_contacts SET company_id`).
		WillReturnError(errEnrich("update failed"))

	// Should not panic — error is logged via slog.Debug
	LinkContactToCompany(context.Background(), db, 1, 999)
}
