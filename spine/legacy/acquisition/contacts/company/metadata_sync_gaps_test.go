package company

import (
	"context"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// TestMetadataSyncer_Run_CheckpointNoRows covers the sql.ErrNoRows branch in
// loadCheckpoint — no existing checkpoint row → starts from 0.
func TestMetadataSyncer_Run_CheckpointNoRows(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	// loadCheckpoint: no row → ErrNoRows → lastID = 0
	targetMock.ExpectQuery(`SELECT last_source_id FROM sync_checkpoints`).
		WithArgs("outreach-prod-metadata-sync").
		WillReturnRows(sqlmock.NewRows([]string{"last_source_id"})) // zero rows

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:     100,
		UseCheckpoint: true,
	})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SourceRows != 0 {
		t.Errorf("SourceRows = %d, want 0", result.SourceRows)
	}
}

// TestMetadataSyncer_Run_CheckpointLoadError covers the DB error branch in
// loadCheckpoint — query fails → Run returns error.
func TestMetadataSyncer_Run_CheckpointLoadError(t *testing.T) {
	sourceDB, _, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	targetMock.ExpectQuery(`SELECT last_source_id FROM sync_checkpoints`).
		WithArgs("outreach-prod-metadata-sync").
		WillReturnError(errCompany("checkpoint query failed"))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:     100,
		UseCheckpoint: true,
	})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Fatal("expected error from checkpoint load failure")
	}
}

// TestMetadataSyncer_Run_CheckpointNegativeID covers lastSourceID < 0 branch —
// stored checkpoint is negative → clamped to 0.
func TestMetadataSyncer_Run_CheckpointNegativeID(t *testing.T) {
	sourceDB, sourceMock, targetDB, targetMock, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	// Checkpoint row exists but has negative last_source_id (corrupt state).
	targetMock.ExpectQuery(`SELECT last_source_id FROM sync_checkpoints`).
		WithArgs("outreach-prod-metadata-sync").
		WillReturnRows(sqlmock.NewRows([]string{"last_source_id"}).AddRow(-5))

	// clamped to 0 → fetch starts at 0
	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WithArgs(0, 100).
		WillReturnRows(sqlmock.NewRows(metadataColumns()))

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{
		BatchSize:     100,
		UseCheckpoint: true,
	})
	result, err := syncer.Run(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SourceRows != 0 {
		t.Errorf("SourceRows = %d, want 0", result.SourceRows)
	}
}
