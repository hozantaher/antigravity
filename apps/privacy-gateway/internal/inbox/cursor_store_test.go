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

func TestCursorStorePersistsByActor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "imap-sync-state.json")
	store, err := NewCursorStore(path)
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	actorA := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	actorB := model.Actor{ID: "user-2", TenantID: "tenant-1"}

	if err := store.Save(context.Background(), actorA, "42"); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Save(context.Background(), actorB, "7"); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	reloaded, err := NewCursorStore(path)
	if err != nil {
		t.Fatalf("reloaded NewCursorStore() error = %v", err)
	}

	gotA, err := reloaded.Load(context.Background(), actorA)
	if err != nil {
		t.Fatalf("Load(actorA) error = %v", err)
	}
	if gotA != "42" {
		t.Fatalf("expected actorA cursor 42, got %q", gotA)
	}

	gotB, err := reloaded.Load(context.Background(), actorB)
	if err != nil {
		t.Fatalf("Load(actorB) error = %v", err)
	}
	if gotB != "7" {
		t.Fatalf("expected actorB cursor 7, got %q", gotB)
	}
}

func TestCursorStoreClearsCursorOnEmptyValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "imap-sync-state.json")
	store, err := NewCursorStore(path)
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	if err := store.Save(context.Background(), actor, "42"); err != nil {
		t.Fatalf("Save(set) error = %v", err)
	}
	if err := store.Save(context.Background(), actor, ""); err != nil {
		t.Fatalf("Save(clear) error = %v", err)
	}

	got, err := store.Load(context.Background(), actor)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got != "" {
		t.Fatalf("expected empty cursor, got %q", got)
	}
}

func TestCursorStoreLoadsLegacyStringMapFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "imap-sync-state.json")
	if err := os.WriteFile(path, []byte(`{"tenant-1:user-1":"42"}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	store, err := NewCursorStore(path)
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	got, err := store.Load(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got != "42" {
		t.Fatalf("expected legacy cursor 42, got %q", got)
	}
}

func TestCursorStorePruneBeforeRemovesStaleEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "imap-sync-state.json")
	store, err := NewCursorStoreWithCodecAndRetention(path, filestore.DefaultCodec(), 24*time.Hour)
	if err != nil {
		t.Fatalf("NewCursorStoreWithCodecAndRetention() error = %v", err)
	}
	store.now = func() time.Time {
		return time.Date(2026, time.April, 5, 12, 0, 0, 0, time.UTC)
	}

	store.cursors = map[string]cursorState{
		"tenant-1:user-1": {
			ProviderUID: "42",
			UpdatedAt:   time.Date(2026, time.April, 3, 10, 0, 0, 0, time.UTC),
		},
		"tenant-1:user-2": {
			ProviderUID: "84",
			UpdatedAt:   time.Date(2026, time.April, 5, 11, 0, 0, 0, time.UTC),
		},
	}
	if err := store.PruneBefore(context.Background(), time.Date(2026, time.April, 4, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("PruneBefore() error = %v", err)
	}

	reloaded, err := NewCursorStore(path)
	if err != nil {
		t.Fatalf("reloaded NewCursorStore() error = %v", err)
	}

	gotOld, err := reloaded.Load(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("Load(old) error = %v", err)
	}
	if gotOld != "" {
		t.Fatalf("expected old cursor to be pruned, got %q", gotOld)
	}

	gotNew, err := reloaded.Load(context.Background(), model.Actor{ID: "user-2", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("Load(new) error = %v", err)
	}
	if gotNew != "84" {
		t.Fatalf("expected retained cursor 84, got %q", gotNew)
	}
}
