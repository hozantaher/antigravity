package watchdog

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mailboxes/mailbox"
)

// TestAlertRace_ConcurrentTicksFireOnce stresses evaluateAuthFailAlert with
// N parallel goroutines all targeting the same mailbox at the same instant.
//
// The production scenario: a scheduled Tick and a dashboard "Recover Now"
// Tick fire within microseconds of each other. Both read recent
// lastAuthAlertAt, both see nil, both compute ShouldAlertOnAuthFail=true,
// both write the timestamp and emit an alert — operator pager lights up
// twice and counts are wrong.
//
// Invariant: given the same (mailbox, events, now) snapshot, at most ONE
// goroutine in a concurrent burst may see fired=true. The rest must be
// suppressed by the cooldown check inside the critical section.

func TestAlertRace_ConcurrentTicksFireOnce(t *testing.T) {
	// Disable noisy slog output for the race test; we inspect counts only.
	slog.SetDefault(slog.New(slog.NewJSONHandler(discardWriter{}, &slog.HandlerOptions{Level: slog.LevelError})))

	mb := mailbox.Mailbox{ID: 42, FromAddress: "race@example.test"}

	events := []AuthFailEvent{
		{FailedAt: time.Now().Add(-1 * time.Minute)},
		{FailedAt: time.Now().Add(-5 * time.Minute)},
		{FailedAt: time.Now().Add(-10 * time.Minute)},
	}

	// Event sink counts how many alert events were recorded.
	sink := &countingEventSink{}

	// Each call to ListRecent returns the same events slice — we're
	// simulating the same 3 auth-fails being visible to every concurrent
	// Tick.
	d := NewDaemon(DaemonConfig{
		Store:     &fakeStore{},
		AuthFails: &stubAuthFailLister{events: events},
		Events:    sink,
	})

	const parallel = 50
	var wg sync.WaitGroup
	var fireCount atomic.Int64
	ctx := context.Background()

	// Use a release barrier so all goroutines start the critical path
	// nearly simultaneously. Without this, goroutines serialize and the
	// race never manifests.
	start := make(chan struct{})
	for i := 0; i < parallel; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if d.evaluateAuthFailAlert(ctx, mb) {
				fireCount.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	got := fireCount.Load()
	if got != 1 {
		t.Fatalf("concurrent ticks fired alert %d times; want exactly 1 (TOCTOU race in evaluateAuthFailAlert)", got)
	}
	if sinkCount := sink.count(); sinkCount != 1 {
		t.Fatalf("event sink recorded %d alerts; want 1", sinkCount)
	}
}

// TestAlertRace_CooldownSurvivesTickBurst confirms the cooldown is respected
// when a second burst arrives shortly after the first. All goroutines in the
// second burst must see fired=false.
func TestAlertRace_CooldownSurvivesTickBurst(t *testing.T) {
	slog.SetDefault(slog.New(slog.NewJSONHandler(discardWriter{}, &slog.HandlerOptions{Level: slog.LevelError})))

	mb := mailbox.Mailbox{ID: 7, FromAddress: "cooldown@example.test"}
	events := []AuthFailEvent{
		{FailedAt: time.Now().Add(-1 * time.Minute)},
		{FailedAt: time.Now().Add(-2 * time.Minute)},
		{FailedAt: time.Now().Add(-3 * time.Minute)},
	}

	d := NewDaemon(DaemonConfig{
		Store:     &fakeStore{},
		AuthFails: &stubAuthFailLister{events: events},
		Events:    &countingEventSink{},
	})

	// First tick: one alert expected.
	ctx := context.Background()
	if !d.evaluateAuthFailAlert(ctx, mb) {
		t.Fatalf("first tick did not fire; seeded event count %d should trigger", len(events))
	}

	// Now hit the same mailbox with 30 parallel ticks — all should be
	// suppressed by cooldown.
	const parallel = 30
	var wg sync.WaitGroup
	var fireCount atomic.Int64
	start := make(chan struct{})
	for i := 0; i < parallel; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if d.evaluateAuthFailAlert(ctx, mb) {
				fireCount.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if n := fireCount.Load(); n != 0 {
		t.Fatalf("cooldown burst fired %d alerts; want 0", n)
	}
}

// stubAuthFailLister satisfies AuthFailReader + AuthFailLister with a fixed
// event list. Used across race tests.
type stubAuthFailLister struct {
	events []AuthFailEvent
}

func (s *stubAuthFailLister) CountRecent(ctx context.Context, mailboxID int64, window time.Duration) (int, error) {
	return len(s.events), nil
}

func (s *stubAuthFailLister) ResolveAll(ctx context.Context, mailboxID int64) error { return nil }

func (s *stubAuthFailLister) ListRecent(ctx context.Context, mailboxID int64, window time.Duration) ([]AuthFailEvent, error) {
	return s.events, nil
}

// countingEventSink records how many events were inserted.
type countingEventSink struct {
	mu sync.Mutex
	n  int
}

func (c *countingEventSink) Record(ctx context.Context, e Event) error {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
	return nil
}

func (c *countingEventSink) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// discardWriter satisfies io.Writer for silencing slog in tests.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
