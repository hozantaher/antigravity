package submission

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

// TestSubmissionFileRepoSaveReturnsPersistenceError covers the write-error branch.
func TestSubmissionFileRepoSaveReturnsPersistenceError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	repo := &FileRepository{path: filepath.Join(parent, "submissions.json")}
	err := repo.Save(context.Background(), model.Submission{
		ID:        "sub_x",
		TenantID:  "t1",
		Status:    model.SubmissionStatusAccepted,
		CreatedAt: time.Now(),
	})
	if err == nil {
		t.Fatal("expected Save() persistence error")
	}
}

// TestSubmissionFileRepoSaveUpdatesExisting covers the replace branch of Save.
func TestSubmissionFileRepoSaveUpdatesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "submissions.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	item := model.Submission{
		ID:        "sub_1",
		TenantID:  "t1",
		Status:    model.SubmissionStatusAccepted,
		CreatedAt: time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), item); err != nil {
		t.Fatalf("Save() initial error = %v", err)
	}

	item.Status = model.SubmissionStatusRelayed
	if err := repo.Save(context.Background(), item); err != nil {
		t.Fatalf("Save() update error = %v", err)
	}

	stored, err := repo.GetByID(context.Background(), "sub_1")
	if err != nil {
		t.Fatalf("GetByID() error = %v", err)
	}
	if stored.Status != model.SubmissionStatusRelayed {
		t.Fatalf("expected updated status relayed, got %s", stored.Status)
	}
}

// TestSubmissionFileRepoGetByIDNotFound covers the missing-id branch.
func TestSubmissionFileRepoGetByIDNotFound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "submissions.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}
	if _, err := repo.GetByID(context.Background(), "missing"); !errors.Is(err, ErrSubmissionNotFound) {
		t.Fatalf("expected ErrSubmissionNotFound, got %v", err)
	}
}

// TestSubmissionFileRepoPruneBeforeReturnsPersistenceError covers the write-error branch.
func TestSubmissionFileRepoPruneBeforeReturnsPersistenceError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	repo := &FileRepository{path: filepath.Join(parent, "submissions.json")}
	if err := repo.PruneBefore(context.Background(), time.Now()); err == nil {
		t.Fatal("expected PruneBefore() persistence error")
	}
}

// TestSubmissionFileRepoNewFailsForInvalidJSON covers the invalid-JSON branch.
func TestSubmissionFileRepoNewFailsForInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "submissions.json")
	if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := NewFileRepository(path); err == nil {
		t.Fatal("expected invalid JSON error")
	}
}
