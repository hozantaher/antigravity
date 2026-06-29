package audit

import (
	"context"
	"encoding/base64"
	"relay/internal/filestore"
	"relay/internal/model"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func extraTestCodec(t *testing.T) filestore.Codec {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 33)
	}
	c, err := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// TestNewService_ReadError covers the filestore.ReadJSON error branch in NewService.
// We create a file that exists but contains data that cannot be decrypted with the
// codec (encrypted with a different key), forcing ReadJSON to return an error.
func TestNewService_ReadError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "audit_bad.json")

	// Write garbage that will fail JSON unmarshal.
	if err := os.WriteFile(path, []byte("not-valid-json-and-not-empty"), 0600); err != nil {
		t.Fatal(err)
	}

	// DefaultCodec will try json.Unmarshal on plaintext "not-valid-json-and-not-empty" → error.
	_, err := NewService(path, filestore.DefaultCodec(), 0)
	if err == nil {
		t.Fatal("expected error from NewService with unreadable file, got nil")
	}
}

// TestListByTenantFiltered_EventTypeNoMatch covers the branch where eventType filter
// excludes all entries (returns empty slice instead of matching).
func TestListByTenantFiltered_EventTypeNoMatch(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), extraTestCodec(t), 0)

	ctx := context.Background()
	svc.Record(ctx, "tenant-1", model.EventIntakeAccepted, "env_1")
	svc.Record(ctx, "tenant-1", model.EventRelayScheduled, "env_2")

	// Filter by an event type that does not exist.
	entries, err := svc.ListByTenantFiltered(ctx, "tenant-1", model.EventRelayCompleted, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected 0 entries for non-matching event type, got %d", len(entries))
	}
}

// TestListByTenantFiltered_LimitEnforced covers the `limit > 0 && len(result) >= limit`
// break branch — limit caps the result.
func TestListByTenantFiltered_LimitEnforced(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), extraTestCodec(t), 0)

	ctx := context.Background()
	for i := 0; i < 10; i++ {
		svc.Record(ctx, "tenant-limit", model.EventIntakeAccepted, "env_"+string(rune('a'+i)))
	}

	entries, err := svc.ListByTenantFiltered(ctx, "tenant-limit", model.EventIntakeAccepted, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries (limit), got %d", len(entries))
	}
}

// TestListByTenantFiltered_TenantNoMatch covers the `e.TenantID != tenantID` branch
// that skips entries from other tenants.
func TestListByTenantFiltered_TenantNoMatch(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), extraTestCodec(t), 0)

	ctx := context.Background()
	svc.Record(ctx, "other-tenant", model.EventIntakeAccepted, "env_other")

	entries, err := svc.ListByTenantFiltered(ctx, "my-tenant", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected 0 entries for wrong tenant, got %d", len(entries))
	}
}

// TestPruneExpired_ExactCutoffKept covers the BucketedAt.Equal(cutoff) branch —
// an entry bucketed exactly at the cutoff boundary is retained.
func TestPruneExpired_ExactCutoffKept(t *testing.T) {
	dir := t.TempDir()

	// Use a fake clock so we can control exact timestamps.
	fixedNow := time.Date(2025, 1, 1, 12, 15, 0, 0, time.UTC) // exact 15-min boundary

	svc, err := NewService(filepath.Join(dir, "audit.json"), extraTestCodec(t), 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	// Inject a fake clock: the entry will be bucketed at fixedNow.Truncate(15min).
	svc.now = func() time.Time { return fixedNow }

	ctx := context.Background()
	svc.Record(ctx, "t1", model.EventIntakeAccepted, "env_boundary")

	// Advance clock by exactly 15 minutes → BucketedAt == cutoff (Equal branch).
	svc.now = func() time.Time { return fixedNow.Add(15 * time.Minute) }

	entries, err := svc.ListByTenant(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}

	// Entry bucketed exactly at cutoff must be kept (>= cutoff).
	if len(entries) != 1 {
		t.Fatalf("expected entry at cutoff to be kept, got %d entries", len(entries))
	}
}

// TestPruneExpired_BeforeCutoffDropped verifies that entries strictly before the
// cutoff are pruned.
func TestPruneExpired_BeforeCutoffDropped(t *testing.T) {
	dir := t.TempDir()

	fixedNow := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)

	svc, err := NewService(filepath.Join(dir, "audit.json"), extraTestCodec(t), 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	svc.now = func() time.Time { return fixedNow }
	ctx := context.Background()
	svc.Record(ctx, "t1", model.EventIntakeAccepted, "env_old")

	// Advance clock by >15 minutes so the entry is before the cutoff.
	svc.now = func() time.Time { return fixedNow.Add(16 * time.Minute) }

	entries, err := svc.ListByTenant(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected expired entry to be dropped, got %d entries", len(entries))
	}
}

// TestRecordWithOutcome_IncludesOutcomeAndStatus covers RecordWithOutcome directly.
func TestRecordWithOutcome_IncludesOutcomeAndStatus(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), extraTestCodec(t), 0)

	ctx := context.Background()
	err := svc.RecordWithOutcome(ctx, "t1", model.EventRelayCompleted, "env_out",
		model.OutcomeSuccess, 250)
	if err != nil {
		t.Fatalf("RecordWithOutcome: %v", err)
	}

	entries, _ := svc.ListByTenant(ctx, "t1")
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	e := entries[0]
	if e.Outcome != model.OutcomeSuccess {
		t.Fatalf("wrong outcome: %q", e.Outcome)
	}
	if e.HTTPStatus != 250 {
		t.Fatalf("wrong HTTP status: %d", e.HTTPStatus)
	}
}

// TestListByTenantFiltered_NoEventTypeFilter verifies empty eventType string
// matches all event types for the tenant.
func TestListByTenantFiltered_NoEventTypeFilter(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), extraTestCodec(t), 0)

	ctx := context.Background()
	svc.Record(ctx, "t1", model.EventIntakeAccepted, "env_1")
	svc.Record(ctx, "t1", model.EventRelayScheduled, "env_2")
	svc.Record(ctx, "t1", model.EventRelayCompleted, "env_3")

	entries, err := svc.ListByTenantFiltered(ctx, "t1", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries with no event type filter, got %d", len(entries))
	}
}

// TestListByTenantFiltered_ZeroLimit verifies limit=0 returns all results.
func TestListByTenantFiltered_ZeroLimit(t *testing.T) {
	dir := t.TempDir()
	svc, _ := NewService(filepath.Join(dir, "audit.json"), extraTestCodec(t), 0)

	ctx := context.Background()
	for i := 0; i < 5; i++ {
		svc.Record(ctx, "t1", model.EventIntakeAccepted, "env_unlim")
	}

	entries, err := svc.ListByTenantFiltered(ctx, "t1", model.EventIntakeAccepted, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 5 {
		t.Fatalf("expected 5 entries with limit=0, got %d", len(entries))
	}
}
