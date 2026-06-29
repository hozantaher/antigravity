package inbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

func TestStorePersistsMessagesAndScopesByActor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbox.json")
	store, err := NewStore(path)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	store.now = func() time.Time {
		return time.Date(2026, time.April, 3, 18, 0, 0, 0, time.UTC)
	}

	saved, err := store.Save(context.Background(), model.InboxMessage{
		ID:         "in_1",
		UserID:     "user-1",
		TenantID:   "tenant-1",
		AliasEmail: "support@relay.example",
		From:       "sender@example.com",
		To:         []string{"support@relay.example"},
		Subject:    "hello",
		TextBody:   "body",
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if saved.ReceivedAt.IsZero() {
		t.Fatal("expected ReceivedAt to be set")
	}

	if _, err := store.Save(context.Background(), model.InboxMessage{
		ID:         "in_2",
		UserID:     "user-2",
		TenantID:   "tenant-1",
		AliasEmail: "ops@relay.example",
		From:       "other@example.com",
		To:         []string{"ops@relay.example"},
		Subject:    "other",
		TextBody:   "body",
	}); err != nil {
		t.Fatalf("second Save() error = %v", err)
	}

	reloaded, err := NewStore(path)
	if err != nil {
		t.Fatalf("reloaded NewStore() error = %v", err)
	}

	messages, err := reloaded.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected 1 message for actor, got %d", len(messages))
	}
	if messages[0].ID != "in_1" {
		t.Fatalf("expected message in_1, got %s", messages[0].ID)
	}
}

func TestStoreUpdatesExistingMessage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbox.json")
	store, err := NewStore(path)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}

	if _, err := store.Save(context.Background(), model.InboxMessage{
		ID:       "in_1",
		UserID:   "user-1",
		TenantID: "tenant-1",
		Subject:  "first",
	}); err != nil {
		t.Fatalf("first Save() error = %v", err)
	}
	if _, err := store.Save(context.Background(), model.InboxMessage{
		ID:       "in_1",
		UserID:   "user-1",
		TenantID: "tenant-1",
		Subject:  "updated",
	}); err != nil {
		t.Fatalf("second Save() error = %v", err)
	}

	messages, err := store.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected 1 message after update, got %d", len(messages))
	}
	if messages[0].Subject != "updated" {
		t.Fatalf("expected updated subject, got %s", messages[0].Subject)
	}
}

func TestStorePrunesExpiredMessagesWhenRetentionEnabled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbox.json")
	store, err := NewStoreWithCodecAndRetention(path, filestore.DefaultCodec(), 24*time.Hour)
	if err != nil {
		t.Fatalf("NewStoreWithCodecAndRetention() error = %v", err)
	}
	now := time.Date(2026, time.April, 5, 18, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }

	if _, err := store.Save(context.Background(), model.InboxMessage{
		ID:         "in_old",
		UserID:     "user-1",
		TenantID:   "tenant-1",
		Subject:    "old",
		ReceivedAt: now.Add(-48 * time.Hour),
	}); err != nil {
		t.Fatalf("Save() old error = %v", err)
	}
	if _, err := store.Save(context.Background(), model.InboxMessage{
		ID:         "in_new",
		UserID:     "user-1",
		TenantID:   "tenant-1",
		Subject:    "new",
		ReceivedAt: now.Add(-2 * time.Hour),
	}); err != nil {
		t.Fatalf("Save() new error = %v", err)
	}

	messages, err := store.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(messages) != 1 || messages[0].ID != "in_new" {
		t.Fatalf("expected only retained inbox message, got %+v", messages)
	}
}
