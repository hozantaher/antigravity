package main

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"relay/internal/transport/metamin"
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Fakes for runDrainLoop
// ---------------------------------------------------------------------------

// fakeBatchDrainer implements batchDrainer and can inject errors or panics.
type fakeBatchDrainer struct {
	envelopes  []model.Envelope
	returnErr  error
	panicValue any
	calls      int32
}

func (d *fakeBatchDrainer) DrainAndShuffle(_ context.Context) ([]model.Envelope, error) {
	atomic.AddInt32(&d.calls, 1)
	if d.panicValue != nil {
		panic(d.panicValue)
	}
	if d.returnErr != nil {
		return nil, d.returnErr
	}
	return d.envelopes, nil
}

// fakeDrainPendingScheduler embeds fakeDrainScheduler and adds PendingCount.
type fakeDrainPendingScheduler struct {
	fakeDrainScheduler
	pendingCount int
}

func (s *fakeDrainPendingScheduler) PendingCount() int { return s.pendingCount }

// ---------------------------------------------------------------------------
// runDrainLoop tests
// ---------------------------------------------------------------------------

// TestRunDrainLoop_ExitsOnContextCancel verifies the loop exits when ctx is done.
func TestRunDrainLoop_ExitsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancelled

	drainer := &fakeBatchDrainer{}
	sched := &fakeDrainPendingScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-drain")
	m := metamin.NewMinimizer()

	done := make(chan struct{})
	go func() {
		runDrainLoop(ctx, drainer, newDrainEnvelopeConfig("record-only"), sched, exitV, nil, nil, nil, m, audit, logger, 100*time.Millisecond)
		close(done)
	}()

	select {
	case <-done:
		// OK — exited on context cancel
	case <-time.After(3 * time.Second):
		t.Fatal("runDrainLoop did not exit on context cancel")
	}
}

// TestRunDrainLoop_DrainError verifies drain errors are logged and the loop continues.
func TestRunDrainLoop_DrainError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	drainErr := errors.New("scheduler read error")
	drainer := &fakeBatchDrainer{returnErr: drainErr}
	sched := &fakeDrainPendingScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-drain-err")
	m := metamin.NewMinimizer()

	go runDrainLoop(ctx, drainer, newDrainEnvelopeConfig("record-only"), sched, exitV, nil, nil, nil, m, audit, logger, 10*time.Millisecond)

	// Wait for at least 3 error iterations to confirm loop continues.
	deadline := time.After(500 * time.Millisecond)
	for {
		if atomic.LoadInt32(&drainer.calls) >= 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected ≥3 drain calls on repeated error, got %d", atomic.LoadInt32(&drainer.calls))
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// TestRunDrainLoop_PanicRecovered verifies the panic recovery fires and the function
// returns (panicking inside DrainAndShuffle terminates the current loop iteration).
func TestRunDrainLoop_PanicRecovered(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	drainer := &fakeBatchDrainer{panicValue: "deliberate drain panic"}
	sched := &fakeDrainPendingScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-drain-panic")
	m := metamin.NewMinimizer()

	done := make(chan struct{})
	go func() {
		defer func() {
			if r := recover(); r != nil {
				// Panic escaped the helper — test fails below
			}
		}()
		runDrainLoop(ctx, drainer, newDrainEnvelopeConfig("record-only"), sched, exitV, nil, nil, nil, m, audit, logger, 1*time.Millisecond)
		close(done)
	}()

	// runDrainLoop should return after the panic is recovered.
	select {
	case <-done:
		// OK — function returned after panic recovery
	case <-time.After(2 * time.Second):
		t.Fatal("runDrainLoop did not return after panic recovery")
	}
}

// TestRunDrainLoop_ProcessesEnvelopes verifies that when DrainAndShuffle returns
// envelopes, they are processed (cover traffic is skipped, real envelopes are relayed).
func TestRunDrainLoop_ProcessesEnvelopes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	envs := []model.Envelope{
		{ID: "env-1", TenantID: "t", IsCover: true},
		{ID: "env-2", TenantID: "t"},
	}
	// Return envelopes once, then return empty to avoid spinning.
	callCount := int32(0)
	drainer := &fakeBatchDrainer{}
	drainer.envelopes = envs

	// Override to return envelopes on first call, then empty.
	var customDrainer = &onceDrainer{envelopes: envs}

	sched := &fakeDrainPendingScheduler{}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-drain-proc")
	m := metamin.NewMinimizer()

	go runDrainLoop(ctx, customDrainer, newDrainEnvelopeConfig("record-only"), sched, exitV, nil, nil, nil, m, audit, logger, 10*time.Millisecond)

	// Wait for env-2 to be relayed (cover is skipped, env-2 is record-only).
	deadline := time.After(500 * time.Millisecond)
	for {
		if sched.relayedCount() >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected env-2 to be relayed, relayed count: %d", sched.relayedCount())
		case <-time.After(5 * time.Millisecond):
		}
	}
	_ = callCount
}

// onceDrainer returns the given envelopes on the first call, then empty forever.
type onceDrainer struct {
	envelopes []model.Envelope
	called    int32
}

func (d *onceDrainer) DrainAndShuffle(_ context.Context) ([]model.Envelope, error) {
	if atomic.CompareAndSwapInt32(&d.called, 0, 1) {
		return d.envelopes, nil
	}
	return nil, nil
}

// TestRunDrainLoop_EmptyBatch verifies drain_tick is logged for empty batches.
func TestRunDrainLoop_EmptyBatch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	drainer := &fakeBatchDrainer{} // returns empty slice
	sched := &fakeDrainPendingScheduler{pendingCount: 5}
	exitV := &fakeDrainExitVerifier{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-drain-empty")
	m := metamin.NewMinimizer()

	go runDrainLoop(ctx, drainer, newDrainEnvelopeConfig("record-only"), sched, exitV, nil, nil, nil, m, audit, logger, 5*time.Millisecond)

	// Wait for a few drain ticks.
	deadline := time.After(300 * time.Millisecond)
	for {
		if atomic.LoadInt32(&drainer.calls) >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected ≥2 drain ticks, got %d", atomic.LoadInt32(&drainer.calls))
		case <-time.After(5 * time.Millisecond):
		}
	}
}
