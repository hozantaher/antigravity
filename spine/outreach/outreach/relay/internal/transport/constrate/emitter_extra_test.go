package constrate

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"relay/internal/minlog"
	"relay/internal/model"
)

// ---------------------------------------------------------------------------
// Test doubles with error injection
// ---------------------------------------------------------------------------

// failingSender fails the first N calls then succeeds. Used to exercise
// the retry + requeue branch in emitOne.
type failingSender struct {
	mu         sync.Mutex
	failFirst  int // number of calls that should fail
	calls      int
	sent       []model.Envelope
	alwaysFail bool
}

func (f *failingSender) Send(ctx context.Context, env model.Envelope) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.alwaysFail || f.calls <= f.failFirst {
		return errors.New("synthetic send failure")
	}
	f.sent = append(f.sent, env)
	return nil
}

func (f *failingSender) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// trackingSource records Requeue calls so we can assert the requeue branch ran.
type trackingSource struct {
	mu        sync.Mutex
	queue     []model.Envelope
	requeued  []model.Envelope
	drawCalls atomic.Int64
}

func (s *trackingSource) Draw() (model.Envelope, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.drawCalls.Add(1)
	if len(s.queue) == 0 {
		return model.Envelope{IsCover: true, ID: "cover"}, false
	}
	env := s.queue[0]
	s.queue = s.queue[1:]
	return env, true
}

func (s *trackingSource) Requeue(env model.Envelope) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requeued = append(s.requeued, env)
}

// ---------------------------------------------------------------------------
// IsRunning
// ---------------------------------------------------------------------------

func TestIsRunningReturnsFalseBeforeRun(t *testing.T) {
	e := NewEmitter(50*time.Millisecond, &mockSource{}, &mockSender{}, minlog.New("test"))
	if e.IsRunning() {
		t.Fatal("expected IsRunning() == false before Run")
	}
}

func TestIsRunningReturnsTrueWhileRunningAndFalseAfterCancel(t *testing.T) {
	e := NewEmitter(20*time.Millisecond, &mockSource{}, &mockSender{}, minlog.New("test"))
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		e.Run(ctx)
		close(done)
	}()

	// Wait until the goroutine flips running to true.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if e.IsRunning() {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !e.IsRunning() {
		cancel()
		<-done
		t.Fatal("expected IsRunning() == true after Run started")
	}

	cancel()
	<-done

	if e.IsRunning() {
		t.Fatal("expected IsRunning() == false after context cancel")
	}
}

// ---------------------------------------------------------------------------
// Run second call short-circuits via `running` guard
// ---------------------------------------------------------------------------

func TestRunReturnsImmediatelyWhenAlreadyRunning(t *testing.T) {
	e := NewEmitter(20*time.Millisecond, &mockSource{}, &mockSender{}, minlog.New("test"))
	// Pre-set running flag so the second Run returns immediately.
	e.mu.Lock()
	e.running = true
	e.mu.Unlock()

	done := make(chan struct{})
	go func() {
		e.Run(context.Background()) // should return right away
		close(done)
	}()

	select {
	case <-done:
		// good -- returned without blocking
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Run did not return when already running")
	}
}

// ---------------------------------------------------------------------------
// emitOne: retry exhaustion requeues real message and draws cover fallback
// ---------------------------------------------------------------------------

func TestEmitOneRequeuesRealWhenAllRetriesFail(t *testing.T) {
	source := &trackingSource{
		queue: []model.Envelope{{ID: "real-1"}},
	}
	// alwaysFail: Send never succeeds; emitOne attempts 3 times, then
	// draws a cover and attempts once more.
	sender := &failingSender{alwaysFail: true}
	logger := minlog.New("test")

	e := NewEmitter(time.Hour, source, sender, logger) // interval irrelevant; we invoke emitOne directly
	e.emitOne(context.Background())

	// 3 retry attempts on the real, plus one attempt on the cover.
	if got := sender.callCount(); got != 4 {
		t.Fatalf("expected 4 Send calls (3 retries + 1 cover), got %d", got)
	}

	source.mu.Lock()
	defer source.mu.Unlock()
	if len(source.requeued) != 1 {
		t.Fatalf("expected real message to be requeued once, got %d", len(source.requeued))
	}
	if source.requeued[0].ID != "real-1" {
		t.Fatalf("requeued wrong envelope: %+v", source.requeued[0])
	}

	// Stats: this was a real message for accounting purposes (isReal=true).
	stats := e.Stats()
	if stats.TotalEmitted != 1 || stats.RealEmitted != 1 || stats.CoverEmitted != 0 {
		t.Fatalf("stats mismatch: %+v", stats)
	}
}

func TestEmitOneRetriesSuccessDoesNotRequeue(t *testing.T) {
	source := &trackingSource{
		queue: []model.Envelope{{ID: "real-1"}},
	}
	sender := &failingSender{failFirst: 2} // fail twice, succeed on 3rd attempt
	e := NewEmitter(time.Hour, source, sender, minlog.New("test"))

	e.emitOne(context.Background())

	if got := sender.callCount(); got != 3 {
		t.Fatalf("expected 3 Send attempts (2 fails + 1 success), got %d", got)
	}

	source.mu.Lock()
	defer source.mu.Unlock()
	if len(source.requeued) != 0 {
		t.Fatalf("expected no requeue on eventual success, got %d", len(source.requeued))
	}

	stats := e.Stats()
	if stats.RealEmitted != 1 {
		t.Fatalf("expected 1 real emitted, got %d", stats.RealEmitted)
	}
}

// ---------------------------------------------------------------------------
// emitOne: cover-only path when send fails and nothing to requeue
// ---------------------------------------------------------------------------

func TestEmitOneCoverPathWhenSendFailsAndSourceEmpty(t *testing.T) {
	source := &trackingSource{} // empty -> Draw returns cover (isReal=false)
	sender := &failingSender{alwaysFail: true}
	e := NewEmitter(time.Hour, source, sender, minlog.New("test"))

	e.emitOne(context.Background())

	source.mu.Lock()
	defer source.mu.Unlock()

	// Not a real message, so Requeue must NOT be called.
	if len(source.requeued) != 0 {
		t.Fatalf("expected no requeue when envelope was cover, got %d", len(source.requeued))
	}

	// Stats should reflect one cover emission.
	stats := e.Stats()
	if stats.CoverEmitted != 1 {
		t.Fatalf("expected 1 cover emitted, got %d", stats.CoverEmitted)
	}
	if stats.TotalEmitted != 1 {
		t.Fatalf("expected TotalEmitted=1, got %d", stats.TotalEmitted)
	}
}

// ---------------------------------------------------------------------------
// NewEmitter sets fields correctly
// ---------------------------------------------------------------------------

func TestNewEmitterSetsFields(t *testing.T) {
	src := &mockSource{}
	snd := &mockSender{}
	log := minlog.New("test")
	const interval = 123 * time.Millisecond

	e := NewEmitter(interval, src, snd, log)
	if e.interval != interval {
		t.Fatalf("interval = %v, want %v", e.interval, interval)
	}
	if e.source != src {
		t.Fatal("source not set")
	}
	if e.sender != snd {
		t.Fatal("sender not set")
	}
	if e.log != log {
		t.Fatal("log not set")
	}
	if e.IsRunning() {
		t.Fatal("emitter should not be running after construction")
	}
}
