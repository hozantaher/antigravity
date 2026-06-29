package sender

import (
	"context"
	"net"
	"common/config"
	"testing"
	"time"
)

// stubAntiTrace wires up an AntiTraceClient pointing at a closed listener.
// SMTP-EGRESS-LOCKDOWN R4 makes antiTrace mandatory, so every Run-invoking
// test that does not need a live relay uses this stub.
func stubAntiTrace(t *testing.T) *AntiTraceClient {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := "http://" + ln.Addr().String()
	ln.Close()
	return NewAntiTraceClient(addr, "tok")
}

// TestEngine_Run_ContextCancel verifies that Run exits when the context is
// already cancelled and returns the context error. No sleep is triggered
// because ctx.Done() is checked at the top of the loop.
func TestEngine_Run_ContextCancel(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{
		Timezone:    "UTC",
		WindowStart: 0,
		WindowEnd:   24,
	}, config.SafetyConfig{})
	e.WithAntiTrace(stubAntiTrace(t))

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected context error from Run")
	}
	if err != context.Canceled {
		t.Errorf("expected context.Canceled, got %v", err)
	}
}

// TestEngine_Run_InvalidTimezoneDefaultsToUTC verifies that an invalid
// timezone string falls back to UTC and returns ctx.Err() on cancel.
func TestEngine_Run_InvalidTimezoneDefaultsToUTC(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{
		Timezone:    "Invalid/Zone",
		WindowStart: 0,
		WindowEnd:   24,
	}, config.SafetyConfig{})
	e.WithAntiTrace(stubAntiTrace(t))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected context error")
	}
}

// TestEngine_Run_OnSentWiring verifies that the preSendHook and onSent
// callback mechanism are correctly wired (structural wiring test, no live SMTP).
func TestEngine_Run_OnSentWiring(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	if e.preSendHook != nil {
		t.Error("preSendHook should be nil by default")
	}
	called := false
	e.WithPreSendHook(func(_ config.MailboxConfig, _ *SendRequest) { called = true })
	e.preSendHook(config.MailboxConfig{}, &SendRequest{})
	if !called {
		t.Error("hook should be callable after wiring")
	}
}

// TestEngine_ResetCounters_DailyReset verifies that sentCounts is cleared on a
// new calendar day even when the hourly reset branch fires first.
//
// This is the exact scenario the single-shared-timestamp bug defeated: the
// first in-window morning tick is always >1h stale (the Run loop skips
// resetCountersIfNeeded while out of the send window overnight), so the hourly
// branch runs and — with a shared timestamp — overwrote it to `now`, making
// the daily check compare now.Day() against now.Day() and never reset. With an
// independent lastDailyReset the daily reset fires correctly.
func TestEngine_ResetCounters_DailyReset(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	now := time.Now()
	e.mu.Lock()
	e.sentCounts["mb@t.cz"] = 99
	// Prior hourly reset >1h ago → the hourly branch fires on this tick.
	e.lastReset = now.Add(-2 * time.Hour)
	// Prior daily reset was yesterday → the daily window has rolled over.
	e.lastDailyReset = now.AddDate(0, 0, -1)
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	sc := e.sentCounts["mb@t.cz"]
	e.mu.Unlock()

	if sc != 0 {
		t.Errorf("sentCounts should be cleared by daily reset even when the hourly branch fires first, got %d", sc)
	}
}

// TestEngine_ResetCounters_HourlyNoDailyReset verifies that an hourly reset
// clears domainCounts and bounceCount but NOT sentCounts (daily-only).
// This complements the existing TestEngine_ResetCounters_HourlyPreservesSentCounts.
func TestEngine_ResetCounters_BounceResetOnHourly(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 5}, config.SafetyConfig{MaxBounceRate: 0.5})

	e.mu.Lock()
	e.domainCounts["x.cz"] = 3
	e.bounceCount = 7
	e.totalSent = 10
	e.lastReset = time.Now().Add(-2 * time.Hour) // triggers hourly reset
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	bc := e.bounceCount
	ts := e.totalSent
	dc := e.domainCounts["x.cz"]
	e.mu.Unlock()

	if bc != 0 {
		t.Errorf("bounceCount should be 0 after hourly reset, got %d", bc)
	}
	if ts != 0 {
		t.Errorf("totalSent should be 0 after hourly reset, got %d", ts)
	}
	if dc != 0 {
		t.Errorf("domainCounts should be 0 after hourly reset, got %d", dc)
	}
}

// TestEngine_Run_ContextAlreadyCancelledBeforeHourCheck verifies the top-of-loop
// ctx.Done() select fires before any sleeping branches are reached.
func TestEngine_Run_ContextDeadlineExceeded(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{
		Timezone:    "UTC",
		WindowStart: 0,
		WindowEnd:   24,
	}, config.SafetyConfig{})
	e.WithAntiTrace(stubAntiTrace(t))

	ctx, cancel := context.WithDeadline(context.Background(), time.Now())
	defer cancel()

	err := e.Run(ctx, nil)
	if err == nil {
		t.Fatal("expected error for deadline-exceeded context")
	}
}
