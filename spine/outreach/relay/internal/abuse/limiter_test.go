package abuse

import (
	"testing"
	"time"
)

func TestLimiterAllowsWithinLimit(t *testing.T) {
	l := NewLimiter(5)
	for i := 0; i < 5; i++ {
		if err := l.Check("actor-1"); err != nil {
			t.Fatalf("request %d should be allowed: %v", i, err)
		}
	}
}

func TestLimiterBlocksOverLimit(t *testing.T) {
	l := NewLimiter(3)
	for i := 0; i < 3; i++ {
		l.Check("actor-1")
	}
	if err := l.Check("actor-1"); err != ErrRateLimited {
		t.Fatalf("expected ErrRateLimited, got %v", err)
	}
}

func TestLimiterIsolatesActors(t *testing.T) {
	l := NewLimiter(2)
	l.Check("actor-1")
	l.Check("actor-1")

	// actor-2 should still be allowed
	if err := l.Check("actor-2"); err != nil {
		t.Fatalf("actor-2 should be allowed: %v", err)
	}
}

// TestLimiterPrunesOldEntries verifies that entries older than one minute
// are evicted on subsequent Check calls, freeing up slots for the actor.
func TestLimiterPrunesOldEntries(t *testing.T) {
	l := NewLimiter(3)
	now := time.Date(2026, 4, 17, 12, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return now }

	// Fill the window.
	for i := 0; i < 3; i++ {
		if err := l.Check("actor-1"); err != nil {
			t.Fatalf("initial fill request %d: %v", i, err)
		}
	}
	if err := l.Check("actor-1"); err != ErrRateLimited {
		t.Fatalf("expected ErrRateLimited after fill, got %v", err)
	}

	// Advance clock beyond the 1-minute window — all prior entries prune.
	l.now = func() time.Time { return now.Add(2 * time.Minute) }

	for i := 0; i < 3; i++ {
		if err := l.Check("actor-1"); err != nil {
			t.Fatalf("after window elapse, request %d should be allowed: %v", i, err)
		}
	}
	if err := l.Check("actor-1"); err != ErrRateLimited {
		t.Fatalf("expected ErrRateLimited after refill, got %v", err)
	}
}

// TestLimiterCleanupRemovesStaleActors covers the Cleanup routine:
// actors with no activity in the last 5 minutes are dropped.
func TestLimiterCleanupRemovesStaleActors(t *testing.T) {
	l := NewLimiter(5)
	base := time.Date(2026, 4, 17, 10, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return base }

	if err := l.Check("stale"); err != nil {
		t.Fatalf("initial stale Check: %v", err)
	}
	if err := l.Check("fresh"); err != nil {
		t.Fatalf("initial fresh Check: %v", err)
	}

	// Advance past the 5-minute cleanup horizon for "stale", then record a
	// fresh entry for "fresh" so only "stale" should be evicted.
	l.now = func() time.Time { return base.Add(6 * time.Minute) }
	if err := l.Check("fresh"); err != nil {
		t.Fatalf("fresh Check after delay: %v", err)
	}

	l.Cleanup()

	l.mu.Lock()
	defer l.mu.Unlock()

	if _, ok := l.windows["stale"]; ok {
		t.Errorf("expected stale actor to be evicted")
	}
	if _, ok := l.windows["fresh"]; !ok {
		t.Errorf("expected fresh actor to survive cleanup")
	}
}

// TestLimiterCleanupRemovesEmptyWindows exercises the len(counts)==0 branch
// in Cleanup. A window whose entries were all pruned by Check must be
// removed by the next Cleanup call.
func TestLimiterCleanupRemovesEmptyWindows(t *testing.T) {
	l := NewLimiter(2)
	base := time.Date(2026, 4, 17, 9, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return base }

	if err := l.Check("actor-empty"); err != nil {
		t.Fatalf("initial Check: %v", err)
	}

	// Advance past the 1-minute Check-window but within the 5-minute Cleanup
	// window, then invoke Check again so prior entries are pruned — the
	// window slice is now reused with old entries dropped.
	l.now = func() time.Time { return base.Add(90 * time.Second) }

	// Force the window into an empty state by manually clearing counts while
	// keeping the map entry, mimicking a pruned-but-not-removed window.
	l.mu.Lock()
	l.windows["actor-empty"].counts = nil
	l.mu.Unlock()

	l.Cleanup()

	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.windows["actor-empty"]; ok {
		t.Errorf("expected empty-window actor to be removed by Cleanup")
	}
}

// TestLimiterCleanupKeepsRecent verifies actors with recent activity
// (latest entry within 5 minutes) are retained by Cleanup.
func TestLimiterCleanupKeepsRecent(t *testing.T) {
	l := NewLimiter(3)
	base := time.Date(2026, 4, 17, 8, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return base }

	for i := 0; i < 2; i++ {
		if err := l.Check("recent"); err != nil {
			t.Fatalf("Check %d: %v", i, err)
		}
	}

	// Advance slightly — less than 5 minutes.
	l.now = func() time.Time { return base.Add(90 * time.Second) }
	l.Cleanup()

	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.windows["recent"]
	if !ok {
		t.Fatalf("recent actor should be retained")
	}
	if len(w.counts) == 0 {
		t.Errorf("recent actor's counts should survive")
	}
}

// TestLimiterIsGoroutineSafe exercises concurrent Check + Cleanup to verify
// the mutex protects shared state under -race.
func TestLimiterIsGoroutineSafe(t *testing.T) {
	l := NewLimiter(1000)
	done := make(chan struct{})

	go func() {
		for i := 0; i < 200; i++ {
			l.Check("concurrent")
		}
		close(done)
	}()
	for i := 0; i < 50; i++ {
		l.Cleanup()
	}
	<-done
}
