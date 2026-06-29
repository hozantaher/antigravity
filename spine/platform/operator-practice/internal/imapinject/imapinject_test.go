package imapinject

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// TestAssertLabHost_AcceptsLab — explicit allow.
func TestAssertLabHost_AcceptsLab(t *testing.T) {
	for _, host := range []string{"mail-lab-gmail", "lab-host.example", "internal.lab", "127.0.0.1", "localhost", "10.20.0.5", "192.168.1.10"} {
		if err := AssertLabHost(host); err != nil {
			t.Errorf("AssertLabHost(%q) errored: %v", host, err)
		}
	}
}

// TestAssertLabHost_RejectsRealProvider — operator typo defence.
func TestAssertLabHost_RejectsRealProvider(t *testing.T) {
	for _, host := range []string{"smtp.seznam.cz", "imap.gmail.com", "smtp.outlook.com", "outlook.office365.com"} {
		if err := AssertLabHost(host); err == nil {
			t.Errorf("AssertLabHost(%q) should have rejected", host)
		}
	}
}

// TestAssertLabHost_RejectsEmpty — empty host is configuration error.
func TestAssertLabHost_RejectsEmpty(t *testing.T) {
	if err := AssertLabHost(""); err == nil {
		t.Fatalf("expected error for empty host")
	}
}

// TestAssertLabHost_RejectsUnknownPublicHost — default deny on
// anything that isn't obviously lab/private.
func TestAssertLabHost_RejectsUnknownPublicHost(t *testing.T) {
	if err := AssertLabHost("mail.example.com"); err == nil {
		t.Fatalf("expected default-deny for public host")
	}
}

// fakeIMAPServer accepts a single TCP connection and replays a scripted
// dialog. Returns the listener (already accepting in a goroutine) and
// the chosen port. Tests call Close() to tear down.
type fakeIMAPServer struct {
	listener net.Listener
	port     int
	script   []string // strings to write back, in order
	expect   []string // substrings expected on each client line
	t        *testing.T
}

func newFakeIMAP(t *testing.T, expect, script []string) *fakeIMAPServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	srv := &fakeIMAPServer{listener: ln, port: port, script: script, expect: expect, t: t}
	go srv.serve()
	return srv
}

func (s *fakeIMAPServer) serve() {
	conn, err := s.listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()

	r := bufio.NewReader(conn)

	// First reply is the greeting; send it before reading the first command.
	if len(s.script) > 0 {
		_, _ = conn.Write([]byte(s.script[0]))
		s.script = s.script[1:]
	}

	for i := 0; i < len(s.expect); i++ {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		// For APPEND we need to echo the literal-bytes branch.
		if strings.Contains(line, "APPEND") {
			_, _ = conn.Write([]byte("+ Ready\r\n"))
			// drain literal bytes — read until we see CRLF after literal
			// (server simulates "got it" then sends tagged OK)
			// Determine literal length:
			start := strings.LastIndex(line, "{")
			end := strings.LastIndex(line, "}")
			n := 0
			if start >= 0 && end > start {
				_, _ = fmt.Sscanf(line[start+1:end], "%d", &n)
			}
			read := 0
			buf := make([]byte, 4096)
			for read < n {
				m, err := r.Read(buf[:min(len(buf), n-read)])
				if err != nil {
					return
				}
				read += m
			}
			// We do NOT additionally read a trailing CRLF — the client
			// writes the literal followed by no extra terminator, which
			// matches how the production code path encodes APPEND.
		}
		if i < len(s.script) {
			_, _ = conn.Write([]byte(s.script[i]))
		}
	}
}

func (s *fakeIMAPServer) Close() error { return s.listener.Close() }

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// TestNew_ReadsGreeting — happy path establishment + greeting.
func TestNew_ReadsGreeting(t *testing.T) {
	srv := newFakeIMAP(t, []string{}, []string{"* OK Lab IMAP ready\r\n"})
	defer srv.Close()

	c, err := New(Config{
		Host:    "127.0.0.1",
		Port:    srv.port,
		Timeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_ = c.Close()
}

// TestNew_RefusesRealProvider — host gate fires before dial.
func TestNew_RefusesRealProvider(t *testing.T) {
	if _, err := New(Config{Host: "smtp.gmail.com", Port: 993}); err == nil {
		t.Fatalf("expected lab-host rejection")
	}
}

// TestLogin_HappyPath — LOGIN succeeds and returns nil.
func TestLogin_HappyPath(t *testing.T) {
	srv := newFakeIMAP(t,
		[]string{"LOGIN"},
		[]string{
			"* OK Lab IMAP ready\r\n",
			"A0001 OK LOGIN completed\r\n",
		},
	)
	defer srv.Close()

	c, err := New(Config{Host: "127.0.0.1", Port: srv.port, Username: "u", Password: "p", Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()
	if err := c.Login(); err != nil {
		t.Fatalf("login: %v", err)
	}
}

// TestAppend_HappyPath — APPEND with literal-bytes flow.
func TestAppend_HappyPath(t *testing.T) {
	srv := newFakeIMAP(t,
		[]string{"LOGIN", "APPEND"},
		[]string{
			"* OK Lab IMAP ready\r\n",
			"A0001 OK LOGIN completed\r\n",
			"A0002 OK APPEND completed\r\n",
		},
	)
	defer srv.Close()

	c, err := New(Config{Host: "127.0.0.1", Port: srv.port, Username: "u", Password: "p", Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()
	if err := c.Login(); err != nil {
		t.Fatalf("login: %v", err)
	}
	if err := c.Append("From: a@b\r\n\r\nhi"); err != nil {
		t.Fatalf("append: %v", err)
	}
}

// TestAppend_RejectsBadResponse — when server returns NO/BAD we
// surface the failure.
func TestAppend_RejectsBadResponse(t *testing.T) {
	srv := newFakeIMAP(t,
		[]string{"LOGIN", "APPEND"},
		[]string{
			"* OK Lab IMAP ready\r\n",
			"A0001 OK LOGIN completed\r\n",
			"A0002 NO APPEND failed quota exceeded\r\n",
		},
	)
	defer srv.Close()

	c, err := New(Config{Host: "127.0.0.1", Port: srv.port, Username: "u", Password: "p", Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()
	if err := c.Login(); err != nil {
		t.Fatalf("login: %v", err)
	}
	if err := c.Append("hi"); err == nil {
		t.Fatalf("expected NO surfaced as error")
	}
}

// TestEscape_StripsLF — passwords with embedded \n must not corrupt
// the IMAP grammar.
func TestEscape_StripsLF(t *testing.T) {
	got := escape("p\rword\nbreak")
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("escape must strip CRLF; got %q", got)
	}
}

// TestEscape_DoublesQuotes — IMAP quoted strings escape " as \".
func TestEscape_DoublesQuotes(t *testing.T) {
	got := escape(`pa"ss`)
	if !strings.Contains(got, `\"`) {
		t.Fatalf("escape must double quotes; got %q", got)
	}
}

// TestNew_DialFailure surfaces the wrapped error.
func TestNew_DialFailure(t *testing.T) {
	if _, err := New(Config{Host: "127.0.0.1", Port: 1, Timeout: 200 * time.Millisecond}); err == nil {
		t.Fatalf("expected dial failure on port 1")
	}
}

// TestConfig_DefaultFolder — empty folder defaults to INBOX.
func TestConfig_DefaultFolder(t *testing.T) {
	cfg := Config{}
	if cfg.folder() != "INBOX" {
		t.Fatalf("expected default INBOX; got %q", cfg.folder())
	}
}

// TestConfig_DefaultTimeout — empty timeout defaults to 10s.
func TestConfig_DefaultTimeout(t *testing.T) {
	cfg := Config{}
	if cfg.timeout() != 10*time.Second {
		t.Fatalf("expected 10s default; got %v", cfg.timeout())
	}
}
