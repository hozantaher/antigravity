package relay

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"context"
	"encoding/base64"
	"path/filepath"
	"testing"
	"time"
)

func testCodec(t *testing.T) filestore.Codec {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 33)
	}
	c, _ := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(key))
	return c
}

func TestScheduleAndDrain(t *testing.T) {
	dir := t.TempDir()
	s, err := NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodec(t),
		time.Millisecond,  // min delay
		5*time.Millisecond, // max delay
		0,
	)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	env := model.Envelope{
		ID:        "env_sched_1",
		TenantID:  "tenant-1",
		Status:    model.StatusSealed,
		SizeClass: model.SizeClass512,
	}

	scheduledAt, err := s.Schedule(ctx, env)
	if err != nil {
		t.Fatal(err)
	}
	if scheduledAt.IsZero() {
		t.Fatal("expected non-zero scheduled time")
	}

	if s.PendingCount() != 1 {
		t.Fatalf("expected 1 pending, got %d", s.PendingCount())
	}

	// Wait for delay to pass
	time.Sleep(10 * time.Millisecond)

	ready, err := s.DrainReady(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ready) != 1 {
		t.Fatalf("expected 1 ready, got %d", len(ready))
	}
	if ready[0].ID != "env_sched_1" {
		t.Fatalf("wrong envelope: %s", ready[0].ID)
	}

	if s.PendingCount() != 0 {
		t.Fatalf("expected 0 pending after drain, got %d", s.PendingCount())
	}
}

func TestDrainReadyRespectsScheduledTime(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodec(t),
		time.Hour, // huge delay
		2*time.Hour,
		0,
	)

	ctx := context.Background()
	s.Schedule(ctx, model.Envelope{ID: "env_future", TenantID: "t", Status: model.StatusSealed})

	ready, _ := s.DrainReady(ctx)
	if len(ready) != 0 {
		t.Fatalf("expected 0 ready (scheduled in future), got %d", len(ready))
	}
}

func TestMarkRelayedAndFailed(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodec(t),
		time.Millisecond,
		time.Millisecond,
		0,
	)

	ctx := context.Background()
	s.Schedule(ctx, model.Envelope{ID: "env_mark", TenantID: "t", Status: model.StatusSealed})

	s.MarkRelayed(ctx, "env_mark")
	// Should not appear in pending (status changed)
	if s.PendingCount() != 0 {
		t.Fatalf("expected 0 pending after mark, got %d", s.PendingCount())
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay.json")
	codec := testCodec(t)

	s1, _ := NewScheduler(path, codec, time.Hour, 2*time.Hour, 0)
	ctx := context.Background()
	s1.Schedule(ctx, model.Envelope{ID: "env_persist", TenantID: "t", Status: model.StatusSealed})

	// Re-open
	s2, _ := NewScheduler(path, codec, time.Hour, 2*time.Hour, 0)
	if s2.PendingCount() != 1 {
		t.Fatalf("expected 1 pending after reopen, got %d", s2.PendingCount())
	}
}

func TestPendingEnvelopes_Empty(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, 0)

	envelopes := s.PendingEnvelopes()
	if envelopes == nil {
		t.Error("expected non-nil slice for empty queue")
	}
	if len(envelopes) != 0 {
		t.Errorf("expected 0 envelopes, got %d", len(envelopes))
	}
}

func TestPendingEnvelopes_OnlyReturnsScheduled(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, 0)

	ctx := context.Background()
	// Schedule two envelopes
	s.Schedule(ctx, model.Envelope{ID: "env-a", TenantID: "t", Status: model.StatusSealed})
	s.Schedule(ctx, model.Envelope{ID: "env-b", TenantID: "t", Status: model.StatusSealed})

	// Mark one as relayed (removes from scheduled)
	s.MarkRelayed(ctx, "env-a")

	envelopes := s.PendingEnvelopes()
	if len(envelopes) != 1 {
		t.Fatalf("expected 1 pending envelope, got %d", len(envelopes))
	}
	if envelopes[0].ID != "env-b" {
		t.Errorf("expected env-b, got %s", envelopes[0].ID)
	}
}

func TestPendingEnvelopes_IsCopy(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, 0)

	ctx := context.Background()
	s.Schedule(ctx, model.Envelope{ID: "env-copy", TenantID: "t", Status: model.StatusSealed})

	envelopes := s.PendingEnvelopes()
	if len(envelopes) != 1 {
		t.Fatalf("expected 1 envelope, got %d", len(envelopes))
	}
	// Mutating the returned slice must not affect the scheduler's internal state
	envelopes[0].ID = "mutated"
	if s.PendingCount() != 1 {
		t.Error("mutating returned slice should not affect internal count")
	}
	fresh := s.PendingEnvelopes()
	if fresh[0].ID == "mutated" {
		t.Error("returned slice is not a copy — internal state was mutated")
	}
}

func TestOldestPendingAge_Empty(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, 0)

	age := s.OldestPendingAge()
	if age != -1 {
		t.Errorf("expected -1 for empty queue, got %v", age)
	}
}

func TestOldestPendingAge_SingleEnvelope(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, 0)

	fixedNow := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return fixedNow }

	ctx := context.Background()
	env := model.Envelope{
		ID:         "env-age",
		TenantID:   "t",
		Status:     model.StatusSealed,
		BucketedAt: fixedNow.Add(-5 * time.Minute),
	}
	s.Schedule(ctx, env)

	age := s.OldestPendingAge()
	if age < 5*time.Minute {
		t.Errorf("expected age >= 5m, got %v", age)
	}
}

func TestOldestPendingAge_MultipleEnvelopes(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, 0)

	fixedNow := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return fixedNow }

	ctx := context.Background()
	// Older envelope: bucketed 10m ago
	s.Schedule(ctx, model.Envelope{
		ID: "env-old", TenantID: "t", Status: model.StatusSealed,
		BucketedAt: fixedNow.Add(-10 * time.Minute),
	})
	// Newer envelope: bucketed 2m ago
	s.Schedule(ctx, model.Envelope{
		ID: "env-new", TenantID: "t", Status: model.StatusSealed,
		BucketedAt: fixedNow.Add(-2 * time.Minute),
	})

	age := s.OldestPendingAge()
	if age < 10*time.Minute {
		t.Errorf("expected oldest age >= 10m, got %v", age)
	}
}

func TestMarkFailed(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, 0)

	ctx := context.Background()
	s.Schedule(ctx, model.Envelope{ID: "env-fail", TenantID: "t", Status: model.StatusSealed})

	if s.PendingCount() != 1 {
		t.Fatalf("expected 1 pending before mark, got %d", s.PendingCount())
	}

	if err := s.MarkFailed(ctx, "env-fail"); err != nil {
		t.Fatalf("MarkFailed returned error: %v", err)
	}

	// Status changed to failed — should no longer be counted as pending
	if s.PendingCount() != 0 {
		t.Errorf("expected 0 pending after MarkFailed, got %d", s.PendingCount())
	}
}

func TestMarkFailed_NonExistentID(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, 0)

	ctx := context.Background()
	// Should not error when the envelope ID is unknown
	if err := s.MarkFailed(ctx, "does-not-exist"); err != nil {
		t.Errorf("MarkFailed on non-existent ID returned error: %v", err)
	}
}

func TestPruneExpired_RemovesOldEnvelopes(t *testing.T) {
	dir := t.TempDir()
	retention := 1 * time.Hour
	s, _ := NewScheduler(filepath.Join(dir, "relay.json"), testCodec(t), time.Hour, 2*time.Hour, retention)

	fixedNow := time.Date(2025, 6, 1, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return fixedNow }

	ctx := context.Background()
	// Old envelope: bucketed 2h ago (beyond the 1h retention)
	s.Schedule(ctx, model.Envelope{
		ID: "env-expired", TenantID: "t", Status: model.StatusSealed,
		BucketedAt: fixedNow.Add(-2 * time.Hour),
	})
	// Recent envelope: bucketed 30m ago (within retention)
	s.Schedule(ctx, model.Envelope{
		ID: "env-recent", TenantID: "t", Status: model.StatusSealed,
		BucketedAt: fixedNow.Add(-30 * time.Minute),
	})

	// Force a persist cycle to trigger pruneExpired by marking one envelope.
	// MarkRelayed calls persist() which calls pruneExpired().
	s.MarkRelayed(ctx, "env-recent") // marks it relayed (status change) + triggers prune

	// env-expired should have been pruned due to retention policy
	envelopes := s.PendingEnvelopes()
	for _, env := range envelopes {
		if env.ID == "env-expired" {
			t.Error("expected env-expired to be pruned by retention policy, but it is still present")
		}
	}
}
