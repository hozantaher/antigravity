package submission

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

func TestFileRepositoryPersistsSubmissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "submissions.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	record := model.Submission{
		ID:          "sub_1",
		TenantID:    "tenant-1",
		ChannelID:   "channel-1",
		SubmittedBy: "user-1",
		Subject:     "Hello",
		TextBody:    "Body",
		Status:      model.SubmissionStatusSanitized,
		CreatedAt:   time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), record); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	reloaded, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("reloaded NewFileRepository() error = %v", err)
	}

	stored, err := reloaded.GetByID(context.Background(), "sub_1")
	if err != nil {
		t.Fatalf("GetByID() error = %v", err)
	}
	if stored.ID != "sub_1" {
		t.Fatalf("expected sub_1, got %s", stored.ID)
	}
}

func TestFileRepositoryListsByTenant(t *testing.T) {
	path := filepath.Join(t.TempDir(), "submissions.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	if err := repo.Save(context.Background(), model.Submission{
		ID:        "sub_1",
		TenantID:  "tenant-1",
		CreatedAt: time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() tenant-1 error = %v", err)
	}
	if err := repo.Save(context.Background(), model.Submission{
		ID:        "sub_2",
		TenantID:  "tenant-2",
		CreatedAt: time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() tenant-2 error = %v", err)
	}

	records, err := repo.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 tenant submission, got %d", len(records))
	}
}

func TestFileRepositoryPruneBeforePersistsTrimmedTerminalSubmissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "submissions.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	for _, item := range []model.Submission{
		{
			ID:        "sub_old_relayed",
			TenantID:  "tenant-1",
			Status:    model.SubmissionStatusRelayed,
			CreatedAt: time.Date(2026, time.April, 3, 11, 0, 0, 0, time.UTC),
		},
		{
			ID:        "sub_active_sanitized",
			TenantID:  "tenant-1",
			Status:    model.SubmissionStatusSanitized,
			CreatedAt: time.Date(2026, time.April, 3, 10, 0, 0, 0, time.UTC),
		},
		{
			ID:        "sub_recent_blocked",
			TenantID:  "tenant-1",
			Status:    model.SubmissionStatusBlocked,
			CreatedAt: time.Date(2026, time.April, 5, 11, 0, 0, 0, time.UTC),
		},
	} {
		if err := repo.Save(context.Background(), item); err != nil {
			t.Fatalf("Save() error = %v", err)
		}
	}

	if err := repo.PruneBefore(context.Background(), time.Date(2026, time.April, 4, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("PruneBefore() error = %v", err)
	}

	reloaded, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("reloaded NewFileRepository() error = %v", err)
	}

	records, err := reloaded.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 retained submissions, got %d", len(records))
	}
	for _, record := range records {
		if record.ID == "sub_old_relayed" {
			t.Fatal("expected old relayed submission to be pruned")
		}
	}
}
