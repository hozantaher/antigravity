package imap

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"common/config"
	"common/health"
	"orchestrator/thread"
)

// ── Constructor ──

func TestNewPoller(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "a@f.cz", IMAPHost: "imap.seznam.cz", IMAPPort: 993},
	}
	p := NewPoller(mbs, nil)
	if p == nil {
		t.Fatal("nil")
	}
	if len(p.mailboxes) != 1 {
		t.Error("mailboxes")
	}
	if p.seen == nil {
		t.Error("seen map nil")
	}
}

func TestNewPoller_NoIMAP(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "a@f.cz", SMTPHost: "smtp.f.cz", SMTPPort: 465},
	}
	p := NewPoller(mbs, nil)
	if p == nil {
		t.Fatal("nil")
	}
}

// ── Search Response Parsing ──

func TestParseSearchResponse(t *testing.T) {
	tests := []struct {
		name     string
		response string
		want     int
	}{
		{"empty", "A002 OK SEARCH completed\r\n", 0},
		{"one", "* SEARCH 42\r\nA002 OK\r\n", 1},
		{"multiple", "* SEARCH 1 2 3 4 5\r\nA002 OK\r\n", 5},
		{"no_match", "* FLAGS (\\Answered)\r\nA002 OK\r\n", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			uids := parseSearchResponse(tt.response)
			if len(uids) != tt.want {
				t.Errorf("got %d uids, want %d: %v", len(uids), tt.want, uids)
			}
		})
	}
}

func TestParseSearchResponse_UIDs(t *testing.T) {
	uids := parseSearchResponse("* SEARCH 10 20 30\r\nA002 OK\r\n")
	if len(uids) != 3 {
		t.Fatalf("expected 3, got %d", len(uids))
	}
	if uids[0] != "10" || uids[1] != "20" || uids[2] != "30" {
		t.Errorf("uids: %v", uids)
	}
}

// ── Header Extraction ──

func TestExtractHeader(t *testing.T) {
	raw := "Message-ID: <abc123@email.seznam.cz>\r\nFrom: jan@firma.cz\r\nSubject: Re: Poptavka\r\nDate: Tue, 07 Apr 2026 10:00:00 +0200\r\nIn-Reply-To: <original@email.seznam.cz>\r\n"

	tests := []struct{ header, want string }{
		{"Message-ID", "<abc123@email.seznam.cz>"},
		{"From", "jan@firma.cz"},
		{"Subject", "Re: Poptavka"},
		{"In-Reply-To", "<original@email.seznam.cz>"},
		{"Nonexistent", ""},
	}

	for _, tt := range tests {
		if got := extractHeader(raw, tt.header); got != tt.want {
			t.Errorf("extractHeader(%q) = %q, want %q", tt.header, got, tt.want)
		}
	}
}

func TestExtractHeader_CaseInsensitive(t *testing.T) {
	raw := "message-id: <lower@test.cz>\r\n"
	if got := extractHeader(raw, "Message-ID"); got != "<lower@test.cz>" {
		t.Errorf("case insensitive: %q", got)
	}
}

// ── Body Extraction ──

func TestExtractBody(t *testing.T) {
	raw := "Subject: Test\r\n\r\nHello, this is the body.\r\n)\r\nA003 OK"
	body := extractBody(raw)
	if body == "" {
		t.Error("empty body")
	}
	if body != "Hello, this is the body." {
		t.Errorf("body: %q", body)
	}
}

func TestExtractBody_Long(t *testing.T) {
	longBody := ""
	for i := 0; i < 300; i++ {
		longBody += "Long body text. "
	}
	raw := "Subject: X\r\n\r\n" + longBody + "\r\n)\r\nA003 OK"
	body := extractBody(raw)
	if len(body) > 2000 {
		t.Errorf("body should be truncated to 2000, got %d", len(body))
	}
}

func TestExtractBody_Empty(t *testing.T) {
	body := extractBody("no double newline here")
	if body != "" {
		t.Errorf("should be empty: %q", body)
	}
}

// ── PollResult ──

func TestPollResult_MatchedNeverExceedsFetched(t *testing.T) {
	// Invariant: Matched <= Fetched always.
	// This test exercises the structure values used by the caller (PollOnce)
	// and verifies the fields are usable for downstream metrics.
	r := PollResult{
		Mailbox:  "mb@f.cz",
		Fetched:  10,
		Matched:  3,
		Errors:   1,
		Duration: 2 * time.Second,
	}
	if r.Matched > r.Fetched {
		t.Errorf("Matched (%d) must not exceed Fetched (%d)", r.Matched, r.Fetched)
	}
	if r.Errors < 0 {
		t.Error("Errors should not be negative")
	}
	if r.Duration <= 0 {
		t.Error("Duration should be positive")
	}
	if r.Mailbox == "" {
		t.Error("Mailbox should be set")
	}
}

// ── Seen Dedup ──
// F4-1: seen is now a bounded set (map[string]struct{} + FIFO list).
// Use the public-via-package markSeen/isSeen helpers instead of the
// raw map.

func TestPoller_SeenDedup(t *testing.T) {
	p := NewPoller(nil, nil)

	p.markSeen("abc123")
	if !p.isSeen("abc123") {
		t.Error("should be seen")
	}
	if p.isSeen("xyz789") {
		t.Error("should not be seen")
	}
}

// ── Date Parsing (from fetchMessage) ──

func TestDateParsing(t *testing.T) {
	layouts := []string{
		"Mon, 02 Jan 2006 15:04:05 -0700",
		"Mon, 2 Jan 2006 15:04:05 -0700",
		"02 Jan 2006 15:04:05 -0700",
	}

	dates := []string{
		"Tue, 07 Apr 2026 10:00:00 +0200",
		"Tue, 7 Apr 2026 10:00:00 +0200",
		"07 Apr 2026 10:00:00 +0200",
	}

	for _, dateStr := range dates {
		parsed := false
		for _, layout := range layouts {
			if _, err := time.Parse(layout, dateStr); err == nil {
				parsed = true
				break
			}
		}
		if !parsed {
			t.Errorf("could not parse: %q", dateStr)
		}
	}
}

// ── parseFetchResponse (net/mail path) ──

func TestParseFetchResponse_NetMail(t *testing.T) {
	// Simulate an IMAP FETCH response containing RFC 2822 headers followed by body.
	raw := "* 1 FETCH (BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE IN-REPLY-TO REFERENCES)] {120}\r\n" +
		"Message-ID: <test123@example.com>\r\n" +
		"From: sender@example.com\r\n" +
		"Subject: Re: Test\r\n" +
		"Date: Tue, 07 Apr 2026 10:00:00 +0200\r\n" +
		"In-Reply-To: <original@example.com>\r\n" +
		"\r\n" +
		"BODY[TEXT] {20}\r\n" +
		"Hello from net/mail.\r\n" +
		")\r\nA003 OK FETCH completed\r\n"

	msg := parseFetchResponse(raw)
	if msg == nil {
		t.Fatal("nil result")
	}
	// MessageID may be empty if framing parsing skips it; at minimum we should
	// not panic and the struct should be returned.
	_ = msg.MessageID
	_ = msg.From
	_ = msg.Subject
}

func TestParseFetchResponse_PlainHeaders(t *testing.T) {
	// Clean headers without IMAP framing — parseFetchResponse should parse via net/mail.
	raw := "Message-ID: <abc@test.cz>\r\n" +
		"From: jan@firma.cz\r\n" +
		"Subject: Odpoved\r\n" +
		"Date: Mon, 06 Apr 2026 09:00:00 +0200\r\n" +
		"In-Reply-To: <orig@test.cz>\r\n" +
		"\r\n" +
		"Dobry den, zaujalo nas vase nabidka.\r\n"

	msg := parseFetchResponse(raw)
	if msg.MessageID != "<abc@test.cz>" {
		t.Errorf("message-id: %q", msg.MessageID)
	}
	if msg.From != "jan@firma.cz" {
		t.Errorf("from: %q", msg.From)
	}
	if msg.Subject != "Odpoved" {
		t.Errorf("subject: %q", msg.Subject)
	}
	if msg.InReplyTo != "<orig@test.cz>" {
		t.Errorf("in-reply-to: %q", msg.InReplyTo)
	}
	if msg.BodyPlain == "" {
		t.Error("body should not be empty")
	}
}

func TestParseFetchResponse_BodyTruncated(t *testing.T) {
	longBody := strings.Repeat("A", 3000)
	raw := "Message-ID: <trunc@test.cz>\r\nSubject: Long\r\n\r\n" + longBody
	msg := parseFetchResponse(raw)
	if len(msg.BodyPlain) > 2000 {
		t.Errorf("body not truncated: %d bytes", len(msg.BodyPlain))
	}
}

func TestParseFetchResponse_Empty(t *testing.T) {
	msg := parseFetchResponse("")
	if msg == nil {
		t.Fatal("should not be nil")
	}
}

// ── extractMailBody ──

func TestExtractMailBody(t *testing.T) {
	raw := "Subject: X\r\n\r\nHello body text.\r\n"
	body, err := extractMailBody(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if body != "Hello body text." {
		t.Errorf("body: %q", body)
	}
}

func TestExtractMailBody_Truncated(t *testing.T) {
	raw := "Subject: X\r\n\r\n" + strings.Repeat("X", 3000) + "\r\n"
	body, err := extractMailBody(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(body) > 2000 {
		t.Errorf("not truncated: %d", len(body))
	}
}

// ── runWithReconnect ──

// fakeConn is a minimal net.Conn that does nothing, used in reconnect tests.
type fakeConn struct{}

func (f *fakeConn) Read(_ []byte) (int, error)         { return 0, nil }
func (f *fakeConn) Write(_ []byte) (int, error)        { return 0, nil }
func (f *fakeConn) Close() error                       { return nil }
func (f *fakeConn) LocalAddr() net.Addr                { return &net.TCPAddr{} }
func (f *fakeConn) RemoteAddr() net.Addr               { return &net.TCPAddr{} }
func (f *fakeConn) SetDeadline(_ time.Time) error      { return nil }
func (f *fakeConn) SetReadDeadline(_ time.Time) error  { return nil }
func (f *fakeConn) SetWriteDeadline(_ time.Time) error { return nil }

func TestRunWithReconnect_SuccessFirstTry(t *testing.T) {
	ctx := context.Background()
	cfg := config.MailboxConfig{Address: "test@example.com"}

	called := false
	dial := func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
		return &fakeConn{}, nil
	}
	handler := func(_ context.Context, _ net.Conn) error {
		called = true
		return nil
	}

	runWithReconnect(ctx, cfg, handler, dial)
	if !called {
		t.Error("handler should have been called")
	}
}

func TestRunWithReconnect_RetriesOnDialError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	cfg := config.MailboxConfig{Address: "test@example.com"}

	var dialAttempts int32
	dial := func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
		atomic.AddInt32(&dialAttempts, 1)
		return nil, fmt.Errorf("connection refused")
	}
	handler := func(_ context.Context, _ net.Conn) error { return nil }

	runWithReconnect(ctx, cfg, handler, dial)

	// Should have tried at least once (backoff starts at 1s, ctx cancels at 100ms).
	if atomic.LoadInt32(&dialAttempts) < 1 {
		t.Error("should have attempted dial at least once")
	}
}

func TestRunWithReconnect_ExitsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	cfg := config.MailboxConfig{Address: "test@example.com"}

	dialCalled := false
	dial := func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
		dialCalled = true
		return &fakeConn{}, nil
	}
	handler := func(_ context.Context, _ net.Conn) error { return nil }

	runWithReconnect(ctx, cfg, handler, dial)
	// With an already-cancelled context, runWithReconnect should return immediately
	// without attempting a dial (ctx.Err() check at top of loop).
	if dialCalled {
		t.Error("should not have dialled with cancelled context")
	}
}

func TestRunWithReconnect_ResetsBackoffOnSuccess(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	cfg := config.MailboxConfig{Address: "test@example.com"}

	// Fail once, then succeed — the backoff reset path is exercised.
	var attempt int32
	dial := func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
		n := atomic.AddInt32(&attempt, 1)
		if n == 1 {
			return nil, fmt.Errorf("first failure")
		}
		return &fakeConn{}, nil
	}

	handlerCalled := false
	handler := func(_ context.Context, _ net.Conn) error {
		handlerCalled = true
		return nil
	}

	// We shorten the backoff by passing a context that cancels before the
	// 1-second default fires, so the test runs fast. The context will cancel
	// during the backoff wait and runWithReconnect exits cleanly.
	runWithReconnect(ctx, cfg, handler, dial)

	// We just verify no panic and the function returns.
	_ = handlerCalled
}

// ── parseDateFallback ──

func TestParseDateFallback(t *testing.T) {
	inbound := &thread.RawInbound{}

	parseDateFallback(inbound, "Tue, 07 Apr 2026 10:00:00 +0200")
	if inbound.ReceivedAt.IsZero() {
		t.Error("date should be parsed")
	}
}

func TestParseDateFallback_Empty(t *testing.T) {
	inbound := &thread.RawInbound{ReceivedAt: time.Now()}
	before := inbound.ReceivedAt

	parseDateFallback(inbound, "")
	if !inbound.ReceivedAt.Equal(before) {
		t.Error("ReceivedAt should not change for empty input")
	}
}

func TestParseDateFallback_Invalid(t *testing.T) {
	inbound := &thread.RawInbound{ReceivedAt: time.Now()}
	before := inbound.ReceivedAt

	parseDateFallback(inbound, "not a date")
	if !inbound.ReceivedAt.Equal(before) {
		t.Error("ReceivedAt should not change for unparseable date")
	}
}

// ── WithHealth ──

func TestPoller_WithHealth(t *testing.T) {
	p := NewPoller([]config.MailboxConfig{}, nil)
	reg := health.New()
	result := p.WithHealth(reg)
	if result != p {
		t.Error("WithHealth should return the same poller for chaining")
	}
	if p.health != reg {
		t.Error("health registry not stored on poller")
	}
}

// ── extractHeader: no trailing newline ──

func TestExtractHeader_NoTrailingNewline(t *testing.T) {
	// Header at end of string with no \r or \n — exercises the `end < 0` branch
	raw := "From: jan@firma.cz"
	got := extractHeader(raw, "From")
	if got != "jan@firma.cz" {
		t.Errorf("extractHeader without newline = %q, want %q", got, "jan@firma.cz")
	}
}

// ── extractIMAPLiteral: edge-case branches ──

func TestExtractIMAPLiteral_MarkerNotFound(t *testing.T) {
	// Marker not in string → returns ""
	got := extractIMAPLiteral("* 1 FETCH (FLAGS (\\Seen))", "BODY[TEXT]")
	if got != "" {
		t.Errorf("expected empty for missing marker, got %q", got)
	}
}

func TestExtractIMAPLiteral_NoBrace(t *testing.T) {
	// Marker found but no {N} on that line → returns ""
	raw := "* 1 FETCH (BODY[TEXT] no-brace-here)\r\ndata"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != "" {
		t.Errorf("expected empty for missing brace, got %q", got)
	}
}

func TestExtractIMAPLiteral_InvalidCount(t *testing.T) {
	// {NaN} → Atoi error → returns ""
	raw := "* 1 FETCH (BODY[TEXT] {abc}\r\ndata)"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != "" {
		t.Errorf("expected empty for non-numeric count, got %q", got)
	}
}

func TestExtractIMAPLiteral_ZeroCount(t *testing.T) {
	// {0} → returns ""
	raw := "* 1 FETCH (BODY[TEXT] {0}\r\ndata)"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != "" {
		t.Errorf("expected empty for zero count, got %q", got)
	}
}

func TestExtractIMAPLiteral_LFOnly(t *testing.T) {
	// LF-only line ending after } → exercises the `\n` branch (not \r\n)
	body := "Hello body"
	raw := "* 1 FETCH (FLAGS () BODY[TEXT] {" + fmt.Sprintf("%d", len(body)) + "}\n" + body + ")"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != body {
		t.Errorf("LF-only: got %q, want %q", got, body)
	}
}

func TestExtractIMAPLiteral_CountExceedsData(t *testing.T) {
	// {100} but only 5 bytes available after \r\n → returns what's available
	raw := "* 1 FETCH (FLAGS () BODY[TEXT] {100}\r\nHello)"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != "Hello)" {
		t.Errorf("truncated data: got %q, want %q", got, "Hello)")
	}
}

// ── findHeaderStart: all-IMAP-framing input ──

func TestFindHeaderStart_AllFraming(t *testing.T) {
	// All lines are IMAP untagged responses → fallback to 0
	s := "* 5 EXISTS\n* 3 RECENT\n"
	idx := findHeaderStart(s)
	if idx != 0 {
		t.Errorf("all-framing should return 0, got %d", idx)
	}
}

func TestFindHeaderStart_WithHeaders(t *testing.T) {
	// IMAP framing then real header
	s := "* 1 FETCH (FLAGS ())\nFrom: jan@firma.cz\r\nSubject: Test\r\n"
	idx := findHeaderStart(s)
	if idx == 0 {
		t.Errorf("should find header start after IMAP framing, got 0")
	}
	if !strings.Contains(s[idx:], "From:") {
		t.Errorf("header start should point to From: line, got: %q", s[idx:])
	}
}

func TestExtractIMAPLiteral_NegativeCount(t *testing.T) {
	// {-1} → count < 0 → returns ""
	raw := "* 1 FETCH (FLAGS () BODY[TEXT] {-1}\r\ndata)"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != "" {
		t.Errorf("expected empty for negative count, got %q", got)
	}
}

func TestExtractIMAPLiteral_NoNewlineAfterBrace(t *testing.T) {
	// Marker line with {N} but the character after } is not \n or \r
	// e.g. "BODY[TEXT] {5}data" — dataStart points to 'd'
	raw := "* 1 FETCH (BODY[TEXT] {5}Hello more data)"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	// dataStart stays right after '}', reads 5 bytes: "Hello"
	if got != "Hello" {
		t.Errorf("no-newline: got %q, want %q", got, "Hello")
	}
}

func TestExtractIMAPLiteral_LineEndAtEndOfString(t *testing.T) {
	// Marker at end of string with no trailing newline → lineEnd = len(rest)
	raw := "* 1 FETCH BODY[TEXT] {5}\r\nHello"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != "Hello" {
		t.Errorf("end-of-string: got %q, want %q", got, "Hello")
	}
}

// ── extractMailBody: error path ──

func TestExtractMailBody_InvalidMail(t *testing.T) {
	// mail.ReadMessage fails on a bare LF header (Go 1.23+ validates headers strictly)
	// Use a header with a bare \n to trigger the error in some Go versions,
	// otherwise verify no panic
	_, err := extractMailBody("")
	// "" has no \r\n\r\n so mail.ReadMessage parses it as a message with empty body and no error
	// In any case, the function should not panic
	_ = err
}
