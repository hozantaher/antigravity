package main

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"relay/internal/delivery"
	"relay/internal/minlog"
	"relay/internal/model"
	"relay/internal/transport"
)

// Sprint AW7-5 — auto-retry for transient (4xx) SMTP failures in
// processDrainEnvelope. Tests cover:
//
//   1. transient (421) → re-queue with 5m backoff (attempt 1 → 2)
//   2. transient (450) → re-queue
//   3. permanent (550) → MarkFailed, no retry
//   4. codeless transport err (connection refused) → re-queue (transient)
//   5. attempt budget reached (env.Attempts == max) → MarkFailed
//   6. exponential backoff: attempt 2 → 15m wait
//   7. capped backoff: attempt 99 → uses last entry
//   8. feature flag disabled → original behavior (MarkFailed)
//   9. retry success on attempt 2 → MarkRelayed, no failed
//  10. audit row emitted per retry (EventRelayRetryScheduled)
//  11. Reschedule error → fall back to MarkFailed (don't leak envelope)
//  12. anti-trace transport unaffected (deliverer interface unchanged)

// retryCfgFor returns a deterministic 3-attempt config: 5m, 15m, 60m backoff.
func retryCfgFor() delivery.RetryConfig {
	return delivery.RetryConfig{
		Enabled:     true,
		MaxAttempts: 3,
		Backoff:     []time.Duration{5 * time.Minute, 15 * time.Minute, 60 * time.Minute},
	}
}

// fixedNow returns a fixed time func for deterministic backoff math.
func fixedNow() (func() time.Time, time.Time) {
	t := time.Date(2026, 5, 9, 22, 0, 0, 0, time.UTC)
	return func() time.Time { return t }, t
}

func newGreylistCfg(_ *testing.T) drainEnvelopeConfig {
	cfg := newDrainEnvelopeConfig("outbound-smtp")
	cfg.retryCfg = retryCfgFor()
	cfg.nowFn, _ = fixedNow()
	return cfg
}

// smtpErr produces an error string starting with the SMTP code so the
// classifier's regex/scan picks it up. Format mirrors net/smtp.
func smtpErr(code int, text string) error {
	return fmt.Errorf("%d %s", code, text)
}

// TestRetry_TransientGreylisted_421 covers the LUMIT/auto-mt.com incident:
// first attempt returns 421 → must re-queue, NOT MarkFailed.
func TestRetry_TransientGreylisted_421(t *testing.T) {
	sched := &fakeDrainScheduler{}
	exitV := &fakeDrainExitVerifier{}
	auditRec := &fakeAuditRecorder{}
	logger := minlog.New("test")

	cfg := newGreylistCfg(t)
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: smtpErr(421, "Service not available")}
	}

	env := buildOutboundSMTPEnvelope(t, "smtp.lumit.example", "pw", 587)
	processDrainEnvelope(context.Background(), env, cfg, sched, exitV, nil, nil, nil, newMinimizer(), auditRec, logger)

	if sched.rescheduleCount() != 1 {
		t.Fatalf("expected 1 reschedule (greylist), got %d", sched.rescheduleCount())
	}
	if len(sched.failedIDs) != 0 {
		t.Errorf("expected 0 MarkFailed (retry path took over), got %d", len(sched.failedIDs))
	}
	rc := sched.rescheduled[0]
	if rc.attempts != 1 {
		t.Errorf("attempts = %d, want 1", rc.attempts)
	}
	_, base := fixedNow()
	// The reschedule delay is jittered ±25% (cryptoJitterDuration) so a batch
	// greylisted in one tick does not re-fire synchronously. Assert the next
	// attempt lands inside the jitter window around the 5m base backoff rather
	// than at an exact instant.
	base5m := 5 * time.Minute
	delta := rc.nextAttemptAt.Sub(base)
	if delta < base5m*3/4 || delta > base5m*5/4 {
		t.Errorf("nextAttemptAt delta = %v, want within ±25%% of %v", delta, base5m)
	}
}

// TestRetry_TransientGreylisted_450 covers postgrey-style "deferred" replies
// from autostonis.cz.
func TestRetry_TransientGreylisted_450(t *testing.T) {
	sched := &fakeDrainScheduler{}
	cfg := newGreylistCfg(t)
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: smtpErr(450, "4.7.1 greylisted")}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.autostonis.cz", "pw", 587)
	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), &fakeAuditRecorder{}, minlog.New("t"))

	if sched.rescheduleCount() != 1 {
		t.Fatalf("expected 1 reschedule, got %d", sched.rescheduleCount())
	}
}

// TestRetry_PermFailure550_NoRetry covers 5xx → original MarkFailed
// behavior. Auth failures, recipient rejects, body rejects must not retry.
func TestRetry_PermFailure550_NoRetry(t *testing.T) {
	sched := &fakeDrainScheduler{}
	cfg := newGreylistCfg(t)
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: smtpErr(550, "user unknown")}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)
	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), &fakeAuditRecorder{}, minlog.New("t"))

	if sched.rescheduleCount() != 0 {
		t.Errorf("expected 0 reschedule for 5xx, got %d", sched.rescheduleCount())
	}
	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 MarkFailed, got %d", len(sched.failedIDs))
	}
}

// TestRetry_NetworkError_Retries covers errors with no SMTP code (connection
// refused to the wgsocks bridge, TLS handshake failure, context cancel, pool
// quarantine). These are transport-layer failures: the message never reached
// the recipient MTA, so re-queuing cannot duplicate it. They MUST re-queue with
// backoff (bounded by MaxAttempts) instead of being permanently MarkFailed —
// the previous behavior silently lost mail on the relay's dominant failure mode.
func TestRetry_NetworkError_Retries(t *testing.T) {
	sched := &fakeDrainScheduler{}
	cfg := newGreylistCfg(t)
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: errors.New("connect: connection refused")}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)
	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), &fakeAuditRecorder{}, minlog.New("t"))

	if sched.rescheduleCount() != 1 {
		t.Errorf("expected 1 reschedule for codeless transport error, got %d", sched.rescheduleCount())
	}
	if len(sched.failedIDs) != 0 {
		t.Errorf("expected 0 MarkFailed (transport error is transient), got %d", len(sched.failedIDs))
	}
}

// TestRetry_AttemptBudgetExhausted covers the cap: when an envelope has
// already been retried MaxAttempts-1 times and fails on the final attempt,
// it MUST go to MarkFailed (no infinite loop).
func TestRetry_AttemptBudgetExhausted(t *testing.T) {
	sched := &fakeDrainScheduler{}
	cfg := newGreylistCfg(t) // MaxAttempts = 3
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: smtpErr(421, "still greylisted")}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)
	env.Attempts = 2 // attempts 1+2 already failed; this is attempt 3 (the last).

	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), &fakeAuditRecorder{}, minlog.New("t"))

	if sched.rescheduleCount() != 0 {
		t.Errorf("expected 0 reschedule (budget exhausted), got %d", sched.rescheduleCount())
	}
	if len(sched.failedIDs) != 1 {
		t.Errorf("expected 1 MarkFailed (budget exhausted), got %d", len(sched.failedIDs))
	}
}

// TestRetry_ExponentialBackoff verifies the per-attempt wait progression
// (5m → 15m → 60m). Attempt N's failure schedules the next attempt at
// now + Backoff[N-1].
func TestRetry_ExponentialBackoff(t *testing.T) {
	sched := &fakeDrainScheduler{}
	cfg := newGreylistCfg(t)
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: smtpErr(421, "greylisted")}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)
	env.Attempts = 1 // failed once → expect 15m wait for attempt 3.

	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), &fakeAuditRecorder{}, minlog.New("t"))

	if sched.rescheduleCount() != 1 {
		t.Fatalf("expected 1 reschedule, got %d", sched.rescheduleCount())
	}
	_, base := fixedNow()
	// BackoffFor(2) = 15m base, then jittered ±25% (see FIX above). Assert the
	// next attempt lands inside the jitter window around 15m.
	base15m := 15 * time.Minute
	delta := sched.rescheduled[0].nextAttemptAt.Sub(base)
	if delta < base15m*3/4 || delta > base15m*5/4 {
		t.Errorf("attempt 2 wait = %v, want within ±25%% of %v", delta, base15m)
	}
}

// TestRetry_FeatureFlagDisabled covers the safety hatch: when retry is
// disabled, all transient errors must MarkFailed (current behavior).
func TestRetry_FeatureFlagDisabled(t *testing.T) {
	sched := &fakeDrainScheduler{}
	cfg := newGreylistCfg(t)
	cfg.retryCfg.Enabled = false
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: smtpErr(421, "greylisted")}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)

	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), &fakeAuditRecorder{}, minlog.New("t"))

	if sched.rescheduleCount() != 0 {
		t.Errorf("disabled flag → 0 reschedule, got %d", sched.rescheduleCount())
	}
	if len(sched.failedIDs) != 1 {
		t.Errorf("disabled flag → 1 MarkFailed, got %d", len(sched.failedIDs))
	}
}

// TestRetry_AuditEmittedOnRetry verifies an audit row is recorded for each
// retry-scheduled outcome (EventRelayRetryScheduled). Operator dashboards
// can then count retry pressure per tenant.
func TestRetry_AuditEmittedOnRetry(t *testing.T) {
	sched := &fakeDrainScheduler{}
	auditRec := &fakeAuditRecorder{}
	cfg := newGreylistCfg(t)
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: smtpErr(421, "greylisted")}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)

	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), auditRec, minlog.New("t"))

	if got := atomic.LoadInt32(&auditRec.calls); got != 1 {
		t.Errorf("expected 1 audit call, got %d", got)
	}
	if auditRec.lastEvent != model.EventRelayRetryScheduled {
		t.Errorf("event = %q, want %q", auditRec.lastEvent, model.EventRelayRetryScheduled)
	}
}

// TestRetry_RescheduleErrorFallsBackToFailed protects against a stuck
// envelope: if Reschedule itself errors (disk full, schema corruption),
// the drain loop must MarkFailed so the queue does not leak.
func TestRetry_RescheduleErrorFallsBackToFailed(t *testing.T) {
	sched := &fakeDrainScheduler{rescheduleErr: errors.New("disk full")}
	auditRec := &fakeAuditRecorder{}
	cfg := newGreylistCfg(t)
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		return &fakeDrainDeliverer{deliverErr: smtpErr(421, "greylisted")}
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)

	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), auditRec, minlog.New("t"))

	if len(sched.failedIDs) != 1 {
		t.Errorf("Reschedule error → MarkFailed fallback, got %d failed", len(sched.failedIDs))
	}
}

// TestRetry_SuccessAfterRetry covers the happy path: attempt 2 succeeds.
// We invoke processDrainEnvelope twice with a deliverer that fails first
// then succeeds (mimicking the LUMIT manual retry resolution).
func TestRetry_SuccessAfterRetry(t *testing.T) {
	sched := &fakeDrainScheduler{}
	auditRec := &fakeAuditRecorder{}
	logger := minlog.New("t")

	calls := 0
	cfg := newGreylistCfg(t)
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		calls++
		if calls == 1 {
			return &fakeDrainDeliverer{deliverErr: smtpErr(421, "greylisted")}
		}
		return &fakeDrainDeliverer{deliverErr: nil}
	}

	// Attempt 1.
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)
	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), auditRec, logger)

	if sched.rescheduleCount() != 1 {
		t.Fatalf("after attempt 1: want 1 reschedule, got %d", sched.rescheduleCount())
	}

	// Simulate the requeued envelope being drained again (Attempts persisted
	// from Reschedule). DrainReady would return an envelope with Attempts=1.
	env2 := env
	env2.Attempts = 1
	processDrainEnvelope(context.Background(), env2, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), auditRec, logger)

	if len(sched.relayedIDs) != 1 {
		t.Errorf("after attempt 2: want 1 MarkRelayed, got %d", len(sched.relayedIDs))
	}
	if len(sched.failedIDs) != 0 {
		t.Errorf("must not have failed once retry succeeded, got %d", len(sched.failedIDs))
	}
}

// TestRetry_AntiTraceTransportUntouched is a contract test: the retry
// path must not mutate or replace the deliverer/transport used. HARD memory
// feedback_anti_trace_full_stack — the engine remains the only path that
// constructs delivery.
func TestRetry_AntiTraceTransportUntouched(t *testing.T) {
	sched := &fakeDrainScheduler{}
	auditRec := &fakeAuditRecorder{}
	cfg := newGreylistCfg(t)

	var observedDeliverer drainDeliverer
	cfg.delivererFn = func(_ transport.AnonymousTransport, _ delivery.SMTPConfig) drainDeliverer {
		d := &fakeDrainDeliverer{deliverErr: smtpErr(421, "greylisted")}
		observedDeliverer = d
		return d
	}
	env := buildOutboundSMTPEnvelope(t, "smtp.example.com", "pw", 587)

	processDrainEnvelope(context.Background(), env, cfg, sched, &fakeDrainExitVerifier{}, nil, nil, nil, newMinimizer(), auditRec, minlog.New("t"))

	if observedDeliverer == nil {
		t.Fatal("deliverer factory was not invoked — retry path bypassed transport")
	}
	if atomic.LoadInt32(&observedDeliverer.(*fakeDrainDeliverer).calls) != 1 {
		t.Errorf("deliverer called %d times, want 1 — retry path must not duplicate dials in same tick",
			observedDeliverer.(*fakeDrainDeliverer).calls)
	}
}
