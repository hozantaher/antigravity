package alias

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

func TestFileRepositoryPersistsAliases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "aliases.json")
	expected := model.Alias{
		ID:        "al_1",
		UserID:    "user-1",
		TenantID:  "tenant-1",
		Email:     "support-1@relay.example",
		Label:     "support",
		CreatedAt: time.Date(2026, time.April, 3, 8, 0, 0, 0, time.UTC),
	}

	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}
	if err := repo.Save(context.Background(), expected); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	reloaded, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("reloaded NewFileRepository() error = %v", err)
	}

	got, err := reloaded.GetByID(context.Background(), expected.ID)
	if err != nil {
		t.Fatalf("GetByID() error = %v", err)
	}
	if got != expected {
		t.Fatalf("expected alias %+v, got %+v", expected, got)
	}

	aliases, err := reloaded.ListByOwner(context.Background(), "tenant-1", "user-1")
	if err != nil {
		t.Fatalf("ListByOwner() error = %v", err)
	}
	if len(aliases) != 1 {
		t.Fatalf("expected 1 alias, got %d", len(aliases))
	}
	if aliases[0] != expected {
		t.Fatalf("expected persisted alias %+v, got %+v", expected, aliases[0])
	}
}

func TestFileRepositoryListByOwnerScopesTenantAndUser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "aliases.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	aliases := []model.Alias{
		{ID: "al_1", UserID: "user-1", TenantID: "tenant-1", Email: "one@relay.example"},
		{ID: "al_2", UserID: "user-2", TenantID: "tenant-1", Email: "two@relay.example"},
		{ID: "al_3", UserID: "user-1", TenantID: "tenant-2", Email: "three@relay.example"},
	}

	for _, alias := range aliases {
		if err := repo.Save(context.Background(), alias); err != nil {
			t.Fatalf("Save(%s) error = %v", alias.ID, err)
		}
	}

	filtered, err := repo.ListByOwner(context.Background(), "tenant-1", "user-1")
	if err != nil {
		t.Fatalf("ListByOwner() error = %v", err)
	}
	if len(filtered) != 1 {
		t.Fatalf("expected 1 scoped alias, got %d", len(filtered))
	}
	if filtered[0].ID != "al_1" {
		t.Fatalf("expected alias al_1, got %s", filtered[0].ID)
	}
}

func TestFileRepositoryRejectsInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "aliases.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	if _, err := NewFileRepository(path); err == nil {
		t.Fatal("expected invalid JSON error")
	}
}

func TestFileRepositoryPruneBeforeRemovesOldAliases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "aliases.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatal(err)
	}

	old := model.Alias{
		ID: "al_old", UserID: "u1", TenantID: "t1", Email: "old@r.ex",
		CreatedAt: time.Date(2026, time.February, 1, 0, 0, 0, 0, time.UTC),
	}
	recent := model.Alias{
		ID: "al_new", UserID: "u1", TenantID: "t1", Email: "new@r.ex",
		CreatedAt: time.Date(2026, time.April, 3, 0, 0, 0, 0, time.UTC),
	}
	for _, a := range []model.Alias{old, recent} {
		if err := repo.Save(context.Background(), a); err != nil {
			t.Fatal(err)
		}
	}

	cutoff := time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC)
	if err := repo.PruneBefore(context.Background(), cutoff); err != nil {
		t.Fatalf("PruneBefore() error = %v", err)
	}

	remaining, err := repo.ListByOwner(context.Background(), "t1", "u1")
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 {
		t.Fatalf("expected 1 remaining alias, got %d", len(remaining))
	}
	if remaining[0].ID != "al_new" {
		t.Fatalf("expected al_new to survive, got %s", remaining[0].ID)
	}

	// Verify persistence
	reloaded, err := NewFileRepository(path)
	if err != nil {
		t.Fatal(err)
	}
	reloadedItems, _ := reloaded.ListByOwner(context.Background(), "t1", "u1")
	if len(reloadedItems) != 1 {
		t.Fatalf("expected 1 after reload, got %d", len(reloadedItems))
	}
}

func TestFileRepositorySaveReturnsPersistenceError(t *testing.T) {
	parentPath := filepath.Join(t.TempDir(), "parent")
	if err := os.WriteFile(parentPath, []byte("not-a-dir"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	repo := &FileRepository{path: filepath.Join(parentPath, "aliases.json")}
	err := repo.Save(context.Background(), model.Alias{ID: "al_1", UserID: "user-1", TenantID: "tenant-1"})
	if err == nil {
		t.Fatal("expected Save() persistence error")
	}
}
