package audit

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

func TestFileStorePersistsAuditEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit-events.json")
	store, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore() error = %v", err)
	}

	if err := store.Append(context.Background(), model.AuditEvent{
		ID:         "aud_1",
		TenantID:   "tenant-1",
		ActorID:    "user-1",
		EventType:  "submission_created",
		ResourceID: "sub_1",
		CreatedAt:  time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Append() error = %v", err)
	}

	reloaded, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("reloaded NewFileStore() error = %v", err)
	}

	events, err := reloaded.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(events))
	}
	if events[0].ID != "aud_1" {
		t.Fatalf("expected aud_1, got %s", events[0].ID)
	}
}

func TestFileStorePruneBeforePersistsTrimmedEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit-events.json")
	store, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore() error = %v", err)
	}

	for _, event := range []model.AuditEvent{
		{
			ID:         "aud_old",
			TenantID:   "tenant-1",
			ActorID:    "user-1",
			EventType:  "submission_created",
			ResourceID: "sub_old",
			CreatedAt:  time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC),
		},
		{
			ID:         "aud_new",
			TenantID:   "tenant-1",
			ActorID:    "user-1",
			EventType:  "submission_created",
			ResourceID: "sub_new",
			CreatedAt:  time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
		},
	} {
		if err := store.Append(context.Background(), event); err != nil {
			t.Fatalf("Append() error = %v", err)
		}
	}

	if err := store.PruneBefore(context.Background(), time.Date(2026, time.April, 2, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("PruneBefore() error = %v", err)
	}

	reloaded, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("reloaded NewFileStore() error = %v", err)
	}

	events, err := reloaded.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 pruned audit event, got %d", len(events))
	}
	if events[0].ID != "aud_new" {
		t.Fatalf("expected aud_new, got %s", events[0].ID)
	}
}
