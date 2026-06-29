package company

import (
	"context"
	"database/sql"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func newSyncMocks(t *testing.T) (*sql.DB, sqlmock.Sqlmock, *sql.DB, sqlmock.Sqlmock, func()) {
	t.Helper()
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New firmyDB: %v", err)
	}
	outDB, outMock, err := sqlmock.New()
	if err != nil {
		firmyDB.Close()
		t.Fatalf("sqlmock.New outDB: %v", err)
	}
	cleanup := func() {
		firmyDB.Close()
		outDB.Close()
	}
	return firmyDB, firmyMock, outDB, outMock, cleanup
}

// ── BackfillCategoryPath via sqlmock ──

func TestBackfillCategoryPath_Empty(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	// Empty firmy batch → done immediately
	firmyMock.ExpectQuery(`SELECT id, category_path FROM firmy_cz_businesses`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "category_path"}))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	n, err := syncer.BackfillCategoryPath(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("n = %d, want 0", n)
	}
}

func TestBackfillCategoryPath_FirmyQueryError(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	firmyMock.ExpectQuery(`SELECT id, category_path FROM firmy_cz_businesses`).
		WillReturnError(errCompany("firmy query failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.BackfillCategoryPath(context.Background())
	if err == nil {
		t.Error("expected error")
	}
}

func TestBackfillCategoryPath_WithData(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	// Single batch with 2 rows (< batchSize so loop ends after first batch)
	firmyMock.ExpectQuery(`SELECT id, category_path FROM firmy_cz_businesses`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "category_path"}).
			AddRow(1, "Výroba/Strojírenství").
			AddRow(2, "Obchod/Velkoobchod"))

	// Outreach DB UPDATE
	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	n, err := syncer.BackfillCategoryPath(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 2 {
		t.Errorf("n = %d, want 2", n)
	}
}

// TestBackfillCategoryPath_MultiBatch catches the `> → <` mutation on
// `if p.id > lastID { lastID = p.id }`. With mutation, lastID is never updated,
// so the second batch query uses `WHERE id > 0` instead of `WHERE id > maxID`.
// sqlmock WithArgs detects the wrong argument.
func TestBackfillCategoryPath_MultiBatch(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	// Batch 1: exactly batchSize=2 rows with IDs 10, 20 → loop must continue
	firmyMock.ExpectQuery(`SELECT id, category_path FROM firmy_cz_businesses`).
		WithArgs(0, 2).
		WillReturnRows(sqlmock.NewRows([]string{"id", "category_path"}).
			AddRow(10, "Strojírenství > Výroba").
			AddRow(20, "Obchod > Velkoobchod"))

	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	// Batch 2: query must use lastID=20 (highest ID from batch 1)
	firmyMock.ExpectQuery(`SELECT id, category_path FROM firmy_cz_businesses`).
		WithArgs(20, 2). // mutation `> → <` would pass 0 here → sqlmock mismatch
		WillReturnRows(sqlmock.NewRows([]string{"id", "category_path"}))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 2})
	n, err := syncer.BackfillCategoryPath(context.Background())
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

func TestBackfillCategoryPath_UpdateError(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	firmyMock.ExpectQuery(`SELECT id, category_path FROM firmy_cz_businesses`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "category_path"}).
			AddRow(1, "Výroba/Strojírenství"))

	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errCompany("update failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.BackfillCategoryPath(context.Background())
	if err == nil {
		t.Error("expected error from update")
	}
}

// ── BackfillCategoriesJSON via sqlmock ──

func TestBackfillCategoriesJSON_Empty(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	firmyMock.ExpectQuery(`SELECT id, categories_json FROM firmy_cz_businesses`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "categories_json"}))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	n, err := syncer.BackfillCategoriesJSON(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("n = %d, want 0", n)
	}
}

func TestBackfillCategoriesJSON_QueryError(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	firmyMock.ExpectQuery(`SELECT id, categories_json FROM firmy_cz_businesses`).
		WillReturnError(errCompany("query failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.BackfillCategoriesJSON(context.Background())
	if err == nil {
		t.Error("expected error")
	}
}

func TestBackfillCategoriesJSON_WithData(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	firmyMock.ExpectQuery(`SELECT id, categories_json FROM firmy_cz_businesses`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "categories_json"}).
			AddRow(10, `["Strojírenství","Výroba"]`).
			AddRow(11, `["Obchod"]`))

	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	n, err := syncer.BackfillCategoriesJSON(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 2 {
		t.Errorf("n = %d, want 2", n)
	}
}

// ── Syncer.Run via sqlmock ──

// firmyBatchCols matches fetchBatch's SELECT
var firmyBatchCols = []string{
	"id", "ico", "name", "email",
	"telephone", "website",
	"street_address", "address_locality",
	"postal_code", "description",
	"velikost_firmy", "pravni_forma",
	"category_path", "categories_json",
	"rating_value", "rating_count",
}

func TestSyncerRun_EmptyFirmy(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	// fetchBatch → empty → bulkUpsert returns 0
	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).
		WillReturnRows(sqlmock.NewRows(firmyBatchCols))

	// Phase 2: LinkContactByFirmyCzID
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Phase 2: LinkContactByICO
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Phase 3: UpdateMetrics step 1
	outMock.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Phase 3: UpdateMetrics step 2 (reset)
	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CompaniesUpserted != 0 {
		t.Errorf("CompaniesUpserted = %d, want 0", result.CompaniesUpserted)
	}
}

func TestSyncerRun_FetchBatchError(t *testing.T) {
	firmyDB, firmyMock, outDB, _, cleanup := newSyncMocks(t)
	defer cleanup()

	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).
		WillReturnError(errCompany("firmy query failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Error("expected error from fetchBatch")
	}
}

func TestSyncerRun_LinkError(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	// Empty batch → bulkUpsert succeeds with 0
	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).
		WillReturnRows(sqlmock.NewRows(firmyBatchCols))

	// LinkContactByFirmyCzID fails
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnError(errCompany("link failed"))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Error("expected error from LinkContactByFirmyCzID")
	}
}

func TestSyncerRun_Incremental_EmptyFirmy(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	// Incremental: first SELECT MAX(firmy_cz_id) on outDB
	outMock.ExpectQuery(`SELECT COALESCE\(MAX\(firmy_cz_id\)`).
		WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(500))

	// fetchBatch → empty
	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).
		WillReturnRows(sqlmock.NewRows(firmyBatchCols))

	// Phase 2 links
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Phase 3 metrics
	outMock.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100, Incremental: true})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CompaniesUpserted != 0 {
		t.Errorf("CompaniesUpserted = %d, want 0", result.CompaniesUpserted)
	}
}

func TestSyncerRun_WithOneBatch(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	// fetchBatch returns 1 company (< batchSize → done)
	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).
		WillReturnRows(sqlmock.NewRows(firmyBatchCols).AddRow(
			101, "12345678", "Strojírna s.r.o.", "info@strojirna.cz",
			"+420123456789", "https://strojirna.cz",
			"Václavské nám. 1", "Praha", "110 00", "CNC výroba",
			"25 - 49 zaměstnanců", "s.r.o.",
			"Strojírenství > Výroba", "",
			4.5, 10,
		))

	// Upsert on outDB (uses RETURNING id)
	outMock.ExpectQuery(`INSERT INTO companies`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	// Phase 2 links
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Phase 3 metrics
	outMock.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CompaniesUpserted != 1 {
		t.Errorf("CompaniesUpserted = %d, want 1", result.CompaniesUpserted)
	}
}

func TestSyncerRun_WithOneBatch_PreservesCategoriesJSON(t *testing.T) {
	firmyDB, firmyMock, outDB, outMock, cleanup := newSyncMocks(t)
	defer cleanup()

	categoriesJSON := `[{"name":"Strojirenstvi","url":"https://example.cz"}]`

	firmyMock.ExpectQuery(`SELECT id, COALESCE\(ico`).
		WillReturnRows(sqlmock.NewRows(firmyBatchCols).AddRow(
			101, "12345678", "Strojírna s.r.o.", "info@strojirna.cz",
			"+420123456789", "https://strojirna.cz",
			"Václavské nám. 1", "Praha", "110 00", "CNC výroba",
			"25 - 49 zaměstnanců", "s.r.o.",
			"Strojírenství > Výroba", categoriesJSON,
			4.5, 10,
		))

	outMock.ExpectQuery(`INSERT INTO companies`).
		WithArgs(
			101, "12345678", "Strojírna s.r.o.", "info@strojirna.cz",
			"+420123456789", "https://strojirna.cz",
			"Václavské nám. 1", "Praha", "110 00", "CNC výroba",
			"25 - 49 zaměstnanců", "s.r.o.",
			"Strojírenství > Výroba", categoriesJSON,
			4.5, 10,
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outMock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outMock.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	outMock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	syncer := NewSyncer(firmyDB, outDB, SyncConfig{BatchSize: 100})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CompaniesUpserted != 1 {
		t.Errorf("CompaniesUpserted = %d, want 1", result.CompaniesUpserted)
	}
}
