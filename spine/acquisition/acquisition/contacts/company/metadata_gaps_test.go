package company

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── LoadMetadataSnapshot: nil DB (line 36-38) ──

func TestLoadMetadataSnapshot_NilDB(t *testing.T) {
	_, err := LoadMetadataSnapshot(context.Background(), nil)
	if err == nil {
		t.Error("expected error for nil DB")
	}
}

// ── fetchBatch (metadata_sync.go): scan error (line 219-221) ──

func TestMetadataSyncFetchBatch_ScanError(t *testing.T) {
	firmyDB, firmyMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer firmyDB.Close()

	// Wrong columns → scan fails
	firmyMock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(1, "bad"))

	outreachDB, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer outreachDB.Close()

	syncer := NewMetadataSyncer(firmyDB, outreachDB, MetadataSyncConfig{BatchSize: 10})
	_, _, err = syncer.fetchBatch(context.Background(), 0)
	if err == nil {
		t.Error("expected scan error from metadata fetchBatch")
	}
}
