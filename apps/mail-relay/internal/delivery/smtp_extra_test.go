package delivery

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"relay/internal/model"
)

// ---------------------------------------------------------------------------
// encodeSubject
// ---------------------------------------------------------------------------

func TestEncodeSubjectASCII(t *testing.T) {
	got := encodeSubject("Hello World")
	if got != "Hello World" {
		t.Fatalf("pure ASCII should pass through unchanged, got %q", got)
	}
}

func TestEncodeSubjectNonASCII(t *testing.T) {
	input := "Héllo"
	got := encodeSubject(input)
	if !strings.HasPrefix(got, "=?utf-8?b?") || !strings.HasSuffix(got, "?=") {
		t.Fatalf("non-ASCII should be RFC 2047 encoded, got %q", got)
	}
	// Verify the base64 payload decodes back to the original string.
	inner := strings.TrimPrefix(strings.TrimSuffix(got, "?="), "=?utf-8?b?")
	decoded, err := base64.StdEncoding.DecodeString(inner)
	if err != nil {
		t.Fatalf("base64 decode error: %v", err)
	}
	if string(decoded) != input {
		t.Fatalf("decoded %q, want %q", decoded, input)
	}
}

func TestEncodeSubjectStripsInjection(t *testing.T) {
	got := encodeSubject("Bad\r\nHeader: injected")
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("CR/LF must be stripped, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// generateBoundary
// ---------------------------------------------------------------------------

func TestGenerateBoundaryUnique(t *testing.T) {
	b1 := generateBoundary()
	b2 := generateBoundary()
	if b1 == b2 {
		t.Fatal("successive boundaries should differ")
	}
	if !strings.HasPrefix(b1, "----=_Part_") {
		t.Fatalf("unexpected prefix in boundary %q", b1)
	}
}

// ---------------------------------------------------------------------------
// BuildMessage — plain text only
// ---------------------------------------------------------------------------

func TestBuildMessagePlainOnly(t *testing.T) {
	msg := BuildMessage("a@a.com", []string{"b@b.com"}, "Hi", "body text", "", nil)
	s := string(msg)

	assertContains(t, s, "From: a@a.com")
	assertContains(t, s, "To: b@b.com")
	assertContains(t, s, "Subject: Hi")
	assertContains(t, s, "Content-Type: text/plain; charset=utf-8")
	assertContains(t, s, "body text")
	// Must NOT have multipart boundary
	if strings.Contains(s, "boundary=") {
		t.Fatal("should not have multipart boundary for plain-only message")
	}
}

func TestBuildMessagePlainOnlyMIMEVersion(t *testing.T) {
	msg := BuildMessage("a@a.com", []string{"b@b.com"}, "Sub", "body", "", nil)
	s := string(msg)
	assertContains(t, s, "MIME-Version: 1.0")
}

// ---------------------------------------------------------------------------
// BuildMessage — multipart/alternative
// ---------------------------------------------------------------------------

func TestBuildMessageMultipart(t *testing.T) {
	msg := BuildMessage("a@a.com", []string{"b@b.com"}, "Sub", "plain body", "<b>html body</b>", nil)
	s := string(msg)

	assertContains(t, s, "multipart/alternative")
	assertContains(t, s, "text/plain")
	assertContains(t, s, "text/html")
	assertContains(t, s, "plain body")
	assertContains(t, s, "<b>html body</b>")
}

func TestBuildMessageMultipartBoundaryFenced(t *testing.T) {
	msg := BuildMessage("a@a.com", []string{"b@b.com"}, "Sub", "plain", "<p>html</p>", nil)
	s := string(msg)
	// Opening and closing boundary markers must both be present.
	if !strings.Contains(s, "--\r\n") {
		t.Fatal("closing boundary (-- suffix) not found")
	}
}

// ---------------------------------------------------------------------------
// BuildMessage — fingerprint headers
// ---------------------------------------------------------------------------

func TestBuildMessageFingerprintHeaders(t *testing.T) {
	headers := map[string]string{
		"Date":       "Mon, 07 Apr 2025 10:00:00 +0000",
		"Message-ID": "<abc123@seznam.cz>",
		"X-Mailer":   "Mozilla/5.0",
	}
	msg := BuildMessage("a@a.com", []string{"b@b.com"}, "Sub", "body", "", headers)
	s := string(msg)

	// Date passes through — it is not a privacy-sensitive header.
	assertContains(t, s, "Date: Mon, 07 Apr 2025 10:00:00 +0000")

	// Message-ID is anonymized: the original seznam.cz value is replaced with a
	// random identifier whose right-hand side is the sender's FQDN ("a.com")
	// by the privacy pipeline in BuildMessage. The previous behaviour used
	// the bare label "@relay>" which is not RFC 5322 §3.6.4 compliant and
	// triggered Seznam silent spam drop.
	if strings.Contains(s, "Message-ID: <abc123@seznam.cz>") {
		t.Fatal("original Message-ID must not survive the privacy pipeline")
	}
	if strings.Contains(s, "@relay>") {
		t.Fatal("legacy '@relay' bare-label suffix must not appear (Seznam compliance)")
	}
	assertContains(t, s, "@a.com>")

	// X-Mailer is stripped by the privacy pipeline.
	if strings.Contains(s, "X-Mailer:") {
		t.Fatal("X-Mailer must be stripped by the privacy pipeline")
	}
}

func TestBuildMessageCustomHeaderSkipContentType(t *testing.T) {
	headers := map[string]string{
		"Content-Type":              "text/html",          // must be skipped
		"Content-Transfer-Encoding": "quoted-printable",  // must be skipped
		"X-Custom":                  "custom-value",
	}
	msg := BuildMessage("a@a.com", []string{"b@b.com"}, "Sub", "body", "", headers)
	s := string(msg)

	// Content-Type must be set by BuildMessage itself (text/plain), not the one
	// from the header map.
	if strings.Contains(s, "Content-Type: text/html") {
		t.Fatal("Content-Type from headers map must be suppressed")
	}
	// Custom header must still appear.
	assertContains(t, s, "X-Custom: custom-value")
}

func TestBuildMessageMIMEVersionNotDuplicated(t *testing.T) {
	headers := map[string]string{
		"MIME-Version": "1.0",
	}
	msg := BuildMessage("a@a.com", []string{"b@b.com"}, "Sub", "body", "", headers)
	s := string(msg)

	count := strings.Count(s, "MIME-Version: 1.0")
	if count != 1 {
		t.Fatalf("MIME-Version should appear exactly once, got %d", count)
	}
}

func TestBuildMessageNonASCIISubject(t *testing.T) {
	msg := BuildMessage("a@a.com", []string{"b@b.com"}, "Čeština", "body", "", nil)
	s := string(msg)
	assertContains(t, s, "=?utf-8?b?")
}

// ---------------------------------------------------------------------------
// AccountPool
// ---------------------------------------------------------------------------

func TestAccountPoolHas(t *testing.T) {
	pool := NewAccountPool(nil, SMTPConfig{Host: "mail.example.com", Port: 587}, []SMTPAccount{
		{Address: "alice@example.com", Password: "pass1"},
		{Address: "BOB@EXAMPLE.COM", Password: "pass2"},
	}, NewRecordDeliverer())

	if !pool.Has("alice@example.com") {
		t.Fatal("should have alice")
	}
	// Lookup should be case-insensitive.
	if !pool.Has("bob@example.com") {
		t.Fatal("should have bob (case-insensitive)")
	}
	if pool.Has("carol@example.com") {
		t.Fatal("should not have carol")
	}
}

func TestAccountPoolDeliverMatchingAccount(t *testing.T) {
	fallback := NewRecordDeliverer()
	pool := NewAccountPool(nil, SMTPConfig{Host: "mail.example.com", Port: 587}, []SMTPAccount{}, fallback)

	// No accounts — every message goes to the fallback.
	ctx := context.Background()
	err := pool.Deliver(ctx, "alice@example.com", []string{"dest@example.com"}, []byte("msg"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fallback.Records) != 1 {
		t.Fatalf("expected 1 record in fallback, got %d", len(fallback.Records))
	}
}

// Regression: nil-receiver methods must not panic. The drain goroutine in
// services/relay/cmd/relay/main.go converts a typed-nil *AccountPool into a
// drainAccountPool interface; a nil-receiver-unsafe Has/Deliver crashes the
// entire drain loop (incident: 302 production sends, 0 deliveries, 2026-05-04).
func TestAccountPoolNilReceiverSafe(t *testing.T) {
	var p *AccountPool
	if p.Has("anyone@example.com") {
		t.Fatal("nil pool should report Has=false")
	}
	err := p.Deliver(context.Background(), "anyone@example.com", []string{"dest@example.com"}, []byte("msg"))
	if err == nil {
		t.Fatal("nil pool Deliver should return error, not panic")
	}
}

// Regression: matched account but nil fallback must not panic when from-address
// matches. (Fallback only used when no account matches.)
func TestAccountPoolDeliverNilFallbackUnknownFrom(t *testing.T) {
	pool := NewAccountPool(nil, SMTPConfig{Host: "mail.example.com", Port: 587}, []SMTPAccount{
		{Address: "known@example.com", Password: "pass"},
	}, nil)

	err := pool.Deliver(context.Background(), "unknown@example.com", []string{"dest@example.com"}, []byte("msg"))
	if err == nil {
		t.Fatal("expected error when no account matches and fallback is nil, got nil")
	}
}

func TestAccountPoolDeliverFallback(t *testing.T) {
	fallback := NewRecordDeliverer()
	pool := NewAccountPool(nil, SMTPConfig{Host: "mail.example.com", Port: 587}, []SMTPAccount{
		{Address: "known@example.com", Password: "pass"},
	}, fallback)

	ctx := context.Background()
	// Deliver from an address NOT in the pool → must use fallback.
	err := pool.Deliver(ctx, "unknown@example.com", []string{"dest@example.com"}, []byte("msg"))
	if err != nil {
		t.Fatalf("unexpected error from fallback: %v", err)
	}
	if len(fallback.Records) != 1 {
		t.Fatalf("expected 1 fallback record, got %d", len(fallback.Records))
	}
}

// ---------------------------------------------------------------------------
// NewAccountPool — implicit TLS auto-detection
// ---------------------------------------------------------------------------

func TestNewAccountPoolPort465ImplicitTLS(t *testing.T) {
	pool := NewAccountPool(nil, SMTPConfig{Host: "smtp.example.com", Port: 465}, []SMTPAccount{
		{Address: "a@example.com", Password: "p"},
	}, NewRecordDeliverer())

	d := pool.accounts["a@example.com"]
	if !d.implicitTLS {
		t.Fatal("port 465 should imply implicitTLS=true")
	}
}

// ---------------------------------------------------------------------------
// NewSMTPDeliverer — configuration
// ---------------------------------------------------------------------------

func TestNewSMTPDelivererPort465(t *testing.T) {
	d := NewSMTPDeliverer(nil, SMTPConfig{Host: "smtp.example.com", Port: 465})
	if !d.implicitTLS {
		t.Fatal("port 465 must set implicitTLS=true")
	}
}

func TestNewSMTPDelivererPort587(t *testing.T) {
	d := NewSMTPDeliverer(nil, SMTPConfig{Host: "smtp.example.com", Port: 587})
	if d.implicitTLS {
		t.Fatal("port 587 must not set implicitTLS=true")
	}
}

func TestNewSMTPDelivererExplicitImplicitTLS(t *testing.T) {
	d := NewSMTPDeliverer(nil, SMTPConfig{Host: "smtp.example.com", Port: 2525, ImplicitTLS: true})
	if !d.implicitTLS {
		t.Fatal("explicit ImplicitTLS=true must be honoured regardless of port")
	}
}

// ---------------------------------------------------------------------------
// ExitChannelDeliverer
// ---------------------------------------------------------------------------

func TestNewExitChannelDeliverer(t *testing.T) {
	rec := NewRecordDeliverer()
	d := NewExitChannelDeliverer(rec)
	if d == nil {
		t.Fatal("NewExitChannelDeliverer returned nil")
	}
}

func TestDeliverEnvelopeUnverifiedChannel(t *testing.T) {
	rec := NewRecordDeliverer()
	d := NewExitChannelDeliverer(rec)

	ctx := context.Background()
	env := model.Envelope{}
	ch := model.ExitChannel{Verified: false}

	err := d.DeliverEnvelope(ctx, env, ch)
	if err == nil {
		t.Fatal("expected error for unverified channel")
	}
	if !strings.Contains(err.Error(), "not verified") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestDeliverEnvelopeVerifiedChannel(t *testing.T) {
	rec := NewRecordDeliverer()
	d := NewExitChannelDeliverer(rec)

	ctx := context.Background()
	env := model.Envelope{}
	ch := model.ExitChannel{Verified: true}

	err := d.DeliverEnvelope(ctx, env, ch)
	if err != nil {
		t.Fatalf("verified channel should not error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func assertContains(t *testing.T, s, sub string) {
	t.Helper()
	if !strings.Contains(s, sub) {
		t.Fatalf("expected to contain %q\ngot:\n%s", sub, s)
	}
}
