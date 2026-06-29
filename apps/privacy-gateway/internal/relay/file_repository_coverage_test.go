package relay

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

// TestRelayFileRepoSaveReturnsPersistenceError covers the Save() write-error branch.
func TestRelayFileRepoSaveReturnsPersistenceError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	repo := &FileRepository{path: filepath.Join(parent, "relay.json")}
	err := repo.Save(context.Background(), model.RelayAttempt{
		ID:        "rly_x",
		TenantID:  "t1",
		Status:    "sent",
		CreatedAt: time.Now(),
	})
	if err == nil {
		t.Fatal("expected Save() persistence error")
	}
}

// TestRelayFileRepoSaveUpdatesExistingAttempt exercises the replace branch of Save.
func TestRelayFileRepoSaveUpdatesExistingAttempt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	attempt := model.RelayAttempt{
		ID:        "rly_1",
		TenantID:  "t1",
		Status:    "sent",
		CreatedAt: time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), attempt); err != nil {
		t.Fatalf("Save() initial error = %v", err)
	}

	attempt.Status = "failed"
	attempt.FailureClass = "timeout"
	if err := repo.Save(context.Background(), attempt); err != nil {
		t.Fatalf("Save() update error = %v", err)
	}

	stored, err := repo.GetByID(context.Background(), "rly_1")
	if err != nil {
		t.Fatalf("GetByID() error = %v", err)
	}
	if stored.Status != "failed" || stored.FailureClass != "timeout" {
		t.Fatalf("expected updated attempt, got %+v", stored)
	}
}

// TestRelayFileRepoGetByIDNotFound covers the missing-id branch.
func TestRelayFileRepoGetByIDNotFound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	if _, err := repo.GetByID(context.Background(), "missing"); !errors.Is(err, ErrRelayAttemptNotFound) {
		t.Fatalf("expected ErrRelayAttemptNotFound, got %v", err)
	}
}

// TestRelayFileRepoPruneBeforeReturnsPersistenceError covers the write-error branch.
func TestRelayFileRepoPruneBeforeReturnsPersistenceError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	repo := &FileRepository{path: filepath.Join(parent, "relay.json")}
	if err := repo.PruneBefore(context.Background(), time.Now()); err == nil {
		t.Fatal("expected PruneBefore() persistence error")
	}
}

// TestRelayFileRepoNewFailsForInvalidJSON covers the invalid-JSON branch.
func TestRelayFileRepoNewFailsForInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := NewFileRepository(path); err == nil {
		t.Fatal("expected invalid JSON error")
	}
}

// TestSortRelayAttemptsIsStableByIDForEqualTimestamps covers the equal-time
// tiebreak branch of sortRelayAttempts.
func TestSortRelayAttemptsIsStableByIDForEqualTimestamps(t *testing.T) {
	ts := time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	items := []model.RelayAttempt{
		{ID: "rly_b", CreatedAt: ts},
		{ID: "rly_a", CreatedAt: ts},
	}
	sortRelayAttempts(items)
	if items[0].ID != "rly_a" || items[1].ID != "rly_b" {
		t.Fatalf("expected ID tiebreak ordering, got %+v", items)
	}
}
