package relay

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

func TestFileRepositoryPersistsRelayAttempts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay-attempts.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	attempt := model.RelayAttempt{
		TenantID:     "tenant-1",
		ActorID:      "user-1",
		ID:           "rly_1",
		SubmissionID: "sub_1",
		AliasID:      "alias-1",
		Provider:     "smtp",
		Status:       "sent",
		CreatedAt:    time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), attempt); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	reloaded, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() reload error = %v", err)
	}

	stored, err := reloaded.GetByID(context.Background(), "rly_1")
	if err != nil {
		t.Fatalf("GetByID() error = %v", err)
	}
	if stored.SubmissionID != "sub_1" {
		t.Fatalf("expected sub_1, got %s", stored.SubmissionID)
	}
}

func TestFileRepositoryPruneBeforeRemovesOldAttempts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay-attempts.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatal(err)
	}

	old := model.RelayAttempt{
		TenantID: "t1", ID: "rly_old", Status: "sent",
		CreatedAt: time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC),
	}
	recent := model.RelayAttempt{
		TenantID: "t1", ID: "rly_new", Status: "sent",
		CreatedAt: time.Date(2026, time.April, 3, 0, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	if err := repo.Save(context.Background(), recent); err != nil {
		t.Fatal(err)
	}

	cutoff := time.Date(2026, time.April, 1, 0, 0, 0, 0, time.UTC)
	if err := repo.PruneBefore(context.Background(), cutoff); err != nil {
		t.Fatalf("PruneBefore() error = %v", err)
	}

	remaining, err := repo.ListByTenant(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 {
		t.Fatalf("expected 1 remaining attempt, got %d", len(remaining))
	}
	if remaining[0].ID != "rly_new" {
		t.Fatalf("expected rly_new to survive, got %s", remaining[0].ID)
	}

	// Verify persistence
	reloaded, err := NewFileRepository(path)
	if err != nil {
		t.Fatal(err)
	}
	reloadedItems, _ := reloaded.ListByTenant(context.Background(), "t1")
	if len(reloadedItems) != 1 {
		t.Fatalf("expected 1 after reload, got %d", len(reloadedItems))
	}
}
