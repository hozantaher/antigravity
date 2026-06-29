package alias

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

// ── FileRepository.Save: update existing alias (lines 44-47) ──

func TestFileRepository_Save_UpdateExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "aliases.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatal(err)
	}

	original := model.Alias{
		ID: "alias-1", TenantID: "t1", UserID: "u1",
		Email: "original@example.com", CreatedAt: time.Now(),
	}
	if err := repo.Save(context.Background(), original); err != nil {
		t.Fatalf("save: %v", err)
	}

	updated := original
	updated.Email = "updated@example.com"
	if err := repo.Save(context.Background(), updated); err != nil {
		t.Fatalf("update: %v", err)
	}

	got, err := repo.GetByID(context.Background(), "alias-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Email != "updated@example.com" {
		t.Errorf("email = %q, want updated@example.com", got.Email)
	}
}

// ── FileRepository.GetByID: not found (line 79) ──

func TestFileRepository_GetByID_NotFound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "aliases.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatal(err)
	}

	_, err = repo.GetByID(context.Background(), "nonexistent")
	if err != ErrAliasNotFound {
		t.Errorf("expected ErrAliasNotFound, got %v", err)
	}
}
