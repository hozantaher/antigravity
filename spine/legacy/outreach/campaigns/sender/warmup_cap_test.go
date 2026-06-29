package sender

import (
	"errors"
	"fmt"
	"testing"
)

// ── AP1 Sprint: warmup cap sentinel + engine integration tests ────────────────
//
// Coverage:
//   1.  IsWarmupCapError — nil
//   2.  IsWarmupCapError — direct sentinel
//   3.  IsWarmupCapError — wrapped sentinel
//   4.  IsWarmupCapError — string match (DB trigger message)
//   5.  IsWarmupCapError — unrelated error → false
//   6.  IsWarmupCapError — wrapped unrelated error → false
//   7.  recordSendResult: warmup cap error → no counter increment, no bounce
//   8.  recordSendResult: warmup cap error → sentCounts unchanged
//   9.  recordSendResult: normal success → increments totalSent
//  10.  recordSendResult: normal permanent error → increments bounceCount
//  11.  ErrWarmupCapExceeded: errors.Is identity
//  12.  IsWarmupCapError: relay-propagated message variant

// ── 1. nil ────────────────────────────────────────────────────────────────────

func TestIsWarmupCapError_Nil(t *testing.T) {
	if IsWarmupCapError(nil) {
		t.Error("expected false for nil error")
	}
}

// ── 2. direct sentinel ────────────────────────────────────────────────────────

func TestIsWarmupCapError_DirectSentinel(t *testing.T) {
	if !IsWarmupCapError(ErrWarmupCapExceeded) {
		t.Error("expected true for ErrWarmupCapExceeded")
	}
}

// ── 3. wrapped sentinel ───────────────────────────────────────────────────────

func TestIsWarmupCapError_WrappedSentinel(t *testing.T) {
	wrapped := fmt.Errorf("send failed: %w", ErrWarmupCapExceeded)
	if !IsWarmupCapError(wrapped) {
		t.Error("expected true for wrapped ErrWarmupCapExceeded")
	}
}

// ── 4. trigger message string (relay propagates the PG RAISE text) ────────────

func TestIsWarmupCapError_TriggerMessage(t *testing.T) {
	msg := errors.New("warmup_cap_exceeded: mailbox=test@example.com phase=warmup_d0 sent_today=5 cap=5")
	if !IsWarmupCapError(msg) {
		t.Error("expected true for trigger message error")
	}
}

// ── 5. unrelated error ────────────────────────────────────────────────────────

func TestIsWarmupCapError_Unrelated(t *testing.T) {
	if IsWarmupCapError(errors.New("smtp: 550 mailbox not found")) {
		t.Error("expected false for unrelated SMTP error")
	}
}

// ── 6. wrapped unrelated error ────────────────────────────────────────────────

func TestIsWarmupCapError_WrappedUnrelated(t *testing.T) {
	wrapped := fmt.Errorf("relay error: %w", errors.New("smtp 421 try again"))
	if IsWarmupCapError(wrapped) {
		t.Error("expected false for wrapped unrelated error")
	}
}

// ── 7+8. recordSendResult: warmup cap → no counter increment ──────────────────
//
// Warmup cap exhaustion is NOT an SMTP event.  The engine must not increment
// sentCounts / domainCounts / totalSent / bounceCount so the in-memory cap
// stays accurate and the circuit breaker is not tripped.

func TestRecordSendResult_WarmupCapExceeded_NoCounterIncrement(t *testing.T) {
	eng := newTestEngine()
	const mb = "sender@example.com"
	const dom = "example.com"

	// Pre-condition: counters are zero.
	if eng.totalSent != 0 {
		t.Fatalf("pre: totalSent=%d, want 0", eng.totalSent)
	}

	eng.recordSendResult(mb, dom, ErrWarmupCapExceeded)

	eng.mu.Lock()
	totalSent := eng.totalSent
	sentCount := eng.sentCounts[mb]
	bounceCount := eng.bounceCount
	eng.mu.Unlock()

	if totalSent != 0 {
		t.Errorf("totalSent=%d after warmup cap, want 0 (must not increment)", totalSent)
	}
	if sentCount != 0 {
		t.Errorf("sentCounts[%s]=%d after warmup cap, want 0", mb, sentCount)
	}
	if bounceCount != 0 {
		t.Errorf("bounceCount=%d after warmup cap, want 0 (must not count as bounce)", bounceCount)
	}
}

// ── 9. normal success increments totalSent ────────────────────────────────────

func TestRecordSendResult_Success_IncrementsTotal(t *testing.T) {
	eng := newTestEngine()
	const mb = "sender@example.com"
	const dom = "example.com"

	eng.recordSendResult(mb, dom, nil)

	eng.mu.Lock()
	got := eng.totalSent
	eng.mu.Unlock()

	if got != 1 {
		t.Errorf("totalSent=%d after success, want 1", got)
	}
}

// ── 10. permanent error increments bounceCount ────────────────────────────────

func TestRecordSendResult_Permanent_IncrementsBounce(t *testing.T) {
	eng := newTestEngine()
	const mb = "sender@example.com"
	const dom = "example.com"

	// Inject enough sends to make per-domain rate calculable but keep under
	// circuit-breaker threshold so the test isn't flaky.
	eng.mu.Lock()
	eng.domainSent[dom] = 0
	eng.totalSent = 0
	eng.mu.Unlock()

	permErr := errors.New("smtp: 550 5.1.1 user unknown")
	eng.recordSendResult(mb, dom, permErr)

	eng.mu.Lock()
	got := eng.bounceCount
	eng.mu.Unlock()

	if got != 1 {
		t.Errorf("bounceCount=%d after permanent error, want 1", got)
	}
}

// ── 11. errors.Is identity ────────────────────────────────────────────────────

func TestErrWarmupCapExceeded_ErrorsIs(t *testing.T) {
	wrapped := fmt.Errorf("wrapper: %w", ErrWarmupCapExceeded)
	if !errors.Is(wrapped, ErrWarmupCapExceeded) {
		t.Error("errors.Is should find ErrWarmupCapExceeded in wrapped chain")
	}
}

// ── 12. relay-propagated message variant ──────────────────────────────────────
//
// The relay may return a 422 / 500 with a JSON body containing the trigger
// message, which the client wraps as a plain error string.

func TestIsWarmupCapError_RelayPropagatedMessage(t *testing.T) {
	relayErr := fmt.Errorf("relay HTTP 422: warmup_cap_exceeded: mailbox=x@seznam.cz phase=warmup_d3 sent_today=10 cap=10")
	if !IsWarmupCapError(relayErr) {
		t.Error("expected true for relay-propagated warmup_cap_exceeded message")
	}
}

// Note: newTestEngine() is defined in engine_state_test.go (same package).

// ── 13. ErrWarmupCapStatusGuard sentinel ─────────────────────────────────────

func TestIsWarmupCapStatusGuardError_DirectSentinel(t *testing.T) {
	if !IsWarmupCapStatusGuardError(ErrWarmupCapStatusGuard) {
		t.Error("expected true for ErrWarmupCapStatusGuard")
	}
}

// ── 14. wrapped status guard sentinel ────────────────────────────────────────

func TestIsWarmupCapStatusGuardError_WrappedSentinel(t *testing.T) {
	wrapped := fmt.Errorf("relay wrapped: %w", ErrWarmupCapStatusGuard)
	if !IsWarmupCapStatusGuardError(wrapped) {
		t.Error("expected true for wrapped ErrWarmupCapStatusGuard")
	}
}

// ── 15. status guard trigger message string ───────────────────────────────────
//
// The migration 079 trigger raises:
//   "warmup_cap_status_guard: mailbox=<addr> status=<status> (not active)"
// The relay propagates this as a plain string error.

func TestIsWarmupCapStatusGuardError_TriggerMessage(t *testing.T) {
	triggerMsg := errors.New("warmup_cap_status_guard: mailbox=test@example.com status=paused (not active)")
	if !IsWarmupCapStatusGuardError(triggerMsg) {
		t.Error("expected true for trigger message with warmup_cap_status_guard prefix")
	}
}

// ── 16. recordSendResult: status guard → no counter increment ─────────────────
//
// A paused/auth_locked mailbox that triggers the status guard must NOT trip the
// circuit breaker or count as a bounce — the mailbox is inactive by design.

func TestRecordSendResult_StatusGuard_NoCounterIncrement(t *testing.T) {
	eng := newTestEngine()
	const mb = "paused@example.com"
	const dom = "example.com"

	// Verify pre-condition: all counters at zero.
	if eng.totalSent != 0 {
		t.Fatalf("pre: totalSent=%d, want 0", eng.totalSent)
	}

	statusGuardErr := fmt.Errorf("relay HTTP 422: warmup_cap_status_guard: mailbox=%s status=auth_locked (not active)", mb)
	eng.recordSendResult(mb, dom, statusGuardErr)

	eng.mu.Lock()
	totalSent := eng.totalSent
	sentCount := eng.sentCounts[mb]
	bounceCount := eng.bounceCount
	eng.mu.Unlock()

	if totalSent != 0 {
		t.Errorf("totalSent=%d after status guard, want 0 (must not increment)", totalSent)
	}
	if sentCount != 0 {
		t.Errorf("sentCounts[%s]=%d after status guard, want 0", mb, sentCount)
	}
	if bounceCount != 0 {
		t.Errorf("bounceCount=%d after status guard, want 0 (must not count as bounce)", bounceCount)
	}
}
