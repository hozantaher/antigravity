package sender

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"common/config"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// D3.3 dry_run gate: an operator-flipped switch that lets the cockpit
// simulate a full campaign send without touching SMTP. Critical for QA
// on a new template / segment before we put a reputation on the line.
//
// SMTP-EGRESS-LOCKDOWN R4: the dry-run gate now lives inside Run's main
// loop (not a standalone send() method), so these tests drive Run with a
// relay that fails-loud if it is ever called and assert the gate short-
// circuited BEFORE any HTTP hit.

// TestEngine_DryRun_ShortCircuitsRelay stands up a real httptest relay that
// registers any hit as a failure. With WithDryRun(true), the engine must
// short-circuit before the relay is touched.
func TestEngine_DryRun_ShortCircuitsRelay(t *testing.T) {
	var relayHits int32
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&relayHits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer relay.Close()

	mb := config.MailboxConfig{
		Address:    "jan@sender.test",
		SMTPHost:   "127.0.0.1",
		SMTPPort:   1,
		DailyLimit: 100,
	}

	var captured SendResult
	done := make(chan struct{})
	onSent := func(_ SendRequest, r SendResult) {
		captured = r
		close(done)
	}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 1000},
		config.SafetyConfig{MaxBounceRate: 0.5},
	).WithDryRun(true)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	e.Enqueue(SendRequest{
		ToAddress: "recipient@firma.test",
		Subject:   "Test",
		BodyPlain: "Body",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go func() { _ = e.Run(ctx, onSent) }()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("onSent never fired — engine Run did not consume the queued request")
	}

	if got := atomic.LoadInt32(&relayHits); got != 0 {
		t.Errorf("dry_run must not hit relay, got %d hit(s)", got)
	}
	if captured.Error != nil {
		t.Fatalf("dry_run must not return error, got %v", captured.Error)
	}
	if captured.MailboxUsed != "jan@sender.test" {
		t.Errorf("mailbox_used not propagated: %q", captured.MailboxUsed)
	}
	if captured.MessageID == "" {
		t.Error("dry_run must still return a synthetic MessageID for audit")
	}
	if !strings.Contains(captured.SMTPResponse, "dry") {
		t.Errorf("dry_run SMTPResponse must carry a dry-run marker: %q", captured.SMTPResponse)
	}
}

func TestEngine_DryRun_DefaultIsLive(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	if e.IsDryRun() {
		t.Error("default engine must be live, IsDryRun()=true")
	}
}

func TestEngine_DryRun_FlagToggle(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{}).WithDryRun(true)
	if !e.IsDryRun() {
		t.Error("WithDryRun(true) did not flip the flag")
	}
}

// TestEngine_Run_ReturnsErrorWithoutAntiTrace verifies SMTP-EGRESS-LOCKDOWN R4:
// misconfigured engine (no AntiTraceClient) returns ErrAntiTraceRequired
// instead of panicking the daemon process. Error return lets caller log +
// exit gracefully; panic would kill the whole daemon and drop in-flight state.
func TestEngine_Run_ReturnsErrorWithoutAntiTrace(t *testing.T) {
	_ = net.ParseIP("127.0.0.1")

	e := NewEngine(nil, config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24}, config.SafetyConfig{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected error when Run is called without AntiTraceClient")
	}
	if !errors.Is(err, ErrAntiTraceRequired) {
		t.Fatalf("expected errors.Is(err, ErrAntiTraceRequired), got %v", err)
	}
	if !strings.Contains(err.Error(), "AntiTraceClient is required") {
		t.Errorf("error message should explain R4 lockdown, got %q", err.Error())
	}
}
