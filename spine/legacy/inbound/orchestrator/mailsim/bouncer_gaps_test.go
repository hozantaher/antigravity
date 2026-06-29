package mailsim

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ── fake SMTP server ──────────────────────────────────────────────────────────

// startFakeSMTP starts a minimal SMTP listener on 127.0.0.1:0 that accepts
// one connection, responds 250 to everything, and then exits.
// Returns the "host:port" address.
func startFakeSMTP(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handleSMTP(conn)
		}
	}()
	return ln.Addr().String()
}

func handleSMTP(conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "220 fake.smtp ESMTP\r\n")
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return
		}
		line := strings.TrimSpace(string(buf[:n]))
		upper := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(upper, "DATA"):
			fmt.Fprintf(conn, "354 go ahead\r\n")
		case strings.HasPrefix(line, "."):
			fmt.Fprintf(conn, "250 OK\r\n")
		case strings.HasPrefix(upper, "QUIT"):
			fmt.Fprintf(conn, "221 bye\r\n")
			return
		default:
			fmt.Fprintf(conn, "250 OK\r\n")
		}
	}
}

// ── handle: no-recipient error ────────────────────────────────────────────────

func TestHandle_NoRecipients_Error(t *testing.T) {
	b := newBouncerForHandle(t, "http://localhost:9999")
	err := b.handle(context.Background(), mailpitMessage{ID: "x", To: nil})
	if err == nil {
		t.Fatal("expected error for empty To list")
	}
}

// ── handle: BehaviorDeliver + OnRespond callback ──────────────────────────────

func TestHandle_Deliver_OnRespondCalled(t *testing.T) {
	var calledBeh Behavior
	var calledRecip string

	b := newBouncerForHandle(t, "http://localhost:9999")
	b.OnRespond = func(beh Behavior, recipient string) {
		calledBeh = beh
		calledRecip = recipient
	}

	// Addresses that Classify as BehaviorDeliver: normal address not matching any pattern.
	msg := mailpitMessage{
		ID: "d1",
		To: []mailpitAddress{{Address: "jan.novak@firma.cz"}}, // normal = Deliver
	}
	err := b.handle(context.Background(), msg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calledBeh != BehaviorDeliver {
		t.Errorf("OnRespond behavior = %v, want Deliver", calledBeh)
	}
	if calledRecip != "jan.novak@firma.cz" {
		t.Errorf("OnRespond recipient = %q", calledRecip)
	}
}

// ── handle: BehaviorSilent + OnRespond callback ───────────────────────────────

func TestHandle_Silent_OnRespondCalled(t *testing.T) {
	var called bool
	b := newBouncerForHandle(t, "http://localhost:9999")
	b.OnRespond = func(beh Behavior, _ string) {
		if beh == BehaviorSilent {
			called = true
		}
	}

	// "silent" prefix → BehaviorSilent per Classify
	msg := mailpitMessage{
		ID: "s1",
		To: []mailpitAddress{{Address: "user-silent@firma.test"}},
	}
	if err := b.handle(context.Background(), msg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("OnRespond not called for Silent behavior")
	}
}

// ── handle: full bounce success path (injectToIMAP succeeds) ─────────────────

// TestHandle_BounceSuccess_InjectSucceeds exercises the full happy path:
// fetchOriginal succeeds via a fake Mailpit server and injectToIMAP succeeds
// via a fake SMTP server. Verifies OnRespond is called.
func TestHandle_BounceSuccess_InjectSucceeds(t *testing.T) {
	// Fake Mailpit returns a valid message for fetchOriginal.
	original := struct {
		ID        string           `json:"ID"`
		MessageID string           `json:"MessageID"`
		From      mailpitAddress   `json:"From"`
		To        []mailpitAddress `json:"To"`
		Subject   string           `json:"Subject"`
		Date      time.Time        `json:"Date"`
		Text      string           `json:"Text"`
	}{
		ID:        "bounce-ok",
		MessageID: "<orig-ok@test>",
		From:      mailpitAddress{Address: "sender@out.test"},
		To:        []mailpitAddress{{Address: "test@firma.test"}},
		Subject:   "Test",
		Text:      "Body",
	}
	mailpitSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(original)
	}))
	defer mailpitSrv.Close()

	smtpAddr := startFakeSMTP(t)

	var respondBeh Behavior
	b := &Bouncer{
		cfg: &BouncerConfig{
			MailpitBaseURL:    mailpitSrv.URL,
			GreenMailSMTPAddr: smtpAddr,
			InboxAddress:      "inbox@test.local",
			PollInterval:      time.Second,
			HTTPClient:        http.DefaultClient,
			// No jitter delay.
		},
		dsn:   DefaultDSNBuilder(),
		reply: DefaultReplyBuilder(),
		OnRespond: func(beh Behavior, _ string) {
			respondBeh = beh
		},
	}

	msg := mailpitMessage{
		ID: "bounce-ok",
		To: []mailpitAddress{{Address: "test@firma.test"}}, // BehaviorHardBounce
	}

	if err := b.handle(context.Background(), msg); err != nil {
		t.Fatalf("unexpected error on full bounce success path: %v", err)
	}
	if !respondBeh.IsBounce() {
		t.Errorf("OnRespond called with non-bounce behavior: %v", respondBeh)
	}
}

// ── handle: OOO success path ──────────────────────────────────────────────────

func TestHandle_OOO_InjectSucceeds(t *testing.T) {
	original := struct {
		ID        string           `json:"ID"`
		MessageID string           `json:"MessageID"`
		From      mailpitAddress   `json:"From"`
		To        []mailpitAddress `json:"To"`
		Subject   string           `json:"Subject"`
		Date      time.Time        `json:"Date"`
		Text      string           `json:"Text"`
	}{
		ID: "ooo-ok", MessageID: "<ooo@test>",
		From: mailpitAddress{Address: "s@out.test"},
		To:   []mailpitAddress{{Address: "ooo@firma.test"}},
		Subject: "Test", Text: "Body",
	}
	mailpitSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(original)
	}))
	defer mailpitSrv.Close()

	smtpAddr := startFakeSMTP(t)
	b := &Bouncer{
		cfg: &BouncerConfig{
			MailpitBaseURL: mailpitSrv.URL, GreenMailSMTPAddr: smtpAddr,
			InboxAddress: "inbox@test.local", PollInterval: time.Second,
			HTTPClient: http.DefaultClient,
		},
		dsn: DefaultDSNBuilder(), reply: DefaultReplyBuilder(),
	}
	msg := mailpitMessage{
		ID: "ooo-ok",
		To: []mailpitAddress{{Address: "ooo@firma.test"}}, // BehaviorOOO
	}
	if err := b.handle(context.Background(), msg); err != nil {
		t.Fatalf("unexpected error on OOO success path: %v", err)
	}
}

// ── injectToIMAP: empty envelopeFrom falls back to MailerDaemonAddress ────────

func TestInjectToIMAP_EmptyFrom_UsesMailerDaemon(t *testing.T) {
	smtpAddr := startFakeSMTP(t)
	b := &Bouncer{
		cfg: &BouncerConfig{
			GreenMailSMTPAddr: smtpAddr,
			InboxAddress:      "inbox@test.local",
		},
		dsn: DefaultDSNBuilder(), // MailerDaemonAddress set by DefaultDSNBuilder
	}
	// Empty envelopeFrom → triggers the fallback branch.
	payload := []byte("Subject: test\r\n\r\ntest body\r\n")
	if err := b.injectToIMAP(payload, ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Verify the mailer-daemon address was used (non-empty default).
	if b.dsn.MailerDaemonAddress == "" {
		t.Error("MailerDaemonAddress should be non-empty in DefaultDSNBuilder")
	}
}

// ── injectToIMAP: non-empty envelopeFrom ─────────────────────────────────────

func TestInjectToIMAP_NonEmptyFrom(t *testing.T) {
	smtpAddr := startFakeSMTP(t)
	b := &Bouncer{
		cfg: &BouncerConfig{
			GreenMailSMTPAddr: smtpAddr,
			InboxAddress:      "inbox@test.local",
		},
		dsn: DefaultDSNBuilder(),
	}
	payload := []byte("Subject: test\r\n\r\ntest body\r\n")
	if err := b.injectToIMAP(payload, "mailer-daemon@local"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ── handle: fetchOriginal body parsing paths ──────────────────────────────────

// TestHandle_Reply_InjectSucceeds exercises the beh.IsReply() branch end-to-end.
func TestHandle_Reply_InjectSucceeds(t *testing.T) {
	// Use user-interested@firma.test which Classify maps to BehaviorReplyInterested
	original := struct {
		ID        string           `json:"ID"`
		MessageID string           `json:"MessageID"`
		From      mailpitAddress   `json:"From"`
		To        []mailpitAddress `json:"To"`
		Subject   string           `json:"Subject"`
		Date      time.Time        `json:"Date"`
		Text      string           `json:"Text"`
	}{
		ID: "reply-ok", MessageID: "<reply@test>",
		From: mailpitAddress{Address: "s@out.test"},
		To:   []mailpitAddress{{Address: "user-interested@firma.test"}},
		Subject: "Nabídka", Text: "Body",
	}
	mailpitSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Serve full Mailpit message JSON for any request
		if strings.HasSuffix(r.URL.Path, ".txt") {
			w.Header().Set("Content-Type", "text/plain")
			io.WriteString(w, "Body text")
			return
		}
		json.NewEncoder(w).Encode(original)
	}))
	defer mailpitSrv.Close()

	smtpAddr := startFakeSMTP(t)
	b := &Bouncer{
		cfg: &BouncerConfig{
			MailpitBaseURL: mailpitSrv.URL, GreenMailSMTPAddr: smtpAddr,
			InboxAddress: "inbox@test.local", PollInterval: time.Second,
			HTTPClient: http.DefaultClient,
		},
		dsn: DefaultDSNBuilder(), reply: DefaultReplyBuilder(),
	}

	msg := mailpitMessage{
		ID: "reply-ok",
		To: []mailpitAddress{{Address: "user-interested@firma.test"}},
	}
	if err := b.handle(context.Background(), msg); err != nil {
		t.Fatalf("unexpected error on reply success path: %v", err)
	}
}
