//go:build integration

package imap

import (
	"context"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"testing"
	"time"

	"common/config"
)

func skipIfNoGreenMail(t *testing.T) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", "localhost:1025", time.Second)
	if err != nil {
		t.Skipf("GreenMail not running (SMTP:1025): %v", err)
	}
	conn.Close()

	conn, err = net.DialTimeout("tcp", "localhost:1143", time.Second)
	if err != nil {
		t.Skipf("GreenMail not running (IMAP:1143): %v", err)
	}
	conn.Close()
}

func TestIntegration_Mailbox_SendAndPoll(t *testing.T) {
	skipIfNoGreenMail(t)

	ctx := context.Background()
	ts := time.Now().UnixNano()
	uniqueID := fmt.Sprintf("test-%d@local.dev", ts)
	subject := fmt.Sprintf("Integration Test %d", ts)
	body := "Dobry den, toto je testovaci e-mail pro IMAP poller."

	// ── Step 1: Send email via SMTP ──
	// GreenMail: recipient must match IMAP login user (test@local.dev)
	msg := fmt.Sprintf("From: sender@local.dev\r\n"+
		"To: test@local.dev\r\n"+
		"Subject: %s\r\n"+
		"Message-ID: <%s>\r\n"+
		"Date: %s\r\n"+
		"Content-Type: text/plain; charset=utf-8\r\n"+
		"\r\n"+
		"%s\r\n",
		subject, uniqueID, time.Now().Format(time.RFC1123Z), body)

	client, err := smtp.Dial("localhost:1025")
	if err != nil {
		t.Fatalf("smtp dial: %v", err)
	}
	defer func() {
		if err := client.Quit(); err != nil {
			t.Logf("SMTP QUIT: %v", err)
		}
	}()

	if err := client.Mail("sender@local.dev"); err != nil {
		t.Fatalf("MAIL FROM: %v", err)
	}
	if err := client.Rcpt("test@local.dev"); err != nil {
		t.Fatalf("RCPT TO: %v", err)
	}
	w, err := client.Data()
	if err != nil {
		t.Fatalf("DATA: %v", err)
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close data: %v", err)
	}

	t.Log("Email sent via SMTP")

	// ── Step 2: Wait for GreenMail to process ──
	time.Sleep(2 * time.Second)

	// ── Step 3: Connect to IMAP and fetch ──
	mb := config.MailboxConfig{
		IMAPHost: "localhost",
		IMAPPort: 1143,
		Username: "test",
		Password: "test",
	}

	conn, err := connect(ctx, mb)
	if err != nil {
		t.Fatalf("imap connect: %v", err)
	}
	defer conn.Close()

	// LOGIN — GreenMail user: test / test (domain=local.dev)
	if err := command(conn, "LOGIN test test"); err != nil {
		t.Fatalf("LOGIN: %v", err)
	}

	// SELECT INBOX
	if err := command(conn, "SELECT INBOX"); err != nil {
		t.Fatalf("SELECT: %v", err)
	}

	// SEARCH UNSEEN
	response, err := commandResponse(conn, "SEARCH UNSEEN")
	if err != nil {
		t.Fatalf("SEARCH: %v", err)
	}

	uids := parseSearchResponse(response)
	if len(uids) == 0 {
		t.Fatal("no unseen messages found in GreenMail INBOX")
	}
	t.Logf("Found %d unseen messages, UIDs: %v", len(uids), uids)

	// ── Step 4: Fetch the last message and verify ──
	lastUID := uids[len(uids)-1]
	fetched, err := fetchMessage(conn, lastUID)
	if err != nil {
		t.Fatalf("FETCH uid %s: %v", lastUID, err)
	}

	if fetched == nil {
		t.Fatal("fetchMessage returned nil")
	}

	t.Logf("Fetched message: Subject=%q From=%q MessageID=%q Body=%q",
		fetched.Subject, fetched.From, fetched.MessageID, fetched.BodyPlain)

	// Verify Message-ID matches the one we sent
	wantMsgID := "<" + uniqueID + ">"
	if fetched.MessageID != wantMsgID {
		t.Errorf("message-id mismatch: want %q, got %q", wantMsgID, fetched.MessageID)
	}

	// Verify subject (exact match)
	if fetched.Subject != subject {
		t.Errorf("subject mismatch: want %q, got %q", subject, fetched.Subject)
	}

	// Verify from
	if !strings.Contains(fetched.From, "sender@local.dev") {
		t.Errorf("from mismatch: got %q", fetched.From)
	}

	// Verify body contains expected text
	if !strings.Contains(fetched.BodyPlain, "testovaci") {
		t.Errorf("body mismatch: got %q", fetched.BodyPlain)
	}

	// LOGOUT
	command(conn, "LOGOUT") //nolint:errcheck
	t.Log("Integration test passed: send → IMAP poll → verify")
}
