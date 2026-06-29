package relay

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"relay/internal/model"
)

// Sprint AW7-5 — Scheduler.Reschedule tests for the greylist auto-retry path.
// The Reschedule contract is: re-queue an envelope with StatusScheduled,
// ScheduledAt set to nextAttemptAt, Attempts captured from the caller-provided
// envelope, and LastError truncated to the safe cap.

func newRescheduleScheduler(t *testing.T) *Scheduler {
	t.Helper()
	dir := t.TempDir()
	s, err := NewScheduler(filepath.Join(dir, "queue.json"), testCodec(t), time.Minute, time.Minute, time.Hour)
	if err != nil {
		t.Fatalf("new scheduler: %v", err)
	}
	return s
}

// TestReschedule_ReinsertsAfterDrain covers the production path: DrainReady
// removes the envelope, then Reschedule re-inserts it with the new ScheduledAt
// and incremented Attempts.
func TestReschedule_ReinsertsAfterDrain(t *testing.T) {
	s := newRescheduleScheduler(t)
	ctx := context.Background()

	env := model.Envelope{ID: "env-rs-1", TenantID: "t1", BucketedAt: time.Now()}
	env.Attempts = 1 // attempt 1 just failed, retry queues attempt 2.

	next := time.Now().Add(5 * time.Minute)
	if err := s.Reschedule(ctx, env, next, "421 greylisted"); err != nil {
		t.Fatalf("Reschedule returned err: %v", err)
	}

	if got := s.PendingCount(); got != 1 {
		t.Fatalf("PendingCount = %d, want 1", got)
	}

	pending := s.PendingEnvelopes()
	if len(pending) != 1 {
		t.Fatalf("got %d pending, want 1", len(pending))
	}
	got := pending[0]
	if got.Status != model.StatusScheduled {
		t.Errorf("Status = %q, want %q", got.Status, model.StatusScheduled)
	}
	if !got.ScheduledAt.Equal(next) {
		t.Errorf("ScheduledAt = %v, want %v", got.ScheduledAt, next)
	}
	if !got.NextAttemptAt.Equal(next) {
		t.Errorf("NextAttemptAt = %v, want %v", got.NextAttemptAt, next)
	}
	if got.Attempts != 1 {
		t.Errorf("Attempts = %d, want 1", got.Attempts)
	}
	if got.LastError != "421 greylisted" {
		t.Errorf("LastError = %q, want %q", got.LastError, "421 greylisted")
	}
}

// TestReschedule_UpdatesInPlace covers the case where the envelope is still
// present in the queue (e.g. a different code path called Reschedule before
// DrainReady removed it). The row must be updated, not duplicated.
func TestReschedule_UpdatesInPlace(t *testing.T) {
	s := newRescheduleScheduler(t)
	ctx := context.Background()

	// Schedule first to put the envelope in the queue.
	env := model.Envelope{ID: "env-rs-2", TenantID: "t1", BucketedAt: time.Now()}
	if _, err := s.Schedule(ctx, env); err != nil {
		t.Fatalf("schedule: %v", err)
	}

	// Now reschedule (envelope still tracked).
	next := time.Now().Add(15 * time.Minute)
	env.Attempts = 2
	if err := s.Reschedule(ctx, env, next, "450 deferred"); err != nil {
		t.Fatalf("Reschedule: %v", err)
	}

	// Must remain a single row.
	if got := s.PendingCount(); got != 1 {
		t.Fatalf("PendingCount = %d, want 1 (no duplication)", got)
	}
	pending := s.PendingEnvelopes()[0]
	if pending.Attempts != 2 {
		t.Errorf("Attempts = %d, want 2", pending.Attempts)
	}
	if !pending.ScheduledAt.Equal(next) {
		t.Errorf("ScheduledAt = %v, want %v", pending.ScheduledAt, next)
	}
}

// TestReschedule_TruncatesLongError verifies the LastError cap (256 bytes)
// to keep the persisted JSON envelope size bounded — long upstream error
// strings (multi-line SMTP replies, stack traces) must not bloat the queue.
func TestReschedule_TruncatesLongError(t *testing.T) {
	s := newRescheduleScheduler(t)
	ctx := context.Background()

	long := strings.Repeat("x", 1000)
	env := model.Envelope{ID: "env-rs-3", TenantID: "t1", Attempts: 1, BucketedAt: time.Now()}
	if err := s.Reschedule(ctx, env, time.Now().Add(time.Minute), long); err != nil {
		t.Fatalf("Reschedule: %v", err)
	}
	got := s.PendingEnvelopes()[0]
	if len(got.LastError) > 256 {
		t.Errorf("LastError len = %d, want <= 256", len(got.LastError))
	}
}

// TestReschedule_ThenDrainReadyAtFutureTime confirms the rescheduled
// envelope is not drained early: it must wait until ScheduledAt has passed.
// This is the load-bearing assertion for the retry path — getting it wrong
// would mean retries fire immediately and amplify recipient pressure.
func TestReschedule_ThenDrainReadyAtFutureTime(t *testing.T) {
	s := newRescheduleScheduler(t)
	ctx := context.Background()
	now := time.Now()
	s.now = func() time.Time { return now }

	env := model.Envelope{ID: "env-rs-4", TenantID: "t1", BucketedAt: now, Attempts: 1}
	if err := s.Reschedule(ctx, env, now.Add(5*time.Minute), "421"); err != nil {
		t.Fatalf("Reschedule: %v", err)
	}

	// 1 minute later — still in the future, not drained yet.
	s.now = func() time.Time { return now.Add(time.Minute) }
	ready, err := s.DrainReady(ctx)
	if err != nil {
		t.Fatalf("DrainReady: %v", err)
	}
	if len(ready) != 0 {
		t.Errorf("got %d ready early, want 0 (must respect ScheduledAt)", len(ready))
	}

	// 6 minutes later — past ScheduledAt, must drain now.
	s.now = func() time.Time { return now.Add(6 * time.Minute) }
	ready, err = s.DrainReady(ctx)
	if err != nil {
		t.Fatalf("DrainReady: %v", err)
	}
	if len(ready) != 1 {
		t.Errorf("got %d ready after backoff, want 1", len(ready))
	}
	if len(ready) > 0 && ready[0].Attempts != 1 {
		t.Errorf("drained env Attempts = %d, want 1 (caller increments on next attempt)", ready[0].Attempts)
	}
}
