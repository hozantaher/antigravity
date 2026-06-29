package inbox

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

// TestCursorStoreLoadTriggersPruneExpired exercises the pruneExpired retention
// branch accessed via Load.
func TestCursorStoreLoadTriggersPruneExpired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "imap-sync-state.json")
	store, err := NewCursorStoreWithCodecAndRetention(path, filestore.DefaultCodec(), time.Hour)
	if err != nil {
		t.Fatalf("NewCursorStoreWithCodecAndRetention() error = %v", err)
	}

	now := time.Date(2026, time.April, 5, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }

	store.cursors = map[string]cursorState{
		"tenant-1:user-old": {
			ProviderUID: "1",
			UpdatedAt:   now.Add(-2 * time.Hour),
		},
		"tenant-1:user-new": {
			ProviderUID: "2",
			UpdatedAt:   now.Add(-5 * time.Minute),
		},
	}

	// Load should trigger pruneExpired on the retention-enabled store.
	got, err := store.Load(context.Background(), model.Actor{ID: "user-new", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got != "2" {
		t.Fatalf("expected cursor 2, got %q", got)
	}

	// The stale entry must be gone.
	gotOld, err := store.Load(context.Background(), model.Actor{ID: "user-old", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("Load(old) error = %v", err)
	}
	if gotOld != "" {
		t.Fatalf("expected old cursor to be pruned, got %q", gotOld)
	}
}

// TestCursorStoreSaveTriggersPruneExpired exercises pruneExpired via Save.
func TestCursorStoreSaveTriggersPruneExpired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "imap-sync-state.json")
	store, err := NewCursorStoreWithCodecAndRetention(path, filestore.DefaultCodec(), time.Hour)
	if err != nil {
		t.Fatalf("NewCursorStoreWithCodecAndRetention() error = %v", err)
	}

	now := time.Date(2026, time.April, 5, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }

	// Seed with a stale cursor that should be pruned on the next Save.
	store.cursors = map[string]cursorState{
		"tenant-1:user-old": {ProviderUID: "1", UpdatedAt: now.Add(-2 * time.Hour)},
	}

	if err := store.Save(context.Background(), model.Actor{ID: "user-new", TenantID: "tenant-1"}, "99"); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := store.Load(context.Background(), model.Actor{ID: "user-old", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("Load(old) error = %v", err)
	}
	if got != "" {
		t.Fatalf("expected stale cursor pruned, got %q", got)
	}
}

// TestCursorStoreReadsMalformedLegacyReturnsError verifies readCursorStateWithCodec
// surfaces errors when the file is not a valid JSON object.
func TestCursorStoreReadsMalformedLegacyReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "imap-sync-state.json")
	if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := NewCursorStore(path); err == nil {
		t.Fatal("expected error for malformed cursor state file")
	}
}
