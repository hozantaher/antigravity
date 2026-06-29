package audit

import (
	"context"
	"encoding/base64"
	"relay/internal/filestore"
	"relay/internal/model"
	"path/filepath"
	"testing"
	"time"
)

func testCodec(t *testing.T) filestore.Codec {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 50)
	}
	c, err := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRecordAndList(t *testing.T) {
	dir := t.TempDir()
	svc, err := NewService(filepath.Join(dir, "audit.json"), testCodec(t), 0)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	svc.Record(ctx, "tenant-1", model.EventIntakeAccepted, "env_abc")
	svc.Record(ctx, "tenant-1", model.EventRelayScheduled, "env_abc")
	svc.Record(ctx, "tenant-2", model.EventIntakeAccepted, "env_xyz")

	entries, err := svc.ListByTenant(ctx, "tenant-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries for tenant-1, got %d", len(entries))
	}

	entries2, _ := svc.ListByTenant(ctx, "tenant-2")
	if len(entries2) != 1 {
		t.Fatalf("expected 1 entry for tenant-2, got %d", len(entries2))
	}
}

func TestAuditEntriesHaveNoPII(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), testCodec(t), 0)

	ctx := context.Background()
	svc.Record(ctx, "tenant-1", model.EventIntakeAccepted, "env_123")

	entries, _ := svc.ListByTenant(ctx, "tenant-1")
	if len(entries) != 1 {
		t.Fatal("expected 1 entry")
	}

	e := entries[0]
	// Verify bucketed timestamp
	if e.BucketedAt.Minute()%15 != 0 {
		t.Fatalf("timestamp not bucketed: %v", e.BucketedAt)
	}
	if e.BucketedAt.Second() != 0 || e.BucketedAt.Nanosecond() != 0 {
		t.Fatalf("timestamp has sub-minute precision: %v", e.BucketedAt)
	}
	// No content/IP fields exist in AuditEntry struct by design
}

func TestFilteredByEventType(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), testCodec(t), 0)

	ctx := context.Background()
	svc.Record(ctx, "tenant-1", model.EventIntakeAccepted, "env_1")
	svc.Record(ctx, "tenant-1", model.EventRelayScheduled, "env_1")
	svc.Record(ctx, "tenant-1", model.EventRelayCompleted, "env_1")

	entries, _ := svc.ListByTenantFiltered(ctx, "tenant-1", model.EventRelayScheduled, 100)
	if len(entries) != 1 {
		t.Fatalf("expected 1 filtered entry, got %d", len(entries))
	}
	if entries[0].EventType != model.EventRelayScheduled {
		t.Fatalf("wrong event type: %s", entries[0].EventType)
	}
}

func TestRetentionPruning(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), testCodec(t), 1*time.Millisecond)

	ctx := context.Background()
	svc.Record(ctx, "tenant-1", model.EventIntakeAccepted, "env_old")
	time.Sleep(5 * time.Millisecond)

	entries, _ := svc.ListByTenant(ctx, "tenant-1")
	if len(entries) != 0 {
		t.Fatalf("expected 0 entries after retention, got %d", len(entries))
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "audit.json")
	codec := testCodec(t)

	svc1, _ := NewService(path, codec, 0)
	ctx := context.Background()
	svc1.Record(ctx, "tenant-1", model.EventIntakeAccepted, "env_persist")

	// Re-open
	svc2, _ := NewService(path, codec, 0)
	entries, _ := svc2.ListByTenant(ctx, "tenant-1")
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry after reopen, got %d", len(entries))
	}
}
