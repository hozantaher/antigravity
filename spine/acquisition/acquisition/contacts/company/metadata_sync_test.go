package company

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func newMetadataSyncMocks(t *testing.T) (*sql.DB, sqlmock.Sqlmock, *sql.DB, sqlmock.Sqlmock, func()) {
	t.Helper()

	sourceDB, sourceMock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New sourceDB: %v", err)
	}
	targetDB, targetMock, err := sqlmock.New()
	if err != nil {
		sourceDB.Close()
		t.Fatalf("sqlmock.New targetDB: %v", err)
	}

	cleanup := func() {
		sourceDB.Close()
		targetDB.Close()
	}
	return sourceDB, sourceMock, targetDB, targetMock, cleanup
}

func metadataColumns() []string {
	return []string{
		"firmy_cz_id", "exclusion_status", "exclusion_reasons", "needs_review",
		"nace_codes", "nace_primary", "v_insolvenci", "v_likvidaci",
		"sector_tags", "sector_primary", "sector_confidence", "sector_source",
		"icp_score", "icp_tier", "region_normalized", "category_path",
		"categories_json", "classified_at",
	}
}

func TestMetadataSyncer_DefaultBatchSize(t *testing.T) {
	syncer := NewMetadataSyncer(nil, nil, MetadataSyncConfig{})
	if syncer.cfg.BatchSize != 5000 {
		t.Fatalf("expected default batch size 5000, got %d", syncer.cfg.BatchSize)
	}
}

func TestMetadataSyncer_Run_EmptySource(t *testing.T) {
	sourceDB, sourceMock, targetDB, _, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{BatchSize: 100})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SourceRows != 0 || result.UpdatedRows != 0 || result.Batches != 0 || result.LastFirmyCzID != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}

	if err := sourceMock.ExpectationsWereMet(); err != nil {
		t.Fatalf("source expectations: %v", err)
	}
}

func TestMetadataSyncer_Run_SingleBatch(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	now := time.Now().UTC().Truncate(time.Second)

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(101, "pass", "{}", false, "{28.41}", "28.41", false, false,
				"{strojirenstvi}", "strojirenstvi", 0.91, "nace", 0.87, "ideal", "praha",
				"Strojirenstvi > Vyroba", `[{"name":"Strojirenstvi"}]`, now).
			AddRow(102, "soft_block", "{missing_email}", true, "{}", "", false, false,
				"{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(102, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{BatchSize: 100})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SourceRows != 2 {
		t.Fatalf("SourceRows = %d, want 2", result.SourceRows)
	}
	if result.UpdatedRows != 2 {
		t.Fatalf("UpdatedRows = %d, want 2", result.UpdatedRows)
	}
	if result.Batches != 1 {
		t.Fatalf("Batches = %d, want 1", result.Batches)
	}
	if result.LastFirmyCzID != 102 {
		t.Fatalf("LastFirmyCzID = %d, want 102", result.LastFirmyCzID)
	}

	if err := sourceMock.ExpectationsWereMet(); err != nil {
		t.Fatalf("source expectations: %v", err)
	}
	if err := targetMock.ExpectationsWereMet(); err != nil {
		t.Fatalf("target expectations: %v", err)
	}
}

func TestMetadataSyncer_Run_MultiBatch(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 2).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(1, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil).
			AddRow(2, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(2, 2).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(3, "hard_block", "{insolvency}", false, "{}", "", true, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(3, 2).
		WillReturnRows(sqlmock.NewRows(metadataColumns()))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{BatchSize: 2})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SourceRows != 3 || result.UpdatedRows != 2 || result.Batches != 2 || result.LastFirmyCzID != 3 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestMetadataSyncer_Run_SourceQueryError(t *testing.T) {
	sourceDB, sourceMock, targetDB, _, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 100).
		WillReturnError(errCompany("source failed"))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{BatchSize: 100})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMetadataSyncer_Run_TargetUpdateError(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(101, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnError(errCompany("target update failed"))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{BatchSize: 100})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMetadataSyncer_Run_StartAfterID(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(500, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(501, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(501, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:    100,
		StartAfterID: 500,
	})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SourceRows != 1 || result.UpdatedRows != 1 || result.LastFirmyCzID != 501 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestMetadataSyncer_Run_UsesCheckpointStartAndSaves(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	targetMock.ExpectQuery(`SELECT last_source_id FROM sync_checkpoints`).
		WithArgs("outreach-prod-metadata-sync").
		WillReturnRows(sqlmock.NewRows([]string{"last_source_id"}).AddRow(500))

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(500, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(501, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	targetMock.ExpectExec(`INSERT INTO sync_checkpoints`).
		WithArgs("outreach-prod-metadata-sync", int64(501), int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(501, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:     100,
		UseCheckpoint: true,
	})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SourceRows != 1 || result.UpdatedRows != 1 || result.LastFirmyCzID != 501 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestMetadataSyncer_Run_CheckpointSaveError(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	targetMock.ExpectQuery(`SELECT last_source_id FROM sync_checkpoints`).
		WithArgs("outreach-prod-metadata-sync").
		WillReturnRows(sqlmock.NewRows([]string{"last_source_id"}).AddRow(500))

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(500, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(501, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	targetMock.ExpectExec(`INSERT INTO sync_checkpoints`).
		WithArgs("outreach-prod-metadata-sync", int64(501), int64(1)).
		WillReturnError(errCompany("checkpoint save failed"))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:     100,
		UseCheckpoint: true,
	})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMetadataSyncer_Run_StartAfterIDOverridesCheckpoint(t *testing.T) {
	sourceDB, sourceMock, targetDB, _, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(700, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:     100,
		StartAfterID:  700,
		UseCheckpoint: true,
	})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SourceRows != 0 || result.UpdatedRows != 0 || result.LastFirmyCzID != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestMetadataSyncer_Run_MaxBatches(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 2).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(1, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil).
			AddRow(2, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:  2,
		MaxBatches: 1,
	})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Batches != 1 || result.SourceRows != 2 || result.UpdatedRows != 2 || result.LastFirmyCzID != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

// TestMetadataSyncer_Run_MaxBatches_StopsAfterExactLimit catches the `>= → <=` mutation on
// `result.Batches >= s.cfg.MaxBatches`. With mutation `<= MaxBatches`: stops after batch 1
// even when MaxBatches=2. Test uses 2 available batches and asserts both are consumed.
func TestMetadataSyncer_Run_MaxBatches_StopsAfterExactLimit(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	// Batch 1: exactly batchSize=2 rows → loop would continue
	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 2).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(10, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil).
			AddRow(20, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	// Batch 2: 1 row → loop ends naturally
	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(20, 2).
		WillReturnRows(sqlmock.NewRows(metadataColumns()).
			AddRow(30, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil))

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:  2,
		MaxBatches: 2, // allow exactly 2 batches
	})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// With mutation `<= 2`: stops after batch 1 (1 <= 2 is true) → Batches=1, SourceRows=2
	// With original `>= 2`: batch 1 done (1 >= 2? false → continue), batch 2 done (2 >= 2? true → break)
	if result.Batches != 2 {
		t.Errorf("Batches = %d, want 2 (mutation `>= → <=` would stop after 1)", result.Batches)
	}
	if result.SourceRows != 3 {
		t.Errorf("SourceRows = %d, want 3", result.SourceRows)
	}
	if err := sourceMock.ExpectationsWereMet(); err != nil {
		t.Errorf("source expectations: %v", err)
	}
}

func TestMetadataSyncer_ApplyBatch_ChunksByParameterLimit(t *testing.T) {
	_, _, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	syncer := NewMetadataSyncer(nil, targetDB, MetadataSyncConfig{BatchSize: 5000})

	largeBatch := make([]metadataRow, 0, 4000)
	for i := 1; i <= 4000; i++ {
		largeBatch = append(largeBatch, metadataRow{
			FirmyCzID:        i,
			ExclusionStatus:  "pass",
			ExclusionReasons: "{}",
			NeedsReview:      false,
			NACECodes:        "{}",
			NACEPrimary:      "",
			VInsolvenci:      false,
			VLikvidaci:       false,
			SectorTags:       "{}",
			SectorPrimary:    "",
			SectorConfidence: 0,
			SectorSource:     "",
			ICPScore:         0,
			ICPTier:          "unscored",
			RegionNormalized: "",
			CategoryPath:     "",
			CategoriesJSON:   "",
		})
	}

	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 3640))
	targetMock.ExpectExec(`UPDATE companies AS c SET`).
		WillReturnResult(sqlmock.NewResult(0, 360))

	updated, err := syncer.applyBatch(context.Background(), largeBatch)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated != 4000 {
		t.Fatalf("updated = %d, want 4000", updated)
	}

	if err := targetMock.ExpectationsWereMet(); err != nil {
		t.Fatalf("target expectations: %v", err)
	}
}
