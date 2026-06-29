package imap

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"common/config"
)

// ── Test infrastructure ──────────────────────────────────────────────────

// appendConn is a richer scriptConn variant that supports interleaved
// reads and writes — AppendToSent's wire conversation has a literal-data
// continuation step that scriptConn's simple "all reads queued upfront"
// model handles, but we want explicit captures so tests can assert on
// the exact bytes sent.
type appendConn struct {
	mu        sync.Mutex
	reads     [][]byte // sequence of chunks Read returns; index advances on each Read
	readIdx   int
	writes    bytes.Buffer
	closed    bool
	readErr   error // when set, all reads return this error
	writeErr  error // when set, all writes return this error
	failClose bool
}

func newAppendConn(reads ...string) *appendConn {
	c := &appendConn{}
	for _, r := range reads {
		c.reads = append(c.reads, []byte(r))
	}
	return c
}

func (c *appendConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.readErr != nil {
		return 0, c.readErr
	}
	if c.readIdx >= len(c.reads) {
		return 0, io.EOF
	}
	chunk := c.reads[c.readIdx]
	c.readIdx++
	n := copy(p, chunk)
	return n, nil
}
func (c *appendConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.writeErr != nil {
		return 0, c.writeErr
	}
	return c.writes.Write(p)
}
func (c *appendConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.failClose {
		return errors.New("close error")
	}
	return nil
}
func (c *appendConn) LocalAddr() net.Addr                { return &net.TCPAddr{} }
func (c *appendConn) RemoteAddr() net.Addr               { return &net.TCPAddr{} }
func (c *appendConn) SetDeadline(time.Time) error        { return nil }
func (c *appendConn) SetReadDeadline(time.Time) error    { return nil }
func (c *appendConn) SetWriteDeadline(time.Time) error   { return nil }
func (c *appendConn) writtenString() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.writes.String()
}

// dialReturning builds an injectable dial closure for AppendToSent that
// returns the given conn on every call. Replicates the closure shape the
// poller tests use.
func dialReturning(c net.Conn) func(context.Context, config.MailboxConfig) (net.Conn, error) {
	return func(context.Context, config.MailboxConfig) (net.Conn, error) {
		return c, nil
	}
}

// dialErr returns a dial closure that always errors.
func dialErr(err error) func(context.Context, config.MailboxConfig) (net.Conn, error) {
	return func(context.Context, config.MailboxConfig) (net.Conn, error) {
		return nil, err
	}
}

// fixedNow returns a deterministic clock for INTERNALDATE assertions.
func fixedNow() time.Time {
	return time.Date(2026, 5, 9, 14, 30, 0, 0, time.FixedZone("CEST", 2*3600))
}

func goodMailbox() config.MailboxConfig {
	return config.MailboxConfig{
		Address:  "sender@firma.cz",
		Username: "sender@firma.cz",
		Password: "pwd",
		IMAPHost: "imap.test.cz",
		IMAPPort: 993,
	}
}

// ── 1. Happy path ────────────────────────────────────────────────────────

// TestAppendToSent_HappyPath_FirstFolderAccepted verifies the canonical
// flow: LOGIN OK → SELECT "Sent" OK → APPEND continuation + tagged OK →
// LOGOUT. Asserts the wire bytes carry \Seen, INTERNALDATE, and the literal
// MIME payload.
func TestAppendToSent_HappyPath_FirstFolderAccepted(t *testing.T) {
	mime := []byte("From: sender@firma.cz\r\nTo: r@x.cz\r\nSubject: Hi\r\n\r\nhello")
	conn := newAppendConn(
		"A001 OK LOGIN completed\r\n",
		"* 1 EXISTS\r\nA100 OK SELECT completed\r\n",
		"+ Ready for literal data\r\n",
		"A101 OK APPEND completed\r\n",
		"A001 OK LOGOUT completed\r\n",
	)
	err := appendToSentWithDial(context.Background(), goodMailbox(), mime, dialReturning(conn), fixedNow)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	wire := conn.writtenString()
	if !strings.Contains(wire, "LOGIN sender@firma.cz pwd") {
		t.Errorf("missing LOGIN: %q", wire)
	}
	if !strings.Contains(wire, `A100 SELECT "Sent"`) {
		t.Errorf("missing SELECT Sent: %q", wire)
	}
	if !strings.Contains(wire, `(\Seen)`) {
		t.Errorf("missing \\Seen flag: %q", wire)
	}
	if !strings.Contains(wire, `"09-May-2026 14:30:00 +0200"`) {
		t.Errorf("missing INTERNALDATE: %q", wire)
	}
	if !strings.Contains(wire, fmt.Sprintf("{%d}", len(mime))) {
		t.Errorf("missing literal byte count: %q", wire)
	}
	if !strings.Contains(wire, "hello") {
		t.Errorf("literal payload not written: %q", wire)
	}
	if !strings.Contains(wire, "A001 LOGOUT") {
		t.Errorf("missing LOGOUT: %q", wire)
	}
}

// ── 2. Folder fallback ────────────────────────────────────────────────────

// TestAppendToSent_FolderFallback_OdeslanaPosta verifies that when the
// server rejects "Sent" with NO, the helper tries the next candidate name.
// Locks the Czech "Odeslaná pošta" path which is what Seznam uses.
func TestAppendToSent_FolderFallback_OdeslanaPosta(t *testing.T) {
	mime := []byte("From: s@f.cz\r\n\r\nbody")
	conn := newAppendConn(
		"A001 OK LOGIN completed\r\n",
		`A100 NO [TRYCREATE] mailbox "Sent" does not exist`+"\r\n",
		"* 0 EXISTS\r\nA100 OK SELECT completed\r\n",
		"+ go\r\n",
		"A101 OK APPEND completed\r\n",
		"A001 OK LOGOUT completed\r\n",
	)
	err := appendToSentWithDial(context.Background(), goodMailbox(), mime, dialReturning(conn), fixedNow)
	if err != nil {
		t.Fatalf("expected success after fallback, got %v", err)
	}
	wire := conn.writtenString()
	// Helper must have tried Sent first, then Odeslaná pošta.
	if !strings.Contains(wire, `A100 SELECT "Sent"`) {
		t.Errorf("did not try Sent first: %q", wire)
	}
	if !strings.Contains(wire, `A100 SELECT "Odeslaná pošta"`) {
		t.Errorf("did not fall back to Odeslaná pošta: %q", wire)
	}
}

// ── 3. All folders refused ────────────────────────────────────────────────

// TestAppendToSent_AllFoldersRejected verifies that when every candidate
// SELECT returns NO, the helper returns a wrapped error (caller will log
// warn but the send remains successful upstream).
func TestAppendToSent_AllFoldersRejected(t *testing.T) {
	mime := []byte("body")
	reads := []string{
		"A001 OK LOGIN completed\r\n",
	}
	for range sentFolderCandidates {
		reads = append(reads, "A100 NO mailbox does not exist\r\n")
	}
	reads = append(reads, "A001 OK LOGOUT completed\r\n")
	conn := newAppendConn(reads...)
	err := appendToSentWithDial(context.Background(), goodMailbox(), mime, dialReturning(conn), fixedNow)
	if err == nil {
		t.Fatal("expected error when no folder accepts SELECT")
	}
	if !strings.Contains(err.Error(), "no Sent folder accepted") {
		t.Errorf("wrong error wrapping: %v", err)
	}
}

// ── 4. SOCKS5 dial failure ────────────────────────────────────────────────

// TestAppendToSent_DialFailure_PropagatesError verifies the helper returns
// an error when the SOCKS5 dial fails (e.g. ErrIMAPSOCKSUnavailable). The
// onSent callback in main.go is responsible for logging warn — here we
// just verify error propagation.
func TestAppendToSent_DialFailure_PropagatesError(t *testing.T) {
	mime := []byte("body")
	err := appendToSentWithDial(context.Background(), goodMailbox(), mime,
		dialErr(ErrIMAPSOCKSUnavailable), fixedNow)
	if err == nil {
		t.Fatal("expected dial error")
	}
	if !errors.Is(err, ErrIMAPSOCKSUnavailable) {
		t.Errorf("expected wrapped ErrIMAPSOCKSUnavailable, got %v", err)
	}
}

// ── 5. Login failure ──────────────────────────────────────────────────────

// TestAppendToSent_LoginFailure_BubblesUp verifies that LOGIN NO terminates
// the flow with an error before any SELECT / APPEND.
func TestAppendToSent_LoginFailure_BubblesUp(t *testing.T) {
	conn := newAppendConn("A001 NO authentication failed\r\n")
	err := appendToSentWithDial(context.Background(), goodMailbox(), []byte("body"),
		dialReturning(conn), fixedNow)
	if err == nil {
		t.Fatal("expected login error")
	}
	if !strings.Contains(err.Error(), "login") {
		t.Errorf("error should mention login: %v", err)
	}
	wire := conn.writtenString()
	if strings.Contains(wire, "SELECT") {
		t.Errorf("SELECT must not run after LOGIN failure: %q", wire)
	}
}

// ── 6. APPEND rejected pre-literal ────────────────────────────────────────

// TestAppendToSent_AppendRejectedBeforeLiteral covers servers that respond
// with tagged NO/BAD immediately after the APPEND command (e.g. quota
// exceeded, permission denied). The helper must NOT write the literal
// payload — that would interleave bytes into the IMAP stream.
func TestAppendToSent_AppendRejectedBeforeLiteral(t *testing.T) {
	mime := []byte("body content goes here")
	conn := newAppendConn(
		"A001 OK LOGIN completed\r\n",
		"A100 OK SELECT completed\r\n",
		"A101 NO [QUOTAEXCEEDED] mailbox is full\r\n",
		"A001 OK LOGOUT\r\n",
	)
	err := appendToSentWithDial(context.Background(), goodMailbox(), mime, dialReturning(conn), fixedNow)
	if err == nil {
		t.Fatal("expected APPEND rejection")
	}
	wire := conn.writtenString()
	if strings.Contains(wire, "body content goes here") {
		t.Errorf("literal must not be written on pre-literal rejection: %q", wire)
	}
}

// ── 7. APPEND rejected after literal ──────────────────────────────────────

// TestAppendToSent_AppendRejectedAfterLiteral covers the case where the
// server accepts the continuation but rejects the tagged completion (e.g.
// post-write parse error).
func TestAppendToSent_AppendRejectedAfterLiteral(t *testing.T) {
	mime := []byte("body")
	conn := newAppendConn(
		"A001 OK LOGIN completed\r\n",
		"A100 OK SELECT completed\r\n",
		"+ go\r\n",
		"A101 BAD parse error\r\n",
		"A001 OK LOGOUT\r\n",
	)
	err := appendToSentWithDial(context.Background(), goodMailbox(), mime, dialReturning(conn), fixedNow)
	if err == nil {
		t.Fatal("expected APPEND rejection")
	}
	if !strings.Contains(err.Error(), "APPEND") {
		t.Errorf("error should mention APPEND: %v", err)
	}
}

// ── 8. Empty wireMIME ─────────────────────────────────────────────────────

// TestAppendToSent_EmptyWireMIME_NoAppend verifies the empty-payload guard.
// We pass a successful-looking conn but the helper must short-circuit
// before any IMAP I/O.
func TestAppendToSent_EmptyWireMIME_NoAppend(t *testing.T) {
	conn := newAppendConn("A001 OK LOGIN completed\r\n")
	err := appendToSentWithDial(context.Background(), goodMailbox(), nil, dialReturning(conn), fixedNow)
	if !errors.Is(err, ErrEmptyWireMIME) {
		t.Fatalf("expected ErrEmptyWireMIME, got %v", err)
	}
	if conn.writtenString() != "" {
		t.Errorf("expected zero writes on empty wireMIME, got %q", conn.writtenString())
	}
}

// ── 9. Mailbox without IMAP creds ─────────────────────────────────────────

// TestAppendToSent_NoIMAPCreds_SilentSkip verifies the helper returns nil
// (not error) when the mailbox has no IMAP host/port — same shape as the
// poller's no-creds skip. This branch is hit for SMTP-only operator mailboxes.
func TestAppendToSent_NoIMAPCreds_SilentSkip(t *testing.T) {
	mb := config.MailboxConfig{
		Address:  "smtp-only@firma.cz",
		Username: "smtp-only@firma.cz",
		Password: "x",
		IMAPHost: "", // no IMAP wired
		IMAPPort: 0,
	}
	// Use a dial closure that would panic if invoked — proves the helper
	// short-circuited before reaching the dial layer.
	dialPanic := func(context.Context, config.MailboxConfig) (net.Conn, error) {
		t.Fatal("dial must not be invoked when no IMAP creds")
		return nil, nil
	}
	err := appendToSentWithDial(context.Background(), mb, []byte("body"), dialPanic, fixedNow)
	if err != nil {
		t.Errorf("expected nil error for no-creds skip, got %v", err)
	}
}

// ── 10. Concurrent calls — no shared state ────────────────────────────────

// TestAppendToSent_Concurrent_NoSharedState fires 8 AppendToSent calls in
// parallel, each with its own conn. Verifies the helper holds no global
// state — required because the engine's onSent callback runs these in
// goroutines.
func TestAppendToSent_Concurrent_NoSharedState(t *testing.T) {
	const N = 8
	var wg sync.WaitGroup
	errs := make([]error, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			conn := newAppendConn(
				"A001 OK LOGIN\r\n",
				"A100 OK SELECT\r\n",
				"+ go\r\n",
				"A101 OK APPEND\r\n",
				"A001 OK LOGOUT\r\n",
			)
			errs[idx] = appendToSentWithDial(context.Background(), goodMailbox(),
				[]byte(fmt.Sprintf("body-%d", idx)),
				dialReturning(conn), fixedNow)
		}(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil {
			t.Errorf("concurrent call %d failed: %v", i, e)
		}
	}
}

// ── 11. INTERNALDATE format (RFC 3501 §6.3.11) ────────────────────────────

// TestAppendToSent_InternalDateFormat verifies the date is emitted in the
// "dd-Mon-yyyy hh:mm:ss ±zzzz" format with quotes around it. Servers reject
// any deviation (e.g. ISO 8601 form) so the regression cost is high.
func TestAppendToSent_InternalDateFormat(t *testing.T) {
	mime := []byte("x")
	conn := newAppendConn(
		"A001 OK LOGIN\r\n",
		"A100 OK SELECT\r\n",
		"+ go\r\n",
		"A101 OK APPEND\r\n",
		"A001 OK LOGOUT\r\n",
	)
	// Use a midnight UTC clock to lock the format exactly.
	clock := func() time.Time {
		return time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC)
	}
	err := appendToSentWithDial(context.Background(), goodMailbox(), mime, dialReturning(conn), clock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wire := conn.writtenString()
	if !strings.Contains(wire, `"05-Jan-2026 00:00:00 +0000"`) {
		t.Errorf("INTERNALDATE format wrong: %q", wire)
	}
}

// ── 12. quoteIMAPString ────────────────────────────────────────────────────

// TestQuoteIMAPString_Escaping verifies double-quote / backslash escaping
// per RFC 3501 §4.3. We don't ship folder names that contain these, but
// the audit ratchet's safety net must not panic on unusual input.
func TestQuoteIMAPString_Escaping(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Sent", `"Sent"`},
		{"Odeslaná pošta", `"Odeslaná pošta"`},
		{`name"with`, `"name\"with"`},
		{`name\with`, `"name\\with"`},
		{"", `""`},
	}
	for _, c := range cases {
		got := quoteIMAPString(c.in)
		if got != c.want {
			t.Errorf("quoteIMAPString(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ── 13. \Seen flag must be present ────────────────────────────────────────

// TestAppendToSent_SeenFlag verifies the APPEND command carries the \Seen
// flag — without it, the message appears as "unread" in the operator's
// webmail, which is a confusing UX and breaks symmetry with native client
// behaviour (Outlook/Thunderbird/Seznam all set Sent items as seen).
func TestAppendToSent_SeenFlag(t *testing.T) {
	conn := newAppendConn(
		"A001 OK LOGIN\r\n",
		"A100 OK SELECT\r\n",
		"+ go\r\n",
		"A101 OK APPEND\r\n",
		"A001 OK LOGOUT\r\n",
	)
	err := appendToSentWithDial(context.Background(), goodMailbox(), []byte("x"),
		dialReturning(conn), fixedNow)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if !strings.Contains(conn.writtenString(), `APPEND "Sent" (\Seen)`) {
		t.Errorf("APPEND command missing \\Seen flag: %q", conn.writtenString())
	}
}

// ── 14. hasContinuationLine helper ────────────────────────────────────────

func TestHasContinuationLine(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want bool
	}{
		{"plain continuation", []byte("+ Ready for literal\r\n"), true},
		{"bare plus only", []byte("+\r\n"), true},
		{"untagged then cont", []byte("* OK something\r\n+ go\r\n"), true},
		{"no continuation", []byte("A001 NO foo\r\n"), false},
		{"plus inside quoted string", []byte("* OK \"+ literal\"\r\n"), false},
		{"empty input", []byte(""), false},
	}
	for _, c := range cases {
		got := hasContinuationLine(c.in)
		if got != c.want {
			t.Errorf("%s: hasContinuationLine(%q) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

// ── 15. BuildWireMIMEForAppend — basic shape ──────────────────────────────

// TestBuildWireMIMEForAppend_TextPlain verifies the text-only branch
// produces well-formed MIME with all the structural headers and the
// terminating CRLF before the body.
func TestBuildWireMIMEForAppend_TextPlain(t *testing.T) {
	headers := map[string]string{
		"Date":       "Mon, 09 May 2026 14:30:00 +0200",
		"Message-ID": "<m1@firma.cz>",
		"X-Mailer":   "Seznam Email 2.4.0",
	}
	out := BuildWireMIMEForAppend(
		`"Jan Novák" <jan@firma.cz>`,
		"recipient@gmail.com",
		"Nabídka spolupráce",
		"Dobrý den,\r\nrád bych se Vám představil.\r\n",
		"",
		headers,
	)
	s := string(out)
	required := []string{
		"From: \"Jan Novák\" <jan@firma.cz>\r\n",
		"To: recipient@gmail.com\r\n",
		"Subject: Nabídka spolupráce\r\n",
		"Date: Mon, 09 May 2026 14:30:00 +0200\r\n",
		"Message-ID: <m1@firma.cz>\r\n",
		"X-Mailer: Seznam Email 2.4.0\r\n",
		"MIME-Version: 1.0\r\n",
		"Content-Type: text/plain; charset=utf-8\r\n",
		"Dobrý den,\r\n",
	}
	for _, r := range required {
		if !strings.Contains(s, r) {
			t.Errorf("missing wire-MIME fragment %q\n--- full ---\n%s", r, s)
		}
	}
	// Header / body separator: blank line before body.
	if !strings.Contains(s, "\r\n\r\nDobrý den") {
		t.Errorf("missing header/body separator")
	}
}

// ── 16. BuildWireMIMEForAppend — multipart/alternative ────────────────────

// TestBuildWireMIMEForAppend_Multipart verifies the dual-part body when
// both bodyPlain and bodyHTML are set.
func TestBuildWireMIMEForAppend_Multipart(t *testing.T) {
	out := BuildWireMIMEForAppend(
		"sender@firma.cz",
		"recipient@x.cz",
		"Subject",
		"plain version",
		"<p>html version</p>",
		map[string]string{"Date": "Mon, 09 May 2026 14:30:00 +0200"},
	)
	s := string(out)
	if !strings.Contains(s, "multipart/alternative") {
		t.Errorf("missing multipart/alternative Content-Type:\n%s", s)
	}
	if !strings.Contains(s, "plain version") {
		t.Errorf("missing plain part")
	}
	if !strings.Contains(s, "<p>html version</p>") {
		t.Errorf("missing html part")
	}
	// Should have an opening and a closing boundary marker.
	openCount := strings.Count(s, "--app-")
	if openCount < 3 { // 2 part openers + 1 closer
		t.Errorf("expected ≥3 boundary occurrences, got %d:\n%s", openCount, s)
	}
}

// ── 17. BuildWireMIMEForAppend — no duplicate From/To/Subject ─────────────

// TestBuildWireMIMEForAppend_NoDuplicateStructuralHeaders verifies that
// callers who accidentally include From / To / Subject in the headers map
// do not cause duplicate RFC 5322 originator/destination lines on the
// wire (same skip-list defence as relay's BuildMessage).
func TestBuildWireMIMEForAppend_NoDuplicateStructuralHeaders(t *testing.T) {
	headers := map[string]string{
		"From":    "duplicate@from.cz",
		"To":      "duplicate@to.cz",
		"Subject": "duplicate subject",
		"Date":    "Mon, 09 May 2026 14:30:00 +0200",
	}
	out := BuildWireMIMEForAppend("real@firma.cz", "real@recipient.cz",
		"real subject", "body", "", headers)
	s := string(out)
	if c := strings.Count(s, "From: "); c != 1 {
		t.Errorf("expected 1 From header, got %d:\n%s", c, s)
	}
	if c := strings.Count(s, "To: "); c != 1 {
		t.Errorf("expected 1 To header, got %d", c)
	}
	if c := strings.Count(s, "Subject: "); c != 1 {
		t.Errorf("expected 1 Subject header, got %d", c)
	}
}

// ── 18. AuditAppendOutcome — nil DB ───────────────────────────────────────

// TestAuditAppendOutcome_NilDB_NoPanic verifies the wrapper doesn't panic
// when the audit DB is unwired (common in tests / dry-run mode).
func TestAuditAppendOutcome_NilDB_NoPanic(t *testing.T) {
	// Must not panic.
	AuditAppendOutcome(context.Background(), nil,
		"sender@firma.cz", "recipient@x.cz", "<m@h>", 1024, "Sent", nil)
	AuditAppendOutcome(context.Background(), nil,
		"sender@firma.cz", "recipient@x.cz", "<m@h>", 0, "", errors.New("failed"))
}
