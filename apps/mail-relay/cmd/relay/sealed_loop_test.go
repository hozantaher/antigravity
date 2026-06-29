package main

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"context"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// runSealedSubscriberLoop tests
// ---------------------------------------------------------------------------

// TestRunSealedSubscriberLoop_ClosedChannelExits verifies the loop exits when
// the sealed channel is closed (normal termination path).
func TestRunSealedSubscriberLoop_ClosedChannelExits(t *testing.T) {
	ch := make(chan model.Envelope)
	close(ch)

	sched := &fakeScheduler{}
	pool := &fakeMixPool{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-sealed")

	done := make(chan struct{})
	go func() {
		runSealedSubscriberLoop(context.Background(), ch, "record-only", pool, sched, audit, logger)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runSealedSubscriberLoop did not exit when channel closed")
	}
}

// TestRunSealedSubscriberLoop_ProcessesEnvelopes verifies envelopes are dispatched
// to handleSealedEnvelope (via scheduler for legacy mode).
func TestRunSealedSubscriberLoop_ProcessesEnvelopes(t *testing.T) {
	ch := make(chan model.Envelope, 2)
	ch <- model.Envelope{ID: "env-1", TenantID: "t", AliasToken: "a"}
	ch <- model.Envelope{ID: "env-2", TenantID: "t", AliasToken: "b"}
	close(ch)

	sched := &fakeScheduler{scheduledAt: time.Now().Add(30 * time.Second)}
	pool := &fakeMixPool{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-sealed-proc")

	runSealedSubscriberLoop(context.Background(), ch, "record-only", pool, sched, audit, logger)

	// Both envelopes should have been scheduled.
	if got := sched.calls; got != 2 {
		t.Errorf("expected 2 schedule calls, got %d", got)
	}
}

// TestRunSealedSubscriberLoop_PanicRecovered verifies the outer recover fires and
// the function returns (not panics) when a panic escapes handleSealedEnvelope.
func TestRunSealedSubscriberLoop_PanicRecovered(t *testing.T) {
	panicSched := &fakeScheduler{panicValue: "outer-loop-test-panic"}
	pool := &fakeMixPool{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-sealed-panic")

	ch := make(chan model.Envelope, 1)
	ch <- model.Envelope{ID: "env-panic", TenantID: "t", AliasToken: "x"}
	close(ch)

	// Should not panic out — handleSealedEnvelope recovers its own panics.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic escaped runSealedSubscriberLoop: %v", r)
		}
	}()
	runSealedSubscriberLoop(context.Background(), ch, "record-only", pool, panicSched, audit, logger)
}

// TestRunSealedSubscriberLoop_OuterRecoverFires exercises the outer
// `if r := recover(); r != nil` branch in runSealedSubscriberLoop by injecting
// a panicking handler via sealedEnvelopeHandlerFn.
func TestRunSealedSubscriberLoop_OuterRecoverFires(t *testing.T) {
	// Replace the handler with one that panics unconditionally (bypasses
	// handleSealedEnvelope's own internal recover).
	orig := sealedEnvelopeHandlerFn
	defer func() { sealedEnvelopeHandlerFn = orig }()

	sealedEnvelopeHandlerFn = func(
		_ context.Context, _ model.Envelope, _ string,
		_ sealedEnvelopeMixPool, _ sealedEnvelopeScheduler,
		_ auditRecorder, _ *minlog.Logger,
	) {
		panic("injected handler panic for outer-recover test")
	}

	pool := &fakeMixPool{}
	sched := &fakeScheduler{}
	audit := &fakeAuditRecorder{}
	logger := minlog.New("test-outer-recover")

	ch := make(chan model.Envelope, 1)
	ch <- model.Envelope{ID: "env-outer", TenantID: "t", AliasToken: "y"}
	close(ch)

	// Must not panic out of runSealedSubscriberLoop — outer recover should catch it.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("outer recover failed to catch panic: %v", r)
		}
	}()
	runSealedSubscriberLoop(context.Background(), ch, "record-only", pool, sched, audit, logger)
}
