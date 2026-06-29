package sender

// engine_branches_test.go — targets uncovered branches in Run.
//
// SMTP-EGRESS-LOCKDOWN R4: direct-SMTP path tests were removed. Engine.Run
// now requires an AntiTraceClient, so every test wires up a throwaway relay
// URL via WithAntiTrace before calling Run.
//
// Run branches covered:
//   - circuit breaker open
//   - empty queue sleep-and-continue
//   - no available mailbox → re-queue at front and continue
//   - domain blocked by allowDomain → append back and continue

import (
	"context"
	"net"
	"testing"
	"time"

	"common/config"
)

// closedRelayAddr returns an http:// address that is guaranteed to be
// unreachable (bind+close). Tests that exhaust mailboxes or trip the domain
// limiter never reach the relay, so an unreachable URL is fine.
func closedRelayAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := "http://" + ln.Addr().String()
	ln.Close()
	return addr
}

// engineWithOpenCircuit returns an engine (with antiTrace) whose global
// circuit breaker is already open so Run enters the pause branch immediately.
func engineWithOpenCircuit(t *testing.T) *Engine {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "mb@t.test", DailyLimit: 100}},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.0},
	)
	e.WithAntiTrace(NewAntiTraceClient(closedRelayAddr(t), "tok"))
	e.mu.Lock()
	e.circuitOpen = true
	e.mu.Unlock()
	return e
}

// ─── Run: business hours window closed ───────────────────────────────────────

// TestEngine_Run_OutsideBusinessHours verifies that when the current hour is
// outside [WindowStart, WindowEnd), Run sleeps (time.Sleep(time.Minute) —
// non-interruptible) and then exits when the context expires.
func TestEngine_Run_OutsideBusinessHours(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping: business-hours sleep takes ~1 minute (non-interruptible)")
	}

	e := NewEngine(nil, config.SendingConfig{
		Timezone:    "UTC",
		WindowStart: 1,
		WindowEnd:   1, // end == start → no valid window
	}, config.SafetyConfig{})
	e.WithAntiTrace(NewAntiTraceClient(closedRelayAddr(t), "tok"))

	ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected context error from Run when outside business hours")
	}
}

// ─── Run: circuit breaker open ────────────────────────────────────────────────

// TestEngine_Run_CircuitOpenPauses verifies that when the global circuit
// breaker is open, Run enters the pause branch and returns on cancellation.
func TestEngine_Run_CircuitOpenPauses(t *testing.T) {
	e := engineWithOpenCircuit(t)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected context error when circuit is open")
	}
}

// ─── Run: empty queue sleep ───────────────────────────────────────────────────

// TestEngine_Run_EmptyQueueSleeps verifies the empty-queue branch: Run sleeps
// briefly then loops back; context cancellation exits it.
func TestEngine_Run_EmptyQueueSleeps(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "mb@t.test", DailyLimit: 100}},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(closedRelayAddr(t), "tok"))

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected context error from empty-queue loop")
	}
}

// ─── Run: no available mailbox ────────────────────────────────────────────────

// TestEngine_Run_NoMailbox_ReQueues verifies that when all mailboxes are at
// their daily limit, the request is put back at the front of the queue and the
// loop sleeps, eventually exiting on cancel.
func TestEngine_Run_NoMailbox_ReQueues(t *testing.T) {
	mb := config.MailboxConfig{Address: "mb@t.test", DailyLimit: 1}
	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(closedRelayAddr(t), "tok"))
	// Exhaust the only mailbox so pickMailbox will fail.
	e.recordSendResult("mb@t.test", "t.test", nil)

	e.Enqueue(SendRequest{ToAddress: "r@t.test", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected context error")
	}
	if e.QueueDepth() == 0 {
		t.Error("request should be re-queued when no mailbox is available")
	}
}

// ─── Run: domain blocked by rate limiter ─────────────────────────────────────

// TestEngine_Run_DomainBlocked verifies that when the domain is rate-limited,
// the request is appended back to the queue and Run sleeps before looping
// (the context cancel exits it).
func TestEngine_Run_DomainBlocked(t *testing.T) {
	mb := config.MailboxConfig{Address: "mb@t.test", DailyLimit: 1000}
	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 1},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(closedRelayAddr(t), "tok"))
	// Fill the domain rate limit so allowDomain returns false immediately.
	e.recordSendResult("mb@t.test", "blocked.test", nil)

	e.Enqueue(SendRequest{ToAddress: "r@blocked.test", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected context error")
	}
	if e.QueueDepth() == 0 {
		t.Error("blocked request should be re-appended to queue")
	}
}
