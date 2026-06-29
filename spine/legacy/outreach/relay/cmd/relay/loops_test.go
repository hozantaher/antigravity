package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Fakes for runDeadDropGCLoop and runLimiterCleanupLoop
// ---------------------------------------------------------------------------

type fakeGCer struct {
	calls int32
}

func (g *fakeGCer) GC() int {
	atomic.AddInt32(&g.calls, 1)
	return 0
}

type fakeCleaner struct {
	calls int32
}

func (c *fakeCleaner) Cleanup() {
	atomic.AddInt32(&c.calls, 1)
}

// ---------------------------------------------------------------------------
// runDeadDropGCLoop tests
// ---------------------------------------------------------------------------

// TestRunDeadDropGCLoop_ContextCancel verifies the loop exits cleanly when the
// context is cancelled without firing GC.
func TestRunDeadDropGCLoop_ContextCancel(t *testing.T) {
	store := &fakeGCer{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancelled

	done := make(chan struct{})
	go func() {
		runDeadDropGCLoop(ctx, store, 100*time.Millisecond)
		close(done)
	}()

	select {
	case <-done:
		// OK
	case <-time.After(2 * time.Second):
		t.Fatal("runDeadDropGCLoop did not exit on context cancel")
	}
}

// TestRunDeadDropGCLoop_TickerFires verifies GC is called when the ticker fires.
func TestRunDeadDropGCLoop_TickerFires(t *testing.T) {
	store := &fakeGCer{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go runDeadDropGCLoop(ctx, store, 10*time.Millisecond)

	// Wait for at least one tick to fire.
	deadline := time.After(500 * time.Millisecond)
	for {
		if atomic.LoadInt32(&store.calls) >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("GC was never called within 500ms")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
}

// TestRunDeadDropGCLoop_MultipleTicksFire verifies GC is called multiple times.
func TestRunDeadDropGCLoop_MultipleTicksFire(t *testing.T) {
	store := &fakeGCer{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go runDeadDropGCLoop(ctx, store, 5*time.Millisecond)

	deadline := time.After(300 * time.Millisecond)
	for {
		if atomic.LoadInt32(&store.calls) >= 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected ≥3 GC calls, got %d", atomic.LoadInt32(&store.calls))
		case <-time.After(2 * time.Millisecond):
		}
	}
}

// ---------------------------------------------------------------------------
// runLimiterCleanupLoop tests
// ---------------------------------------------------------------------------

// TestRunLimiterCleanupLoop_ContextCancel verifies the loop exits on cancel.
func TestRunLimiterCleanupLoop_ContextCancel(t *testing.T) {
	limiter := &fakeCleaner{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancelled

	done := make(chan struct{})
	go func() {
		runLimiterCleanupLoop(ctx, limiter, 100*time.Millisecond)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runLimiterCleanupLoop did not exit on context cancel")
	}
}

// TestRunLimiterCleanupLoop_TickerFires verifies Cleanup is called when ticker fires.
func TestRunLimiterCleanupLoop_TickerFires(t *testing.T) {
	limiter := &fakeCleaner{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go runLimiterCleanupLoop(ctx, limiter, 10*time.Millisecond)

	deadline := time.After(500 * time.Millisecond)
	for {
		if atomic.LoadInt32(&limiter.calls) >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("Cleanup was never called within 500ms")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// TestRunLimiterCleanupLoop_MultipleTicksFire verifies Cleanup is called multiple times.
func TestRunLimiterCleanupLoop_MultipleTicksFire(t *testing.T) {
	limiter := &fakeCleaner{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go runLimiterCleanupLoop(ctx, limiter, 5*time.Millisecond)

	deadline := time.After(300 * time.Millisecond)
	for {
		if atomic.LoadInt32(&limiter.calls) >= 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected ≥3 Cleanup calls, got %d", atomic.LoadInt32(&limiter.calls))
		case <-time.After(2 * time.Millisecond):
		}
	}
}
