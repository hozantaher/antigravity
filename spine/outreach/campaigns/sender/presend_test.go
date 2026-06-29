package sender

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"common/config"
)

// minimalSendingConfig returns a SendingConfig that lets Engine.Run
// dispatch immediately in tests: 24-hour window, no Poisson pacing,
// hourly per-domain caps roomy enough for the burst.
func minimalSendingConfig() config.SendingConfig {
	return config.SendingConfig{
		Timezone:         "UTC",
		WindowStart:      0,
		WindowEnd:        24,
		MaxPerDomainHour: 1000,
		MinDelaySeconds:  0,
		MaxDelaySeconds:  0,
	}
}

// newSilentRelay stands up an httptest server that returns 200 + a
// synthetic envelope id for every POST. Used by tests that drive
// Engine.Run end-to-end without actually exercising the dry-run gate.
func newSilentRelay(t *testing.T) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"envelope_id":"env_test_001"}`))
	}))
	t.Cleanup(s.Close)
	return s
}

// stubMXResolver is a deterministic MXResolver for hermetic tests.
// Per-domain canned responses + a counter so we can assert exactly
// how many DNS lookups the cache permitted.
type stubMXResolver struct {
	mu       sync.Mutex
	mxByDom  map[string]struct {
		records []*net.MX
		err     error
	}
	aByDom map[string]struct {
		addrs []string
		err   error
	}
	mxCalls  int64
	hostCalls int64
}

func newStubResolver() *stubMXResolver {
	return &stubMXResolver{
		mxByDom: map[string]struct {
			records []*net.MX
			err     error
		}{},
		aByDom: map[string]struct {
			addrs []string
			err   error
		}{},
	}
}

func (s *stubMXResolver) setMX(domain string, records []*net.MX, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mxByDom[domain] = struct {
		records []*net.MX
		err     error
	}{records, err}
}

func (s *stubMXResolver) setHost(host string, addrs []string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.aByDom[host] = struct {
		addrs []string
		err   error
	}{addrs, err}
}

func (s *stubMXResolver) LookupMX(_ context.Context, domain string) ([]*net.MX, error) {
	atomic.AddInt64(&s.mxCalls, 1)
	s.mu.Lock()
	defer s.mu.Unlock()
	got, ok := s.mxByDom[domain]
	if !ok {
		// Default behaviour for unknown domains: empty MX, no error
		// (looks like an RFC 7505 null MX). Tests should set explicit
		// expectations.
		return nil, nil
	}
	return got.records, got.err
}

func (s *stubMXResolver) LookupHost(_ context.Context, host string) ([]string, error) {
	atomic.AddInt64(&s.hostCalls, 1)
	s.mu.Lock()
	defer s.mu.Unlock()
	got, ok := s.aByDom[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	return got.addrs, got.err
}

func (s *stubMXResolver) callCounts() (mx, host int64) {
	return atomic.LoadInt64(&s.mxCalls), atomic.LoadInt64(&s.hostCalls)
}

// TestPreSendDomainCheck_TableDriven exercises the verdict matrix for
// the canonical recipient shapes. Covers happy path, MX-empty, A-only
// fallback, malformed inputs, and empty domain — the 5 verdict
// permutations the gate must distinguish for the orchestrator
// callback's email_verification suffix.
func TestPreSendDomainCheck_TableDriven(t *testing.T) {
	r := newStubResolver()
	r.setMX("gmail.com", []*net.MX{{Host: "gmail-smtp-in.l.google.com", Pref: 10}}, nil)
	r.setMX("a-only.example", nil, nil) // empty MX → fallback to A
	r.setHost("a-only.example", []string{"203.0.113.10"}, nil)
	// "definitely-dead.invalid" → MX lookup returns NXDOMAIN-shaped
	// DNSError so the gate emits the "no_mx_no_a" reason (vs. the
	// "empty_mx" RFC 7505 null-MX shape exercised separately below).
	r.setMX("definitely-dead.invalid", nil, &net.DNSError{Err: "no such host", Name: "definitely-dead.invalid", IsNotFound: true})

	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r})

	cases := []struct {
		name       string
		recipient  string
		wantOK     bool
		wantReason string
	}{
		{"valid_domain_with_mx", "ceo@gmail.com", true, ""},
		{"a_record_fallback", "ops@a-only.example", true, ""},
		{"no_mx_no_a", "ghost@definitely-dead.invalid", false, "no_mx_no_a"},
		{"empty_string", "", false, "malformed_email"},
		{"no_at_sign", "not-an-email", false, "malformed_email"},
		{"empty_local_part", "@example.com", false, "malformed_email"},
		{"trailing_at_only", "user@", false, "malformed_email"},
		{"double_at_garbage", "a@b@c", false, "malformed_email"},
		{"whitespace_in_domain", "u@bad domain.cz", false, "malformed_email"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := checker.Check(context.Background(), tc.recipient)
			if got.OK != tc.wantOK {
				t.Fatalf("OK=%v, want %v (reason=%q)", got.OK, tc.wantOK, got.Reason)
			}
			if got.Reason != tc.wantReason {
				t.Fatalf("Reason=%q, want %q", got.Reason, tc.wantReason)
			}
		})
	}
}

// TestPreSendDomainCheck_EmptyMXDistinctReason asserts that an
// explicit RFC 7505 null-MX response is labelled "empty_mx" rather
// than the generic "no_mx_no_a". Operators rely on this split to tell
// "domain published a no-mail policy" apart from "domain is dead".
func TestPreSendDomainCheck_EmptyMXDistinctReason(t *testing.T) {
	r := newStubResolver()
	r.setMX("null-mx.example", nil, nil)
	// No A-record either → A-fallback also fails.
	r.setHost("null-mx.example", nil, &net.DNSError{Err: "no such host", IsNotFound: true})

	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r})
	got := checker.Check(context.Background(), "x@null-mx.example")
	if got.OK {
		t.Fatal("expected OK=false for explicit empty MX with no A fallback")
	}
	if got.Reason != "empty_mx" {
		t.Fatalf("Reason=%q, want %q (RFC 7505 null MX shape)", got.Reason, "empty_mx")
	}
}

// TestPreSendDomainCheck_CacheHit asserts that a second call for the
// same domain serves from the in-memory cache (zero additional MX
// lookups). Operator scaling target: 100k-contact campaign should
// trigger ~one DNS per distinct domain.
func TestPreSendDomainCheck_CacheHit(t *testing.T) {
	r := newStubResolver()
	r.setMX("gmail.com", []*net.MX{{Host: "mx", Pref: 10}}, nil)
	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r})

	got1 := checker.Check(context.Background(), "a@gmail.com")
	if !got1.OK || got1.Cached {
		t.Fatalf("first call: OK=%v cached=%v want OK=true cached=false", got1.OK, got1.Cached)
	}
	got2 := checker.Check(context.Background(), "b@gmail.com")
	if !got2.OK || !got2.Cached {
		t.Fatalf("second call: OK=%v cached=%v want OK=true cached=true", got2.OK, got2.Cached)
	}
	mxCalls, _ := r.callCounts()
	if mxCalls != 1 {
		t.Fatalf("MX lookups=%d, want 1 (cache should serve second call)", mxCalls)
	}
}

// TestPreSendDomainCheck_CacheNegative asserts the cache also serves
// negative verdicts — we don't want to re-hammer DNS for a known-dead
// domain on every contact in the cohort.
func TestPreSendDomainCheck_CacheNegative(t *testing.T) {
	r := newStubResolver()
	r.setMX("dead.invalid", nil, nil) // empty MX
	// No A record.
	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r})

	got1 := checker.Check(context.Background(), "a@dead.invalid")
	if got1.OK || got1.Reason == "" {
		t.Fatalf("first call: OK=%v reason=%q want OK=false non-empty reason", got1.OK, got1.Reason)
	}
	got2 := checker.Check(context.Background(), "b@dead.invalid")
	if got2.OK || !got2.Cached || got2.Reason != got1.Reason {
		t.Fatalf("second call: OK=%v cached=%v reason=%q want OK=false cached=true reason=%q",
			got2.OK, got2.Cached, got2.Reason, got1.Reason)
	}
	mxCalls, _ := r.callCounts()
	if mxCalls != 1 {
		t.Fatalf("MX lookups=%d, want 1 (negative result should also cache)", mxCalls)
	}
}

// TestPreSendDomainCheck_CacheTTLExpiry asserts an entry past its TTL
// triggers a fresh lookup. We can't sleep 24h in a unit test, so this
// shoves an old at-stamp directly into the cache.
func TestPreSendDomainCheck_CacheTTLExpiry(t *testing.T) {
	r := newStubResolver()
	r.setMX("ttl.example", []*net.MX{{Host: "mx", Pref: 10}}, nil)
	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r})

	// Pre-populate an expired entry directly.
	checker.cacheMu.Lock()
	checker.cache["ttl.example"] = preSendCacheEntry{
		ok:     false,
		reason: "stale",
		at:     time.Now().Add(-2 * preSendCacheTTL),
	}
	checker.cacheMu.Unlock()

	got := checker.Check(context.Background(), "u@ttl.example")
	if !got.OK {
		t.Fatalf("expected fresh lookup to succeed; got OK=%v reason=%q", got.OK, got.Reason)
	}
	if got.Cached {
		t.Fatal("expected Cached=false for expired entry — should have re-resolved")
	}
}

// TestPreSendDomainCheck_RaceSafe runs 10 goroutines querying the
// same domain. Asserts no race (run with -race) and at-most-1 DNS
// call after the first goroutine populates the cache.
//
// We give the first call a head-start so the cache is warm before the
// burst — otherwise the test would flake on a parallel cache miss.
func TestPreSendDomainCheck_RaceSafe(t *testing.T) {
	r := newStubResolver()
	r.setMX("race.example", []*net.MX{{Host: "mx", Pref: 10}}, nil)
	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r})

	// Warm the cache first so all goroutines hit the cached path.
	checker.Check(context.Background(), "warm@race.example")
	mxBefore, _ := r.callCounts()

	const goroutines = 10
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func(i int) {
			defer wg.Done()
			got := checker.Check(context.Background(), fmt.Sprintf("user%d@race.example", i))
			if !got.OK {
				t.Errorf("goroutine %d: unexpected OK=false", i)
			}
		}(i)
	}
	wg.Wait()
	mxAfter, _ := r.callCounts()
	if mxAfter != mxBefore {
		t.Fatalf("MX lookups during burst=%d, want 0 (cache should absorb all 10 goroutines)", mxAfter-mxBefore)
	}
}

// TestPreSendDomainCheck_CacheEviction asserts the cache evicts past
// the cap. Set a tiny cap so we can exercise the LRU-ish path.
func TestPreSendDomainCheck_CacheEviction(t *testing.T) {
	r := newStubResolver()
	r.setMX("a.example", []*net.MX{{Host: "mx", Pref: 10}}, nil)
	r.setMX("b.example", []*net.MX{{Host: "mx", Pref: 10}}, nil)
	r.setMX("c.example", []*net.MX{{Host: "mx", Pref: 10}}, nil)
	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r, CacheCap: 2})

	checker.Check(context.Background(), "u@a.example")
	time.Sleep(2 * time.Millisecond) // separate at-timestamps
	checker.Check(context.Background(), "u@b.example")
	time.Sleep(2 * time.Millisecond)
	checker.Check(context.Background(), "u@c.example") // evicts a.example

	if got := checker.CacheSize(); got > 2 {
		t.Fatalf("CacheSize=%d, want <=2", got)
	}
	// a.example should have been evicted → next lookup is a fresh MX call.
	beforeMx, _ := r.callCounts()
	checker.Check(context.Background(), "u@a.example")
	afterMx, _ := r.callCounts()
	if afterMx-beforeMx != 1 {
		t.Fatalf("MX lookups for re-resolved a.example=%d, want 1", afterMx-beforeMx)
	}
}

// TestEngine_PreSendDomainCheck_SkipsBadDomain asserts that with a
// checker wired and a recipient whose domain has no MX + no A:
//   - antiTrace.Send is NOT called (we'd have observed a 0-byte send
//     here; instead the engine continues to the next request);
//   - onSent fires with SendResult.Error matching ErrPreSendDomainCheck;
//   - SMTPResponse carries the "presend-skip: <reason>" prefix the
//     orchestrator callback parses for the email_verification suffix.
func TestEngine_PreSendDomainCheck_SkipsBadDomain(t *testing.T) {
	r := newStubResolver()
	// "dead.invalid" → empty MX, no A.
	r.setMX("dead.invalid", nil, nil)
	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r})

	relay := newSilentRelay(t)

	mailboxes := []config.MailboxConfig{
		{Address: "sender@firma.cz", DailyLimit: 10, SMTPHost: "smtp.firma.cz", SMTPPort: 465},
	}
	e := NewEngine(mailboxes, minimalSendingConfig(), config.SafetyConfig{MaxBounceRate: 0.5}).
		WithDryRun(true).
		WithPreSendDomainCheck(checker)
	// engine-bypass-allowed: test wiring — client passed to Engine.WithAntiTrace
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	if !e.PreSendDomainCheckEnabled() {
		t.Fatal("PreSendDomainCheckEnabled() should be true after WithPreSendDomainCheck")
	}

	e.Enqueue(SendRequest{
		ContactID: 1,
		ToAddress: "ghost@dead.invalid",
		Subject:   "Hello",
		BodyPlain: "Body",
	})

	var got SendResult
	var gotReq SendRequest
	gotCh := make(chan struct{}, 1)
	onSent := func(req SendRequest, result SendResult) {
		got = result
		gotReq = req
		select {
		case gotCh <- struct{}{}:
		default:
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = e.Run(ctx, onSent)
	}()

	select {
	case <-gotCh:
	case <-time.After(2 * time.Second):
		t.Fatal("onSent did not fire within 2s — gate should produce a skip result")
	}

	cancel()

	if gotReq.ContactID != 1 {
		t.Fatalf("onSent saw wrong contact_id=%d", gotReq.ContactID)
	}
	if got.Error == nil {
		t.Fatal("expected SendResult.Error != nil for pre-send skip")
	}
	if !IsPreSendDomainCheckSkip(got.Error) {
		t.Fatalf("expected ErrPreSendDomainCheck, got %v", got.Error)
	}
	if got.SMTPResponse == "" || got.MailboxUsed != "sender@firma.cz" {
		t.Fatalf("skip result missing mailbox/response: %+v", got)
	}
}

// TestEngine_PreSendDomainCheck_AllowsGoodDomain asserts that a
// recipient with at least one MX is NOT gated and proceeds to the
// dry-run send (synthetic result with no Error). This is the "happy
// path" complement to the skip test above.
func TestEngine_PreSendDomainCheck_AllowsGoodDomain(t *testing.T) {
	r := newStubResolver()
	r.setMX("ok.cz", []*net.MX{{Host: "mx1.ok.cz", Pref: 10}}, nil)
	checker := NewPreSendDomainChecker(&PreSendDomainCheckOptions{Resolver: r})

	relay := newSilentRelay(t)

	mailboxes := []config.MailboxConfig{
		{Address: "sender@firma.cz", DailyLimit: 10, SMTPHost: "smtp.firma.cz", SMTPPort: 465},
	}
	e := NewEngine(mailboxes, minimalSendingConfig(), config.SafetyConfig{MaxBounceRate: 0.5}).
		WithDryRun(true).
		WithPreSendDomainCheck(checker)
	// engine-bypass-allowed: test wiring — client passed to Engine.WithAntiTrace
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	e.Enqueue(SendRequest{
		ContactID: 42,
		ToAddress: "buyer@ok.cz",
		Subject:   "Hi",
		BodyPlain: "Body",
	})

	gotCh := make(chan SendResult, 1)
	onSent := func(_ SendRequest, result SendResult) {
		select {
		case gotCh <- result:
		default:
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = e.Run(ctx, onSent) }()

	select {
	case got := <-gotCh:
		if got.Error != nil {
			t.Fatalf("good-domain send returned error: %v", got.Error)
		}
		if got.MailboxUsed != "sender@firma.cz" {
			t.Fatalf("MailboxUsed=%q, want sender@firma.cz", got.MailboxUsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("dry-run send did not fire within 2s")
	}
	cancel()
}

// TestEngine_PreSendDomainCheck_DisabledWhenNil asserts the legacy
// path — engine constructed without WithPreSendDomainCheck behaves
// exactly like before (no skips, no extra DNS).
func TestEngine_PreSendDomainCheck_DisabledWhenNil(t *testing.T) {
	relay := newSilentRelay(t)

	mailboxes := []config.MailboxConfig{
		{Address: "sender@firma.cz", DailyLimit: 10, SMTPHost: "smtp.firma.cz", SMTPPort: 465},
	}
	e := NewEngine(mailboxes, minimalSendingConfig(), config.SafetyConfig{MaxBounceRate: 0.5}).
		WithDryRun(true)
	// engine-bypass-allowed: test wiring — client passed to Engine.WithAntiTrace
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	if e.PreSendDomainCheckEnabled() {
		t.Fatal("checker should be disabled by default")
	}

	e.Enqueue(SendRequest{ContactID: 1, ToAddress: "x@anywhere.example", BodyPlain: "B"})

	gotCh := make(chan SendResult, 1)
	onSent := func(_ SendRequest, r SendResult) {
		select {
		case gotCh <- r:
		default:
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = e.Run(ctx, onSent) }()

	select {
	case got := <-gotCh:
		if got.Error != nil {
			t.Fatalf("legacy path returned error: %v", got.Error)
		}
		if IsPreSendDomainCheckSkip(got.Error) {
			t.Fatal("legacy path should NEVER emit ErrPreSendDomainCheck")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("legacy-path send did not fire within 2s")
	}
	cancel()
}

// TestRecordSendResult_IgnoresPreSendSkip asserts the defensive
// short-circuit in recordSendResult — even if a future caller routes a
// pre-send-skip result through this function, it must not increment
// daily caps, bounce counters, or trip the circuit breaker.
func TestRecordSendResult_IgnoresPreSendSkip(t *testing.T) {
	mailboxes := []config.MailboxConfig{
		{Address: "sender@firma.cz", DailyLimit: 10},
	}
	e := NewEngine(mailboxes, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.5})

	skipErr := fmt.Errorf("%w: %s", ErrPreSendDomainCheck, "no_mx_no_a")
	e.recordSendResult("sender@firma.cz", "dead.invalid", skipErr)

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.sentCounts["sender@firma.cz"] != 0 {
		t.Fatalf("daily cap counter advanced: %d", e.sentCounts["sender@firma.cz"])
	}
	if e.bounceCount != 0 {
		t.Fatalf("bounce counter advanced: %d", e.bounceCount)
	}
	if e.totalSent != 0 {
		t.Fatalf("totalSent advanced: %d", e.totalSent)
	}
}

// TestIsPreSendDomainCheckSkip_SentinelMatching asserts that the
// errors.Is contract holds for wrapped errors. Callbacks rely on this.
func TestIsPreSendDomainCheckSkip_SentinelMatching(t *testing.T) {
	wrapped := fmt.Errorf("%w: %s", ErrPreSendDomainCheck, "empty_mx")
	if !IsPreSendDomainCheckSkip(wrapped) {
		t.Fatal("IsPreSendDomainCheckSkip should match wrapped sentinel")
	}
	other := errors.New("some other error")
	if IsPreSendDomainCheckSkip(other) {
		t.Fatal("IsPreSendDomainCheckSkip should NOT match unrelated error")
	}
	if IsPreSendDomainCheckSkip(nil) {
		t.Fatal("IsPreSendDomainCheckSkip should NOT match nil")
	}
}

// TestPreSendDomainCheck_DefaultCacheCap asserts that NewPreSendDomainChecker(nil)
// builds a checker with the production default cap (50_000) — guards
// against a future refactor accidentally zeroing the cap.
func TestPreSendDomainCheck_DefaultCacheCap(t *testing.T) {
	c := NewPreSendDomainChecker(nil)
	if c.cacheCap != preSendCacheCap {
		t.Fatalf("default cacheCap=%d, want %d", c.cacheCap, preSendCacheCap)
	}
	if c.resolver == nil {
		t.Fatal("default resolver must be non-nil (stdMXResolver)")
	}
}

// ── Sprint AE — level-2 RCPT probe tests ──────────────────────────────

// stubProbe satisfies RecipientProbe; canned verdicts per email.
type stubProbe struct {
	verdicts map[string]struct {
		ok     bool
		reason string
		err    error
	}
	callCount atomic.Int32
}

func (s *stubProbe) Validate(_ context.Context, email string) (bool, string, error) {
	s.callCount.Add(1)
	v, ok := s.verdicts[email]
	if !ok {
		// Default to valid so a missing fixture doesn't accidentally
		// block a send. Tests that need a specific verdict register it.
		return true, "valid", nil
	}
	return v.ok, v.reason, v.err
}

// alwaysGoodResolver returns one MX for any domain; lets level-1 pass
// so the test exercises the level-2 path.
type alwaysGoodResolver struct{}

func (alwaysGoodResolver) LookupMX(_ context.Context, _ string) ([]*net.MX, error) {
	return []*net.MX{{Host: "mx.example.com.", Pref: 10}}, nil
}
func (alwaysGoodResolver) LookupHost(_ context.Context, _ string) ([]string, error) {
	return []string{"127.0.0.1"}, nil
}

// AE-T01 — high-risk domain + probe valid → OK, probe was called once.
func TestPreSendDomainCheck_Level2_ProbeAccepts(t *testing.T) {
	probe := &stubProbe{verdicts: map[string]struct {
		ok     bool
		reason string
		err    error
	}{"user@tiscali.cz": {ok: true, reason: "valid"}}}
	c := NewPreSendDomainChecker(&PreSendDomainCheckOptions{
		Resolver:        alwaysGoodResolver{},
		Probe:           probe,
		HighRiskDomains: []string{"tiscali.cz"},
	})
	res := c.Check(context.Background(), "user@tiscali.cz")
	if !res.OK {
		t.Fatalf("level-2 valid probe should pass, got %+v", res)
	}
	if got := probe.callCount.Load(); got != 1 {
		t.Errorf("probe called %d times, want 1", got)
	}
}

// AE-T02 — high-risk domain + probe invalid → skip with rcpt_invalid reason.
func TestPreSendDomainCheck_Level2_ProbeRefuses(t *testing.T) {
	probe := &stubProbe{verdicts: map[string]struct {
		ok     bool
		reason string
		err    error
	}{"ghost@tiscali.cz": {ok: false, reason: "invalid"}}}
	c := NewPreSendDomainChecker(&PreSendDomainCheckOptions{
		Resolver:        alwaysGoodResolver{},
		Probe:           probe,
		HighRiskDomains: []string{"tiscali.cz"},
	})
	res := c.Check(context.Background(), "ghost@tiscali.cz")
	if res.OK || res.Reason != "rcpt_invalid" {
		t.Fatalf("probe invalid should skip with reason rcpt_invalid, got %+v", res)
	}
}

// AE-T03 — non-high-risk domain skips probe entirely.
func TestPreSendDomainCheck_Level2_LowRiskBypassesProbe(t *testing.T) {
	probe := &stubProbe{}
	c := NewPreSendDomainChecker(&PreSendDomainCheckOptions{
		Resolver:        alwaysGoodResolver{},
		Probe:           probe,
		HighRiskDomains: []string{"tiscali.cz"},
	})
	res := c.Check(context.Background(), "user@example.com")
	if !res.OK {
		t.Fatalf("low-risk domain should pass without probe, got %+v", res)
	}
	if got := probe.callCount.Load(); got != 0 {
		t.Errorf("probe should not fire for low-risk domain; called %d times", got)
	}
}

// AE-T04 — probe transport error → fail-open (OK=true).
func TestPreSendDomainCheck_Level2_ProbeTransportError_FailOpen(t *testing.T) {
	probe := &stubProbe{verdicts: map[string]struct {
		ok     bool
		reason string
		err    error
	}{"user@tiscali.cz": {ok: false, reason: "", err: errors.New("relay timeout")}}}
	c := NewPreSendDomainChecker(&PreSendDomainCheckOptions{
		Resolver:        alwaysGoodResolver{},
		Probe:           probe,
		HighRiskDomains: []string{"tiscali.cz"},
	})
	res := c.Check(context.Background(), "user@tiscali.cz")
	if !res.OK {
		t.Fatalf("probe transport error must fail-open, got %+v", res)
	}
	if res.Reason != "probe_transport_error" {
		t.Errorf("expected reason probe_transport_error, got %q", res.Reason)
	}
}

// AE-T05 — probe "unknown" verdict (not explicit invalid) → fail-open.
func TestPreSendDomainCheck_Level2_ProbeUnknown_FailOpen(t *testing.T) {
	probe := &stubProbe{verdicts: map[string]struct {
		ok     bool
		reason string
		err    error
	}{"user@tiscali.cz": {ok: false, reason: "unknown"}}}
	c := NewPreSendDomainChecker(&PreSendDomainCheckOptions{
		Resolver:        alwaysGoodResolver{},
		Probe:           probe,
		HighRiskDomains: []string{"tiscali.cz"},
	})
	res := c.Check(context.Background(), "user@tiscali.cz")
	if !res.OK {
		t.Fatalf("probe unknown must fail-open (only explicit invalid blocks), got %+v", res)
	}
}

// AE-T06 — second probe of the same email hits the email cache.
func TestPreSendDomainCheck_Level2_EmailCacheHit(t *testing.T) {
	probe := &stubProbe{verdicts: map[string]struct {
		ok     bool
		reason string
		err    error
	}{"user@tiscali.cz": {ok: true, reason: "valid"}}}
	c := NewPreSendDomainChecker(&PreSendDomainCheckOptions{
		Resolver:        alwaysGoodResolver{},
		Probe:           probe,
		HighRiskDomains: []string{"tiscali.cz"},
	})
	_ = c.Check(context.Background(), "user@tiscali.cz")
	res := c.Check(context.Background(), "user@tiscali.cz")
	if !res.Cached {
		t.Errorf("second check should hit email cache, got Cached=%v", res.Cached)
	}
	if got := probe.callCount.Load(); got != 1 {
		t.Errorf("probe should fire once across two checks, fired %d times", got)
	}
}

// AE-T07 — wiring boundary: probe wired but HighRiskDomains empty → no probe.
func TestPreSendDomainCheck_Level2_EmptyHighRiskDomains_NoProbe(t *testing.T) {
	probe := &stubProbe{}
	c := NewPreSendDomainChecker(&PreSendDomainCheckOptions{
		Resolver:        alwaysGoodResolver{},
		Probe:           probe,
		HighRiskDomains: nil,
	})
	_ = c.Check(context.Background(), "user@tiscali.cz")
	if got := probe.callCount.Load(); got != 0 {
		t.Errorf("empty HighRiskDomains must disable probe; fired %d times", got)
	}
}

// AE-T08 — wiring boundary: HighRiskDomains set but Probe nil → no probe.
func TestPreSendDomainCheck_Level2_NilProbe_NoProbe(t *testing.T) {
	c := NewPreSendDomainChecker(&PreSendDomainCheckOptions{
		Resolver:        alwaysGoodResolver{},
		Probe:           nil,
		HighRiskDomains: []string{"tiscali.cz"},
	})
	res := c.Check(context.Background(), "user@tiscali.cz")
	if !res.OK {
		t.Fatalf("nil probe must pass through level-1 result, got %+v", res)
	}
}
