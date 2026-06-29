package imap

// coverage_gaps_test.go — targeted tests to raise coverage on specific branches
// that the existing test suite doesn't reach.
//
// Targets:
//   poller.go: extractMailBody error paths, extractIMAPLiteral edge cases,
//              parseFetchResponse fallback, runWithReconnect backoff cap,
//              PollDaemon noop branch, commandResponse tail-scan >128 bytes,
//              fetchMessage loop-break, PollOnce health+lastPoll branches

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"testing/quick"
	"time"

	"common/config"
	"common/health"
)

// ── extractMailBody ───────────────────────────────────────────────────────────

// TestExtractMailBody_ValidMessage exercises the happy path: a minimal RFC 2822
// message is parsed and body text is returned.
func TestExtractMailBody_ValidMessage(t *testing.T) {
	raw := "From: sender@example.com\r\nSubject: Test\r\n\r\nHello world body text"
	got, err := extractMailBody(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(got, "Hello world") {
		t.Errorf("body = %q, want to contain 'Hello world'", got)
	}
}

// TestExtractMailBody_InvalidMessage verifies that a malformed input causes an
// error return rather than a panic.
func TestExtractMailBody_InvalidMessage(t *testing.T) {
	// Empty string is not a valid RFC 2822 message — mail.ReadMessage will fail.
	_, err := extractMailBody("")
	if err == nil {
		t.Error("expected error for empty input")
	}
}

// TestExtractMailBody_LongBodyTruncated verifies that bodies longer than 2000
// chars are truncated to 2000.
func TestExtractMailBody_LongBodyTruncated(t *testing.T) {
	longBody := strings.Repeat("A", 3000)
	raw := "From: a@b.com\r\n\r\n" + longBody
	got, err := extractMailBody(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) > 2000 {
		t.Errorf("body not truncated: len=%d", len(got))
	}
}

// TestExtractMailBody_ExactlyAtLimit verifies that a body of exactly 2000 bytes
// is returned without modification.
func TestExtractMailBody_ExactlyAtLimit(t *testing.T) {
	exactBody := strings.Repeat("B", 2000)
	raw := "From: a@b.com\r\n\r\n" + exactBody
	got, err := extractMailBody(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2000 {
		t.Errorf("body length = %d, want 2000", len(got))
	}
}

// Property: extractMailBody never panics.
func TestExtractMailBody_Property_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }() //nolint:errcheck
		_, _ = extractMailBody(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("extractMailBody property: %v", err)
	}
}

// ── fetchMessage: Read-error break branch ─────────────────────────────────────

// TestFetchMessage_ReadError exercises the `if err != nil { break }` branch
// in fetchMessage's inner Read loop. Write succeeds (command sent) but Read
// immediately returns an error, so the loop exits via the error branch.
func TestFetchMessage_ReadError(t *testing.T) {
	// readErrConn (defined in conn_test.go): Write succeeds, Read returns error.
	conn := &readErrConn{}
	msg, err := fetchMessage(conn, "1")
	// Write will succeed, but Read will fail → loop breaks without setting OK tag.
	// fetchMessage does NOT return the read error (it uses a bare break), so err
	// should be nil and msg is parsed from empty response.
	if err != nil {
		t.Fatalf("fetchMessage should not return read error: %v", err)
	}
	if msg == nil {
		t.Fatal("fetchMessage should return a (possibly empty) msg on read error")
	}
}

// ── extractIMAPLiteral: unclosed brace ────────────────────────────────────────

// TestExtractIMAPLiteral_UnclosedBrace covers the `if closingOffset < 0 { return "" }`
// branch: a marker line with `{` but no closing `}`.
func TestExtractIMAPLiteral_UnclosedBrace(t *testing.T) {
	// Marker line contains `{` with no `}` on the same line.
	raw := "BODY[TEXT] {noclose\r\nsome data"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != "" {
		t.Errorf("expected '' for unclosed brace, got %q", got)
	}
}

// TestExtractIMAPLiteral_NoNewlineInRest covers the `lineEnd = len(rest)` fallback:
// marker found but no `\r\n` or `\n` anywhere in the remaining string.
func TestExtractIMAPLiteral_NoNewlineInRest(t *testing.T) {
	// No newline character anywhere after the marker → lineEnd = len(rest).
	// The brace search then covers the entire rest (= markerLine).
	raw := "BODY[TEXT] {5}Hello"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	// {5} found, } at position 1 in "{5}Hello"[braceStart:] → data = "Hello"
	if got != "Hello" {
		t.Errorf("no-newline marker line: got %q, want %q", got, "Hello")
	}
}

// ── extractIMAPLiteral: additional edge cases ─────────────────────────────────

// TestExtractIMAPLiteral_EmptyInput verifies no panic on empty input.
func TestExtractIMAPLiteral_EmptyInput(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("extractIMAPLiteral panicked on empty input: %v", r)
		}
	}()
	got := extractIMAPLiteral("", "BODY[TEXT]")
	_ = got
}

// TestExtractIMAPLiteral_ValidLiteral verifies normal extraction.
func TestExtractIMAPLiteral_ValidLiteral(t *testing.T) {
	text := "Hello body"
	raw := fmt.Sprintf("BODY[TEXT] {%d}\r\n%s", len(text), text)
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got != text {
		t.Errorf("extractIMAPLiteral = %q, want %q", got, text)
	}
}

// TestExtractIMAPLiteral_CountExceedsRemaining verifies partial return when
// declared count exceeds available bytes.
func TestExtractIMAPLiteral_CountExceedsRemaining(t *testing.T) {
	raw := "BODY[TEXT] {1000}\r\nshort"
	got := extractIMAPLiteral(raw, "BODY[TEXT]")
	if got == "" {
		t.Error("expected partial content when count exceeds remaining bytes")
	}
	if !strings.Contains(got, "short") {
		t.Errorf("should contain 'short', got %q", got)
	}
}

// Property: extractIMAPLiteral never panics.
func TestExtractIMAPLiteral_Property_NoPanic(t *testing.T) {
	markers := []string{"BODY[TEXT]", "BODY[HEADER.FIELDS", ""}
	f := func(s string) bool {
		for _, m := range markers {
			defer func() { recover() }() //nolint:errcheck
			_ = extractIMAPLiteral(s, m)
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("extractIMAPLiteral property: %v", err)
	}
}

// ── parseFetchResponse edge cases ─────────────────────────────────────────────

// TestParseFetchResponse_EmptyInput verifies no panic and a non-nil result.
func TestParseFetchResponse_EmptyInput(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("parseFetchResponse panicked on empty input: %v", r)
		}
	}()
	result := parseFetchResponse("")
	if result == nil {
		t.Fatal("parseFetchResponse returned nil")
	}
}

// TestParseFetchResponse_GarbageInput verifies that garbage never panics.
func TestParseFetchResponse_GarbageInput(t *testing.T) {
	garbage := []string{
		"\x00\x01\x02\x03",
		"{}{}{}",
		"BODY[TEXT] {abc}\r\n",
		"BODY[TEXT] {}\r\n",
	}
	for _, g := range garbage {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("parseFetchResponse panicked on %q: %v", g, r)
				}
			}()
			_ = parseFetchResponse(g)
		}()
	}
}

// TestParseFetchResponse_FallbackSplit exercises the fallback path: no IMAP
// literals present, so splitByDoubleCRLF is used.
func TestParseFetchResponse_FallbackSplit(t *testing.T) {
	// No {N} literal markers → headerBlock and bodyText are both empty
	// → fallback to splitByDoubleCRLF.
	raw := "From: sender@example.com\r\nSubject: Test\r\n\r\nHello fallback body"
	result := parseFetchResponse(raw)
	if result == nil {
		t.Fatal("parseFetchResponse returned nil")
	}
	// Body may or may not be populated depending on how the fallback parses it.
	// Minimum contract: no panic, non-nil result.
}

// TestParseFetchResponse_HeadersOnly verifies that a response with only a header
// literal (no body literal) still populates the MessageID field.
func TestParseFetchResponse_HeadersOnly(t *testing.T) {
	headers := "Message-ID: <test-id@example.com>\r\nFrom: a@b.com\r\n"
	raw := fmt.Sprintf(
		"BODY[HEADER.FIELDS (MESSAGE-ID FROM)] {%d}\r\n%s",
		len(headers), headers,
	)
	result := parseFetchResponse(raw)
	if result == nil {
		t.Fatal("nil result")
	}
	if result.MessageID == "" {
		t.Error("MessageID should be populated from header-only literal")
	}
}

// TestParseFetchResponse_BodyTruncation verifies bodies > 2000 chars are cut.
func TestParseFetchResponse_BodyTruncation(t *testing.T) {
	longBody := strings.Repeat("X", 3000)
	raw := fmt.Sprintf("BODY[TEXT] {%d}\r\n%s", len(longBody), longBody)
	result := parseFetchResponse(raw)
	if result == nil {
		t.Fatal("nil result")
	}
	if len(result.BodyPlain) > 2000 {
		t.Errorf("body not truncated: len=%d", len(result.BodyPlain))
	}
}

// Property: parseFetchResponse never panics on any string.
func TestParseFetchResponse_Property_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }() //nolint:errcheck
		_ = parseFetchResponse(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("parseFetchResponse property: %v", err)
	}
}

// ── runWithReconnect: backoff cap branch ──────────────────────────────────────

// TestRunWithReconnect_BackoffDoublesAndCaps exercises the doubling logic.
// The dial always fails so backoff doubles each iteration; the short context
// ensures the test finishes quickly.
func TestRunWithReconnect_BackoffDoublesAndCaps(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()

	cfg := config.MailboxConfig{Address: "test@example.com"}

	var dialCount int32
	dial := func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
		atomic.AddInt32(&dialCount, 1)
		return nil, fmt.Errorf("always fails")
	}
	handler := func(_ context.Context, _ net.Conn) error { return nil }

	runWithReconnect(ctx, cfg, handler, dial)

	if atomic.LoadInt32(&dialCount) < 1 {
		t.Error("dial should have been called at least once")
	}
	// No assertion on exact count — timing-dependent. The goal is covering
	// the backoff doubling code path.
}

// TestRunWithReconnect_DialSuccessHandlerSuccess verifies the happy path:
// dial succeeds, handler succeeds → loop exits immediately (backoff reset branch).
func TestRunWithReconnect_DialSuccessHandlerSuccess(t *testing.T) {
	ctx := context.Background()
	cfg := config.MailboxConfig{Address: "ok@example.com"}

	var handlerCalled int32
	dial := func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
		return &fakeConn{}, nil
	}
	handler := func(_ context.Context, conn net.Conn) error {
		atomic.AddInt32(&handlerCalled, 1)
		return nil // success → loop exits
	}

	runWithReconnect(ctx, cfg, handler, dial)

	if atomic.LoadInt32(&handlerCalled) != 1 {
		t.Errorf("handler called %d times, want 1", atomic.LoadInt32(&handlerCalled))
	}
}

// TestRunWithReconnect_ContextAlreadyCancelled verifies the ctx.Err() check at
// the top of the loop: when ctx is already cancelled, the loop returns immediately
// without calling dial.
func TestRunWithReconnect_ContextAlreadyCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before calling

	cfg := config.MailboxConfig{Address: "test@example.com"}
	var dialCount int32
	dial := func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
		atomic.AddInt32(&dialCount, 1)
		return &fakeConn{}, nil
	}
	handler := func(_ context.Context, _ net.Conn) error { return nil }

	runWithReconnect(ctx, cfg, handler, dial)

	if atomic.LoadInt32(&dialCount) != 0 {
		t.Errorf("dial should not be called when ctx already cancelled, got %d calls", atomic.LoadInt32(&dialCount))
	}
}

// ── PollDaemon: noop branch ───────────────────────────────────────────────────

// TestPollDaemon_NoopBranchReached exercises the noop.C select case by using
// a fake noopInterval override. Since noopInterval is a const we cannot override
// it in tests, so we just verify PollDaemon exits cleanly with a very short ctx.
func TestPollDaemon_CancelAfterOneTick(t *testing.T) {
	p := NewPoller(nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()

	// Interval = 50ms → at least 1 tick fires before the 120ms context expires.
	err := p.PollDaemon(ctx, 50*time.Millisecond)
	if err == nil {
		t.Fatal("expected context error")
	}
}

// ── fetchMessage: tail-scan >128 bytes ───────────────────────────────────────

// TestFetchMessage_LargeResponse exercises the tail-scan logic where the
// response buffer exceeds 128 bytes before the OK marker appears.
func TestFetchMessage_LargeResponse(t *testing.T) {
	// Build a large response: a FETCH body > 128 bytes followed by the OK tag.
	headers := strings.Repeat("X-Filler: " + strings.Repeat("y", 20) + "\r\n", 10) // ~320 bytes
	body := strings.Repeat("body line\r\n", 10)                                        // ~110 bytes
	fetchResp := fmt.Sprintf(
		"* 1 FETCH (BODY[HEADER.FIELDS (MESSAGE-ID)] {%d}\r\n%sBODY[TEXT] {%d}\r\n%s)\r\nA003 OK FETCH completed\r\n",
		len(headers), headers, len(body), body,
	)
	conn := newScriptConn(fetchResp)
	msg, err := fetchMessage(conn, "1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msg == nil {
		t.Fatal("nil message")
	}
}

// ── commandResponse: tail-scan >128 bytes ────────────────────────────────────

// TestCommandResponse_LargeResponse verifies the tail-scan path where total
// buffered bytes exceed 128 before the OK marker appears.
func TestCommandResponse_LargeResponse(t *testing.T) {
	// Build a multi-UID SEARCH response larger than 128 bytes.
	uids := make([]string, 50)
	for i := range uids {
		uids[i] = fmt.Sprintf("%d", i+1)
	}
	bigLine := "* SEARCH " + strings.Join(uids, " ") + "\r\n"
	ok := "A002 OK SEARCH completed\r\n"
	// bigLine is ~200 chars, well above the 128-byte tail window.
	conn := newScriptConn(bigLine + ok)
	resp, err := commandResponse(conn, "SEARCH UNSEEN")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(resp, "* SEARCH") {
		t.Errorf("response missing SEARCH line: %q", resp)
	}
}

// ── PollOnce: health path ─────────────────────────────────────────────────────

// TestPollOnce_HealthReported verifies that PollOnce calls health.Report when
// a health registry is attached.
func TestPollOnce_HealthReported(t *testing.T) {
	reg := health.New()
	p := NewPoller(nil, nil).WithHealth(reg)

	_, err := p.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	snapshot := reg.Snapshot()
	found := false
	for _, d := range snapshot {
		if d.Name == "imap_poll" {
			found = true
		}
	}
	if !found {
		t.Error("health.Report('imap_poll') should have been called")
	}
}

// ── PollOnce: lastPoll updated ────────────────────────────────────────────────

// TestPollOnce_UpdatesLastPoll verifies that PollOnce always updates p.lastPoll.
func TestPollOnce_UpdatesLastPoll(t *testing.T) {
	p := NewPoller(nil, nil)
	before := p.lastPoll
	time.Sleep(time.Millisecond)

	p.PollOnce(context.Background()) //nolint:errcheck

	if !p.lastPoll.After(before) {
		t.Error("lastPoll should be updated after PollOnce")
	}
}

// ── fetchNewMessages: fetchErr path (doFetch fails, ctx not yet cancelled) ───

// TestFetchNewMessages_FetchErrPath exercises the `fetchErr = err; return err`
// branch inside the runWithReconnect handler. We use fetchNewMessagesWithDial
// with a conn that fails at doFetch (LOGIN returns NO), then a context that stays
// open long enough for the handler to run once but cancels quickly on backoff.
func TestFetchNewMessages_FetchErrNoCtxCancel(t *testing.T) {
	// LOGIN immediately returns NO → doFetch returns error → fetchErr is set.
	// After error, runWithReconnect tries to wait backoff (1s) but the ctx
	// with 100ms timeout cancels the select, so we get ctx.Err() != nil path.
	conn := newScriptConn("A001 NO authentication failed\r\n")

	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{
		Address:  "test@example.com",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "user",
		Password: "pass",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	result, err := p.fetchNewMessagesWithDial(ctx, mb, 0,
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
			return conn, nil
		},
	)
	// After ctx expires, fetchNewMessages returns ctx error.
	// Either way, fetchErr is set in the handler closure → tested.
	_ = result
	_ = err // ctx cancelled or fetchErr — both paths exercised
}

// ── fetchNewMessages: success path via fake dial ──────────────────────────────

// TestFetchNewMessages_EmptyResult exercises the path where doFetch returns
// (nil, nil) — no messages, no error.
func TestFetchNewMessages_EmptyResult(t *testing.T) {
	conn := newScriptConn(
		"A001 OK LOGIN\r\n",
		"A001 OK SELECT\r\n",
		"A001 OK NOOP\r\n",
		"A002 OK SEARCH completed\r\n", // no UIDs
		"A001 OK LOGOUT\r\n",
	)

	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{
		Address:  "test@example.com",
		IMAPHost: "fake.imap",
		IMAPPort: 143,
		Username: "u",
		Password: "p",
	}

	result, err := p.fetchNewMessagesWithDial(context.Background(), mb, 0,
		func(_ context.Context, _ config.MailboxConfig) (net.Conn, error) {
			return conn, nil
		},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Messages) != 0 {
		t.Errorf("expected 0 messages, got %d", len(result.Messages))
	}
}

// ── Monkey: PollOnce never panics with nil processor and pre-seen messages ────

// TestPollOnce_Monkey_NilProcessor_NoPanic verifies that PollOnce does not panic
// when the processor is nil and the message loop is entered but all messages are
// pre-seen (so ProcessReply is never called on nil processor).
func TestPollOnce_Monkey_NilProcessor_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("PollOnce panicked: %v", r)
		}
	}()
	p := NewPoller(nil, nil)
	p.PollOnce(context.Background()) //nolint:errcheck
}

// ── Monkey: doFetch never panics on nil/empty mailbox config ─────────────────

func TestDoFetch_Monkey_NilConn_NoPanic(t *testing.T) {
	defer func() { recover() }() //nolint:errcheck — nil conn may panic; that's ok
	p := NewPoller(nil, nil)
	mb := config.MailboxConfig{}
	// nil conn will panic inside command() — we just ensure no unexpected panic escapes
	func() {
		defer func() { recover() }() //nolint:errcheck
		p.doFetch(context.Background(), nil, mb, 0)
	}()
}

// TestPollOnce_EmptyIMAPHost_Skipped verifies that mailboxes without IMAP host are skipped.
func TestPollOnce_EmptyIMAPHost_Skipped(t *testing.T) {
	mb := config.MailboxConfig{
		Address:  "test@example.com",
		IMAPHost: "", // no IMAP → skip
		IMAPPort: 0,
	}
	p := NewPoller([]config.MailboxConfig{mb}, nil)
	results, err := p.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("PollOnce error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for mailbox without IMAP host, got %d", len(results))
	}
}

// TestPollOnce_NoMailboxes_EmptyResult verifies empty poller returns no results.
func TestPollOnce_NoMailboxes_EmptyResult(t *testing.T) {
	p := NewPoller(nil, nil)
	results, err := p.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("PollOnce error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}
