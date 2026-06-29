package imap

import (
	"context"
	"fmt"
	"net"
	"strings"
	"testing"

	"common/config"
)

// scriptDial returns a dialer that always hands back the given conn — used to
// inject a scriptConn into fetchMailboxDirect without real network I/O. The
// injected dial bypasses connect()'s greeting read, so the script starts at the
// LOGIN response (mirrors the doFetch unit tests).
func scriptDial(conn net.Conn) func(context.Context, config.MailboxConfig) (net.Conn, error) {
	return func(context.Context, config.MailboxConfig) (net.Conn, error) { return conn, nil }
}

func TestFetchMailboxDirect_WithMessages(t *testing.T) {
	// Full RFC822 message returned via BODY[] (the modern path post.cz uses) so
	// RawBytes is populated — ImapPollLoop skips messages with empty RawBody.
	rawMsg := "Message-ID: <msg7@test.cz>\r\n" +
		"From: sender@test.cz\r\n" +
		"Subject: Re: Dotaz\r\n" +
		"Date: Wed, 03 Jun 2026 21:15:41 +0200\r\n" +
		"\r\n" +
		"Mám zájem, ozvěte se.\r\n"
	fetchResp := fmt.Sprintf("* 1 FETCH (UID 7 BODY[] {%d}\r\n%s)\r\nA003 OK FETCH completed\r\n", len(rawMsg), rawMsg)

	conn := newScriptConn(
		"A001 OK LOGIN completed\r\n",
		"* OK [UIDVALIDITY 99001] selected\r\nA001 OK SELECT completed\r\n",
		"A001 OK NOOP completed\r\n",
		"* SEARCH 7\r\nA002 OK SEARCH completed\r\n",
		fetchResp,
		"A001 OK LOGOUT completed\r\n",
	)

	mb := config.MailboxConfig{Address: "hozan@post.cz", Username: "u", Password: "p", IMAPHost: "imap.seznam.cz", IMAPPort: 993}
	res, err := fetchMailboxDirect(context.Background(), mb, 0, scriptDial(conn))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.UIDValidity != 99001 {
		t.Errorf("UIDValidity = %d, want 99001", res.UIDValidity)
	}
	if len(res.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(res.Messages))
	}
	m := res.Messages[0]
	if m.UID != 7 {
		t.Errorf("UID = %d, want 7", m.UID)
	}
	if !strings.Contains(m.Inbound.MessageID, "msg7@test.cz") {
		t.Errorf("MessageID = %q, want it to contain msg7@test.cz", m.Inbound.MessageID)
	}
	if len(m.Inbound.RawBytes) == 0 {
		t.Error("RawBytes empty — ImapPollLoop would skip this message")
	}
}

func TestFetchMailboxDirect_SinceUIDUsesUIDRange(t *testing.T) {
	// With a non-zero watermark, the search must be `UID SEARCH UID <wm+1>:*`
	// (resume-by-UID, independent of \Seen) — not UNSEEN.
	conn := newScriptConn(
		"A001 OK LOGIN completed\r\n",
		"* OK [UIDVALIDITY 99001] selected\r\nA001 OK SELECT completed\r\n",
		"A001 OK NOOP completed\r\n",
		"A002 OK SEARCH completed\r\n", // no new UIDs above the watermark
		"A001 OK LOGOUT completed\r\n",
	)
	mb := config.MailboxConfig{Address: "hozan@post.cz", Username: "u", Password: "p", IMAPHost: "imap.seznam.cz", IMAPPort: 993}
	res, err := fetchMailboxDirect(context.Background(), mb, 100, scriptDial(conn))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Messages) != 0 {
		t.Errorf("expected 0 new messages, got %d", len(res.Messages))
	}
	if got := conn.written.String(); !strings.Contains(got, "UID SEARCH UID 101:*") {
		t.Errorf("expected resume-by-UID search command, sent: %q", got)
	}
}

func TestConnect_AllowImapDirect_ForcesDirectForCZ(t *testing.T) {
	// Regression: resolveImapSOCKSAddr("CZ") returns a hardcoded 127.0.0.1:1080
	// default. ALLOW_IMAP_DIRECT=1 must short-circuit resolution and attempt a
	// DIRECT dial — not a SOCKS5 dial to that dead in-relay port.
	t.Setenv("ALLOW_IMAP_DIRECT", "1")
	t.Setenv("IMAP_SOCKS_CZ", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	mb := config.MailboxConfig{Address: "x@post.cz", IMAPHost: "127.0.0.1", IMAPPort: 9, PreferredCountry: "CZ"}
	_, err := connect(context.Background(), mb)
	if err == nil {
		t.Skip("port 9 unexpectedly open; skipping")
	}
	if strings.Contains(strings.ToLower(err.Error()), "socks") {
		t.Errorf("ALLOW_IMAP_DIRECT=1 must force a direct dial, but error mentions socks: %v", err)
	}
	if !strings.Contains(err.Error(), "127.0.0.1:9") {
		t.Errorf("expected dial error against the real host:port, got: %v", err)
	}
}

func TestFetchMailboxDirect_DialError(t *testing.T) {
	mb := config.MailboxConfig{Address: "x@post.cz", Username: "u", Password: "p", IMAPHost: "imap.seznam.cz", IMAPPort: 993}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancelled ctx → runWithReconnect bails, fetch returns error
	_, err := fetchMailboxDirect(ctx, mb, 0, func(context.Context, config.MailboxConfig) (net.Conn, error) {
		return nil, fmt.Errorf("dial refused")
	})
	if err == nil {
		t.Fatal("expected error when dial fails and ctx is cancelled")
	}
}
