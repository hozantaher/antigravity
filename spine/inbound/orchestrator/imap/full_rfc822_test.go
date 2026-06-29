package imap

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for S1.2 — IMAP poller full RFC822 fetch.
// ════════════════════════════════════════════════════════════════════════
//
// Every assertion below corresponds to a contract the downstream MIME parser
// (S1.3) and RecordInbound (S1.4) depend on. Drift in any of these breaks
// the inbound mail pipeline silently — tests are the canary.

// ── Test 1: BODY[] literal extraction (happy path) ─────────────────────
func TestExtractFullBodyLiteral_HappyPath(t *testing.T) {
	body := "Subject: Test\r\nFrom: a@b\r\n\r\nHello."
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\nA003 OK FETCH\r\n", len(body), body)

	got := extractFullBodyLiteral(raw)
	if string(got) != body {
		t.Errorf("got %q, want %q", got, body)
	}
}

// ── Test 2: BODY[] not present → returns nil ─────────────────────────────
func TestExtractFullBodyLiteral_Missing(t *testing.T) {
	raw := "* 1 FETCH (BODY[TEXT] {5}\r\nhello)"
	if got := extractFullBodyLiteral(raw); got != nil {
		t.Errorf("expected nil for missing BODY[], got %q", got)
	}
}

// ── Test 3: BODY[] vs BODY[TEXT] disambiguation ─────────────────────────
// Server might return both markers; we want the BODY[] full-RFC822 one,
// not the BODY[TEXT] partial.
func TestExtractFullBodyLiteral_DistinguishesFromBodyText(t *testing.T) {
	full := "Subject: A\r\n\r\nFull"
	raw := fmt.Sprintf("* 1 FETCH (BODY[TEXT] {4}\r\nXXXX BODY[] {%d}\r\n%s)", len(full), full)
	got := extractFullBodyLiteral(raw)
	if string(got) != full {
		t.Errorf("got %q, want full RFC822 %q", got, full)
	}
}

// ── Test 4: parseFetchResponse populates RawBytes ──────────────────────
func TestParseFetchResponse_PopulatesRawBytes(t *testing.T) {
	body := "Message-ID: <a@b>\r\nFrom: x@y\r\nSubject: S\r\n\r\nBody text."
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\nA003 OK\r\n", len(body), body)

	msg := parseFetchResponse(raw)
	if msg == nil {
		t.Fatal("nil result")
	}
	if !bytes.Equal(msg.RawBytes, []byte(body)) {
		t.Errorf("RawBytes mismatch:\n got %q\nwant %q", msg.RawBytes, body)
	}
}

// ── Test 5: headers parsed from RawBytes path ──────────────────────────
func TestParseFetchResponse_HeadersFromRaw(t *testing.T) {
	body := "Message-ID: <full@example>\r\n" +
		"From: alice@example.cz\r\n" +
		"Subject: Re: Plný fetch\r\n" +
		"Date: Wed, 29 Apr 2026 12:00:00 +0200\r\n" +
		"In-Reply-To: <orig@x>\r\n" +
		"\r\n" +
		"Plain body."
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\nA003 OK\r\n", len(body), body)

	msg := parseFetchResponse(raw)
	if msg.MessageID != "<full@example>" {
		t.Errorf("MessageID: %q", msg.MessageID)
	}
	if msg.From != "alice@example.cz" {
		t.Errorf("From: %q", msg.From)
	}
	// net/mail decodes RFC 2047 if the header is encoded; here it's UTF-8 raw
	// which net/mail returns as-is.
	if !strings.Contains(msg.Subject, "Plný fetch") {
		t.Errorf("Subject: %q", msg.Subject)
	}
	if msg.InReplyTo != "<orig@x>" {
		t.Errorf("InReplyTo: %q", msg.InReplyTo)
	}
}

// ── Test 6: Date header populates ReceivedAt ───────────────────────────
func TestParseFetchResponse_ReceivedAtFromDate(t *testing.T) {
	body := "From: a@b\r\nSubject: D\r\nDate: Wed, 29 Apr 2026 12:00:00 +0200\r\n\r\nx"
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\n", len(body), body)
	msg := parseFetchResponse(raw)
	if msg.ReceivedAt.Year() != 2026 || msg.ReceivedAt.Month() != 4 || msg.ReceivedAt.Day() != 29 {
		t.Errorf("ReceivedAt: %v", msg.ReceivedAt)
	}
}

// ── Test 7: BodyPlain populated from raw (back-compat) ─────────────────
func TestParseFetchResponse_BodyPlainFromRaw(t *testing.T) {
	body := "From: a@b\r\nSubject: B\r\n\r\nVisible body content."
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\n", len(body), body)
	msg := parseFetchResponse(raw)
	if !strings.Contains(msg.BodyPlain, "Visible body content.") {
		t.Errorf("BodyPlain: %q", msg.BodyPlain)
	}
}

// ── Test 8: Legacy two-literal fallback still works ────────────────────
// Existing tests use BODY[HEADER.FIELDS] + BODY[TEXT]; ensure they still
// parse so transitional code paths don't regress.
func TestParseFetchResponse_LegacyTwoLiteralStillWorks(t *testing.T) {
	headers := "Message-ID: <legacy@x>\r\nFrom: legacy@x.cz\r\nSubject: Legacy\r\n"
	bodyText := "Legacy body."
	raw := fmt.Sprintf("* 1 FETCH (BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT)] {%d}\r\n%s BODY[TEXT] {%d}\r\n%s)\r\n",
		len(headers), headers, len(bodyText), bodyText)

	msg := parseFetchResponse(raw)
	if msg.MessageID != "<legacy@x>" {
		t.Errorf("legacy MessageID: %q", msg.MessageID)
	}
	if msg.From != "legacy@x.cz" {
		t.Errorf("legacy From: %q", msg.From)
	}
	if !strings.Contains(msg.BodyPlain, "Legacy body.") {
		t.Errorf("legacy BodyPlain: %q", msg.BodyPlain)
	}
	// Legacy path leaves RawBytes empty (no BODY[] literal).
	if len(msg.RawBytes) != 0 {
		t.Errorf("legacy path should NOT set RawBytes, got %d bytes", len(msg.RawBytes))
	}
}

// ── Test 9: oversized message → nil result ─────────────────────────────
// Set a tiny limit via env override and feed a body that exceeds it.
func TestParseFetchResponse_OversizeReturnsNil(t *testing.T) {
	t.Setenv("MAIL_MAX_SIZE_BYTES", "100")
	body := strings.Repeat("X", 200)
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\n", len(body), body)
	if msg := parseFetchResponse(raw); msg != nil {
		t.Errorf("expected nil for oversized message, got result with %d RawBytes", len(msg.RawBytes))
	}
}

// ── Test 10: under-limit message accepted ──────────────────────────────
func TestParseFetchResponse_UnderLimitAccepted(t *testing.T) {
	t.Setenv("MAIL_MAX_SIZE_BYTES", "1000")
	body := "From: a@b\r\nSubject: X\r\n\r\n" + strings.Repeat("y", 100)
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\n", len(body), body)
	msg := parseFetchResponse(raw)
	if msg == nil {
		t.Fatal("expected non-nil under limit")
	}
	if len(msg.RawBytes) == 0 {
		t.Error("under-limit message must populate RawBytes")
	}
}

// ── Test 11: maxMailSizeBytes env override + default ───────────────────
func TestMaxMailSizeBytes_EnvOverride(t *testing.T) {
	t.Setenv("MAIL_MAX_SIZE_BYTES", "12345")
	if got := maxMailSizeBytes(); got != 12345 {
		t.Errorf("MAIL_MAX_SIZE_BYTES=12345 → got %d", got)
	}
}

func TestMaxMailSizeBytes_Default(t *testing.T) {
	os.Unsetenv("MAIL_MAX_SIZE_BYTES")
	const want = 25 * 1024 * 1024
	if got := maxMailSizeBytes(); got != want {
		t.Errorf("default → got %d, want %d", got, want)
	}
}

// ── Test 12: invalid env value falls back to default ───────────────────
func TestMaxMailSizeBytes_InvalidEnvFallsBack(t *testing.T) {
	t.Setenv("MAIL_MAX_SIZE_BYTES", "not-a-number")
	const want = 25 * 1024 * 1024
	if got := maxMailSizeBytes(); got != want {
		t.Errorf("invalid env → got %d, want %d", got, want)
	}
}

// ── Test 13: zero/negative env → default ───────────────────────────────
func TestMaxMailSizeBytes_NonPositiveFallsBack(t *testing.T) {
	t.Setenv("MAIL_MAX_SIZE_BYTES", "0")
	const want = 25 * 1024 * 1024
	if got := maxMailSizeBytes(); got != want {
		t.Errorf("zero env → got %d, want %d", got, want)
	}
}

// ── Test 14: 1MB body round-trip preserves all bytes ───────────────────
func TestParseFetchResponse_1MBBody(t *testing.T) {
	body := "From: big@x\r\nSubject: BigOne\r\n\r\n" + strings.Repeat("a", 1024*1024)
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\n", len(body), body)
	msg := parseFetchResponse(raw)
	if msg == nil {
		t.Fatal("nil")
	}
	if len(msg.RawBytes) != len(body) {
		t.Errorf("RawBytes len: got %d, want %d", len(msg.RawBytes), len(body))
	}
	// Check first + last bytes — drift in extractIMAPLiteral can chop ends.
	if string(msg.RawBytes[:10]) != "From: big@" {
		t.Errorf("RawBytes prefix wrong: %q", msg.RawBytes[:10])
	}
	if string(msg.RawBytes[len(msg.RawBytes)-5:]) != "aaaaa" {
		t.Errorf("RawBytes suffix wrong")
	}
}

// ── Test 15: non-ASCII (UTF-8) body bytes preserved ────────────────────
func TestParseFetchResponse_UTF8Preserved(t *testing.T) {
	body := "Subject: \xc4\x8celý\r\nFrom: a@b\r\n\r\nDěkuji za zprávu — vše v pořádku."
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\n", len(body), body)
	msg := parseFetchResponse(raw)
	if !bytes.Equal(msg.RawBytes, []byte(body)) {
		t.Errorf("UTF-8 bytes not preserved")
	}
	if !strings.Contains(msg.BodyPlain, "Děkuji") {
		t.Errorf("BodyPlain UTF-8 dropped: %q", msg.BodyPlain)
	}
}

// ── Test 16: malformed mail (missing headers) doesn't crash ────────────
func TestParseFetchResponse_NoHeaders(t *testing.T) {
	body := "just body text without any headers"
	raw := fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s)\r\n", len(body), body)
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("parseFetchResponse panicked: %v", r)
		}
	}()
	msg := parseFetchResponse(raw)
	if msg == nil {
		t.Fatal("nil result on no-header input")
	}
	// MessageID should be empty since none was present
	if msg.MessageID != "" {
		t.Errorf("expected empty MessageID, got %q", msg.MessageID)
	}
}

// ── Test 17: BODY[] with explicit {0} → empty RawBytes, falls back ─────
// Server pathological case — empty literal. extractIMAPLiteral returns ""
// for {0}, so the path falls through to legacy parsing.
func TestParseFetchResponse_EmptyBodyLiteral(t *testing.T) {
	raw := "* 1 FETCH (BODY[] {0}\r\n)\r\nA003 OK\r\n"
	msg := parseFetchResponse(raw)
	if msg == nil {
		t.Fatal("nil")
	}
	if len(msg.RawBytes) != 0 {
		t.Errorf("expected empty RawBytes for {0} literal, got %d", len(msg.RawBytes))
	}
}

// ── Test 18: FETCH command syntax — uses BODY.PEEK[] not BODY[] ────────
// Source-level audit: the FETCH command MUST use PEEK so the poller does
// not flip \Seen on read. Operators rely on read-state for ops triage.
func TestFetchCommandUsesPEEK(t *testing.T) {
	// fetchMessage builds the command inline. We can't easily intercept it
	// without a fake conn, so this test reads the source file directly.
	src, err := os.ReadFile("poller.go")
	if err != nil {
		t.Skipf("cannot read poller.go: %v", err)
	}
	if !bytes.Contains(src, []byte("BODY.PEEK[]")) {
		t.Error("fetchMessage MUST use BODY.PEEK[] to avoid setting \\Seen")
	}
	// Defense-in-depth: ensure the old narrow fetch (BODY[TEXT] only) is
	// not the active command — a regression would wipe RawBytes silently.
	if bytes.Contains(src, []byte("(BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES FROM SUBJECT DATE)] BODY[TEXT])")) {
		t.Error("old narrow FETCH command must be removed (regresses RawBytes)")
	}
}
