package enrich

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// TestRecalculateAll_UpdateFailure_DoesNotIncrementCounter verifies the
// brownfield fix: a transient DB error on the per-contact UPDATE must not
// silently inflate result.Updated. Operator dashboards read result.Updated
// as ground truth — bare ExecContext without error capture meant a
// reported "Updated 100" could correspond to ~80 actual rows in DB.
func TestRecalculateAll_UpdateFailure_DoesNotIncrementCounter(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns).AddRow(
			1, "jan@firma.cz", "{machinery}", 0.8, "25 - 49 zaměstnanců",
			0.10, // old score; new score will diverge enough to trigger UPDATE
			0, 0, 0, 0,
			nil, "active",
			"corporate", 0.02, false, 0.0, "valid", 0,
		))

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	// Simulate transient DB error on the score UPDATE.
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnError(errors.New("connection reset by peer"))

	// History INSERT must NOT be attempted when the UPDATE failed (the
	// continue branch in the fix skips both the counter and the history
	// write). If sqlmock reports unmet expectations on the history
	// statement, that's the desired behavior — we did NOT register one.

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("RecalculateAll error (must be nil — per-row failure is logged not returned): %v", err)
	}
	if result.Total != 1 {
		t.Errorf("Total = %d, want 1 (the row WAS processed; only the write failed)", result.Total)
	}
	if result.Updated != 0 {
		t.Errorf("Updated = %d, want 0 — counter must reflect actual DB writes, not attempts", result.Updated)
	}
}

// TestRecalculateAll_HistoryFailure_StillCountsUpdate verifies that a
// failure on the best-effort history INSERT does NOT roll back the
// reported Updated count. The score UPDATE succeeded — operator should
// see it counted, even if the audit-history side write hiccuped.
func TestRecalculateAll_HistoryFailure_StillCountsUpdate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnRows(sqlmock.NewRows(recalcAllColumns).AddRow(
			2, "ana@firma.cz", "{machinery}", 0.8, "10 - 24 zaměstnanců",
			0.10,
			0, 0, 0, 0,
			nil, "active",
			"corporate", 0.02, false, 0.0, "valid", 0,
		))

	mock.ExpectPrepare(`UPDATE outreach_contacts`)
	mock.ExpectPrepare(`INSERT INTO outreach_score_history`)

	// UPDATE succeeds.
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// History INSERT fails — must not affect Updated counter.
	mock.ExpectExec(`INSERT INTO outreach_score_history`).
		WillReturnError(errors.New("history table locked"))

	result, err := RecalculateAll(context.Background(), db, []string{"machinery"})
	if err != nil {
		t.Fatalf("RecalculateAll error: %v", err)
	}
	if result.Updated != 1 {
		t.Errorf("Updated = %d, want 1 — history failure must not roll back the score UPDATE counter", result.Updated)
	}
}
