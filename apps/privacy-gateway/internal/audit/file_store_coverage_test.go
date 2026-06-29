package audit

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

// TestFileStoreLoadsEmptyFileGivesEmptyStore exercises the empty-file branch
// of NewFileStoreWithCodec.
func TestFileStoreLoadsEmptyFileGivesEmptyStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.json")
	if err := os.WriteFile(path, []byte{}, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	store, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore() error = %v", err)
	}
	events, err := store.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected empty store, got %d events", len(events))
	}
}

// TestFileStoreNewFailsOnInvalidJSON exercises the read-error branch.
func TestFileStoreNewFailsOnInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.json")
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := NewFileStore(path); err == nil {
		t.Fatal("expected NewFileStore() error for invalid JSON")
	}
}

// TestFileStoreAppendWriteFailsReturnsError exercises the persistence error
// path of Append by pointing the store at a non-writable path.
func TestFileStoreAppendWriteFailsReturnsError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "parent")
	if err := os.WriteFile(parent, []byte("blocker"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	store := &FileStore{path: filepath.Join(parent, "audit.json")}
	err := store.Append(context.Background(), model.AuditEvent{
		ID:        "aud_err",
		TenantID:  "tenant-1",
		CreatedAt: time.Date(2026, time.April, 3, 0, 0, 0, 0, time.UTC),
	})
	if err == nil {
		t.Fatal("expected Append() error when parent path is not a directory")
	}
}

// TestFileStorePruneBeforeWriteFailsReturnsError exercises the persistence
// error path of PruneBefore.
func TestFileStorePruneBeforeWriteFailsReturnsError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "parent")
	if err := os.WriteFile(parent, []byte("blocker"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	store := &FileStore{path: filepath.Join(parent, "audit.json")}
	if err := store.PruneBefore(context.Background(), time.Now()); err == nil {
		t.Fatal("expected PruneBefore() error when parent path is not a directory")
	}
}
