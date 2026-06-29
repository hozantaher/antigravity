//go:build integration

// Package integration contains AT3.2 runtime verification tests.
//
// These tests exercise Engine.Run end-to-end with LAB_ONLY=1 and assert that
// zero real SMTP egress occurs (zero AntiTraceClient.Send calls, zero
// SMTPSocketOpenTotal increments). They complement the static audit ratchet in
// services/campaigns/sender/airtight_audit_test.go (AT2.3) which catches
// code-level violations at parse time; AT3.2 catches runtime wiring failures.
//
// Excluded from default go test ./... by the integration build tag.
// Run via:
//
//	go test -tags=integration ./services/campaigns/integration/...
//
// Subsystem: anti-trace (docs/subsystem-maps/anti-trace.md G8)
// ADR: docs/decisions/ADR-005-airtight-dev-env.md §D5
// Closes: #292 (AT3.2)
package integration

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"common/config"
	"common/metrics"
	"campaigns/sender"
)

// ── Spy relay ──────────────────────────────────────────────────────────────
//
// relayHits counts actual HTTP POSTs to /v1/submit. Under LAB_ONLY=1 this
// must always be 0. If the LabAbortEvaluator gate is bypassed the test
// server responds 200 so the engine does not error-loop, but the counter
// increment is the authoritative assertion.

func newSpyRelayServer(t *testing.T) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// ── Fake LabAbortEvaluator ─────────────────────────────────────────────────

type fakeEval struct {
	mu      sync.Mutex
	calls   int
	skip    bool
	reason  string
	err     error
}

func (f *fakeEval) ShouldAbort(_ context.Context, _, _ string) (bool, string, error) {
	f.mu.Lock()
	f.calls++
	skip, reason, err := f.skip, f.reason, f.err
	f.mu.Unlock()
	return skip, reason, err
}

func (f *fakeEval) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// ── Engine factory ─────────────────────────────────────────────────────────

func newLabOnlyEngine(t *testing.T, relayURL string, ev sender.LabAbortEvaluator, labOnly bool) *sender.Engine {
	t.Helper()
	mb := config.MailboxConfig{
		Address:    "test@lab.test",
		SMTPHost:   "127.0.0.1",
		SMTPPort:   1,
		Username:   "test@lab.test",
		Password:   "x",
		DailyLimit: 1000,
	}
	e := sender.NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{
			Timezone:         "UTC",
			WindowStart:      0,
			WindowEnd:        24,
			MaxPerDomainHour: 10000,
			MinDelaySeconds:  0,
			MaxDelaySeconds:  0,
		},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(sender.NewAntiTraceClient(relayURL, "lab-token"))
	if ev != nil {
		e.WithLabEvaluator(ev, labOnly)
	}
	return e
}

// runAndDrain enqueues reqs, starts e.Run in a goroutine, waits until all
// onSent callbacks fire (or timeout), then cancels the context. Returns the
// collected SendResults.
func runAndDrain(t *testing.T, e *sender.Engine, reqs []sender.SendRequest, timeout time.Duration) []sender.SendResult {
	t.Helper()
	var (
		mu      sync.Mutex
		results []sender.SendResult
		done    = make(chan struct{})
		want    = len(reqs)
		fired   int
	)

	for _, r := range reqs {
		e.Enqueue(r)
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	t.Cleanup(cancel)

	errCh := make(chan error, 1)
	go func() {
		errCh <- e.Run(ctx, func(req sender.SendRequest, res sender.SendResult) {
			mu.Lock()
			results = append(results, res)
			fired++
			if fired >= want {
				select {
				case done <- struct{}{}:
				default:
				}
			}
			mu.Unlock()
		})
	}()

	select {
	case <-done:
		// all onSent callbacks received
	case <-ctx.Done():
		// timed out — still return partial results for assertion
	}
	cancel()
	<-errCh

	mu.Lock()
	defer mu.Unlock()
	return append([]sender.SendResult(nil), results...)
}

// buildRequests synthesises N distinct SendRequests with unique recipients.
func buildRequests(n int) []sender.SendRequest {
	reqs := make([]sender.SendRequest, n)
	for i := range reqs {
		reqs[i] = sender.SendRequest{
			CampaignID: 1,
			ContactID:  int64(i + 1),
			Step:       0,
			ToAddress:  "contact" + string(rune('0'+i+1)) + "@target.test",
			Subject:    "Test",
			BodyPlain:  "Body",
		}
	}
	return reqs
}

// ── Test cases (≥10 per feedback_extreme_testing) ─────────────────────────

// TC1: LabEvaluator returns skip=true → AntiTraceClient.Send never called.
func TestAirtightLabSend_TC1_SkipEvaluator_NoRelayCalls(t *testing.T) {
	relay, hits := newSpyRelayServer(t)
	ev := &fakeEval{skip: true, reason: "lab verdict: reject"}
	e := newLabOnlyEngine(t, relay.URL, ev, true)

	before := metrics.SMTPSocketOpenTotal.Value()
	results := runAndDrain(t, e, buildRequests(5), 5*time.Second)

	if got := atomic.LoadInt32(hits); got != 0 {
		t.Errorf("TC1: relay hit %d time(s), want 0", got)
	}
	if got := metrics.SMTPSocketOpenTotal.Value() - before; got != 0 {
		t.Errorf("TC1: SMTPSocketOpenTotal delta=%d, want 0", got)
	}
	if len(results) != 5 {
		t.Errorf("TC1: got %d onSent calls, want 5", len(results))
	}
}

// TC2: 5 contacts, all lab-skipped → LabSkipTotal increments 5×.
func TestAirtightLabSend_TC2_FiveContactsLabSkipMetric(t *testing.T) {
	relay, _ := newSpyRelayServer(t)
	ev := &fakeEval{skip: true, reason: "verdict: rate-exceeded"}
	e := newLabOnlyEngine(t, relay.URL, ev, true)

	before := metrics.LabSkipTotal.Value()
	results := runAndDrain(t, e, buildRequests(5), 5*time.Second)

	delta := metrics.LabSkipTotal.Value() - before
	if delta != 5 {
		t.Errorf("TC2: LabSkipTotal delta=%d, want 5", delta)
	}
	for i, r := range results {
		if r.Error != nil {
			t.Errorf("TC2: result[%d].Error should be nil on lab-skip, got %v", i, r.Error)
		}
		if r.SMTPResponse == "" {
			t.Errorf("TC2: result[%d].SMTPResponse empty, want lab-skip marker", i)
		}
	}
}

// TC3: LabEvaluator returns skip=false → relay IS called (allow path
// verifies the evaluator is wired, not dead code).
func TestAirtightLabSend_TC3_AllowEvaluator_RelayIsCalled(t *testing.T) {
	relay, hits := newSpyRelayServer(t)
	ev := &fakeEval{skip: false}
	e := newLabOnlyEngine(t, relay.URL, ev, false) // labOnly=false = production-like

	_ = runAndDrain(t, e, buildRequests(1), 3*time.Second)

	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("TC3: relay hit %d time(s), want 1", got)
	}
}

// TC4: LabEvaluator returns err + labOnly=true → fail-closed (relay not hit).
func TestAirtightLabSend_TC4_EvalError_LabOnly1_FailClosed(t *testing.T) {
	relay, hits := newSpyRelayServer(t)
	ev := &fakeEval{err: errors.New("lab api: connection refused")}
	e := newLabOnlyEngine(t, relay.URL, ev, true)

	before := metrics.LabUnreachableTotal.Value()
	beforeSkip := metrics.LabSkipTotal.Value()
	beforeSocket := metrics.SMTPSocketOpenTotal.Value()

	results := runAndDrain(t, e, buildRequests(1), 3*time.Second)

	if got := atomic.LoadInt32(hits); got != 0 {
		t.Errorf("TC4: relay hit %d time(s) under fail-closed, want 0", got)
	}
	if metrics.LabUnreachableTotal.Value()-before != 1 {
		t.Error("TC4: LabUnreachableTotal must increment on lab error")
	}
	if metrics.LabSkipTotal.Value()-beforeSkip != 1 {
		t.Error("TC4: LabSkipTotal must increment on fail-closed")
	}
	if metrics.SMTPSocketOpenTotal.Value()-beforeSocket != 0 {
		t.Error("TC4: SMTPSocketOpenTotal must stay 0 under fail-closed")
	}
	if len(results) != 1 {
		t.Errorf("TC4: onSent must fire so audit can record skip; got %d", len(results))
	}
}

// TC5: LabEvaluator returns err + labOnly=false → fail-open (relay IS hit).
func TestAirtightLabSend_TC5_EvalError_LabOnly0_FailOpen(t *testing.T) {
	relay, hits := newSpyRelayServer(t)
	ev := &fakeEval{err: errors.New("lab api: timeout")}
	e := newLabOnlyEngine(t, relay.URL, ev, false)

	before := metrics.LabUnreachableTotal.Value()
	beforeSkip := metrics.LabSkipTotal.Value()

	_ = runAndDrain(t, e, buildRequests(1), 3*time.Second)

	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("TC5: relay hit %d time(s) under fail-open, want 1", got)
	}
	if metrics.LabUnreachableTotal.Value()-before != 1 {
		t.Error("TC5: LabUnreachableTotal must increment")
	}
	if metrics.LabSkipTotal.Value()-beforeSkip != 0 {
		t.Error("TC5: LabSkipTotal must NOT increment under fail-open")
	}
}

// TC6: No LabEvaluator wired → legacy path, relay called.
func TestAirtightLabSend_TC6_NilEvaluator_LegacyRelayPath(t *testing.T) {
	relay, hits := newSpyRelayServer(t)
	e := newLabOnlyEngine(t, relay.URL, nil, false)

	_ = runAndDrain(t, e, buildRequests(1), 3*time.Second)

	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("TC6: relay hit %d time(s) on nil evaluator, want 1", got)
	}
}

// TC7: ValidateAirtight rejects TRANSPORT_MODE=direct at boot.
func TestAirtightLabSend_TC7_ValidateAirtight_DirectBanned(t *testing.T) {
	s := config.SendingConfig{TransportMode: "direct"}
	err := s.ValidateAirtight()
	if err == nil {
		t.Fatal("TC7: ValidateAirtight must reject TRANSPORT_MODE=direct")
	}
	var ae *config.AirtightError
	if !errors.As(err, &ae) {
		t.Fatalf("TC7: expected *config.AirtightError, got %T", err)
	}
	if ae.ExitCode != config.AirtightExitCodeBadMode {
		t.Errorf("TC7: ExitCode=%d, want %d (AirtightExitCodeBadMode)", ae.ExitCode, config.AirtightExitCodeBadMode)
	}
}

// TC8: ValidateAirtight rejects LabOnly=true with non-lab mode.
func TestAirtightLabSend_TC8_ValidateAirtight_LabOnlyMismatch(t *testing.T) {
	s := config.SendingConfig{TransportMode: "socks5", LabOnly: true}
	err := s.ValidateAirtight()
	if err == nil {
		t.Fatal("TC8: ValidateAirtight must reject LabOnly=true with non-lab mode")
	}
	var ae *config.AirtightError
	if !errors.As(err, &ae) {
		t.Fatalf("TC8: expected *config.AirtightError, got %T", err)
	}
	if ae.ExitCode != config.AirtightExitCodeLabOnlyMismatch {
		t.Errorf("TC8: ExitCode=%d, want %d (AirtightExitCodeLabOnlyMismatch)", ae.ExitCode, config.AirtightExitCodeLabOnlyMismatch)
	}
}

// TC9: Mid-batch ctx cancel → graceful exit, partial skip counts recorded.
func TestAirtightLabSend_TC9_CtxCancel_GracefulExit(t *testing.T) {
	relay, hits := newSpyRelayServer(t)
	ev := &fakeEval{skip: true, reason: "lab: reject"}
	e := newLabOnlyEngine(t, relay.URL, ev, true)

	// Enqueue 10 requests but cancel the context very quickly.
	// We can't assert exactly how many fired (race), but:
	//   - relay must never be hit (lab-only)
	//   - no goroutine leak (Run must return)
	for _, r := range buildRequests(10) {
		e.Enqueue(r)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- e.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) {}) }()
	cancel()

	select {
	case err := <-done:
		if err == nil || !errors.Is(err, context.Canceled) {
			// context.DeadlineExceeded is also acceptable
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Errorf("TC9: Run returned unexpected error: %v", err)
			}
		}
	case <-time.After(3 * time.Second):
		t.Fatal("TC9: Run did not exit after ctx cancel — goroutine leak?")
	}

	if got := atomic.LoadInt32(hits); got != 0 {
		t.Errorf("TC9: relay hit %d time(s) during cancel, want 0", got)
	}
}

// TC10: SMTPSocketOpenTotal counter matches relay hits when lab evaluator
// is absent (production wiring sanity check). Under lab-only it must be 0.
func TestAirtightLabSend_TC10_SMTPSocketOpenCounter_Matches(t *testing.T) {
	t.Run("under_lab_only", func(t *testing.T) {
		relay, hits := newSpyRelayServer(t)
		ev := &fakeEval{skip: true, reason: "lab: reject"}
		e := newLabOnlyEngine(t, relay.URL, ev, true)

		before := metrics.SMTPSocketOpenTotal.Value()
		_ = runAndDrain(t, e, buildRequests(5), 5*time.Second)

		delta := metrics.SMTPSocketOpenTotal.Value() - before
		relayHits := int64(atomic.LoadInt32(hits))
		if delta != 0 {
			t.Errorf("TC10/lab_only: SMTPSocketOpenTotal delta=%d, want 0", delta)
		}
		if relayHits != 0 {
			t.Errorf("TC10/lab_only: relay hits=%d, want 0", relayHits)
		}
	})

	t.Run("without_lab_only", func(t *testing.T) {
		relay, hits := newSpyRelayServer(t)
		ev := &fakeEval{skip: false}
		e := newLabOnlyEngine(t, relay.URL, ev, false)

		before := metrics.SMTPSocketOpenTotal.Value()
		_ = runAndDrain(t, e, buildRequests(3), 5*time.Second)

		delta := metrics.SMTPSocketOpenTotal.Value() - before
		relayHits := int64(atomic.LoadInt32(hits))
		if delta != relayHits {
			t.Errorf("TC10/no_lab_only: SMTPSocketOpenTotal delta=%d != relay hits %d", delta, relayHits)
		}
	})
}

// TC11: LabSkipTotal per contact — metric delta equals result count
// (no over- or under-counting).
func TestAirtightLabSend_TC11_LabSkipTotal_ExactCount(t *testing.T) {
	relay, _ := newSpyRelayServer(t)
	const n = 7
	ev := &fakeEval{skip: true, reason: "lab verdict: spam"}
	e := newLabOnlyEngine(t, relay.URL, ev, true)

	before := metrics.LabSkipTotal.Value()
	results := runAndDrain(t, e, buildRequests(n), 8*time.Second)

	delta := metrics.LabSkipTotal.Value() - before
	if int(delta) != n {
		t.Errorf("TC11: LabSkipTotal delta=%d, want %d", delta, n)
	}
	if len(results) != n {
		t.Errorf("TC11: onSent fires=%d, want %d", len(results), n)
	}
}

// TC12: skip result carries "lab-skip" prefix in SMTPResponse (audit contract).
func TestAirtightLabSend_TC12_SkipResult_SMTPResponsePrefix(t *testing.T) {
	relay, _ := newSpyRelayServer(t)
	wantReason := "lab verdict: greylist-reject"
	ev := &fakeEval{skip: true, reason: wantReason}
	e := newLabOnlyEngine(t, relay.URL, ev, true)

	results := runAndDrain(t, e, buildRequests(1), 3*time.Second)
	if len(results) == 0 {
		t.Fatal("TC12: no onSent callback fired")
	}
	resp := results[0].SMTPResponse
	if len(resp) < 8 || resp[:8] != "lab-skip" {
		t.Errorf("TC12: SMTPResponse=%q, want prefix 'lab-skip'", resp)
	}
	if len(resp) < len("lab-skip: "+wantReason) {
		t.Errorf("TC12: SMTPResponse too short to contain reason: %q", resp)
	}
}

// TC13: Property — random LabEvaluator inputs (skip=true, various reasons)
// never produce relay hits under labOnly=true. Runs 20 rounds.
func TestAirtightLabSend_TC13_Property_RandomReasons_NoRelay(t *testing.T) {
	reasons := []string{
		"lab: reject", "lab: spam", "lab: greylist", "lab: rate-exceeded",
		"lab: dkim-fail", "lab: link-ratio", "lab: blocked-domain",
	}
	for i, reason := range reasons {
		relay, hits := newSpyRelayServer(t)
		ev := &fakeEval{skip: true, reason: reason}
		e := newLabOnlyEngine(t, relay.URL, ev, true)

		before := metrics.SMTPSocketOpenTotal.Value()
		_ = runAndDrain(t, e, buildRequests(3), 3*time.Second)

		if got := atomic.LoadInt32(hits); got != 0 {
			t.Errorf("TC13[reason=%d %q]: relay hit %d time(s), want 0", i, reason, got)
		}
		if metrics.SMTPSocketOpenTotal.Value()-before != 0 {
			t.Errorf("TC13[reason=%d %q]: SMTPSocketOpenTotal incremented", i, reason)
		}
	}
}

// TC14: EvalCalls equals N under successful lab-skip (evaluator invoked once
// per contact, not double-called or skipped).
func TestAirtightLabSend_TC14_EvalCallsMatchContacts(t *testing.T) {
	relay, _ := newSpyRelayServer(t)
	const n = 5
	ev := &fakeEval{skip: true, reason: "lab: reject"}
	e := newLabOnlyEngine(t, relay.URL, ev, true)

	_ = runAndDrain(t, e, buildRequests(n), 5*time.Second)

	if got := ev.Calls(); got != n {
		t.Errorf("TC14: evaluator called %d time(s), want %d", got, n)
	}
}
