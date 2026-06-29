package sender

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"common/config"
)

// SMTP-EGRESS-LOCKDOWN R4: Engine.Run is relay-only. Every test wires up an
// antiTrace client (fake httptest relay or unreachable address) before
// calling Run — the engine panics otherwise.

// fakeRelay returns an httptest.Server that accepts any POST and replies with
// a canned JSON envelope so the relay client parses a successful result.
func fakeRelay(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// F3-3: real relay contract returns envelope_id; the prior
		// "message_id" key was silently ignored by the antiTraceResponse
		// struct (which decodes envelope_id), masking the contract drift.
		_, _ = w.Write([]byte(`{"envelope_id":"relay-env-ok","status":"queued"}`))
	}))
}

// unreachableRelayURL returns an http:// address that is guaranteed to be
// unreachable (bind+close). Tests that never actually attempt a send (pre-
// cancelled context) use it to avoid a live listener.
func unreachableRelayURL(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := "http://" + ln.Addr().String()
	ln.Close()
	return addr
}

// TestEngine_Run_ContextCancelBeforeLoop verifies that a pre-cancelled context
// returns immediately from Run (the ctx.Done() check at the top of the loop
// fires before any business-hours or queue logic runs).
func TestEngine_Run_ContextCancelBeforeLoop(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{
		Timezone:    "UTC",
		WindowStart: 0,
		WindowEnd:   24,
	}, config.SafetyConfig{})
	e.WithAntiTrace(NewAntiTraceClient(unreachableRelayURL(t), "tok"))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := e.Run(ctx, nil)
	if err != context.Canceled {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

// TestEngine_Run_DeadlineExceeded verifies a past-deadline context is
// propagated.
func TestEngine_Run_DeadlineExceeded(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{
		Timezone:    "UTC",
		WindowStart: 0,
		WindowEnd:   24,
	}, config.SafetyConfig{})
	e.WithAntiTrace(NewAntiTraceClient(unreachableRelayURL(t), "tok"))

	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

// TestEngine_Run_AntiTrace_SendSuccess exercises the relay path in Run and
// verifies onSent fires.
func TestEngine_Run_AntiTrace_SendSuccess(t *testing.T) {
	relay := fakeRelay(t)
	defer relay.Close()

	client := NewAntiTraceClient(relay.URL, "tok")
	mb := config.MailboxConfig{Address: "mb@firma.cz", Username: "mb@firma.cz", Password: "pw", DailyLimit: 100}

	sent := make(chan SendResult, 1)
	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{
			Timezone:         "UTC",
			WindowStart:      0,
			WindowEnd:        24,
			MaxPerDomainHour: 100,
			MinDelaySeconds:  0,
			MaxDelaySeconds:  0,
		},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(client)

	e.Enqueue(SendRequest{ToAddress: "r@target.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		e.Run(ctx, func(_ SendRequest, result SendResult) {
			sent <- result
			cancel()
		})
	}()

	select {
	case result := <-sent:
		if result.Error != nil {
			t.Errorf("send error: %v", result.Error)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("timed out waiting for anti-trace send result")
	}
}

// TestEngine_Run_AntiTrace_WithPreSendHook verifies that preSendHook is called
// in the relay path before the relay call.
func TestEngine_Run_AntiTrace_WithPreSendHook(t *testing.T) {
	relay := fakeRelay(t)
	defer relay.Close()

	hookCalled := make(chan string, 1)

	client := NewAntiTraceClient(relay.URL, "tok")
	mb := config.MailboxConfig{Address: "mb@firma.cz", DailyLimit: 100}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{
			Timezone:         "UTC",
			WindowStart:      0,
			WindowEnd:        24,
			MaxPerDomainHour: 100,
			MinDelaySeconds:  0,
			MaxDelaySeconds:  0,
		},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(client)
	e.WithPreSendHook(func(mailbox config.MailboxConfig, req *SendRequest) {
		select {
		case hookCalled <- mailbox.Address:
		default:
		}
	})

	e.Enqueue(SendRequest{ToAddress: "r@target.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		e.Run(ctx, func(_ SendRequest, _ SendResult) {
			cancel()
		})
	}()

	select {
	case addr := <-hookCalled:
		if addr == "" {
			t.Error("hook should receive mailbox address")
		}
	case <-time.After(6 * time.Second):
		t.Fatal("timed out waiting for hook in anti-trace path")
	}
}

// TestEngine_Run_RecordSend_AfterSuccess checks that sentCounts increments
// after a successful relay send through Run.
func TestEngine_Run_RecordSend_AfterSuccess(t *testing.T) {
	relay := fakeRelay(t)
	defer relay.Close()

	mb := config.MailboxConfig{Address: "sender@t.cz", DailyLimit: 100}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{
			Timezone:         "UTC",
			WindowStart:      0,
			WindowEnd:        24,
			MaxPerDomainHour: 100,
			MinDelaySeconds:  0,
			MaxDelaySeconds:  0,
		},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	e.Enqueue(SendRequest{ToAddress: "r@target.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		e.Run(ctx, func(_ SendRequest, _ SendResult) {
			close(done)
			cancel()
		})
	}()

	select {
	case <-done:
		e.mu.Lock()
		count := e.sentCounts["sender@t.cz"]
		total := e.totalSent
		e.mu.Unlock()
		if count != 1 {
			t.Errorf("sentCounts should be 1, got %d", count)
		}
		if total != 1 {
			t.Errorf("totalSent should be 1, got %d", total)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("timed out")
	}
}

// TestEngine_Run_ZeroDelay verifies that with min=max=0 the post-send delay is
// effectively zero.
func TestEngine_Run_ZeroDelay(t *testing.T) {
	relay := fakeRelay(t)
	defer relay.Close()

	mb := config.MailboxConfig{Address: "sender@t.cz", DailyLimit: 100}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{
			Timezone:         "UTC",
			WindowStart:      0,
			WindowEnd:        24,
			MaxPerDomainHour: 100,
			MinDelaySeconds:  0,
			MaxDelaySeconds:  0,
		},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	e.Enqueue(SendRequest{ToAddress: "r@target.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	start := time.Now()
	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		e.Run(ctx, func(_ SendRequest, _ SendResult) {
			close(done)
			cancel()
		})
	}()

	select {
	case <-done:
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Errorf("send took too long with zero delay: %v", elapsed)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("timed out")
	}
}

// TestEngine_Run_ContextCancelledDuringDelay verifies that the delay select
// responds to context cancellation (covers the `case <-ctx.Done()` after send).
func TestEngine_Run_ContextCancelledDuringDelay(t *testing.T) {
	relay := fakeRelay(t)
	defer relay.Close()

	mb := config.MailboxConfig{Address: "sender@t.cz", DailyLimit: 100}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{
			Timezone:         "UTC",
			WindowStart:      0,
			WindowEnd:        24,
			MaxPerDomainHour: 100,
			MinDelaySeconds:  30,
			MaxDelaySeconds:  60,
		},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	e.Enqueue(SendRequest{ToAddress: "r@target.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	ctx, cancel := context.WithCancel(context.Background())

	errCh := make(chan error, 1)
	go func() {
		errCh <- e.Run(ctx, func(_ SendRequest, _ SendResult) {
			cancel()
		})
	}()

	select {
	case err := <-errCh:
		if err != context.Canceled {
			t.Errorf("expected context.Canceled after delay interruption, got %v", err)
		}
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("timed out — delay was not interrupted by context cancellation")
	}
}

// TestEngine_Run_RelayError_DoesNotBounceContact verifies that a relay-side
// HTTP error (e.g. 502) does NOT count as a bounce against the recipient
// domain. The relay sits between us and the actual MTA — its own 5xx is an
// infrastructure failure on our side, not a deliverability signal about
// the contact. Classifier returns SMTPTransient, so the domain enters
// greylisting backoff and the contact stays eligible for retry.
//
// Prior behavior (pre-2026-04-25) classified relay HTTP errors as
// SMTPUnknown which counted as a bounce. That conflated relay flakes with
// real MTA refusals and could trip the per-domain circuit breaker on a
// healthy contact. See backoff.go ClassifySMTPError godoc.
func TestEngine_Run_RelayError_DoesNotBounceContact(t *testing.T) {
	var hits int32
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		http.Error(w, `{"error":"forced"}`, http.StatusBadGateway)
	}))
	defer relay.Close()

	mb := config.MailboxConfig{Address: "sender@t.cz", Username: "sender@t.cz", Password: "pw", DailyLimit: 100}

	results := make(chan SendResult, 1)
	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{
			Timezone:         "UTC",
			WindowStart:      0,
			WindowEnd:        24,
			MaxPerDomainHour: 100,
			MinDelaySeconds:  0,
			MaxDelaySeconds:  0,
		},
		config.SafetyConfig{MaxBounceRate: 0.99},
	)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	e.Enqueue(SendRequest{ToAddress: "r@target.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		e.Run(ctx, func(_ SendRequest, result SendResult) {
			results <- result
			cancel()
		})
	}()

	select {
	case result := <-results:
		if result.Error == nil {
			t.Error("expected relay error")
		}
		// Sentinel must wrap the error so the classifier can identify it.
		if !errors.Is(result.Error, ErrAntiTraceHTTPStatus) {
			t.Errorf("relay error not wrapped with ErrAntiTraceHTTPStatus: %v", result.Error)
		}
		e.mu.Lock()
		bc := e.bounceCount
		ts := e.totalSent
		dbu := e.domainDeferredUntil["target.cz"]
		e.mu.Unlock()
		if bc != 0 {
			t.Errorf("bounceCount should be 0 (relay error is not a contact bounce), got %d", bc)
		}
		if ts != 1 {
			t.Errorf("totalSent should be 1 (the attempt counted), got %d", ts)
		}
		if dbu.IsZero() {
			t.Errorf("domainDeferredUntil[target.cz] should be set (greylisting backoff scheduled)")
		}
	case <-time.After(6 * time.Second):
		t.Fatal("timed out")
	}
}
