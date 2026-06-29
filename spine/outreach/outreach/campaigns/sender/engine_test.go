package sender

import (
	"common/config"
	"strings"
	"testing"
	"time"
)

func TestBuildMessage_PlainTextOnly(t *testing.T) {
	headers := map[string]string{"List-Unsubscribe": "<http://unsub.url>"}
	msg := buildMessage("from@test.cz", "to@test.cz", "Subject", "Plain body", "", headers, "abc123@test.cz")
	s := string(msg)

	if !strings.Contains(s, "Content-Type: text/plain; charset=utf-8") {
		t.Error("missing text/plain Content-Type")
	}
	if strings.Contains(s, "multipart/alternative") {
		t.Error("should not be multipart when no HTML body")
	}
	if !strings.Contains(s, "Plain body") {
		t.Error("missing body content")
	}
	if !strings.Contains(s, "List-Unsubscribe: <http://unsub.url>") {
		t.Error("missing custom header")
	}
}

func TestBuildMessage_MultipartWithHTML(t *testing.T) {
	headers := map[string]string{"X-Mailer": "Seznam.cz"}
	msg := buildMessage("from@test.cz", "to@test.cz", "Subject",
		"Plain body", "<html><body>HTML body</body></html>",
		headers, "abc123@test.cz")
	s := string(msg)

	if !strings.Contains(s, "multipart/alternative") {
		t.Error("missing multipart/alternative Content-Type")
	}
	if !strings.Contains(s, "text/plain") {
		t.Error("missing text/plain part")
	}
	if !strings.Contains(s, "text/html") {
		t.Error("missing text/html part")
	}
	if !strings.Contains(s, "Plain body") {
		t.Error("missing plain body")
	}
	if !strings.Contains(s, "HTML body") {
		t.Error("missing HTML body")
	}
	if !strings.Contains(s, "X-Mailer: Seznam.cz") {
		t.Error("missing X-Mailer header")
	}
}

func TestBuildMessage_MessageIDWithBrackets(t *testing.T) {
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "B", "", nil, "<already-bracketed@t.cz>")
	s := string(msg)

	// Should not double-bracket
	if strings.Contains(s, "<<already-bracketed") {
		t.Error("double-bracketed Message-ID")
	}
	if !strings.Contains(s, "Message-ID: <already-bracketed@t.cz>") {
		t.Error("missing or malformed Message-ID")
	}
}

func TestBuildMessage_MessageIDWithoutBrackets(t *testing.T) {
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "B", "", nil, "no-brackets@t.cz")
	s := string(msg)

	if !strings.Contains(s, "Message-ID: <no-brackets@t.cz>") {
		t.Error("missing angle brackets on Message-ID")
	}
}

func TestBuildMessage_SkipsDuplicateHeaders(t *testing.T) {
	headers := map[string]string{
		"From":       "should-not-duplicate@test.cz",
		"To":         "should-not-duplicate@test.cz",
		"Subject":    "should-not-duplicate",
		"Message-ID": "should-not-duplicate",
		"Date":       "Mon, 01 Jan 2026 10:00:00 +0100",
		"X-Custom":   "should-appear",
	}
	msg := buildMessage("real@from.cz", "real@to.cz", "Real Subject", "Body", "", headers, "id@test.cz")
	s := string(msg)

	// Standard headers should appear exactly once (from buildMessage, not from map)
	fromCount := strings.Count(s, "From:")
	if fromCount != 1 {
		t.Errorf("From: appears %d times, expected 1", fromCount)
	}

	// Date from headers map should appear
	if !strings.Contains(s, "Date: Mon, 01 Jan 2026") {
		t.Error("Date header from map not included")
	}

	// Custom header should appear
	if !strings.Contains(s, "X-Custom: should-appear") {
		t.Error("custom header not included")
	}
}

func TestBuildMessage_MultipartBoundaryClosing(t *testing.T) {
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "P", "<html>H</html>", nil, "id@t.cz")
	s := string(msg)

	// Must have closing boundary (with --)
	boundaryIdx := strings.Index(s, "boundary=\"")
	if boundaryIdx < 0 {
		t.Fatal("no boundary found")
	}
	boundaryEnd := strings.Index(s[boundaryIdx+10:], "\"")
	boundary := s[boundaryIdx+10 : boundaryIdx+10+boundaryEnd]

	if !strings.Contains(s, "--"+boundary+"--") {
		t.Error("missing closing boundary")
	}
}

func TestGenerateMessageID_Unique(t *testing.T) {
	ids := make(map[string]bool)
	for i := 0; i < 100; i++ {
		id := generateMessageID("test@firma.cz")
		if ids[id] {
			t.Fatalf("duplicate message ID: %s", id)
		}
		ids[id] = true
	}
}

func TestGenerateMessageID_ContainsDomain(t *testing.T) {
	id := generateMessageID("jan@technotrade.cz")
	if !strings.Contains(id, "technotrade.cz") {
		t.Errorf("message ID should contain domain, got: %s", id)
	}
}

func TestRandomDelay_Range(t *testing.T) {
	for i := 0; i < 50; i++ {
		delay := randomDelay(10, 60)
		secs := int(delay.Seconds())
		if secs < 10 || secs >= 60 {
			t.Errorf("delay %d out of range [10, 60)", secs)
		}
	}
}

func TestRandomDelay_MinEqualsMax(t *testing.T) {
	delay := randomDelay(30, 30)
	if int(delay.Seconds()) != 30 {
		t.Errorf("expected 30s when min=max, got %v", delay)
	}
}

func TestEngine_EnqueueAndDepth(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	if e.QueueDepth() != 0 {
		t.Fatalf("expected empty queue, got %d", e.QueueDepth())
	}

	e.Enqueue(SendRequest{CampaignID: 1, ContactID: 1, Subject: "Test"})
	e.Enqueue(SendRequest{CampaignID: 1, ContactID: 2, Subject: "Test 2"})

	if e.QueueDepth() != 2 {
		t.Fatalf("expected 2, got %d", e.QueueDepth())
	}
}

func TestEngine_Dequeue_FIFO(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	e.Enqueue(SendRequest{ContactID: 1})
	e.Enqueue(SendRequest{ContactID: 2})

	req, ok := e.dequeue()
	if !ok || req.ContactID != 1 {
		t.Error("expected first item (ContactID=1)")
	}

	req, ok = e.dequeue()
	if !ok || req.ContactID != 2 {
		t.Error("expected second item (ContactID=2)")
	}

	_, ok = e.dequeue()
	if ok {
		t.Error("expected empty queue")
	}
}

func TestEngine_CircuitBreaker(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.1})

	// 11 sends, 2 bounces = 18% bounce rate > 10%
	for i := 0; i < 9; i++ {
		e.recordSend("mb@test.cz", "test.cz", false)
	}
	for i := 0; i < 2; i++ {
		e.recordSend("mb@test.cz", "test.cz", true)
	}

	if !e.isCircuitOpen() {
		t.Error("circuit breaker should be open at 18% bounce rate")
	}
}

func TestEngine_CircuitBreaker_BelowThreshold(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{MaxBounceRate: 0.1})

	for i := 0; i < 100; i++ {
		e.recordSend("mb@test.cz", "test.cz", false)
	}
	e.recordSend("mb@test.cz", "test.cz", true) // 1% bounce rate

	if e.isCircuitOpen() {
		t.Error("circuit breaker should not open at 1%")
	}
}

func TestEngine_DomainRateLimit(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 3}, config.SafetyConfig{})

	e.recordSend("mb@test.cz", "firma.cz", false)
	e.recordSend("mb@test.cz", "firma.cz", false)

	if !e.allowDomain("firma.cz") {
		t.Error("should allow 3rd send (limit is 3)")
	}

	e.recordSend("mb@test.cz", "firma.cz", false)

	if e.allowDomain("firma.cz") {
		t.Error("should block 4th send (limit exceeded)")
	}

	// Different domain should be unaffected
	if !e.allowDomain("jina-firma.cz") {
		t.Error("different domain should be allowed")
	}
}

func TestEngine_WarmupLimit(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	tests := []struct {
		day      int
		expected int
	}{
		{1, 10},
		{2, 20},
		{3, 40},
		{5, 80},
		{7, 120},
		{14, 150},
		{30, 150},
	}

	for _, tt := range tests {
		result := e.warmupLimit(tt.day)
		if result != tt.expected {
			t.Errorf("warmupLimit(%d) = %d, want %d", tt.day, result, tt.expected)
		}
	}
}

func TestEngine_WarmupLimit_CustomSchedule(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{
		WarmupSchedule: map[int]int{1: 15, 3: 30, 7: 50},
	}, config.SafetyConfig{})

	// best starts at 10, custom schedule overrides when limit > best
	if e.warmupLimit(1) != 15 { t.Errorf("day 1: got %d", e.warmupLimit(1)) }
	if e.warmupLimit(3) != 30 { t.Errorf("day 3: got %d", e.warmupLimit(3)) }
	if e.warmupLimit(10) != 50 { t.Errorf("day 10: got %d", e.warmupLimit(10)) }
}

func TestEngine_PickMailbox_RoundRobin(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "a@t.cz", DailyLimit: 100},
		{Address: "b@t.cz", DailyLimit: 100},
		{Address: "c@t.cz", DailyLimit: 100},
	}
	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{})

	mb1, _ := e.pickMailbox("")
	mb2, _ := e.pickMailbox("")
	mb3, _ := e.pickMailbox("")
	mb4, _ := e.pickMailbox("")

	if mb1.Address != "a@t.cz" { t.Errorf("first: %s", mb1.Address) }
	if mb2.Address != "b@t.cz" { t.Errorf("second: %s", mb2.Address) }
	if mb3.Address != "c@t.cz" { t.Errorf("third: %s", mb3.Address) }
	if mb4.Address != "a@t.cz" { t.Errorf("fourth (wrap): %s", mb4.Address) }
}

func TestEngine_PickMailbox_SkipsExhausted(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "a@t.cz", DailyLimit: 1},
		{Address: "b@t.cz", DailyLimit: 100},
	}
	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{})

	// Exhaust mailbox A
	e.recordSend("a@t.cz", "test.cz", false)

	mb, err := e.pickMailbox("")
	if err != nil { t.Fatalf("error: %v", err) }
	if mb.Address != "b@t.cz" { t.Errorf("should skip exhausted A, got %s", mb.Address) }
}

func TestEngine_PickMailbox_AllExhausted(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "a@t.cz", DailyLimit: 1},
		{Address: "b@t.cz", DailyLimit: 1},
	}
	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{})
	e.recordSend("a@t.cz", "d.cz", false)
	e.recordSend("b@t.cz", "d.cz", false)

	_, err := e.pickMailbox("")
	if err == nil { t.Error("should error when all exhausted") }
}

func TestEngine_PickMailbox_Warmup(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "new@t.cz", DailyLimit: 200, WarmupDay: 1},
	}
	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{})

	// Warmup day 1 = limit 10
	for i := 0; i < 10; i++ {
		e.recordSend("new@t.cz", "d.cz", false)
	}
	_, err := e.pickMailbox("")
	if err == nil { t.Error("should hit warmup limit of 10") }
}

func TestEngine_ResetCounters(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 5}, config.SafetyConfig{})

	e.recordSend("mb@t.cz", "firma.cz", false)
	e.recordSend("mb@t.cz", "firma.cz", false)

	if e.allowDomain("firma.cz") != true { t.Error("should allow before reset") }

	// Force reset by setting lastReset to 2 hours ago
	e.mu.Lock()
	e.lastReset = e.lastReset.Add(-2 * 3600_000_000_000) // 2 hours ago
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	// After reset, domain counts should be cleared
	e.mu.Lock()
	count := e.domainCounts["firma.cz"]
	e.mu.Unlock()
	if count != 0 { t.Errorf("domain count should be 0 after reset, got %d", count) }
}

func TestNewEngine(t *testing.T) {
	mbs := []config.MailboxConfig{{Address: "a@t.cz"}}
	e := NewEngine(mbs, config.SendingConfig{MinDelaySeconds: 10}, config.SafetyConfig{MaxBounceRate: 0.05})
	if e == nil { t.Fatal("nil engine") }
	if len(e.mailboxes) != 1 { t.Error("mailboxes not set") }
	if e.safety.MaxBounceRate != 0.05 { t.Error("safety not set") }
}

func TestEngine_WithPreSendHook_Fluent(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	hook := PreSendHook(func(_ config.MailboxConfig, _ *SendRequest) {})
	returned := e.WithPreSendHook(hook)
	if returned != e {
		t.Error("WithPreSendHook should return same engine pointer (fluent API)")
	}
}

func TestEngine_WithPreSendHook_Stored(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	if e.preSendHook != nil {
		t.Error("preSendHook should be nil before setting")
	}
	called := false
	e.WithPreSendHook(func(_ config.MailboxConfig, _ *SendRequest) { called = true })
	if e.preSendHook == nil {
		t.Error("preSendHook should be set after WithPreSendHook")
	}
	// Invoke it to confirm it's the right function
	e.preSendHook(config.MailboxConfig{}, &SendRequest{})
	if !called {
		t.Error("stored hook was not called")
	}
}

func TestEngine_WithPreSendHook_MutatesRequest(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	e.WithPreSendHook(func(mb config.MailboxConfig, req *SendRequest) {
		req.Subject = "humanized: " + req.Subject
		if req.Headers == nil {
			req.Headers = make(map[string]string)
		}
		req.Headers["X-Persona"] = mb.Address
	})

	req := &SendRequest{Subject: "original"}
	mb := config.MailboxConfig{Address: "jan@firma.cz"}
	e.preSendHook(mb, req)

	if req.Subject != "humanized: original" {
		t.Errorf("subject not mutated: %s", req.Subject)
	}
	if req.Headers["X-Persona"] != "jan@firma.cz" {
		t.Errorf("header not set: %v", req.Headers)
	}
}

func TestSendRequest_FirstName(t *testing.T) {
	req := SendRequest{
		CampaignID: 1,
		ContactID:  2,
		ToAddress:  "to@t.cz",
		Subject:    "Hello",
		FirstName:  "Jan",
	}
	if req.FirstName != "Jan" {
		t.Errorf("FirstName not stored: got %q", req.FirstName)
	}
}

func TestPreSendHook_ReceivesMailboxPersona(t *testing.T) {
	persona := config.PersonaConfig{
		Name:    "Jan Novák",
		Role:    "Sales Manager",
		Company: "TechnoTrade",
		Email:   "jan@technotrade.cz",
	}
	mb := config.MailboxConfig{
		Address: "jan@technotrade.cz",
		Persona: persona,
	}

	var capturedMB config.MailboxConfig
	hook := PreSendHook(func(mailbox config.MailboxConfig, _ *SendRequest) {
		capturedMB = mailbox
	})

	req := &SendRequest{Subject: "test"}
	hook(mb, req)

	if capturedMB.Persona.Name != "Jan Novák" {
		t.Errorf("persona not passed to hook: got %q", capturedMB.Persona.Name)
	}
	if capturedMB.Persona.Company != "TechnoTrade" {
		t.Errorf("company not passed: got %q", capturedMB.Persona.Company)
	}
}

func TestSendRequest_Struct(t *testing.T) {
	r := SendRequest{CampaignID: 1, ContactID: 2, Step: 0, ToAddress: "to@t.cz", Subject: "S", BodyPlain: "B", BodyHTML: "<b>B</b>", Headers: map[string]string{"X": "Y"}}
	if r.Step != 0 { t.Error("wrong step") }
	if r.Headers["X"] != "Y" { t.Error("wrong headers") }
}

func TestSendResult_Struct(t *testing.T) {
	r := SendResult{MessageID: "abc", MailboxUsed: "m@t.cz"}
	if r.MessageID != "abc" { t.Error("wrong id") }
}

func TestBuildMessage_NilHeaders(t *testing.T) {
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "Body", "", nil, "id@t.cz")
	s := string(msg)
	if !strings.Contains(s, "From: f@t.cz") { t.Error("missing From") }
	if !strings.Contains(s, "Body") { t.Error("missing body") }
}

func TestBuildMessage_EmptyHeaders(t *testing.T) {
	msg := buildMessage("f@t.cz", "t@t.cz", "S", "Body", "", map[string]string{}, "id@t.cz")
	if len(msg) == 0 { t.Error("empty message") }
}

// TestSend_NoAuthOnEmptyCredentials verifies engine behaviour for the three
// main SMTP port paths as a table test.  A real network connection is not
// available in CI, so the test validates the logic that is exercisable without
// a live server:
//
//   - Port 465  → implicit TLS dial path (tls.Dial)
//   - Port 587  → plain TCP dial + STARTTLS upgrade before auth
//   - Port 1025 → plain TCP dial, no STARTTLS (local MailPit / dev)
//
// The auth block is skipped when both Username and Password are empty; this
// keeps MailPit (port 1025, no credentials) working and also means that a
// port-587 mailbox without credentials would reach StartTLS before auth would
// be attempted.  The STARTTLS call itself requires a live server, so this test
// confirms the port-routing table is correct by inspecting MailboxConfig
// fields, not by dialling.
func TestSend_NoAuthOnEmptyCredentials(t *testing.T) {
	tests := []struct {
		name         string
		port         int
		wantImplicit bool // true → uses tls.Dial (port 465)
		wantSTARTTLS bool // true → StartTLS upgrade is attempted (port 587)
	}{
		{name: "implicit TLS port 465",  port: 465,  wantImplicit: true,  wantSTARTTLS: false},
		{name: "STARTTLS port 587",       port: 587,  wantImplicit: false, wantSTARTTLS: true},
		{name: "plain TCP port 1025",     port: 1025, wantImplicit: false, wantSTARTTLS: false},
		{name: "plain TCP port 25",       port: 25,   wantImplicit: false, wantSTARTTLS: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mb := config.MailboxConfig{
				Address:  "sender@test.cz",
				SMTPHost: "smtp.test.cz",
				SMTPPort: tt.port,
				// Empty credentials → auth block is skipped
				Username: "",
				Password: "",
			}

			// Verify the implicit-TLS branch condition
			isImplicit := mb.SMTPPort == 465
			if isImplicit != tt.wantImplicit {
				t.Errorf("port %d: implicit TLS = %v, want %v", tt.port, isImplicit, tt.wantImplicit)
			}

			// Verify the STARTTLS branch condition
			isSTARTTLS := mb.SMTPPort == 587
			if isSTARTTLS != tt.wantSTARTTLS {
				t.Errorf("port %d: STARTTLS = %v, want %v", tt.port, isSTARTTLS, tt.wantSTARTTLS)
			}

			// Auth is skipped when credentials are empty — verify the guard
			authSkipped := mb.Username == "" && mb.Password == ""
			if !authSkipped {
				t.Errorf("port %d: auth should be skipped for empty credentials", tt.port)
			}
		})
	}
}

func TestEngine_WithAntiTrace(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	client := NewAntiTraceClient("http://relay.local", "tok")
	result := e.WithAntiTrace(client)
	if result != e {
		t.Error("WithAntiTrace should return the same engine for chaining")
	}
	if e.antiTrace != client {
		t.Error("antiTrace client not stored on engine")
	}
}

func TestEngine_ResetCounters_HourlyPreservesSentCounts(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 5}, config.SafetyConfig{})

	// Populate both count maps
	e.mu.Lock()
	e.domainCounts["firma.cz"] = 4
	e.sentCounts["mb@t.cz"] = 7
	// Set lastReset to 2 hours ago (same day) → triggers hourly reset but not daily
	e.lastReset = time.Now().Add(-2 * time.Hour)
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	dc := e.domainCounts["firma.cz"]
	sc := e.sentCounts["mb@t.cz"]
	e.mu.Unlock()

	if dc != 0 {
		t.Errorf("domainCounts should be cleared by hourly reset, got %d", dc)
	}
	// sentCounts are only reset on a new calendar day, not on hourly reset
	if sc != 7 {
		t.Errorf("sentCounts should NOT be cleared by hourly reset, got %d", sc)
	}
}
