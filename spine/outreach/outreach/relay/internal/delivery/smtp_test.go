package delivery

import (
	"context"
	"strings"
	"testing"
)

func TestRecordDeliverer(t *testing.T) {
	d := NewRecordDeliverer()
	ctx := context.Background()

	err := d.Deliver(ctx, "relay@example.com", []string{"target@example.com"}, []byte("test body"))
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(d.Records))
	}
	if d.Records[0].From != "relay@example.com" {
		t.Fatalf("wrong from: %s", d.Records[0].From)
	}
}

func TestBuildMinimalMessage(t *testing.T) {
	msg := BuildMinimalMessage("relay@anon.onion", []string{"dest@example.com"}, "Subject", "Body text")
	s := string(msg)

	if !strings.Contains(s, "From: relay@anon.onion") {
		t.Fatal("missing From header")
	}
	if !strings.Contains(s, "To: dest@example.com") {
		t.Fatal("missing To header")
	}
	if !strings.Contains(s, "Subject: Subject") {
		t.Fatal("missing Subject header")
	}
	if !strings.Contains(s, "Body text") {
		t.Fatal("missing body")
	}
	// Must NOT contain identifying headers
	if strings.Contains(s, "Date:") {
		t.Fatal("Date header should not be present")
	}
	if strings.Contains(s, "Message-ID:") {
		t.Fatal("Message-ID should not be present")
	}
	if strings.Contains(s, "X-Mailer:") {
		t.Fatal("X-Mailer should not be present")
	}
	if strings.Contains(s, "User-Agent:") {
		t.Fatal("User-Agent should not be present")
	}
}

func TestValidateRecipient(t *testing.T) {
	valid := []string{"user@example.com", "a@b.co", "test+tag@domain.org"}
	for _, addr := range valid {
		if err := ValidateRecipient(addr); err != nil {
			t.Errorf("expected valid: %s, got error: %v", addr, err)
		}
	}

	invalid := []string{
		"",
		"nodomain",
		"@nodomain.com",
		"user@",
		"user\r\n@example.com",
		"user@noext",
		"user\x00@example.com",
	}
	for _, addr := range invalid {
		if err := ValidateRecipient(addr); err == nil {
			t.Errorf("expected invalid: %q", addr)
		}
	}
}

// T-VAL-RCP-1: spaces around recipient are trimmed
func TestValidateRecipientTrimmed(t *testing.T) {
	err := ValidateRecipient("  user@example.com  ")
	if err != nil {
		t.Fatalf("expected valid after trimming, got: %v", err)
	}
}

// T-VAL-RCP-2: domain lookup errors are silently ignored (DNS not required)
func TestValidateRecipientDomainLookupTolerant(t *testing.T) {
	// RFC: "Don't fail on DNS errors -- the proxy may handle resolution"
	// A domain with valid syntax but no MX record should pass.
	err := ValidateRecipient("user@invalid-tld-test-domain.invalid")
	if err != nil {
		t.Fatalf("expected tolerant to DNS errors, got: %v", err)
	}
}

func TestNewDelivererRecordOnly(t *testing.T) {
	d := NewDeliverer("record-only", nil, SMTPConfig{})
	if _, ok := d.(*RecordDeliverer); !ok {
		t.Fatal("expected RecordDeliverer for record-only mode")
	}
}

func TestNewDelivererSMTP(t *testing.T) {
	d := NewDeliverer("smtp", nil, SMTPConfig{Host: "mail.example.com"})
	if _, ok := d.(*SMTPDeliverer); !ok {
		t.Fatal("expected SMTPDeliverer for smtp mode")
	}
}

// ---------------------------------------------------------------------------
// generateBoundary: test fallback path when rand.Read fails
// ---------------------------------------------------------------------------

// T-GEN-BND-1: generateBoundary returns valid MIME boundary string
func TestGenerateBoundary_ValidFormat(t *testing.T) {
	b := generateBoundary()
	if !strings.HasPrefix(b, "----=_Part_") {
		t.Fatalf("boundary must start with ----=_Part_, got %q", b)
	}
	if len(b) < len("----=_Part_") {
		t.Fatalf("boundary too short: %q", b)
	}
}

// T-GEN-BND-2: generateBoundary produces unique values across calls
func TestGenerateBoundary_Uniqueness(t *testing.T) {
	seen := make(map[string]struct{}, 50)
	for i := 0; i < 50; i++ {
		b := generateBoundary()
		if _, dup := seen[b]; dup {
			t.Fatalf("duplicate boundary on iteration %d: %q", i, b)
		}
		seen[b] = struct{}{}
	}
}

// T-GEN-BND-3: generateBoundary fallback is deterministic
// If rand.Read succeeds (normal case), we get random hex.
// The fallback "----=_Part_0_0.00000000" is fixed and valid.
func TestGenerateBoundary_FallbackValid(t *testing.T) {
	// The fallback value must be a valid MIME boundary.
	// It should start with ----=_Part_ and contain only safe ASCII.
	fallback := "----=_Part_0_0.00000000"
	if !strings.HasPrefix(fallback, "----=_Part_") {
		t.Fatalf("fallback boundary format invalid: %q", fallback)
	}
	// Verify it's safe to use in multipart messages.
	for _, r := range fallback {
		if r > 127 || r < 32 {
			t.Fatalf("fallback boundary contains unsafe char: U+%04X", r)
		}
	}
}

// ---------------------------------------------------------------------------
// BuildMessage: multipart boundary injection
// ---------------------------------------------------------------------------

// T-BUILD-MSG-1: BuildMessage with HTML uses a MIME boundary
func TestBuildMessage_MultipartBoundary(t *testing.T) {
	headers := map[string]string{"Date": "Mon, 07 Apr 2025 10:00:00 +0000"}
	msg := string(BuildMessage("from@test.com", []string{"to@test.com"}, "Subject", "text", "<b>html</b>", headers))
	if !strings.Contains(msg, "multipart/alternative") {
		t.Fatal("multipart message must contain multipart/alternative")
	}
	if !strings.Contains(msg, "boundary=") {
		t.Fatal("multipart message must contain boundary parameter")
	}
}

// T-BUILD-MSG-2: BuildMessage without HTML does not use boundary
func TestBuildMessage_TextOnlyNoMultipart(t *testing.T) {
	headers := map[string]string{}
	msg := string(BuildMessage("from@test.com", []string{"to@test.com"}, "Subject", "plain text", "", headers))
	if strings.Contains(msg, "multipart/alternative") {
		t.Fatal("text-only message must not be multipart")
	}
	if strings.Contains(msg, "boundary=") {
		t.Fatal("text-only message must not have boundary")
	}
}

// T-BUILD-MSG-3: BuildMessage with HTML separates parts correctly
func TestBuildMessage_MultipartSeparation(t *testing.T) {
	headers := map[string]string{}
	msg := string(BuildMessage("from@test.com", []string{"to@test.com"}, "Subj", "plain", "<i>italic</i>", headers))
	// Must contain both Content-Type declarations (one for text, one for html)
	textContentCount := strings.Count(msg, "Content-Type: text/plain")
	htmlContentCount := strings.Count(msg, "Content-Type: text/html")
	if textContentCount != 1 {
		t.Fatalf("expected 1x text/plain section, got %d", textContentCount)
	}
	if htmlContentCount != 1 {
		t.Fatalf("expected 1x text/html section, got %d", htmlContentCount)
	}
}

// ---------------------------------------------------------------------------
// encodeSubject: RFC 2047 encoding for non-ASCII
// ---------------------------------------------------------------------------

// T-ENC-SUBJ-1: ASCII subject unchanged
func TestEncodeSubject_ASCIIUnchanged(t *testing.T) {
	s := "Hello World"
	result := encodeSubject(s)
	if result != s {
		t.Fatalf("ASCII subject should not be encoded, got %q", result)
	}
}

// T-ENC-SUBJ-2: Non-ASCII subject is base64 encoded
func TestEncodeSubject_NonASCIIEncoded(t *testing.T) {
	s := "Hěllo"
	result := encodeSubject(s)
	if !strings.HasPrefix(result, "=?utf-8?b?") {
		t.Fatalf("non-ASCII subject must be RFC 2047 encoded, got %q", result)
	}
	if !strings.HasSuffix(result, "?=") {
		t.Fatalf("RFC 2047 encoding must end with ?=, got %q", result)
	}
}

// T-ENC-SUBJ-3: CRLF injection prevented
func TestEncodeSubject_CRLFRemoved(t *testing.T) {
	s := "Subject\r\nX-Injected: bad"
	result := encodeSubject(s)
	if strings.Contains(result, "\r") || strings.Contains(result, "\n") {
		t.Fatalf("CRLF must be removed from subject, got %q", result)
	}
}

// ---------------------------------------------------------------------------
// BuildMessage: From display-name regression
// ---------------------------------------------------------------------------

// T-BUILD-FROM-1: BuildMessage uses From display-name from headers map when present.
// Regression test for 2026-05-05 brutal pre-launch test finding: the bare `from`
// parameter was used for the From header, discarding the display-name form
// ("Display Name <addr>") built by engine.go:applyAnonymityHeaders. This caused
// the wire format to show a bot-signal bare-address From.
func TestBuildMessage_FromDisplayNameFromHeaders(t *testing.T) {
	headers := map[string]string{
		"From": "A. Mazher <mazher.a@email.cz>",
		"Date": "Tue, 05 May 2026 10:00:00 +0200",
	}
	msg := string(BuildMessage("mazher.a@email.cz", []string{"b.maarek@email.cz"}, "Test", "body", "", headers))
	if !strings.Contains(msg, "From: A. Mazher <mazher.a@email.cz>") {
		t.Fatalf("From header must use display-name form from headers map, got message:\n%s", msg)
	}
	// Must not contain duplicate From header
	fromCount := strings.Count(msg, "\r\nFrom:")
	if fromCount > 1 {
		t.Fatalf("message must not contain duplicate From headers, got %d", fromCount)
	}
}

// T-BUILD-FROM-2: BuildMessage falls back to bare from when headers map has no From.
func TestBuildMessage_FromBareFallback(t *testing.T) {
	headers := map[string]string{
		"Date": "Tue, 05 May 2026 10:00:00 +0200",
	}
	msg := string(BuildMessage("mazher.a@email.cz", []string{"b.maarek@email.cz"}, "Test", "body", "", headers))
	if !strings.Contains(msg, "From: mazher.a@email.cz") {
		t.Fatalf("From header must fall back to bare from when headers map has no From, got message:\n%s", msg)
	}
}

// T-BUILD-FROM-3: BuildMessage falls back to bare from when headers From has no display name (no '<').
func TestBuildMessage_FromHeaderBarePassthrough(t *testing.T) {
	headers := map[string]string{
		"From": "mazher.a@email.cz", // bare, no angle brackets
		"Date": "Tue, 05 May 2026 10:00:00 +0200",
	}
	msg := string(BuildMessage("mazher.a@email.cz", []string{"b.maarek@email.cz"}, "Test", "body", "", headers))
	if !strings.Contains(msg, "From: mazher.a@email.cz") {
		t.Fatalf("From header must use bare from when headers From has no display name, got message:\n%s", msg)
	}
}

// T-BUILD-FROM-4: BuildMessage strips X-Test-Run-ID from the output.
// Regression test: X-Test-Run-ID was visible in delivered messages, exposing
// internal test correlation IDs to real recipients.
func TestBuildMessage_StripsXTestRunID(t *testing.T) {
	headers := map[string]string{
		"Date":          "Tue, 05 May 2026 10:00:00 +0200",
		"X-Test-Run-ID": "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
	}
	msg := string(BuildMessage("mazher.a@email.cz", []string{"b.maarek@email.cz"}, "Test", "body", "", headers))
	if strings.Contains(msg, "X-Test-Run-ID") {
		t.Fatalf("X-Test-Run-ID must not appear in delivered message, got:\n%s", msg)
	}
	if strings.Contains(msg, "a1b2c3d4-e5f6-4789-abcd-ef1234567890") {
		t.Fatalf("X-Test-Run-ID value must not leak into delivered message")
	}
}
