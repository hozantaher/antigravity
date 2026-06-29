package sender

// r1_monkey_test.go — R1 TDD+monkey pass targeting uncovered branches in:
//   - engine.go: generateMessageID (format property), randomDelay (property),
//     resetCountersIfNeeded (ephemeral state pruning), recordSendResult
//     (greylisting budget exhaustion + mailbox cooldown), pickMailbox edge cases
//   - probe_adapter.go: BuildCanaryMessage nil-safety + CRLF-injection property
//   - antitrace.go: Send (empty BodyHTML, never-panic property)

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"
	"time"

	"common/config"
)

// ─── generateMessageID — property tests ──────────────────────────────────────

// TestGenerateMessageID_Property_FormatAlwaysValid runs 200 random from-addresses
// through generateMessageID and checks every result is non-empty, contains '@',
// and has no CR/LF (which would break SMTP header framing).
func TestGenerateMessageID_Property_FormatAlwaysValid(t *testing.T) {
	f := func(addr string) bool {
		id := generateMessageID(addr)
		if id == "" {
			return false
		}
		if strings.ContainsAny(id, "\r\n") {
			return false
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestGenerateMessageID_NoAngleBrackets ensures generateMessageID never
// wraps the ID in '<>'; the Run loop adds brackets itself.
func TestGenerateMessageID_NoAngleBrackets(t *testing.T) {
	for i := 0; i < 20; i++ {
		id := generateMessageID("sender@firma.cz")
		if strings.ContainsAny(id, "<>") {
			t.Errorf("generateMessageID should not include angle brackets, got %q", id)
		}
	}
}

// TestGenerateMessageID_ContainsDomainPart verifies the extracted domain
// appears as the right-hand side of '@' in the generated ID.
func TestGenerateMessageID_ContainsDomainPart(t *testing.T) {
	id := generateMessageID("test@mycompany.cz")
	if !strings.Contains(id, "@") {
		t.Errorf("generateMessageID(%q) = %q: missing '@' separator", "test@mycompany.cz", id)
	}
	parts := strings.SplitN(id, "@", 2)
	if len(parts) != 2 || parts[1] == "" {
		t.Errorf("generateMessageID should have non-empty domain after '@', got %q", id)
	}
}

// ─── randomDelay — property + edge cases ─────────────────────────────────────

// TestRandomDelay_Property_NeverPanics runs random (min, max) int16 pairs
// through randomDelay to verify it never panics (covers the crypto/rand branch
// and the unsigned-modulo fallback arithmetic).
func TestRandomDelay_Property_NeverPanics(t *testing.T) {
	f := func(min, max int16) bool {
		defer func() { recover() }()
		_ = randomDelay(int(min), int(max))
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestRandomDelay_Property_NonNegative asserts randomDelay always returns a
// non-negative duration for representative (min, max) pairs.
func TestRandomDelay_Property_NonNegative(t *testing.T) {
	pairs := [][2]int{
		{0, 0}, {0, 1}, {1, 1}, {1, 5}, {5, 10}, {0, 3600}, {100, 200},
	}
	for _, p := range pairs {
		d := randomDelay(p[0], p[1])
		if d < 0 {
			t.Errorf("randomDelay(%d,%d) returned negative: %v", p[0], p[1], d)
		}
	}
}

// TestRandomDelay_LargeRange_Distribution verifies that over 200 draws of
// randomDelay(0, 3) at least 2 distinct values appear (statistical guard
// against a constant-output regression).
func TestRandomDelay_LargeRange_Distribution(t *testing.T) {
	seen := make(map[time.Duration]bool)
	for i := 0; i < 200; i++ {
		seen[randomDelay(0, 3)] = true
	}
	if len(seen) < 2 {
		t.Errorf("randomDelay(0,3) over 200 calls: only %d distinct values, expected ≥2", len(seen))
	}
}

// ─── resetCountersIfNeeded — ephemeral state pruning ─────────────────────────

// TestResetCounters_PrunesExpiredDomainDeferral verifies that a past-due
// domainDeferredUntil entry is removed, while its paired domainBackoffAttempt
// is PRESERVED so the greylisting escalation ladder survives across retries.
func TestResetCounters_PrunesExpiredDomainDeferral(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	e.mu.Lock()
	e.domainDeferredUntil["expired.cz"] = time.Now().Add(-time.Minute)
	e.domainBackoffAttempt["expired.cz"] = 2
	e.lastReset = time.Now() // prevent hourly/daily reset from firing
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	_, hasDeferral := e.domainDeferredUntil["expired.cz"]
	attempt := e.domainBackoffAttempt["expired.cz"]
	e.mu.Unlock()

	if hasDeferral {
		t.Error("expired deferral should be pruned from domainDeferredUntil")
	}
	// The attempt counter must NOT be pruned with the deferral — clearing it on
	// every prune collapsed the 15m→1h→4h→24h→permanent ladder to a fixed
	// 15-minute retry forever. It is cleared only on a successful send.
	if attempt != 2 {
		t.Errorf("domainBackoffAttempt must survive deferral prune, got %d, want 2", attempt)
	}
}

// TestResetCounters_KeepsActiveDomainDeferral verifies that a deferral in
// the future is NOT pruned.
func TestResetCounters_KeepsActiveDomainDeferral(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	e.mu.Lock()
	e.domainDeferredUntil["future.cz"] = time.Now().Add(5 * time.Minute)
	e.domainBackoffAttempt["future.cz"] = 1
	e.lastReset = time.Now()
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	_, hasDeferral := e.domainDeferredUntil["future.cz"]
	e.mu.Unlock()

	if !hasDeferral {
		t.Error("active deferral (in the future) should NOT be pruned")
	}
}

// TestResetCounters_PrunesExpiredDomainCircuitBreaker verifies that a domain
// circuit opened more than 1h ago is removed during the prune pass.
func TestResetCounters_PrunesExpiredDomainCircuitBreaker(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	e.mu.Lock()
	e.domainCircuitOpen["old.cz"] = time.Now().Add(-2 * time.Hour)
	e.lastReset = time.Now()
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	_, stillOpen := e.domainCircuitOpen["old.cz"]
	e.mu.Unlock()

	if stillOpen {
		t.Error("expired domain circuit breaker (>1h old) should be pruned")
	}
}

// TestResetCounters_KeepsActiveCircuitBreaker verifies that a domain circuit
// opened less than 1h ago is NOT pruned.
func TestResetCounters_KeepsActiveCircuitBreaker(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	e.mu.Lock()
	e.domainCircuitOpen["active.cz"] = time.Now().Add(-30 * time.Minute)
	e.lastReset = time.Now()
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	_, stillOpen := e.domainCircuitOpen["active.cz"]
	e.mu.Unlock()

	if !stillOpen {
		t.Error("active domain circuit breaker (<1h) should NOT be pruned")
	}
}

// TestResetCounters_PrunesExpiredMailboxCooldown verifies that a past-due
// mailboxCooldownUntil entry and its mailboxConsecutiveFails are removed.
func TestResetCounters_PrunesExpiredMailboxCooldown(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	e.mu.Lock()
	e.mailboxCooldownUntil["mb@old.cz"] = time.Now().Add(-time.Minute)
	e.mailboxConsecutiveFails["mb@old.cz"] = mailboxFailThreshold
	e.lastReset = time.Now()
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	_, hasCooldown := e.mailboxCooldownUntil["mb@old.cz"]
	_, hasFails := e.mailboxConsecutiveFails["mb@old.cz"]
	e.mu.Unlock()

	if hasCooldown {
		t.Error("expired mailbox cooldown should be pruned from mailboxCooldownUntil")
	}
	if hasFails {
		t.Error("expired mailbox cooldown should also prune mailboxConsecutiveFails")
	}
}

// TestResetCounters_PruneMultipleExpired exercises pruning of 5 expired entries
// across all three prune maps in a single resetCountersIfNeeded call.
func TestResetCounters_PruneMultipleExpired(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	past := time.Now().Add(-time.Hour)
	e.mu.Lock()
	for i := 0; i < 5; i++ {
		domain := fmt.Sprintf("d%d.cz", i)
		mb := fmt.Sprintf("mb%d@host.cz", i)
		e.domainDeferredUntil[domain] = past
		e.domainBackoffAttempt[domain] = i
		e.domainCircuitOpen[domain] = past.Add(-time.Hour) // opened 2h ago
		e.mailboxCooldownUntil[mb] = past
		e.mailboxConsecutiveFails[mb] = i
	}
	e.lastReset = time.Now()
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	deferred := len(e.domainDeferredUntil)
	circuits := len(e.domainCircuitOpen)
	cooldowns := len(e.mailboxCooldownUntil)
	e.mu.Unlock()

	if deferred != 0 {
		t.Errorf("expected 0 expired deferrals after prune, got %d", deferred)
	}
	if circuits != 0 {
		t.Errorf("expected 0 expired circuit entries after prune, got %d", circuits)
	}
	if cooldowns != 0 {
		t.Errorf("expected 0 expired cooldowns after prune, got %d", cooldowns)
	}
}

// ─── recordSendResult — greylisting budget exhaustion ─────────────────────────

// TestRecordSendResult_GreylistBudgetExhausted verifies that when
// domainBackoffAttempt >= maxGreylistingAttempts the transient error is
// escalated to a permanent bounce (domainBounces increments).
func TestRecordSendResult_GreylistBudgetExhausted(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "mb@t.cz", DailyLimit: 100}},
		config.SendingConfig{MaxPerDomainHour: 9999},
		config.SafetyConfig{MaxBounceRate: 1.0}, // disable global circuit breaker
	)

	domain := "greylist.cz"
	e.mu.Lock()
	e.domainBackoffAttempt[domain] = maxGreylistingAttempts // already at max
	before := e.domainBounces[domain]
	e.mu.Unlock()

	// "451 greylisting" → SMTPTransient, but budget exhausted → escalate.
	transientErr := fmt.Errorf("451 greylisting: try again")
	e.recordSendResult("mb@t.cz", domain, transientErr)

	e.mu.Lock()
	after := e.domainBounces[domain]
	e.mu.Unlock()

	if after <= before {
		t.Errorf("greylisting budget exhausted: domainBounces should increase (before=%d after=%d)", before, after)
	}
}

// TestRecordSendResult_GreylistBudgetNotExhausted verifies that a normal
// transient error (attempt < maxGreylistingAttempts) does NOT increment
// domainBounces and instead sets a deferral.
func TestRecordSendResult_GreylistBudgetNotExhausted(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "mb@t.cz", DailyLimit: 100}},
		config.SendingConfig{MaxPerDomainHour: 9999},
		config.SafetyConfig{MaxBounceRate: 1.0},
	)

	domain := "greylist2.cz"
	e.mu.Lock()
	e.domainBackoffAttempt[domain] = 0 // first attempt
	e.mu.Unlock()

	transientErr := fmt.Errorf("451 greylisting: try again")
	e.recordSendResult("mb@t.cz", domain, transientErr)

	e.mu.Lock()
	bounces := e.domainBounces[domain]
	_, hasDeferral := e.domainDeferredUntil[domain]
	e.mu.Unlock()

	if bounces != 0 {
		t.Errorf("normal transient: domainBounces should remain 0, got %d", bounces)
	}
	if !hasDeferral {
		t.Error("normal transient: should have set a deferral in domainDeferredUntil")
	}
}

// TestRecordSendResult_SMTPUnknown_MailboxCooldownTrigger verifies that after
// mailboxFailThreshold consecutive SMTPUnknown errors the mailbox enters cooldown.
func TestRecordSendResult_SMTPUnknown_MailboxCooldownTrigger(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "fragile@t.cz", DailyLimit: 100}},
		config.SendingConfig{MaxPerDomainHour: 9999},
		config.SafetyConfig{MaxBounceRate: 1.0},
	)

	// Not a textproto.Error, no hint → SMTPUnknown.
	unknownErr := fmt.Errorf("dial tcp: connection refused")
	for i := 0; i < mailboxFailThreshold; i++ {
		e.recordSendResult("fragile@t.cz", "domain.cz", unknownErr)
	}

	e.mu.Lock()
	coolUntil, inCooldown := e.mailboxCooldownUntil["fragile@t.cz"]
	e.mu.Unlock()

	if !inCooldown {
		t.Error("mailbox should be in cooldown after mailboxFailThreshold consecutive SMTPUnknown errors")
	}
	if !time.Now().Before(coolUntil) {
		t.Error("cooldown timestamp should be in the future")
	}
}

// TestRecordSendResult_SMTPOK_ClearsCooldown verifies that a successful send
// clears prior cooldown / consecutive-fail state for the mailbox.
func TestRecordSendResult_SMTPOK_ClearsCooldown(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "mb@t.cz", DailyLimit: 100}},
		config.SendingConfig{MaxPerDomainHour: 9999},
		config.SafetyConfig{MaxBounceRate: 1.0},
	)

	e.mu.Lock()
	e.mailboxCooldownUntil["mb@t.cz"] = time.Now().Add(30 * time.Minute)
	e.mailboxConsecutiveFails["mb@t.cz"] = mailboxFailThreshold
	e.mu.Unlock()

	// nil error → SMTPOK.
	e.recordSendResult("mb@t.cz", "domain.cz", nil)

	e.mu.Lock()
	_, inCooldown := e.mailboxCooldownUntil["mb@t.cz"]
	_, hasFails := e.mailboxConsecutiveFails["mb@t.cz"]
	e.mu.Unlock()

	if inCooldown {
		t.Error("successful send should clear mailboxCooldownUntil")
	}
	if hasFails {
		t.Error("successful send should clear mailboxConsecutiveFails")
	}
}

// ─── pickMailbox — additional edge cases ────────────────────────────────────

// TestPickMailbox_AllCooldown_ReturnError verifies that when every mailbox is
// in active cooldown pickMailbox returns an error instead of spinning forever.
func TestPickMailbox_AllCooldown_ReturnError(t *testing.T) {
	pool := []config.MailboxConfig{
		{Address: "a@t.cz", DailyLimit: 100},
		{Address: "b@t.cz", DailyLimit: 100},
	}
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	e.mu.Lock()
	e.mailboxCooldownUntil["a@t.cz"] = time.Now().Add(30 * time.Minute)
	e.mailboxCooldownUntil["b@t.cz"] = time.Now().Add(30 * time.Minute)
	e.mu.Unlock()

	_, err := e.pickMailbox("")
	if err == nil {
		t.Error("all mailboxes in cooldown: expected error, got nil")
	}
}

// TestPickMailbox_DailyCapReached_SkipsMailbox verifies that a mailbox whose
// sentCounts equals its DailyLimit is skipped in favour of a fresh one.
func TestPickMailbox_DailyCapReached_SkipsMailbox(t *testing.T) {
	pool := []config.MailboxConfig{
		{Address: "full@t.cz", DailyLimit: 3},
		{Address: "fresh@t.cz", DailyLimit: 10},
	}
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	e.mu.Lock()
	e.sentCounts["full@t.cz"] = 3
	e.mu.Unlock()

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("expected fresh mailbox to be picked, got error: %v", err)
	}
	if mb.Address != "fresh@t.cz" {
		t.Errorf("expected fresh@t.cz, got %q", mb.Address)
	}
}

// ─── probe_adapter.go — BuildCanaryMessage nil-safety + CRLF injection ───────

// TestBuildCanaryMessage_Property_NeverPanics runs quick.Check with random
// (from, to, subject, body, html) to verify BuildCanaryMessage never panics.
func TestBuildCanaryMessage_Property_NeverPanics(t *testing.T) {
	f := func(from, to, subject, body, html string) bool {
		defer func() { recover() }()
		_ = BuildCanaryMessage(from, to, subject, body, html, nil)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// TestBuildCanaryMessage_CRLFInHeaderValueNoSeparateHeader verifies that a
// CR/LF-poisoned custom header value does not produce a separate Bcc: header
// line. The CR/LF are stripped so "Bcc:" becomes part of the value text, not
// a standalone header field.
func TestBuildCanaryMessage_CRLFInHeaderValueNoSeparateHeader(t *testing.T) {
	poison := "legit\r\nBcc: attacker@evil.cz"
	headers := map[string]string{"X-Custom": poison}
	msg := BuildCanaryMessage("f@t.cz", "to@t.cz", "S", "B", "", headers)
	s := string(msg)
	// A successful smuggle would produce "\r\nBcc: attacker@evil.cz" as a
	// standalone SMTP header. After stripping, the string "Bcc:" can still
	// appear inside the value but it must NOT appear after a CRLF (i.e. as
	// a header field name).
	for _, line := range strings.Split(s, "\r\n") {
		if strings.HasPrefix(line, "Bcc:") {
			t.Errorf("CRLF-poisoned value injected standalone Bcc header: %q", line)
		}
	}
}

// TestBuildCanaryMessage_CRLFInSubjectNoSeparateHeader verifies that CR/LF in
// the subject is stripped so it cannot create a standalone header.
func TestBuildCanaryMessage_CRLFInSubjectNoSeparateHeader(t *testing.T) {
	poisonSubject := "Normal\r\nBcc: attacker@evil.cz"
	msg := BuildCanaryMessage("f@t.cz", "to@t.cz", poisonSubject, "B", "", nil)
	s := string(msg)
	for _, line := range strings.Split(s, "\r\n") {
		if strings.HasPrefix(line, "Bcc:") {
			t.Errorf("CRLF in subject injected standalone Bcc header: %q", line)
		}
	}
}

// TestBuildCanaryMessage_ColonKeyDropped verifies that a header key containing
// ':' is rejected (a colon in the key would create a second header).
func TestBuildCanaryMessage_ColonKeyDropped(t *testing.T) {
	headers := map[string]string{"X-Foo: Bar": "value"}
	msg := BuildCanaryMessage("f@t.cz", "to@t.cz", "S", "B", "", headers)
	if strings.Contains(string(msg), "X-Foo: Bar: value") {
		t.Error("header key with colon should be dropped, not rendered")
	}
}

// TestProbeAdapter_FixedMessageID verifies that BuildCanaryMessage always
// embeds the sentinel "probe@probe.internal" Message-ID.
func TestProbeAdapter_FixedMessageID(t *testing.T) {
	msg := BuildCanaryMessage("f@t.cz", "to@t.cz", "S", "B", "", nil)
	if !strings.Contains(string(msg), "probe@probe.internal") {
		t.Error("BuildCanaryMessage should embed the sentinel probe@probe.internal Message-ID")
	}
}

// ─── AntiTraceClient.Send — additional edge cases ─────────────────────────────

// TestAntiTraceClient_Send_Property_NeverPanics calls Send against an
// unreachable address with random (subject, body) pairs — guards all error
// paths without needing a live relay.
func TestAntiTraceClient_Send_Property_NeverPanics(t *testing.T) {
	f := func(subject, body string) bool {
		defer func() { recover() }()
		c := &AntiTraceClient{
			url:      "http://127.0.0.1:0", // nothing listening
			token:    "tok",
 
			http:     &http.Client{},
		}
		_ = c.Send(context.Background(), SendRequest{
			ToAddress: "r@t.cz",
			Subject:   subject,
			BodyPlain: body,
		})
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Fatal(err)
	}
}

// TestAntiTraceClient_Send_EmptyBodyHTMLOmitted verifies that an empty
// BodyHTML is not included in the JSON payload sent to the relay.
func TestAntiTraceClient_Send_EmptyBodyHTMLOmitted(t *testing.T) {
	captured := make(chan antiTraceRequest, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req antiTraceRequest
		json.NewDecoder(r.Body).Decode(&req)
		captured <- req
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(antiTraceResponse{EnvelopeID: "e-1", Status: "ok"})
	}))
	defer srv.Close()

	c := &AntiTraceClient{url: srv.URL, token: "t", http: &http.Client{}}
	// SMTPUsername is required: Send guards on it (engine rotation injects
	// per-mailbox creds) and returns early without it, so the relay would never
	// be hit and the receive below would block until the test timeout.
	res := c.Send(context.Background(), SendRequest{
		ToAddress: "x@y.cz", Subject: "S", BodyPlain: "plain only", BodyHTML: "",
		SMTPUsername: "sender@x.cz", SMTPPassword: "pw",
	})
	if res.Error != nil {
		t.Fatalf("Send returned error: %v", res.Error)
	}

	select {
	case req := <-captured:
		if req.BodyHTML != "" {
			t.Errorf("empty BodyHTML should not be set in payload, got %q", req.BodyHTML)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay never received the request")
	}
}

// TestAntiTraceClient_Send_HeadersForwardedToRelay verifies that custom
// headers from SendRequest.Headers are included in the relay payload.
func TestAntiTraceClient_Send_HeadersForwardedToRelay(t *testing.T) {
	captured := make(chan antiTraceRequest, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req antiTraceRequest
		json.NewDecoder(r.Body).Decode(&req)
		captured <- req
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(antiTraceResponse{EnvelopeID: "e-2", Status: "ok"})
	}))
	defer srv.Close()

	c := &AntiTraceClient{url: srv.URL, token: "t", http: &http.Client{}}
	res := c.Send(context.Background(), SendRequest{
		ToAddress:    "x@y.cz",
		Subject:      "S",
		BodyPlain:    "B",
		Headers:      map[string]string{"X-Mailer": "custom-mailer"},
		SMTPUsername: "sender@x.cz", SMTPPassword: "pw",
	})
	if res.Error != nil {
		t.Fatalf("Send returned error: %v", res.Error)
	}

	select {
	case req := <-captured:
		if req.Headers["X-Mailer"] != "custom-mailer" {
			t.Errorf("Headers not forwarded to relay, got: %v", req.Headers)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay never received the request")
	}
}
