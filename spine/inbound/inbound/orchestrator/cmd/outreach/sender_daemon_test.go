package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"campaigns/sender"
)

// fakeHealthReporter records every Report call. Safe for concurrent use.
type fakeHealthReporter struct {
	mu      sync.Mutex
	reports []reportCall
}

type reportCall struct {
	name   string
	ok     bool
	errMsg string
}

func (f *fakeHealthReporter) Report(name string, ok bool, errMsg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reports = append(f.reports, reportCall{name: name, ok: ok, errMsg: errMsg})
}

func (f *fakeHealthReporter) snapshot() []reportCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]reportCall, len(f.reports))
	copy(out, f.reports)
	return out
}

// fakeAlertNotifier records every alert call. Safe for concurrent use.
type fakeAlertNotifier struct {
	mu          sync.Mutex
	errors      []alertCall
	panics      []alertCall
}

type alertCall struct {
	daemon string
	msg    string
}

func (f *fakeAlertNotifier) DaemonError(_ context.Context, daemon, errMsg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errors = append(f.errors, alertCall{daemon: daemon, msg: errMsg})
}

func (f *fakeAlertNotifier) DaemonPanic(_ context.Context, daemon, panicMsg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.panics = append(f.panics, alertCall{daemon: daemon, msg: panicMsg})
}

func (f *fakeAlertNotifier) errorCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.errors)
}

func (f *fakeAlertNotifier) panicCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.panics)
}

func (f *fakeAlertNotifier) lastError() alertCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.errors) == 0 {
		return alertCall{}
	}
	return f.errors[len(f.errors)-1]
}

func (f *fakeAlertNotifier) lastPanic() alertCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.panics) == 0 {
		return alertCall{}
	}
	return f.panics[len(f.panics)-1]
}

// 1. ErrAntiTraceRequired = boot misconfig → loud signal: health=false + alert.
func TestSuperviseSender_AntiTraceRequiredFiresAlert(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	superviseSender(context.Background(), func() error {
		return sender.ErrAntiTraceRequired
	}, hr, ac)

	reports := hr.snapshot()
	if len(reports) != 1 {
		t.Fatalf("want 1 report, got %d: %#v", len(reports), reports)
	}
	got := reports[0]
	if got.name != senderDaemonName || got.ok {
		t.Errorf("want unhealthy sender_daemon, got %+v", got)
	}
	if !contains(got.errMsg, "AntiTraceClient is required") {
		t.Errorf("errMsg should propagate ErrAntiTraceRequired text, got %q", got.errMsg)
	}
	if ac.errorCount() != 1 {
		t.Errorf("want 1 DaemonError alert, got %d", ac.errorCount())
	}
	if ac.panicCount() != 0 {
		t.Errorf("want 0 DaemonPanic, got %d", ac.panicCount())
	}
}

// 2. context.Canceled = graceful → no alert, health=true.
func TestSuperviseSender_ContextCanceledIsGraceful(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	superviseSender(ctx, func() error { return ctx.Err() }, hr, ac)

	reports := hr.snapshot()
	if len(reports) != 1 || !reports[0].ok {
		t.Fatalf("want healthy report on graceful shutdown, got %#v", reports)
	}
	if ac.errorCount() != 0 || ac.panicCount() != 0 {
		t.Errorf("graceful shutdown must not alert; errors=%d panics=%d", ac.errorCount(), ac.panicCount())
	}
}

// 3. context.DeadlineExceeded = also graceful.
func TestSuperviseSender_DeadlineExceededIsGraceful(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()
	time.Sleep(5 * time.Millisecond)
	superviseSender(ctx, func() error { return ctx.Err() }, hr, ac)

	reports := hr.snapshot()
	if len(reports) != 1 || !reports[0].ok {
		t.Fatalf("want healthy report on deadline shutdown, got %#v", reports)
	}
	if ac.errorCount() != 0 {
		t.Errorf("deadline shutdown must not alert, got %d errors", ac.errorCount())
	}
}

// 4. Wrapped context.Canceled is recognised via errors.Is.
func TestSuperviseSender_WrappedContextCanceledIsGraceful(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	wrapped := fmt.Errorf("sender shutdown: %w", context.Canceled)
	superviseSender(context.Background(), func() error { return wrapped }, hr, ac)

	reports := hr.snapshot()
	if len(reports) != 1 || !reports[0].ok {
		t.Fatalf("wrapped context.Canceled must be treated as graceful, got %#v", reports)
	}
	if ac.errorCount() != 0 {
		t.Errorf("wrapped graceful shutdown must not alert")
	}
}

// 5. Wrapped ErrAntiTraceRequired → loud signal (errors.Is matches both branches).
func TestSuperviseSender_WrappedAntiTraceErrorAlerts(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	wrapped := fmt.Errorf("boot: %w", sender.ErrAntiTraceRequired)
	superviseSender(context.Background(), func() error { return wrapped }, hr, ac)

	reports := hr.snapshot()
	if len(reports) != 1 || reports[0].ok {
		t.Fatalf("wrapped non-context error must mark daemon unhealthy, got %#v", reports)
	}
	if ac.errorCount() != 1 {
		t.Errorf("want 1 alert, got %d", ac.errorCount())
	}
}

// 6. nil return is treated as anomaly (Run should block forever).
func TestSuperviseSender_NilReturnIsAnomaly(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	superviseSender(context.Background(), func() error { return nil }, hr, ac)

	reports := hr.snapshot()
	if len(reports) != 1 || reports[0].ok {
		t.Fatalf("nil return must mark daemon unhealthy, got %#v", reports)
	}
	if ac.errorCount() != 1 {
		t.Fatalf("nil return must fire alert, got %d", ac.errorCount())
	}
	if !contains(ac.lastError().msg, "Run returned nil") {
		t.Errorf("alert message should mention nil return, got %q", ac.lastError().msg)
	}
}

// 7. Panic with string value → recovered, alerted, marked unhealthy.
func TestSuperviseSender_PanicWithStringRecovered(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	superviseSender(context.Background(), func() error {
		panic("boom")
	}, hr, ac)

	if ac.panicCount() != 1 {
		t.Fatalf("want 1 DaemonPanic, got %d", ac.panicCount())
	}
	if !contains(ac.lastPanic().msg, "boom") {
		t.Errorf("panic message should propagate, got %q", ac.lastPanic().msg)
	}
	if ac.errorCount() != 0 {
		t.Errorf("panic path must not also fire DaemonError, got %d", ac.errorCount())
	}
	reports := hr.snapshot()
	if len(reports) != 1 || reports[0].ok {
		t.Fatalf("panic must mark daemon unhealthy, got %#v", reports)
	}
}

// 8. Panic with error value → recovered.
func TestSuperviseSender_PanicWithErrorRecovered(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	superviseSender(context.Background(), func() error {
		panic(errors.New("nil pointer dereference"))
	}, hr, ac)

	if ac.panicCount() != 1 {
		t.Fatalf("want 1 panic alert, got %d", ac.panicCount())
	}
}

// 9. Concurrent Report calls from many goroutines must not race
// (run with -race; the supervisor itself is single-threaded but a fake registry
// mirroring health.Registry must accept concurrent writes).
func TestSuperviseSender_ConcurrentReportsRaceClean(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	var wg sync.WaitGroup
	const n = 50
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := fmt.Errorf("worker %d failed", i)
			superviseSender(context.Background(), func() error { return err }, hr, ac)
		}(i)
	}
	wg.Wait()

	if got := len(hr.snapshot()); got != n {
		t.Errorf("want %d reports, got %d", n, got)
	}
	if got := ac.errorCount(); got != n {
		t.Errorf("want %d alerts, got %d", n, got)
	}
}

// 10. Run blocks until context cancel, then returns ctx.Err — graceful.
func TestSuperviseSender_BlockingRunHonoursCancel(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		superviseSender(ctx, func() error {
			<-ctx.Done()
			return ctx.Err()
		}, hr, ac)
		close(done)
	}()

	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("supervisor did not return after cancel")
	}

	reports := hr.snapshot()
	if len(reports) != 1 || !reports[0].ok {
		t.Errorf("want healthy on cancel-driven shutdown, got %#v", reports)
	}
	if ac.errorCount() != 0 {
		t.Errorf("cancel-driven shutdown must not alert")
	}
}

// 11. Generic non-context error (e.g. SMTP boot) → unhealthy + alert.
func TestSuperviseSender_GenericRuntimeErrorAlerts(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	bootErr := errors.New("dial smtp: connection refused")
	superviseSender(context.Background(), func() error { return bootErr }, hr, ac)

	reports := hr.snapshot()
	if len(reports) != 1 || reports[0].ok || reports[0].errMsg != bootErr.Error() {
		t.Fatalf("want unhealthy with raw message, got %#v", reports)
	}
	if ac.errorCount() != 1 || ac.lastError().msg != bootErr.Error() {
		t.Errorf("alert must propagate raw error message, got %#v", ac.lastError())
	}
}

// 12. Supervisor reports the canonical daemon name "sender_daemon" (consumed
// by /health endpoint and downstream alerting).
func TestSuperviseSender_DaemonNameIsCanonical(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &fakeAlertNotifier{}

	superviseSender(context.Background(), func() error { return errors.New("x") }, hr, ac)

	reports := hr.snapshot()
	if len(reports) != 1 || reports[0].name != "sender_daemon" {
		t.Errorf("want canonical name 'sender_daemon', got %q", reports[0].name)
	}
	if ac.errorCount() != 1 || ac.lastError().daemon != "sender_daemon" {
		t.Errorf("alert daemon name must be 'sender_daemon', got %q", ac.lastError().daemon)
	}
}

// 13. Each invocation produces exactly one Report (no double-report on success/error path).
func TestSuperviseSender_ExactlyOneReportPerInvocation(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		run  func() error
	}{
		{"err", func() error { return errors.New("e") }},
		{"ctx", func() error { return context.Canceled }},
		{"nil", func() error { return nil }},
		{"anti", func() error { return sender.ErrAntiTraceRequired }},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			hr := &fakeHealthReporter{}
			ac := &fakeAlertNotifier{}
			superviseSender(context.Background(), tc.run, hr, ac)
			if got := len(hr.snapshot()); got != 1 {
				t.Errorf("%s: want 1 report, got %d", tc.name, got)
			}
		})
	}
}

// 14. Property: panic-then-error path can never fire both a DaemonError and a
// DaemonPanic (mutual exclusion of failure surfaces).
func TestSuperviseSender_PanicAndErrorAreMutuallyExclusive(t *testing.T) {
	t.Parallel()
	cases := []func() error{
		func() error { panic("boom") },
		func() error { return errors.New("x") },
		func() error { return sender.ErrAntiTraceRequired },
		func() error { return nil },
		func() error { return context.Canceled },
	}
	for i, run := range cases {
		hr := &fakeHealthReporter{}
		ac := &fakeAlertNotifier{}
		superviseSender(context.Background(), run, hr, ac)
		if ac.errorCount() > 0 && ac.panicCount() > 0 {
			t.Errorf("case %d: both DaemonError and DaemonPanic fired (mutex violated)", i)
		}
	}
}

// 15. Counter contract: graceful shutdown increments healthy-report count
// once. (Useful for downstream "last graceful shutdown" timeline metrics.)
func TestSuperviseSender_GracefulShutdownCounterContract(t *testing.T) {
	t.Parallel()
	var healthyCount atomic.Int32
	hr := &countingHealthReporter{onReport: func(_ string, ok bool, _ string) {
		if ok {
			healthyCount.Add(1)
		}
	}}
	ac := &fakeAlertNotifier{}

	superviseSender(context.Background(), func() error { return context.Canceled }, hr, ac)
	if got := healthyCount.Load(); got != 1 {
		t.Errorf("want exactly 1 healthy report on graceful shutdown, got %d", got)
	}
}

type countingHealthReporter struct {
	onReport func(name string, ok bool, errMsg string)
}

func (c *countingHealthReporter) Report(name string, ok bool, errMsg string) {
	c.onReport(name, ok, errMsg)
}

func contains(s, substr string) bool {
	return len(substr) == 0 || (len(s) >= len(substr) && indexOf(s, substr) >= 0)
}

func indexOf(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
