package company

import (
	"context"
	"database/sql"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── NewMetadataSyncer edge cases ──────────────────────────────────────────

// TestNewMetadataSyncer_NegativeStartAfterID covers cfg.StartAfterID < 0 → clamped to 0.
func TestNewMetadataSyncer_NegativeStartAfterID(t *testing.T) {
	s := NewMetadataSyncer(nil, nil, MetadataSyncConfig{StartAfterID: -100})
	if s.cfg.StartAfterID != 0 {
		t.Errorf("StartAfterID = %d, want 0 (clamped)", s.cfg.StartAfterID)
	}
}

// TestNewMetadataSyncer_NegativeMaxBatches covers cfg.MaxBatches < 0 → clamped to 0.
func TestNewMetadataSyncer_NegativeMaxBatches(t *testing.T) {
	s := NewMetadataSyncer(nil, nil, MetadataSyncConfig{MaxBatches: -99})
	if s.cfg.MaxBatches != 0 {
		t.Errorf("MaxBatches = %d, want 0 (clamped)", s.cfg.MaxBatches)
	}
}

// TestNewMetadataSyncer_EmptyCheckpointSource covers the default checkpoint source name.
func TestNewMetadataSyncer_EmptyCheckpointSource(t *testing.T) {
	s := NewMetadataSyncer(nil, nil, MetadataSyncConfig{})
	const wantSource = "outreach-prod-metadata-sync"
	if s.cfg.CheckpointSource != wantSource {
		t.Errorf("CheckpointSource = %q, want %q", s.cfg.CheckpointSource, wantSource)
	}
}

// TestNewMetadataSyncer_CustomCheckpointSource verifies a provided source is preserved.
func TestNewMetadataSyncer_CustomCheckpointSource(t *testing.T) {
	s := NewMetadataSyncer(nil, nil, MetadataSyncConfig{CheckpointSource: "my-source"})
	if s.cfg.CheckpointSource != "my-source" {
		t.Errorf("CheckpointSource = %q, want %q", s.cfg.CheckpointSource, "my-source")
	}
}

// TestNewMetadataSyncer_ZeroBatchSize covers cfg.BatchSize <= 0 → default 5000.
func TestNewMetadataSyncer_ZeroBatchSize(t *testing.T) {
	s := NewMetadataSyncer(nil, nil, MetadataSyncConfig{BatchSize: 0})
	if s.cfg.BatchSize != 5000 {
		t.Errorf("BatchSize = %d, want 5000", s.cfg.BatchSize)
	}
}

// TestNewMetadataSyncer_NegativeBatchSize covers BatchSize < 0 → default 5000.
func TestNewMetadataSyncer_NegativeBatchSize(t *testing.T) {
	s := NewMetadataSyncer(nil, nil, MetadataSyncConfig{BatchSize: -50})
	if s.cfg.BatchSize != 5000 {
		t.Errorf("BatchSize = %d, want 5000 (negative should default)", s.cfg.BatchSize)
	}
}

// ── Run — nil source/target DB guard ──────────────────────────────────────

// TestMetadataSyncer_Run_NilSourceDB covers the source DB nil guard in Run.
func TestMetadataSyncer_Run_NilSourceDB(t *testing.T) {
	targetDB, _, cleanup := newTargetOnlyMock(t)
	defer cleanup()

	syncer := NewMetadataSyncer(nil, targetDB, MetadataSyncConfig{BatchSize: 10})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Fatal("expected error when sourceDB is nil")
	}
}

// TestMetadataSyncer_Run_NilTargetDB covers the target DB nil guard in Run.
func TestMetadataSyncer_Run_NilTargetDB(t *testing.T) {
	sourceDB, _, cleanup := newSourceOnlyMock(t)
	defer cleanup()

	syncer := NewMetadataSyncer(sourceDB, nil, MetadataSyncConfig{BatchSize: 10})
	_, err := syncer.Run(context.Background())
	if err == nil {
		t.Fatal("expected error when targetDB is nil")
	}
}

// ── fetchBatch — rows.Err() coverage ─────────────────────────────────────

// TestMetadataSyncer_FetchBatch_RowsErr covers the rows.Err() path in fetchBatch.
func TestMetadataSyncer_FetchBatch_RowsErr(t *testing.T) {
	sourceDB, sourceMock, targetDB, _, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	// Return one row then fail with rows.Err().
	rows := sqlmock.NewRows(metadataColumns()).
		AddRow(1, "pass", "{}", false, "{}", "", false, false, "{}", "", 0.0, "", 0.0, "unscored", "", "", "", nil).
		RowError(0, errCompany("row error"))

	sourceMock.ExpectQuery(`SELECT firmy_cz_id`).
		WillReturnRows(rows)

	syncer := NewMetadataSyncer(sourceDB, targetDB, MetadataSyncConfig{BatchSize: 100})
	_, _, err := syncer.fetchBatch(context.Background(), 0)
	if err == nil {
		t.Fatal("expected rows.Err() to propagate")
	}
}

// ── applyBatch — empty batch short-circuit ────────────────────────────────

// TestMetadataSyncer_ApplyBatch_Empty covers the early return for empty batch.
func TestMetadataSyncer_ApplyBatch_Empty(t *testing.T) {
	_, _, targetDB, _, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	syncer := NewMetadataSyncer(nil, targetDB, MetadataSyncConfig{BatchSize: 100})
	updated, err := syncer.applyBatch(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated != 0 {
		t.Errorf("updated = %d, want 0", updated)
	}
}

// TestMetadataSyncer_ApplyBatchChunk_Empty covers the early return for empty chunk.
func TestMetadataSyncer_ApplyBatchChunk_Empty(t *testing.T) {
	_, _, targetDB, _, cleanup := newMetadataSyncMocks(t)
	defer cleanup()

	syncer := NewMetadataSyncer(nil, targetDB, MetadataSyncConfig{BatchSize: 100})
	updated, err := syncer.applyBatchChunk(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated != 0 {
		t.Errorf("updated = %d, want 0", updated)
	}
}

// ── property tests ────────────────────────────────────────────────────────

// TestNewMetadataSyncer_Property_NeverPanics verifies NewMetadataSyncer never panics
// for arbitrary config values.
func TestNewMetadataSyncer_Property_NeverPanics(t *testing.T) {
	f := func(batchSize int32, startAfterID int32, maxBatches int32) bool {
		defer func() { recover() }()
		s := NewMetadataSyncer(nil, nil, MetadataSyncConfig{
			BatchSize:    int(batchSize),
			StartAfterID: int(startAfterID),
			MaxBatches:   int(maxBatches),
		})
		// Invariants that must hold regardless of input.
		return s.cfg.BatchSize > 0 &&
			s.cfg.StartAfterID >= 0 &&
			s.cfg.MaxBatches >= 0 &&
			s.cfg.CheckpointSource != ""
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Error(err)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

func newSourceOnlyMock(t *testing.T) (*sql.DB, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	return db, mock, func() { db.Close() }
}

func newTargetOnlyMock(t *testing.T) (*sql.DB, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	return db, mock, func() { db.Close() }
}
