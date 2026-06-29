package company

import (
	"context"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── BackfillCategoriesJSON gap coverage ──────────────────────────────────

// TestBackfillCategoriesJSON_ScanError covers the rows.Scan error branch.
func TestBackfillCategoriesJSON_ScanError(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	// Return three columns instead of two to trigger scan error.
	firmyMock.ExpectQuery(`SELECT id, categories_json FROM firmy_cz_businesses`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "categories_json", "extra"}).
			AddRow(1, `["a"]`, "unexpected"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.BackfillCategoriesJSON(context.Background())
	if err == nil {
		t.Error("expected scan error")
	}
}

// TestBackfillCategoriesJSON_RowsErr covers the rows.Err() path after iteration.
func TestBackfillCategoriesJSON_RowsErr(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	rows := sqlmock.NewRows([]string{"id", "categories_json"}).
		AddRow(1, `["Strojirenstvi"]`).
		RowError(0, errCompany("row iteration error"))

	firmyMock.ExpectQuery(`SELECT id, categories_json FROM firmy_cz_businesses`).
		WillReturnRows(rows)

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.BackfillCategoriesJSON(context.Background())
	if err == nil {
		t.Error("expected rows.Err() to propagate")
	}
}

// TestBackfillCategoriesJSON_UpdateError covers the outreach DB update error path.
func TestBackfillCategoriesJSON_UpdateError(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	firmyMock.ExpectQuery(`SELECT id, categories_json FROM firmy_cz_businesses`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "categories_json"}).
			AddRow(10, `["Strojirenstvi"]`))

	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errCompany("update failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.BackfillCategoriesJSON(context.Background())
	if err == nil {
		t.Error("expected error from update")
	}
}

// TestBackfillCategoriesJSON_MultiBatch_IDTracking catches `> → <` mutation on
// `if p.id > lastID { lastID = p.id }` in BackfillCategoriesJSON.
func TestBackfillCategoriesJSON_MultiBatch_IDTracking(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	// Batch 1: exactly batchSize=2 rows (loop must continue).
	firmyMock.ExpectQuery(`SELECT id, categories_json FROM firmy_cz_businesses`).
		WithArgs(0, 2).
		WillReturnRows(sqlmock.NewRows([]string{"id", "categories_json"}).
			AddRow(10, `["a"]`).
			AddRow(20, `["b"]`))

	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	// Batch 2: must use lastID=20.
	firmyMock.ExpectQuery(`SELECT id, categories_json FROM firmy_cz_businesses`).
		WithArgs(20, 2).
		WillReturnRows(sqlmock.NewRows([]string{"id", "categories_json"}))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 2})
	n, err := syncer.BackfillCategoriesJSON(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 2 {
		t.Errorf("n = %d, want 2", n)
	}
	if err := firmyMock.ExpectationsWereMet(); err != nil {
		t.Errorf("firmy expectations: %v", err)
	}
}

// ── BackfillCategoryPath additional gap coverage ──────────────────────────

// TestBackfillCategoryPath_ScanError covers the rows.Scan error branch.
func TestBackfillCategoryPath_ScanError(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	// Return wrong column count to trigger scan error.
	firmyMock.ExpectQuery(`SELECT id, category_path FROM firmy_cz_businesses`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "category_path", "extra"}).
			AddRow(1, "Výroba", "unexpected"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.BackfillCategoryPath(context.Background())
	if err == nil {
		t.Error("expected scan error")
	}
}

// TestBackfillCategoryPath_RowsErr covers the rows.Err() path.
func TestBackfillCategoryPath_RowsErr(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	rows := sqlmock.NewRows([]string{"id", "category_path"}).
		AddRow(1, "Výroba/Stroje").
		RowError(0, errCompany("row iteration error"))

	firmyMock.ExpectQuery(`SELECT id, category_path FROM firmy_cz_businesses`).
		WillReturnRows(rows)

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.BackfillCategoryPath(context.Background())
	if err == nil {
		t.Error("expected rows.Err() to propagate")
	}
}

// ── bulkUpsert incremental error path ────────────────────────────────────

// TestSyncerRun_Incremental_MaxIDError covers the MAX(firmy_cz_id) query error.
func TestSyncerRun_Incremental_MaxIDError(t *testing.T) {
	firmyDB, _, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	outMock.ExpectQuery(`SELECT COALESCE\(MAX\(firmy_cz_id\)`).
		WillReturnError(errCompany("max id query failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100, Incremental: true})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Error("expected error from incremental max-id query")
	}
}

// TestSyncerRun_LinkByICOError covers LinkContactByICO error after FirmyCzID link succeeds.
func TestSyncerRun_LinkByICOError(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	// Empty firmy batch → bulkUpsert = 0.
	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).
		WillReturnRows(sqlmock.NewRows(firmyBatchCols))

	// LinkContactByFirmyCzID succeeds.
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	// LinkContactByICO fails.
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnError(errCompany("link by ico failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Error("expected error from LinkContactByICO")
	}
}

// TestSyncerRun_MetricsError covers UpdateMetrics error after links succeed.
func TestSyncerRun_MetricsError(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).
		WillReturnRows(sqlmock.NewRows(firmyBatchCols))

	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// UpdateMetrics step 1 fails.
	outMock.ExpectExec(`UPDATE companies co SET`).
		WillReturnError(errCompany("metrics step1 failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Error("expected error from UpdateMetrics")
	}
}

// ── fetchBatch rows.Err() ─────────────────────────────────────────────────

// TestFetchBatch_RowsErr covers the rows.Err() path in Syncer.fetchBatch.
func TestFetchBatch_RowsErr(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	rows := sqlmock.NewRows(firmyBatchCols).
		AddRow(1, "12345678", "Firma s.r.o.", "info@firma.cz", "", "",
			"", "", "", "", "", "", "", "", 4.5, 10).
		RowError(0, errCompany("rows iteration error"))

	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).WillReturnRows(rows)

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, _, err := syncer.fetchBatch(context.Background(), 0)
	if err == nil {
		t.Error("expected rows.Err() to propagate from fetchBatch")
	}
}

// ── property tests ────────────────────────────────────────────────────────

// TestJoinStrings_Property_NeverPanics verifies joinStrings handles arbitrary inputs.
func TestJoinStrings_Property_NeverPanics(t *testing.T) {
	f := func(count uint8) bool {
		defer func() { recover() }()
		ss := make([]string, int(count%50))
		for i := range ss {
			ss[i] = "x"
		}
		joinStrings(ss, ",")
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Error(err)
	}
}

// TestNewSyncer_Property_DefaultBatchSize verifies batch-size normalisation invariant.
func TestNewSyncer_Property_DefaultBatchSize(t *testing.T) {
	f := func(batchSize int32) bool {
		defer func() { recover() }()
		s := NewSyncer(nil, nil, SyncConfig{BatchSize: int(batchSize)})
		return s.cfg.BatchSize > 0
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Error(err)
	}
}
