package delivery

import (
	"bufio"
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
)

// ----------------------------------------------------------------------------
// Test scaffolding — in-memory IMAP scripted server + injected transport.
//
// The relay drain calls AppendToSent with a transport.AnonymousTransport;
// we inject a fake transport whose DialContext returns one end of a
// net.Pipe, and the other end is driven by a tiny scripted IMAP server
// running in a goroutine. This avoids spinning a real TCP listener and
// keeps tests deterministic + race-clean.
// ----------------------------------------------------------------------------

// pipeTransport implements transport.AnonymousTransport for tests.
// DialContext returns the client side of a net.Pipe; the server side
// is consumed by the scripted handler so the AppendToSent flow can
// LOGIN/SELECT/APPEND without touching real I/O.
type pipeTransport struct {
	handler func(server net.Conn)
	dialErr error
}

func (p *pipeTransport) DialContext(_ context.Context, _, _ string) (net.Conn, error) {
	if p.dialErr != nil {
		return nil, p.dialErr
	}
	client, server := net.Pipe()
	go p.handler(server)
	return client, nil
}

// scriptedIMAPServer replays a deterministic script against the
// client-driver. It expects the AppendToSent flow:
//
//	1) greeting → "* OK ready\r\n"
//	2) A100 LOGIN ...  → respond per loginResponse
//	3) A101N SELECT ... iterate through SentFolderCandidates until
//	   selectIndex hits, then respond OK; earlier names → NO
//	4) A102 APPEND ... → continuation "+ go ahead\r\n", then read
//	   literal, then "A102 OK ..." (or replace with appendResp).
//	5) A103 LOGOUT → "* BYE\r\n" + "A103 OK\r\n"
type scriptedConfig struct {
	greeting       string
	loginResp      string // "A100 OK ..." or "A100 NO ..."
	selectAcceptAt int    // 0-based index in SentFolderCandidates accepted; -1 = none
	appendCont     string // "+ go ahead\r\n" (default) or "" to skip continuation
	appendResp     string // "A102 OK ..." or "A102 NO ..."
	captureLiteral *bytes.Buffer
	skipLogout     bool
}

func runScriptedServer(t *testing.T, server net.Conn, cfg scriptedConfig) {
	t.Helper()
	defer server.Close()
	br := bufio.NewReader(server)

	send := func(s string) error {
		if err := server.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
			return err
		}
		_, err := server.Write([]byte(s))
		return err
	}
	readLine := func() (string, error) {
		if err := server.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			return "", err
		}
		line, err := br.ReadString('\n')
		return line, err
	}

	// 1. Greeting
	greet := cfg.greeting
	if greet == "" {
		greet = "* OK IMAP4rev1 ready\r\n"
	}
	if err := send(greet); err != nil {
		return
	}

	// 2. LOGIN
	line, err := readLine()
	if err != nil {
		return
	}
	if !strings.Contains(line, "LOGIN") {
		_ = send("A100 BAD expected LOGIN\r\n")
		return
	}
	loginResp := cfg.loginResp
	if loginResp == "" {
		loginResp = "A100 OK LOGIN completed\r\n"
	}
	if err := send(loginResp); err != nil {
		return
	}
	if !strings.HasPrefix(loginResp, "A100 OK") {
		return
	}

	// 3. SELECT iterations
	for i := range SentFolderCandidates {
		selLine, err := readLine()
		if err != nil {
			return
		}
		if !strings.Contains(selLine, "SELECT") {
			return
		}
		tag := fmt.Sprintf("A101%d", i)
		if cfg.selectAcceptAt == i {
			if err := send(tag + " OK SELECT completed\r\n"); err != nil {
				return
			}
			break
		}
		if err := send(tag + " NO no such mailbox\r\n"); err != nil {
			return
		}
		if cfg.selectAcceptAt < 0 && i == len(SentFolderCandidates)-1 {
			// All candidates exhausted; flow returns; logout may or may not be invoked.
			return
		}
	}
	if cfg.selectAcceptAt < 0 {
		return
	}

	// 4. APPEND
	appLine, err := readLine()
	if err != nil {
		return
	}
	if !strings.Contains(appLine, "APPEND") {
		return
	}
	// Parse {N} literal size
	openBrace := strings.LastIndex(appLine, "{")
	closeBrace := strings.LastIndex(appLine, "}")
	if openBrace < 0 || closeBrace <= openBrace {
		return
	}
	var size int
	fmt.Sscanf(appLine[openBrace+1:closeBrace], "%d", &size)

	cont := cfg.appendCont
	if cont == "" {
		cont = "+ Ready for literal\r\n"
	}
	if cont != "skip" {
		if err := send(cont); err != nil {
			return
		}
	}
	// Read N bytes literal + trailing CRLF
	literal := make([]byte, size)
	if _, err := io.ReadFull(br, literal); err != nil {
		return
	}
	_, _ = br.ReadString('\n') // consume CRLF after literal
	if cfg.captureLiteral != nil {
		cfg.captureLiteral.Write(literal)
	}
	appResp := cfg.appendResp
	if appResp == "" {
		appResp = "A102 OK APPEND completed\r\n"
	}
	if err := send(appResp); err != nil {
		return
	}

	if cfg.skipLogout {
		return
	}
	// 5. LOGOUT (best-effort, ignore failure)
	logoutLine, err := readLine()
	if err != nil {
		return
	}
	if strings.Contains(logoutLine, "LOGOUT") {
		_ = send("* BYE\r\n")
		_ = send("A103 OK LOGOUT completed\r\n")
	}
}

func validParams() AppendParams {
	return AppendParams{
		MailboxAddress: "sender@example.cz",
		IMAPHost:       "imap.example.cz",
		IMAPPort:       143, // plain TCP — TLS path tested separately when feasible
		Username:       "sender@example.cz",
		Password:       "hunter2",
		WireMIME:       []byte("From: a@b\r\nSubject: t\r\n\r\nhi\r\n"),
	}
}

// ----------------------------------------------------------------------------
// Test cases — covering ≥10 cases per memory feedback_extreme_testing.
// ----------------------------------------------------------------------------

// 1. Happy path: dial OK, login OK, first candidate SELECT OK, APPEND OK.
func TestAppendToSent_HappyPath(t *testing.T) {
	t.Parallel()
	captured := &bytes.Buffer{}
	tp := &pipeTransport{handler: func(s net.Conn) {
		runScriptedServer(t, s, scriptedConfig{
			selectAcceptAt: 0,
			captureLiteral: captured,
		})
	}}
	err := AppendToSent(context.Background(), tp, validParams())
	if err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
	if got := captured.String(); !strings.Contains(got, "Subject: t") {
		t.Errorf("server did not receive expected literal: %q", got)
	}
}

// 2. ErrNoIMAPCreds when IMAPHost is empty.
func TestAppendToSent_NoIMAPCreds_MissingHost(t *testing.T) {
	t.Parallel()
	p := validParams()
	p.IMAPHost = ""
	err := AppendToSent(context.Background(), &pipeTransport{}, p)
	if !errors.Is(err, ErrNoIMAPCreds) {
		t.Fatalf("expected ErrNoIMAPCreds, got %v", err)
	}
}

// 3. ErrNoIMAPCreds when IMAPPort is zero.
func TestAppendToSent_NoIMAPCreds_ZeroPort(t *testing.T) {
	t.Parallel()
	p := validParams()
	p.IMAPPort = 0
	err := AppendToSent(context.Background(), &pipeTransport{}, p)
	if !errors.Is(err, ErrNoIMAPCreds) {
		t.Fatalf("expected ErrNoIMAPCreds, got %v", err)
	}
}

// 4. ErrEmptyWireMIME when payload is empty.
func TestAppendToSent_EmptyWireMIME(t *testing.T) {
	t.Parallel()
	p := validParams()
	p.WireMIME = nil
	err := AppendToSent(context.Background(), &pipeTransport{}, p)
	if !errors.Is(err, ErrEmptyWireMIME) {
		t.Fatalf("expected ErrEmptyWireMIME, got %v", err)
	}
}

// 5. Dial fail propagates and is wrapped with a useful message.
func TestAppendToSent_DialFail(t *testing.T) {
	t.Parallel()
	tp := &pipeTransport{dialErr: errors.New("connection refused")}
	err := AppendToSent(context.Background(), tp, validParams())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "dial") {
		t.Errorf("expected dial in error, got %v", err)
	}
}

// 6. Login fail (server returns "A100 NO").
func TestAppendToSent_LoginFail(t *testing.T) {
	t.Parallel()
	tp := &pipeTransport{handler: func(s net.Conn) {
		runScriptedServer(t, s, scriptedConfig{
			loginResp: "A100 NO authentication failed\r\n",
		})
	}}
	err := AppendToSent(context.Background(), tp, validParams())
	if err == nil || !strings.Contains(err.Error(), "login") {
		t.Fatalf("expected login error, got %v", err)
	}
}

// 7. Folder fallback — first candidate NO, second OK.
func TestAppendToSent_FolderFallback(t *testing.T) {
	t.Parallel()
	tp := &pipeTransport{handler: func(s net.Conn) {
		runScriptedServer(t, s, scriptedConfig{
			selectAcceptAt: 1, // second candidate ("Odeslaná pošta")
		})
	}}
	if err := AppendToSent(context.Background(), tp, validParams()); err != nil {
		t.Fatalf("expected success via fallback, got %v", err)
	}
}

// 8. All folders rejected → no Sent folder accepted error.
func TestAppendToSent_NoFolderAccepted(t *testing.T) {
	t.Parallel()
	tp := &pipeTransport{handler: func(s net.Conn) {
		runScriptedServer(t, s, scriptedConfig{
			selectAcceptAt: -1,
		})
	}}
	err := AppendToSent(context.Background(), tp, validParams())
	if err == nil || !strings.Contains(err.Error(), "no Sent folder") {
		t.Fatalf("expected no Sent folder error, got %v", err)
	}
}

// 9. APPEND rejected by server (continuation skipped, BAD returned).
func TestAppendToSent_AppendRejected(t *testing.T) {
	t.Parallel()
	tp := &pipeTransport{handler: func(s net.Conn) {
		// Custom flow: greet+login+select then immediately A102 BAD.
		defer s.Close()
		br := bufio.NewReader(s)
		_, _ = s.Write([]byte("* OK ready\r\n"))
		_, _ = br.ReadString('\n')
		_, _ = s.Write([]byte("A100 OK LOGIN\r\n"))
		_, _ = br.ReadString('\n') // A1010 SELECT "Sent"
		_, _ = s.Write([]byte("A1010 OK SELECT\r\n"))
		_, _ = br.ReadString('\n') // A102 APPEND header
		_, _ = s.Write([]byte("A102 BAD quota exceeded\r\n"))
	}}
	err := AppendToSent(context.Background(), tp, validParams())
	if err == nil || !strings.Contains(err.Error(), "APPEND") {
		t.Fatalf("expected APPEND rejected error, got %v", err)
	}
}

// 10. INTERNALDATE format follows RFC 3501 §6.3.11 ("DD-Mon-YYYY HH:MM:SS +ZZZZ").
func TestAppendToSent_InternalDateFormat(t *testing.T) {
	t.Parallel()
	// Capture the APPEND header line so we can assert the date format.
	headerCh := make(chan string, 1)
	tp := &pipeTransport{handler: func(s net.Conn) {
		defer s.Close()
		br := bufio.NewReader(s)
		_, _ = s.Write([]byte("* OK ready\r\n"))
		_, _ = br.ReadString('\n')
		_, _ = s.Write([]byte("A100 OK\r\n"))
		_, _ = br.ReadString('\n')
		_, _ = s.Write([]byte("A1010 OK\r\n"))
		appLine, _ := br.ReadString('\n')
		headerCh <- appLine
		_, _ = s.Write([]byte("+ go\r\n"))
		_, _ = io.CopyN(io.Discard, br, int64(len(validParams().WireMIME)))
		_, _ = br.ReadString('\n')
		_, _ = s.Write([]byte("A102 OK\r\n"))
		_, _ = br.ReadString('\n')
		_, _ = s.Write([]byte("A103 OK\r\n"))
	}}
	pinned := time.Date(2026, 5, 11, 9, 30, 15, 0, time.FixedZone("CET", 2*3600))
	err := appendToSentWithClock(context.Background(), tp, validParams(), func() time.Time { return pinned })
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	hdr := <-headerCh
	// RFC 3501 §6.3.11 example: "11-May-2026 09:30:15 +0200"
	if !strings.Contains(hdr, `"11-May-2026 09:30:15 +0200"`) {
		t.Errorf("INTERNALDATE format wrong: %q", hdr)
	}
}

// 11. Nil transport → typed error, no panic.
func TestAppendToSent_NilTransport(t *testing.T) {
	t.Parallel()
	err := AppendToSent(context.Background(), nil, validParams())
	if err == nil || !strings.Contains(err.Error(), "transport is nil") {
		t.Fatalf("expected nil-transport error, got %v", err)
	}
}

// 12. Concurrent goroutines do not race (run with -race).
func TestAppendToSent_ConcurrentSafe(t *testing.T) {
	t.Parallel()
	var wg sync.WaitGroup
	const N = 8
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func() {
			defer wg.Done()
			tp := &pipeTransport{handler: func(s net.Conn) {
				runScriptedServer(t, s, scriptedConfig{selectAcceptAt: 0})
			}}
			_ = AppendToSent(context.Background(), tp, validParams())
		}()
	}
	wg.Wait()
}

// 13. BuildWireMIMEForAppend produces a parseable text/plain body when
// bodyHTML is empty, with structural From/To/Subject headers first.
func TestBuildWireMIMEForAppend_PlainOnly(t *testing.T) {
	t.Parallel()
	got := BuildWireMIMEForAppend("a@b", "c@d", "subj", "hello", "", map[string]string{
		"Date":      "Mon, 11 May 2026 10:00:00 +0200",
		"X-Mailer":  "test/1.0",
		"Reply-To":  "reply@b",
	})
	s := string(got)
	if !strings.HasPrefix(s, "From: a@b\r\nTo: c@d\r\nSubject: subj\r\n") {
		t.Errorf("structural headers in wrong order: %q", s)
	}
	if !strings.Contains(s, "Content-Type: text/plain") {
		t.Errorf("missing text/plain content type: %q", s)
	}
	if !strings.Contains(s, "Reply-To: reply@b") {
		t.Errorf("missing custom Reply-To: %q", s)
	}
	if !strings.Contains(s, "hello") {
		t.Errorf("missing body: %q", s)
	}
}

// 14. BuildWireMIMEForAppend produces multipart/alternative when
// bodyHTML is non-empty.
func TestBuildWireMIMEForAppend_Multipart(t *testing.T) {
	t.Parallel()
	got := BuildWireMIMEForAppend("a@b", "c@d", "subj", "plain body", "<p>html</p>", nil)
	s := string(got)
	if !strings.Contains(s, "multipart/alternative") {
		t.Errorf("expected multipart/alternative, got %q", s)
	}
	if !strings.Contains(s, "<p>html</p>") {
		t.Errorf("missing HTML body: %q", s)
	}
	if !strings.Contains(s, "plain body") {
		t.Errorf("missing plain body: %q", s)
	}
}

// 15. quoteIMAPString escapes backslash + double-quote per RFC 3501 §4.3.
func TestQuoteIMAPString_Escaping(t *testing.T) {
	t.Parallel()
	got := quoteIMAPString(`weird"name\here`)
	want := `"weird\"name\\here"`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// 16. hasContinuationLine detects "+ " prefix and bare "+".
func TestHasContinuationLine(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		buf  []byte
		want bool
	}{
		{"bare-plus", []byte("+"), true},
		{"plus-space", []byte("+ go\r\n"), true},
		{"multi-line", []byte("* OK\r\n+ go\r\n"), true},
		{"no-plus", []byte("A102 OK\r\n"), false},
		{"plus-in-quoted-not-line-start", []byte(`* OK "+ inside"`), false},
	}
	for _, tc := range cases {
		if got := hasContinuationLine(tc.buf); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}
