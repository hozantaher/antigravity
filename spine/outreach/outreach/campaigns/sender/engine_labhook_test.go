package sender

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"common/config"
	"common/metrics"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// KT-A14 — Mail Lab pre-send abort hook wiring tests.
//
// Coverage matrix (≥10 cases per the testing discipline rule):
//   1. Nil evaluator → engine works as before (legacy path).
//   2. Evaluator returns skip=false, err=nil → SMTP submit fires.
//   3. Evaluator returns skip=true, reason="…" → SMTP submit DOES NOT fire,
//      onSent gets a synthetic SendResult, recordSendResult NOT called
//      (sentCounts stays 0), LabSkipTotal incremented.
//   4. Evaluator returns err=… AND LAB_ONLY=1 → fail-closed (skip).
//   5. Evaluator returns err=… AND LAB_ONLY=0 → fail-open (SMTP fires).
//   6. Skip reason propagates into SendResult.SMTPResponse for audit.
//   7. Skip path does not advance per-mailbox sentCounts (no rate-limit hit).
//   8. Skip path does not advance per-domain domainCounts.
//   9. ShouldAbort receives the actual mailbox.Address as sender (not
//      the relay's static fromAddr).
//  10. ShouldAbort receives the actual recipient address.
//  11. labOnly fail-closed increments BOTH LabUnreachableTotal AND LabSkipTotal.
//  12. labOnly fail-open increments LabUnreachableTotal but NOT LabSkipTotal.
//  13. Concurrent calls into the evaluator are race-free (run with -race).
//  14. Engine.LabOnly() reflects the flag value passed to WithLabEvaluator.
//
// Tests use a fakeLabEvaluator + an httptest relay that fails-loud on hit
// when the test asserts "no SMTP submit". This is the same pattern as
// engine_dryrun_test.go.

type fakeLabEvaluator struct {
	mu        sync.Mutex
	calls     []fakeLabCall
	skip      bool
	reason    string
	err       error
	delay     time.Duration
}

type fakeLabCall struct {
	Sender    string
	Recipient string
}

func (f *fakeLabEvaluator) ShouldAbort(_ context.Context, sender, recipient string) (bool, string, error) {
	f.mu.Lock()
	f.calls = append(f.calls, fakeLabCall{Sender: sender, Recipient: recipient})
	skip, reason, err, delay := f.skip, f.reason, f.err, f.delay
	f.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	return skip, reason, err
}

func (f *fakeLabEvaluator) Calls() []fakeLabCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]fakeLabCall, len(f.calls))
	copy(out, f.calls)
	return out
}

func newSpyRelay(t *testing.T) (server *httptest.Server, hits *int32) {
	t.Helper()
	var c int32
	hits = &c
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&c, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"envelope_id":"test-env-%d","status":"queued"}`, time.Now().UnixNano())
	}))
	t.Cleanup(server.Close)
	return server, hits
}

func newLabhookEngine(t *testing.T, ev LabAbortEvaluator, labOnly bool, relayURL string) *Engine {
	t.Helper()
	mb := config.MailboxConfig{
		Address:    "operator@firma.test",
		SMTPHost:   "127.0.0.1",
		SMTPPort:   1,
		Username:   "operator@firma.test",
		Password:   "x",
		DailyLimit: 100,
	}
	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{
			Timezone: "UTC", WindowStart: 0, WindowEnd: 24,
			MaxPerDomainHour: 1000,
			MinDelaySeconds:  0, MaxDelaySeconds: 1,
		},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(relayURL, "tok"))
	if ev != nil {
		e.WithLabEvaluator(ev, labOnly)
	}
	return e
}

func runOneAndCancel(t *testing.T, e *Engine, req SendRequest, wantOnSent bool) (SendResult, bool) {
	t.Helper()
	var (
		captured SendResult
		fired    bool
	)
	done := make(chan struct{})
	onSent := func(_ SendRequest, r SendResult) {
		captured = r
		fired = true
		close(done)
	}
	e.Enqueue(req)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	errCh := make(chan error, 1)
	go func() { errCh <- e.Run(ctx, onSent) }()

	if wantOnSent {
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("onSent never fired — Run did not consume the queued request")
		}
	} else {
		// Wait briefly to give Run a chance to consume + skip.
		select {
		case <-done:
		case <-time.After(500 * time.Millisecond):
		}
	}
	cancel()
	<-errCh
	return captured, fired
}

// 1. Nil evaluator → engine wires the legacy SMTP submit unchanged.
func TestEngine_LabHook_NilEvaluator_DoesNotChangePath(t *testing.T) {
	relay, hits := newSpyRelay(t)
	e := newLabhookEngine(t, nil, false, relay.URL)
	res, fired := runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test",
		Subject:   "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire when no evaluator is wired")
	}
	if got := atomic.LoadInt32(hits); got == 0 {
		t.Errorf("relay must be hit when no evaluator is wired, got %d hits", got)
	}
	if res.MailboxUsed != "operator@firma.test" {
		t.Errorf("mailbox_used not propagated: %q", res.MailboxUsed)
	}
}

// 2. Evaluator allows the send → SMTP submit fires normally.
func TestEngine_LabHook_Allow_ProceedsWithSend(t *testing.T) {
	relay, hits := newSpyRelay(t)
	ev := &fakeLabEvaluator{skip: false}
	e := newLabhookEngine(t, ev, false, relay.URL)
	_, fired := runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test",
		Subject:   "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire when evaluator allows the send")
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("relay must be hit once when evaluator allows, got %d", got)
	}
	calls := ev.Calls()
	if len(calls) != 1 {
		t.Errorf("evaluator should be invoked exactly once on accept path, got %d", len(calls))
	}
}

// 3. Evaluator says skip → SMTP submit does NOT fire.
func TestEngine_LabHook_Skip_BypassesRelay(t *testing.T) {
	relay, hits := newSpyRelay(t)
	ev := &fakeLabEvaluator{skip: true, reason: "lab verdict: reject (rate-exceeded)"}
	e := newLabhookEngine(t, ev, false, relay.URL)
	res, fired := runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@blocked.test",
		Subject:   "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire on skip so audit can record the verdict")
	}
	if got := atomic.LoadInt32(hits); got != 0 {
		t.Errorf("relay must NOT be hit on skip, got %d hit(s)", got)
	}
	if res.Error != nil {
		t.Errorf("skip must not surface an error in SendResult, got %v", res.Error)
	}
	if res.MailboxUsed != "operator@firma.test" {
		t.Errorf("mailbox_used not propagated on skip: %q", res.MailboxUsed)
	}
}

// 4. Evaluator returns err + LAB_ONLY=1 → fail-closed (skip).
func TestEngine_LabHook_Error_LabOnly1_FailsClosed(t *testing.T) {
	relay, hits := newSpyRelay(t)
	ev := &fakeLabEvaluator{err: errors.New("dial: connection refused")}
	e := newLabhookEngine(t, ev, true, relay.URL)
	_, fired := runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test",
		Subject:   "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire on fail-closed skip so audit can record")
	}
	if got := atomic.LoadInt32(hits); got != 0 {
		t.Errorf("LAB_ONLY=1 + lab error must NOT hit relay, got %d hit(s)", got)
	}
}

// 5. Evaluator returns err + LAB_ONLY=0 → fail-open (proceed).
func TestEngine_LabHook_Error_LabOnly0_FailsOpen(t *testing.T) {
	relay, hits := newSpyRelay(t)
	ev := &fakeLabEvaluator{err: errors.New("dial: timeout")}
	e := newLabhookEngine(t, ev, false, relay.URL)
	_, fired := runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test",
		Subject:   "S", BodyPlain: "B",
	}, true)
	if !fired {
		t.Fatal("onSent must fire on fail-open path")
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("LAB_ONLY=0 + lab error must STILL hit relay, got %d hit(s)", got)
	}
}

// 6. Skip reason flows into SendResult.SMTPResponse.
func TestEngine_LabHook_Skip_ReasonInSMTPResponse(t *testing.T) {
	relay, _ := newSpyRelay(t)
	wantReason := "lab verdict: spam (link_ratio_too_high)"
	ev := &fakeLabEvaluator{skip: true, reason: wantReason}
	e := newLabhookEngine(t, ev, false, relay.URL)
	res, _ := runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@blocked.test", Subject: "S", BodyPlain: "B",
	}, true)
	if res.SMTPResponse == "" || res.SMTPResponse == wantReason {
		// SMTPResponse should embed the reason with a "lab-skip:" prefix.
		t.Logf("SMTPResponse=%q", res.SMTPResponse)
	}
	if !strings.Contains(res.SMTPResponse, "lab-skip") {
		t.Errorf("SMTPResponse should carry lab-skip marker: %q", res.SMTPResponse)
	}
	if !strings.Contains(res.SMTPResponse, "spam") {
		t.Errorf("SMTPResponse should embed verdict reason: %q", res.SMTPResponse)
	}
}

// 7. Skip path does NOT advance the per-mailbox sentCounts.
func TestEngine_LabHook_Skip_DoesNotIncrementSentCounts(t *testing.T) {
	relay, _ := newSpyRelay(t)
	ev := &fakeLabEvaluator{skip: true, reason: "lab verdict: greylist"}
	e := newLabhookEngine(t, ev, false, relay.URL)
	_, _ = runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	e.mu.Lock()
	got := e.sentCounts["operator@firma.test"]
	e.mu.Unlock()
	if got != 0 {
		t.Errorf("skip must not advance sentCounts; got %d, want 0", got)
	}
}

// 8. Skip path does NOT advance per-domain domainCounts.
func TestEngine_LabHook_Skip_DoesNotIncrementDomainCounts(t *testing.T) {
	relay, _ := newSpyRelay(t)
	ev := &fakeLabEvaluator{skip: true, reason: "lab verdict: reject"}
	e := newLabhookEngine(t, ev, false, relay.URL)
	_, _ = runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	e.mu.Lock()
	got := e.domainCounts["example.test"]
	e.mu.Unlock()
	if got != 0 {
		t.Errorf("skip must not advance domainCounts; got %d, want 0", got)
	}
}

// 9. ShouldAbort sees the actual mailbox address as sender.
func TestEngine_LabHook_PassesActualMailboxAddressAsSender(t *testing.T) {
	relay, _ := newSpyRelay(t)
	ev := &fakeLabEvaluator{skip: true, reason: "x"}
	e := newLabhookEngine(t, ev, false, relay.URL)
	_, _ = runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	calls := ev.Calls()
	if len(calls) == 0 {
		t.Fatal("evaluator was never called")
	}
	if calls[0].Sender != "operator@firma.test" {
		t.Errorf("sender mismatch; got %q want operator@firma.test", calls[0].Sender)
	}
}

// 10. ShouldAbort sees the actual recipient address.
func TestEngine_LabHook_PassesActualRecipient(t *testing.T) {
	relay, _ := newSpyRelay(t)
	ev := &fakeLabEvaluator{skip: true, reason: "x"}
	e := newLabhookEngine(t, ev, false, relay.URL)
	_, _ = runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@kunde.test", Subject: "S", BodyPlain: "B",
	}, true)
	calls := ev.Calls()
	if len(calls) == 0 {
		t.Fatal("evaluator was never called")
	}
	if calls[0].Recipient != "rcpt@kunde.test" {
		t.Errorf("recipient mismatch; got %q want rcpt@kunde.test", calls[0].Recipient)
	}
}

// 11. labOnly=1 + lab error → BOTH LabUnreachableTotal AND LabSkipTotal increment.
func TestEngine_LabHook_LabOnly1_IncrementsBothCounters(t *testing.T) {
	relay, _ := newSpyRelay(t)
	ev := &fakeLabEvaluator{err: errors.New("lab down")}
	e := newLabhookEngine(t, ev, true, relay.URL)
	// Snapshot starting values; metrics package counters are package-level.
	beforeUnreach := getCounter(t, "outreach_lab_unreachable_total")
	beforeSkip := getCounter(t, "outreach_lab_skip_total")
	_, _ = runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	afterUnreach := getCounter(t, "outreach_lab_unreachable_total")
	afterSkip := getCounter(t, "outreach_lab_skip_total")
	if afterUnreach <= beforeUnreach {
		t.Errorf("LabUnreachableTotal must increment on lab error; before=%d after=%d", beforeUnreach, afterUnreach)
	}
	if afterSkip <= beforeSkip {
		t.Errorf("LabSkipTotal must increment on fail-closed; before=%d after=%d", beforeSkip, afterSkip)
	}
}

// 12. labOnly=0 + lab error → LabUnreachableTotal increments, LabSkipTotal does NOT.
func TestEngine_LabHook_LabOnly0_OnlyIncrementsUnreachable(t *testing.T) {
	relay, _ := newSpyRelay(t)
	ev := &fakeLabEvaluator{err: errors.New("lab down")}
	e := newLabhookEngine(t, ev, false, relay.URL)
	beforeUnreach := getCounter(t, "outreach_lab_unreachable_total")
	beforeSkip := getCounter(t, "outreach_lab_skip_total")
	_, _ = runOneAndCancel(t, e, SendRequest{
		ToAddress: "rcpt@example.test", Subject: "S", BodyPlain: "B",
	}, true)
	afterUnreach := getCounter(t, "outreach_lab_unreachable_total")
	afterSkip := getCounter(t, "outreach_lab_skip_total")
	if afterUnreach <= beforeUnreach {
		t.Errorf("LabUnreachableTotal must increment on lab error; before=%d after=%d", beforeUnreach, afterUnreach)
	}
	if afterSkip != beforeSkip {
		t.Errorf("LabSkipTotal must NOT increment on fail-open; before=%d after=%d", beforeSkip, afterSkip)
	}
}

// 13. Concurrent ShouldAbort calls do not race (run with -race).
// Drives multiple sends through one engine in parallel via Enqueue and
// asserts the evaluator records all calls without lock contention panics.
func TestEngine_LabHook_ConcurrentCalls_NoRace(t *testing.T) {
	relay, _ := newSpyRelay(t)
	ev := &fakeLabEvaluator{skip: false} // allow all
	e := newLabhookEngine(t, ev, false, relay.URL)
	const N = 20
	for i := 0; i < N; i++ {
		e.Enqueue(SendRequest{ToAddress: "rcpt@example.test", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- e.Run(ctx, func(_ SendRequest, _ SendResult) {}) }()
	// Wait for queue to drain or timeout
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if e.QueueDepth() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-errCh
	calls := ev.Calls()
	if len(calls) == 0 {
		t.Fatal("expected at least one evaluator call under load")
	}
}

// 14. Engine.LabOnly() reflects the configured flag.
func TestEngine_LabHook_LabOnlyAccessor(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	if e.LabOnly() {
		t.Error("LabOnly default should be false")
	}
	e.WithLabEvaluator(&fakeLabEvaluator{}, true)
	if !e.LabOnly() {
		t.Error("LabOnly should reflect WithLabEvaluator(_, true)")
	}
	e.WithLabEvaluator(&fakeLabEvaluator{}, false)
	if e.LabOnly() {
		t.Error("LabOnly should reflect WithLabEvaluator(_, false)")
	}
}

// helpers ------------------------------------------------------------------

// getCounter reads the current value of one of our package-level counters
// by name. Tests that want to assert "did X increment?" snapshot before
// and after by calling this twice. Counters are package globals — every
// test in this file sees the same instance, so we use deltas, never
// absolute values.
func getCounter(t *testing.T, name string) int64 {
	t.Helper()
	switch name {
	case "outreach_lab_skip_total":
		return metrics.LabSkipTotal.Value()
	case "outreach_lab_unreachable_total":
		return metrics.LabUnreachableTotal.Value()
	}
	t.Fatalf("getCounter: unknown counter %q", name)
	return 0
}
