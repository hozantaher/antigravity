package identityvault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

// TestIdentityVaultFileRepoSaveReturnsPersistenceError covers the write-error branch.
func TestIdentityVaultFileRepoSaveReturnsPersistenceError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	repo := &FileRepository{path: filepath.Join(parent, "identity-links.json")}
	err := repo.Save(context.Background(), model.IdentityLink{
		ID:       "idl_x",
		TenantID: "t1",
		AliasID:  "alias-1",
	})
	if err == nil {
		t.Fatal("expected Save() persistence error")
	}
}

// TestIdentityVaultFileRepoSaveUpdatesExisting covers the replace branch of Save.
func TestIdentityVaultFileRepoSaveUpdatesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity-links.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	link := model.IdentityLink{
		ID:              "idl_1",
		TenantID:        "t1",
		AliasID:         "alias-1",
		RealIdentityRef: "old@example.com",
		CreatedAt:       time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), link); err != nil {
		t.Fatalf("Save() initial error = %v", err)
	}

	link.RealIdentityRef = "new@example.com"
	if err := repo.Save(context.Background(), link); err != nil {
		t.Fatalf("Save() update error = %v", err)
	}

	stored, err := repo.GetByAliasID(context.Background(), "t1", "alias-1")
	if err != nil {
		t.Fatalf("GetByAliasID() error = %v", err)
	}
	if stored.RealIdentityRef != "new@example.com" {
		t.Fatalf("expected updated ref new@example.com, got %s", stored.RealIdentityRef)
	}
}

// TestIdentityVaultFileRepoGetByAliasIDNotFound covers the missing-alias branch.
func TestIdentityVaultFileRepoGetByAliasIDNotFound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity-links.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}
	if _, err := repo.GetByAliasID(context.Background(), "t1", "missing"); !errors.Is(err, ErrIdentityLinkNotFound) {
		t.Fatalf("expected ErrIdentityLinkNotFound, got %v", err)
	}
}

// TestIdentityVaultFileRepoPruneBeforeReturnsPersistenceError covers the write-error branch.
func TestIdentityVaultFileRepoPruneBeforeReturnsPersistenceError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	repo := &FileRepository{path: filepath.Join(parent, "identity-links.json")}
	if err := repo.PruneInactiveBefore(context.Background(), time.Now()); err == nil {
		t.Fatal("expected PruneInactiveBefore() persistence error")
	}
}

// TestIdentityVaultFileRepoNewFailsForInvalidJSON covers the invalid-JSON branch.
func TestIdentityVaultFileRepoNewFailsForInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity-links.json")
	if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := NewFileRepository(path); err == nil {
		t.Fatal("expected invalid JSON error")
	}
}
