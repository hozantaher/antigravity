package main

// Sprint H3 — superviseSender panic-recovery test pack.
//
// Complements the original 19 tests in sender_daemon_test.go by adding focused
// coverage on:
//   - panic recovery for every kind of value Go lets you throw (string, error,
//     custom struct, integer, nil, runtime.Error)
//   - playbook URL plumbing (S29) — recovered panic still propagates the
//     ctx-attached runbook so Sentry tag assertion works for both panic and
//     error paths
//   - goroutine leak detection — supervise must not leak background goroutines
//     when Run panics, errors, or returns gracefully
//   - permanent-failure aggregation — when the supervisor is invoked many times
//     in a row (operator reboot loop), each call must report cleanly with no
//     state bleed
//
// All cases are race-clean (-race) and t.Parallel() where shared state allows.

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// recoveryAlertProbe extends fakeAlertNotifier semantics with a deterministic
// hook on panic — used by the goroutine-leak case to wait for completion
// without time.Sleep.
type recoveryAlertProbe struct {
	mu        sync.Mutex
	errors    []alertCall
	panics    []alertCall
	panicHook func(daemon, msg string)
	errorHook func(daemon, msg string)
}

func (r *recoveryAlertProbe) DaemonError(_ context.Context, daemon, errMsg string) {
	r.mu.Lock()
	r.errors = append(r.errors, alertCall{daemon: daemon, msg: errMsg})
	hook := r.errorHook
	r.mu.Unlock()
	if hook != nil {
		hook(daemon, errMsg)
	}
}

func (r *recoveryAlertProbe) DaemonPanic(_ context.Context, daemon, panicMsg string) {
	r.mu.Lock()
	r.panics = append(r.panics, alertCall{daemon: daemon, msg: panicMsg})
	hook := r.panicHook
	r.mu.Unlock()
	if hook != nil {
		hook(daemon, panicMsg)
	}
}

func (r *recoveryAlertProbe) panicCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.panics)
}

func (r *recoveryAlertProbe) errorCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.errors)
}

func (r *recoveryAlertProbe) lastPanic() alertCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.panics) == 0 {
		return alertCall{}
	}
	return r.panics[len(r.panics)-1]
}

// customPanicValue is a non-error, non-string struct — sender code that
// panic()s a domain struct (e.g. SendError) must still be recovered.
type customPanicValue struct {
	Kind   string
	Reason string
}

// runtimeFault simulates a runtime panic (e.g. nil-map write) by deferencing a
// nil pointer. Distinct test from explicit panic("boom") because runtime panics
// arrive at recover() as runtime.Error implementations.
func runtimeFault() error {
	var m map[string]int
	m["x"] = 1 // panics: assignment to entry in nil map
	return nil
}

// 1. Panic with a structured (non-error) struct — recovered + alerted, message
//    formatted via fmt.Sprintf("%v", r) so struct fields appear in alert.
func TestSuperviseSenderRecovery_PanicWithStructuredValue(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	superviseSender(context.Background(), func() error {
		panic(customPanicValue{Kind: "smtp", Reason: "EOF on TLS handshake"})
	}, hr, ac)

	if ac.panicCount() != 1 {
		t.Fatalf("want 1 panic alert, got %d", ac.panicCount())
	}
	if !strings.Contains(ac.lastPanic().msg, "EOF on TLS handshake") {
		t.Errorf("alert must propagate struct fields, got %q", ac.lastPanic().msg)
	}
	if ac.errorCount() != 0 {
		t.Errorf("panic must not also fire DaemonError, got %d", ac.errorCount())
	}
}

// 2. Panic with integer value — recovered (defensive: third-party libraries
//    occasionally panic(int) for legacy reasons).
func TestSuperviseSenderRecovery_PanicWithInteger(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	superviseSender(context.Background(), func() error {
		panic(42)
	}, hr, ac)

	if ac.panicCount() != 1 {
		t.Fatalf("integer panic must be recovered + alerted, got %d alerts", ac.panicCount())
	}
	if !strings.Contains(ac.lastPanic().msg, "42") {
		t.Errorf("alert must contain the panicked value, got %q", ac.lastPanic().msg)
	}
}

// 3. Panic with nil — Go 1.21+ throws *runtime.PanicNilError; recover() must
//    catch it. This is the defensive case from the H3 brief item #3.
func TestSuperviseSenderRecovery_PanicWithNil(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic(nil) escaped supervisor — recover bypassed: %v", r)
		}
	}()

	superviseSender(context.Background(), func() error {
		//nolint:govet // intentional: panic(nil) is the case we are testing
		panic(nil)
	}, hr, ac)

	// Go 1.21+ converts panic(nil) to *runtime.PanicNilError, so recover() sees a
	// non-nil value and we report exactly one panic. On older Go the recover()
	// returns nil and superviseSender treats it as "Run returned nil → DaemonError".
	// Either path is acceptable — the supervisor MUST NOT crash the process.
	totalSignals := ac.panicCount() + ac.errorCount()
	if totalSignals == 0 {
		t.Fatalf("panic(nil) produced no signal — daemon would die silently")
	}
	reports := hr.snapshot()
	if len(reports) != 1 || reports[0].ok {
		t.Fatalf("panic(nil) must mark daemon unhealthy, got %#v", reports)
	}
}

// 4. Runtime fault (nil-map write) — recovered. This is the realistic shape of
//    the silent-death bug the supervisor was added to prevent.
func TestSuperviseSenderRecovery_RuntimeFaultRecovered(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	superviseSender(context.Background(), runtimeFault, hr, ac)

	if ac.panicCount() != 1 {
		t.Fatalf("runtime fault must surface as DaemonPanic, got %d", ac.panicCount())
	}
	if !strings.Contains(strings.ToLower(ac.lastPanic().msg), "nil map") {
		t.Errorf("alert should mention nil map (got %q) — operator needs the cause", ac.lastPanic().msg)
	}
	reports := hr.snapshot()
	if len(reports) != 1 || reports[0].ok {
		t.Fatalf("runtime fault must mark daemon unhealthy, got %#v", reports)
	}
}

// W1 (#93, 2026-04-29): tests #5 and #6 covered telemetry.WithPlaybook /
// PlaybookFrom / CaptureWithPlaybook — half-finished plumbing where the
// consumer (sender_daemon.go) was wired but the producer was never
// added in main.go and docs/playbooks/ didn't exist on main. The
// helpers were deleted along with these tests; ctx-plumbing through
// supervise is still verified by tests #1–#4 (above) and #7+ (below).

// 7. Goroutine leak guard — panicking Run does not spawn dangling goroutines.
//    Compares NumGoroutine before vs after; allows ±2 jitter for runtime
//    bookkeeping and t.Parallel scheduling.
func TestSuperviseSenderRecovery_NoGoroutineLeakOnPanic(t *testing.T) {
	// Not parallel: NumGoroutine is global state.
	runtime.GC()
	time.Sleep(50 * time.Millisecond) // let any prior goroutines drain
	before := runtime.NumGoroutine()

	for i := 0; i < 20; i++ {
		hr := &fakeHealthReporter{}
		ac := &recoveryAlertProbe{}
		superviseSender(context.Background(), func() error {
			panic(fmt.Sprintf("iter-%d", i))
		}, hr, ac)
	}

	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	after := runtime.NumGoroutine()

	if delta := after - before; delta > 2 {
		t.Errorf("goroutine leak: before=%d after=%d delta=%d (>2 = leak)", before, after, delta)
	}
}

// 8. Goroutine leak guard — error returns do not spawn dangling goroutines.
func TestSuperviseSenderRecovery_NoGoroutineLeakOnError(t *testing.T) {
	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	before := runtime.NumGoroutine()

	for i := 0; i < 20; i++ {
		hr := &fakeHealthReporter{}
		ac := &recoveryAlertProbe{}
		superviseSender(context.Background(), func() error {
			return fmt.Errorf("iter-%d boot fail", i)
		}, hr, ac)
	}

	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	after := runtime.NumGoroutine()

	if delta := after - before; delta > 2 {
		t.Errorf("goroutine leak: before=%d after=%d delta=%d", before, after, delta)
	}
}

// 9. Many sequential panics (operator reboot loop) — each invocation must
//    independently report exactly one panic, with no state bleed.
//    This is the "5 panics in 1 minute" / "10 panics in 5 minutes" shape from
//    H3 brief items #9 + #10, expressed as a property over the supervisor
//    contract: it is stateless, so N panics produce N independent alerts.
//    A future restart-supervisor wrapper would sit ABOVE this and add the
//    backoff / permanent-failure semantics.
func TestSuperviseSenderRecovery_TenSequentialPanicsAllIndependent(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	const n = 10
	for i := 0; i < n; i++ {
		i := i
		superviseSender(context.Background(), func() error {
			panic(fmt.Sprintf("panic-%d", i))
		}, hr, ac)
	}

	if got := ac.panicCount(); got != n {
		t.Errorf("want %d independent panic alerts, got %d", n, got)
	}
	if got := len(hr.snapshot()); got != n {
		t.Errorf("want %d health reports, got %d", n, got)
	}
	for i, rep := range hr.snapshot() {
		if rep.ok {
			t.Errorf("report %d: want unhealthy, got healthy", i)
		}
	}
}

// 10. Panic alternating with success — each supervise call is independent;
//     a graceful ctx-cancel after a panic must still report healthy.
func TestSuperviseSenderRecovery_PanicAlternatingWithGracefulCancel(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	// panic
	superviseSender(context.Background(), func() error { panic("first") }, hr, ac)
	// graceful
	superviseSender(context.Background(), func() error { return context.Canceled }, hr, ac)
	// panic
	superviseSender(context.Background(), func() error { panic("second") }, hr, ac)
	// graceful
	superviseSender(context.Background(), func() error { return context.DeadlineExceeded }, hr, ac)

	if ac.panicCount() != 2 {
		t.Errorf("want 2 panics across the sequence, got %d", ac.panicCount())
	}
	if ac.errorCount() != 0 {
		t.Errorf("graceful shutdowns must not fire DaemonError, got %d", ac.errorCount())
	}
	reps := hr.snapshot()
	if len(reps) != 4 {
		t.Fatalf("want 4 reports across 4 invocations, got %d", len(reps))
	}
	wantOK := []bool{false, true, false, true}
	for i, rep := range reps {
		if rep.ok != wantOK[i] {
			t.Errorf("report %d: want ok=%v, got ok=%v", i, wantOK[i], rep.ok)
		}
	}
}

// 11. Concurrent supervisor invocations under panic load — race-detector
//     must observe zero data races even when many goroutines panic
//     simultaneously and write into shared fakeHealthReporter state.
func TestSuperviseSenderRecovery_ConcurrentPanicLoadRaceClean(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	const workers = 64
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx := context.Background()
			switch i % 4 {
			case 0:
				superviseSender(ctx, func() error { panic(fmt.Sprintf("goroutine %d", i)) }, hr, ac)
			case 1:
				superviseSender(ctx, func() error { return errors.New("err") }, hr, ac)
			case 2:
				superviseSender(ctx, func() error { return context.Canceled }, hr, ac)
			case 3:
				superviseSender(ctx, func() error { return nil }, hr, ac)
			}
		}(i)
	}
	wg.Wait()

	if got := len(hr.snapshot()); got != workers {
		t.Errorf("want %d total reports, got %d", workers, got)
	}
}

// 12. Recovered panic re-entrancy — a panic in the panic recovery path must
//     not propagate outward. We exercise this by passing a hook that itself
//     panics; safeCall (Sprint T3) wraps the DaemonPanic call so the hook
//     panic is contained and does not escape superviseSender.
//
//     Previously documented as a KNOWN GAP (TODO); fixed by T3 hardening
//     (2026-05-06). safeCall wraps every alertClient invocation inside
//     superviseSender's defer so a misbehaving Sentry hook cannot kill the
//     daemon during launch.
func TestSuperviseSenderRecovery_AlertHookPanicDoesNotEscape(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{
		panicHook: func(_, _ string) {
			panic("alert path also broken")
		},
	}

	// With safeCall wrapping the hook invocation the hook panic must NOT escape.
	// If it does, the outer defer will catch it and fail the test (regression).
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("alert-hook panic escaped supervisor (T3 regression): %v", r)
		}
	}()

	superviseSender(context.Background(), func() error {
		panic("primary")
	}, hr, ac)

	// The supervisor must have marked the daemon unhealthy despite the hook panic.
	reps := hr.snapshot()
	if len(reps) != 1 || reps[0].ok {
		t.Errorf("daemon must be unhealthy after primary panic, got %#v", reps)
	}
}

// 13. Stress: 100 sequential panics — assert no allocation explosion in the
//     report buffer + no goroutine leak. Acts as a guard for the sequential
//     reboot loop scenario at scale.
func TestSuperviseSenderRecovery_HundredPanicsBounded(t *testing.T) {
	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	before := runtime.NumGoroutine()

	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}
	const n = 100
	for i := 0; i < n; i++ {
		superviseSender(context.Background(), func() error { panic("loop") }, hr, ac)
	}

	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	after := runtime.NumGoroutine()

	if delta := after - before; delta > 2 {
		t.Errorf("goroutine leak under load: before=%d after=%d", before, after)
	}
	if got := ac.panicCount(); got != n {
		t.Errorf("want %d panic alerts, got %d", n, got)
	}
	if got := len(hr.snapshot()); got != n {
		t.Errorf("want %d health reports, got %d", n, got)
	}
}

// 14. Panic message normalization — supervisor formats the recovered value
//     with "panic: %v" prefix so downstream log filters can grep by prefix.
func TestSuperviseSenderRecovery_PanicMessageFormatContract(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		val   any
		match string
	}{
		{"string", "boom", "panic: boom"},
		{"error", errors.New("nil deref"), "panic: nil deref"},
		{"struct", customPanicValue{Kind: "k", Reason: "r"}, "panic:"},
		{"int", 7, "panic: 7"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			hr := &fakeHealthReporter{}
			ac := &recoveryAlertProbe{}
			superviseSender(context.Background(), func() error {
				panic(tc.val)
			}, hr, ac)

			if ac.panicCount() != 1 {
				t.Fatalf("%s: want 1 panic, got %d", tc.name, ac.panicCount())
			}
			if !strings.HasPrefix(ac.lastPanic().msg, tc.match) {
				t.Errorf("%s: alert msg %q must start with %q", tc.name, ac.lastPanic().msg, tc.match)
			}
			reps := hr.snapshot()
			if len(reps) != 1 || !strings.HasPrefix(reps[0].errMsg, "panic:") {
				t.Errorf("%s: health errMsg must use panic: prefix, got %q", tc.name, reps[0].errMsg)
			}
		})
	}
}

// 15. Nested panic in Run — Run() defers its own recover and panics again from
//     inside the recovery. The outer supervisor's recover must catch the
//     re-thrown panic.
func TestSuperviseSenderRecovery_NestedPanicInRun(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("nested panic escaped supervisor: %v", r)
		}
	}()

	superviseSender(context.Background(), func() error {
		defer func() {
			if r := recover(); r != nil {
				panic(fmt.Sprintf("rethrown: %v", r))
			}
		}()
		panic("primary")
	}, hr, ac)

	if ac.panicCount() != 1 {
		t.Fatalf("want 1 panic alert from rethrown panic, got %d", ac.panicCount())
	}
	if !strings.Contains(ac.lastPanic().msg, "rethrown") {
		t.Errorf("alert msg should reflect rethrown panic, got %q", ac.lastPanic().msg)
	}
}

// 16. Race-clean atomic counter contract: a 100-iteration concurrent panic
//     run produces exactly 100 panic alerts, no double-count, no drop.
func TestSuperviseSenderRecovery_ConcurrentPanicCountIsExact(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	const n = 100
	var wg sync.WaitGroup
	var startGate sync.WaitGroup
	startGate.Add(1) // all goroutines wait on this so they panic ~together

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			startGate.Wait()
			superviseSender(context.Background(), func() error {
				panic(fmt.Sprintf("g%d", i))
			}, hr, ac)
		}(i)
	}
	startGate.Done()
	wg.Wait()

	if got := ac.panicCount(); got != n {
		t.Errorf("want exactly %d panic alerts under concurrent load, got %d", n, got)
	}
}

// 17. Panic during Run, ctx already canceled — the panic still wins (we report
//     unhealthy + DaemonPanic, NOT the graceful path). Verifies the defer
//     ordering: recover() runs before the ctx check, so a panic with a dead
//     context still surfaces as an alert.
func TestSuperviseSenderRecovery_PanicWithCanceledContextStillAlerts(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	superviseSender(ctx, func() error {
		panic("died during shutdown")
	}, hr, ac)

	if ac.panicCount() != 1 {
		t.Fatalf("panic during canceled-ctx must still alert, got %d", ac.panicCount())
	}
	if ac.errorCount() != 0 {
		t.Errorf("must not also fire DaemonError, got %d", ac.errorCount())
	}
	reps := hr.snapshot()
	if len(reps) != 1 || reps[0].ok {
		t.Errorf("panic during canceled-ctx must mark unhealthy, got %#v", reps)
	}
}

// 18. Stateless property: invocation N has no dependency on invocation N-1.
//     Two parallel suites of 50 panics each — totals must match the sum.
func TestSuperviseSenderRecovery_StatelessAcrossInvocations(t *testing.T) {
	t.Parallel()

	run := func(label string) (panicCalls, reportCalls int) {
		hr := &fakeHealthReporter{}
		ac := &recoveryAlertProbe{}
		for i := 0; i < 50; i++ {
			superviseSender(context.Background(), func() error {
				panic(label + "-panic")
			}, hr, ac)
		}
		return ac.panicCount(), len(hr.snapshot())
	}

	var aPanic, aReport, bPanic, bReport int32
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); p, r := run("A"); atomic.StoreInt32(&aPanic, int32(p)); atomic.StoreInt32(&aReport, int32(r)) }()
	go func() { defer wg.Done(); p, r := run("B"); atomic.StoreInt32(&bPanic, int32(p)); atomic.StoreInt32(&bReport, int32(r)) }()
	wg.Wait()

	if aPanic != 50 || bPanic != 50 {
		t.Errorf("each suite must produce 50 panics; got A=%d B=%d", aPanic, bPanic)
	}
	if aReport != 50 || bReport != 50 {
		t.Errorf("each suite must produce 50 reports; got A=%d B=%d", aReport, bReport)
	}
}

// 19. Long Run — supervisor blocks for the full Run duration and reports only
//     after Run returns. Catches a regression where supervisor returns early
//     and leaves Run executing in the background.
func TestSuperviseSenderRecovery_BlocksUntilRunReturns(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{}

	const runDuration = 100 * time.Millisecond
	start := time.Now()
	superviseSender(context.Background(), func() error {
		time.Sleep(runDuration)
		panic("delayed")
	}, hr, ac)
	elapsed := time.Since(start)

	if elapsed < runDuration {
		t.Errorf("supervisor returned in %v, expected >= %v (Run hadn't finished)", elapsed, runDuration)
	}
	if ac.panicCount() != 1 {
		t.Errorf("want 1 panic recovery after delayed Run, got %d", ac.panicCount())
	}
}

// W1 (#93, 2026-04-29): test #20 deleted along with the playbook plumbing.

// ── Sprint T3 (2026-05-06): safeCall + DaemonError hook isolation ─────────────

// T3-1. DaemonError hook panics — daemon still reports unhealthy, panic does
//       not escape. Mirrors test #12 but for the error path (non-nil Run return).
func TestSuperviseSenderRecovery_DaemonErrorHookPanicDoesNotEscape(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{
		errorHook: func(_, _ string) {
			panic("DaemonError hook broken")
		},
	}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("DaemonError hook panic escaped supervisor (T3 regression): %v", r)
		}
	}()

	superviseSender(context.Background(), func() error {
		return errors.New("boot misconfiguration")
	}, hr, ac)

	reps := hr.snapshot()
	if len(reps) != 1 || reps[0].ok {
		t.Errorf("daemon must be unhealthy after error return, got %#v", reps)
	}
}

// T3-2. DaemonError hook panics on nil-return path (Run returns nil).
func TestSuperviseSenderRecovery_DaemonErrorHookPanicOnNilReturn(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{
		errorHook: func(_, _ string) {
			panic("DaemonError hook broken on nil path")
		},
	}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("DaemonError hook panic on nil path escaped supervisor: %v", r)
		}
	}()

	superviseSender(context.Background(), func() error {
		return nil // unexpected nil return
	}, hr, ac)

	reps := hr.snapshot()
	if len(reps) != 1 || reps[0].ok {
		t.Errorf("daemon must be unhealthy after nil return, got %#v", reps)
	}
}

// T3-3. safeCall — no-op when fn completes normally (no recover fires).
func TestSafeCall_NormalExecution(t *testing.T) {
	t.Parallel()
	called := false
	safeCall("test/op", func() { called = true })
	if !called {
		t.Fatal("safeCall must invoke fn when it does not panic")
	}
}

// T3-4. safeCall — recovers a string panic, does not re-throw.
func TestSafeCall_StringPanicRecovered(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("safeCall let string panic escape: %v", r)
		}
	}()
	safeCall("test/op", func() { panic("boom") })
}

// T3-5. safeCall — recovers an error panic.
func TestSafeCall_ErrorPanicRecovered(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("safeCall let error panic escape: %v", r)
		}
	}()
	safeCall("test/op", func() { panic(errors.New("db timeout")) })
}

// T3-6. safeCall — recovers an integer panic.
func TestSafeCall_IntegerPanicRecovered(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("safeCall let integer panic escape: %v", r)
		}
	}()
	safeCall("test/op", func() { panic(42) })
}

// T3-7. safeCall — recovers a struct panic (domain error type).
func TestSafeCall_StructPanicRecovered(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("safeCall let struct panic escape: %v", r)
		}
	}()
	safeCall("test/op", func() { panic(customPanicValue{Kind: "sentry", Reason: "nil hub"}) })
}

// T3-8. safeCall — concurrent calls all recover independently, no data race.
func TestSafeCall_ConcurrentPanicsAllRecovered(t *testing.T) {
	t.Parallel()
	const workers = 50
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					// If safeCall lets a panic escape it will land here → fail.
					panic(fmt.Sprintf("safeCall leaked panic from worker %d: %v", i, r))
				}
			}()
			safeCall("test/concurrent", func() {
				if i%2 == 0 {
					panic(fmt.Sprintf("worker-%d", i))
				}
			})
		}(i)
	}
	wg.Wait()
}

// T3-9. Panicking DaemonPanic hook with concurrent load — all invocations
//        are contained; health reports still arrive (defense-in-depth).
func TestSuperviseSenderRecovery_ConcurrentPanicWithBrokenHook(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{
		panicHook: func(_, _ string) {
			panic("sentry network timeout")
		},
	}

	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					// safeCall should have eaten this — if we see it, it leaked.
					panic(fmt.Sprintf("hook panic leaked in goroutine %d: %v", i, r))
				}
			}()
			superviseSender(context.Background(), func() error {
				panic(fmt.Sprintf("daemon-%d", i))
			}, hr, ac)
		}(i)
	}
	wg.Wait()

	if got := len(hr.snapshot()); got != n {
		t.Errorf("want %d health reports, got %d (safeCall must not suppress hr.Report)", n, got)
	}
}

// T3-10. Repeated DaemonError hook panics (10 sequential) — all recovered,
//         no leak, each invocation produces one health report.
func TestSuperviseSenderRecovery_RepeatedDaemonErrorHookPanic(t *testing.T) {
	t.Parallel()
	hr := &fakeHealthReporter{}
	ac := &recoveryAlertProbe{
		errorHook: func(_, _ string) { panic("errorHook always broken") },
	}

	const n = 10
	for i := 0; i < n; i++ {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("iteration %d: hook panic escaped: %v", i, r)
				}
			}()
			superviseSender(context.Background(), func() error {
				return fmt.Errorf("boot fail %d", i)
			}, hr, ac)
		}()
	}

	if got := len(hr.snapshot()); got != n {
		t.Errorf("want %d health reports, got %d", n, got)
	}
	for i, rep := range hr.snapshot() {
		if rep.ok {
			t.Errorf("report %d: want unhealthy, got healthy", i)
		}
	}
}
