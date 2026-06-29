package relay

import (
	"relay/internal/model"
	"context"
	"path/filepath"
	"testing"
	"time"
)

// TestQueuePersistsAcrossRestart verifies that envelopes written to the encrypted
// queue file survive a simulated process restart. A new Scheduler instance opened
// against the same path must surface all previously enqueued envelopes.
func TestQueuePersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay.json")
	codec := testCodec(t)

	// Use a large minDelay so no envelope becomes "ready" during the test —
	// we want to verify persistence, not delivery.
	const minDelay = time.Hour
	const maxDelay = 2 * time.Hour

	envelopes := []model.Envelope{
		{ID: "restart-env-1", TenantID: "tenant-a", Status: model.StatusSealed, SizeClass: model.SizeClass512},
		{ID: "restart-env-2", TenantID: "tenant-a", Status: model.StatusSealed, SizeClass: model.SizeClass2K},
		{ID: "restart-env-3", TenantID: "tenant-b", Status: model.StatusSealed, SizeClass: model.SizeClass8K},
	}

	// Phase 1: enqueue 3 envelopes and simulate graceful shutdown (no explicit
	// shutdown method needed — persist() is called synchronously on every Schedule).
	s1, err := NewScheduler(path, codec, minDelay, maxDelay, 0)
	if err != nil {
		t.Fatalf("NewScheduler (phase 1): %v", err)
	}

	ctx := context.Background()
	for _, env := range envelopes {
		if _, err := s1.Schedule(ctx, env); err != nil {
			t.Fatalf("Schedule %s: %v", env.ID, err)
		}
	}

	if got := s1.PendingCount(); got != len(envelopes) {
		t.Fatalf("before restart: want %d pending, got %d", len(envelopes), got)
	}

	// Phase 2: simulate restart — open a brand-new Scheduler against the same path.
	s2, err := NewScheduler(path, codec, minDelay, maxDelay, 0)
	if err != nil {
		t.Fatalf("NewScheduler (phase 2 / restart): %v", err)
	}

	if got := s2.PendingCount(); got != len(envelopes) {
		t.Fatalf("after restart: want %d pending, got %d", len(envelopes), got)
	}

	// Verify each original envelope ID is present by advancing the clock so all
	// scheduled envelopes become ready, then draining them.
	s2.now = func() time.Time { return time.Now().Add(48 * time.Hour) }

	ready, err := s2.DrainReady(ctx)
	if err != nil {
		t.Fatalf("DrainReady after restart: %v", err)
	}
	if len(ready) != len(envelopes) {
		t.Fatalf("after restart drain: want %d envelopes, got %d", len(envelopes), len(ready))
	}

	got := make(map[string]bool, len(ready))
	for _, env := range ready {
		got[env.ID] = true
	}
	for _, env := range envelopes {
		if !got[env.ID] {
			t.Errorf("envelope %s missing after restart", env.ID)
		}
	}
}
