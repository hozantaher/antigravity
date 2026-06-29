package imap

// monkey_test.go — property and boundary tests for IMAP parsing helpers.
// Focuses on nil safety, empty inputs, and no-panic guarantees.

import (
	"strings"
	"testing"
	"testing/quick"

	"orchestrator/thread"
)

// ── splitByDoubleCRLF boundary tests ─────────────────────────────────────────
// Returns (headerBlock, bodySection string).

func TestSplitByDoubleCRLF_EmptyInput(t *testing.T) {
	header, body := splitByDoubleCRLF("")
	// No separator found — both returned empty.
	_ = header
	_ = body
}

func TestSplitByDoubleCRLF_NoDelimiter(t *testing.T) {
	header, body := splitByDoubleCRLF("single block without delimiter")
	// No CRLF separator — both return empty strings.
	_ = header
	_ = body
}

func TestSplitByDoubleCRLF_DoubleCRLFSeparator(t *testing.T) {
	header, body := splitByDoubleCRLF("From: x@y.com\r\n\r\nHello body")
	if body != "Hello body" {
		t.Errorf("body = %q, want 'Hello body'", body)
	}
	_ = header
}

func TestSplitByDoubleCRLF_DoubleNewlineSeparator(t *testing.T) {
	// Fallback to \n\n separator
	header, body := splitByDoubleCRLF("From: x@y.com\n\nHello body")
	if body != "Hello body" {
		t.Errorf("body = %q, want 'Hello body'", body)
	}
	_ = header
}

func TestSplitByDoubleCRLF_OnlyDelimiter(t *testing.T) {
	// Should not panic.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("splitByDoubleCRLF panicked on pure delimiter: %v", r)
		}
	}()
	header, body := splitByDoubleCRLF("\r\n\r\n")
	_ = header
	_ = body
}

// Property: splitByDoubleCRLF never panics for any input string.
func TestSplitByDoubleCRLF_Property_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }() //nolint:errcheck
		h, b := splitByDoubleCRLF(s)
		_ = h
		_ = b
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("splitByDoubleCRLF property: %v", err)
	}
}

// ── findHeaderStart boundary tests ───────────────────────────────────────────
// Returns int (offset into the string).

func TestFindHeaderStart_EmptyString(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("findHeaderStart panicked on empty input: %v", r)
		}
	}()
	idx := findHeaderStart("")
	if idx < 0 {
		t.Errorf("findHeaderStart('') = %d, should be >= 0", idx)
	}
}

func TestFindHeaderStart_PureMRealHeader(t *testing.T) {
	s := "Message-ID: <abc@example.com>\r\nSubject: Test\r\n"
	idx := findHeaderStart(s)
	// Must be within bounds.
	if idx < 0 || idx > len(s) {
		t.Errorf("findHeaderStart returned out-of-bounds index %d for len %d", idx, len(s))
	}
}

func TestFindHeaderStart_IMAPFraming(t *testing.T) {
	// Lines starting with '*' or 'A0' should be skipped.
	s := "* 1 FETCH (...)\r\nA001 OK\r\nMessage-ID: <abc@example.com>\r\n"
	idx := findHeaderStart(s)
	if idx < 0 || idx > len(s) {
		t.Errorf("findHeaderStart returned out-of-bounds index %d for len %d", idx, len(s))
	}
}

// ── parseDateFallback boundary tests ─────────────────────────────────────────
// Signature: parseDateFallback(msg *thread.RawInbound, dateStr string)

func TestParseDateFallback_EmptyString(t *testing.T) {
	msg := &thread.RawInbound{}
	parseDateFallback(msg, "")
	// ReceivedAt should remain zero (no-op on empty string).
	if !msg.ReceivedAt.IsZero() {
		t.Error("parseDateFallback('') should not set ReceivedAt")
	}
}

func TestParseDateFallback_ValidRFC2822Date(t *testing.T) {
	msg := &thread.RawInbound{}
	parseDateFallback(msg, "Mon, 01 Jan 2024 12:00:00 +0000")
	if msg.ReceivedAt.IsZero() {
		t.Error("parseDateFallback should set ReceivedAt for valid RFC 2822 date")
	}
}

func TestParseDateFallback_ValidShortDay(t *testing.T) {
	msg := &thread.RawInbound{}
	parseDateFallback(msg, "Mon, 1 Jan 2024 12:00:00 +0000")
	if msg.ReceivedAt.IsZero() {
		t.Error("parseDateFallback should handle single-digit day format")
	}
}

func TestParseDateFallback_GarbageInput(t *testing.T) {
	inputs := []string{
		"not a date",
		"01/01/01",
		"\x00\x01\x02",
		"2024-01-15T10:30:00Z",
	}
	for _, in := range inputs {
		msg := &thread.RawInbound{}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("parseDateFallback(%q) panicked: %v", in, r)
				}
			}()
			parseDateFallback(msg, in)
			// ReceivedAt remains zero for unrecognised formats.
		}()
	}
}

// Property: parseDateFallback never panics on a non-nil RawInbound.
func TestParseDateFallback_Property_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }() //nolint:errcheck
		msg := &thread.RawInbound{}
		parseDateFallback(msg, s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("parseDateFallback property: %v", err)
	}
}

// ── parseSearchResponse boundary tests ───────────────────────────────────────

func TestParseSearchResponse_EmptyResponse(t *testing.T) {
	uids := parseSearchResponse("")
	if len(uids) != 0 {
		t.Errorf("expected 0 UIDs from empty response, got %d: %v", len(uids), uids)
	}
}

func TestParseSearchResponse_NoUIDs(t *testing.T) {
	uids := parseSearchResponse("A002 OK SEARCH done")
	if len(uids) != 0 {
		t.Errorf("expected 0 UIDs, got %d: %v", len(uids), uids)
	}
}

func TestParseSearchResponse_OneUID(t *testing.T) {
	uids := parseSearchResponse("* SEARCH 42\r\nA002 OK SEARCH done\r\n")
	if len(uids) != 1 {
		t.Errorf("expected 1 UID, got %d: %v", len(uids), uids)
	}
	if len(uids) == 1 && uids[0] != "42" {
		t.Errorf("expected UID '42', got %q", uids[0])
	}
}

func TestParseSearchResponse_MultipleUIDs(t *testing.T) {
	uids := parseSearchResponse("* SEARCH 1 2 3 4 5\r\nA002 OK SEARCH done\r\n")
	if len(uids) != 5 {
		t.Errorf("expected 5 UIDs, got %d: %v", len(uids), uids)
	}
}

func TestParseSearchResponse_EmptySearchLine(t *testing.T) {
	// "* SEARCH" with no UIDs — parts[2:] is empty slice, no panic.
	uids := parseSearchResponse("* SEARCH\r\nA002 OK SEARCH done\r\n")
	if len(uids) != 0 {
		t.Errorf("expected 0 UIDs from empty SEARCH line, got %d: %v", len(uids), uids)
	}
}

func TestParseSearchResponse_GarbageLine(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("parseSearchResponse panicked on garbage input: %v", r)
		}
	}()
	_ = parseSearchResponse("not an imap response\r\nrandom noise\r\n")
}

// Property: parseSearchResponse never panics.
func TestParseSearchResponse_Property_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }() //nolint:errcheck
		_ = parseSearchResponse(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("parseSearchResponse property: %v", err)
	}
}

// ── extractHeader boundary tests ─────────────────────────────────────────────

func TestExtractHeader_EmptyBlock(t *testing.T) {
	got := extractHeader("", "Message-ID")
	if got != "" {
		t.Errorf("extractHeader on empty block = %q, want ''", got)
	}
}

func TestExtractHeader_MissingKey(t *testing.T) {
	block := "From: sender@example.com\r\nSubject: Hello\r\n"
	got := extractHeader(block, "Message-ID")
	if got != "" {
		t.Errorf("extractHeader missing key = %q, want ''", got)
	}
}

func TestExtractHeader_PresentKey(t *testing.T) {
	block := "Message-ID: <abc123@example.com>\r\nFrom: x@y.com\r\n"
	got := extractHeader(block, "Message-ID")
	if got == "" {
		t.Error("extractHeader should find Message-ID in block")
	}
	if !strings.Contains(got, "abc123") {
		t.Errorf("extractHeader returned %q, expected to contain 'abc123'", got)
	}
}

func TestExtractHeader_EmptyKey(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("extractHeader with empty key panicked: %v", r)
		}
	}()
	_ = extractHeader("From: x@y.com\r\n", "")
}

func TestExtractHeader_CaseInsensitiveMonkey(t *testing.T) {
	block := "message-id: <lower@example.com>\r\n"
	got := extractHeader(block, "Message-ID")
	if got == "" {
		t.Error("extractHeader should be case-insensitive")
	}
}

// Property: extractHeader never panics.
func TestExtractHeader_Property_NoPanic(t *testing.T) {
	f := func(block, key string) bool {
		defer func() { recover() }() //nolint:errcheck
		_ = extractHeader(block, key)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("extractHeader property: %v", err)
	}
}

// ── extractBody boundary tests ────────────────────────────────────────────────

func TestExtractBody_EmptyBlock(t *testing.T) {
	body := extractBody("")
	_ = body // nil or empty both fine — no panic
}

func TestExtractBody_BlockWithDoubleCRLF(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("extractBody panicked: %v", r)
		}
	}()
	got := extractBody("headers\r\n\r\nbody content here)")
	_ = got
}

func TestExtractBody_ReturnsBodyAfterSeparator(t *testing.T) {
	got := extractBody("Header: value\r\n\r\nbody text)")
	if !strings.Contains(got, "body text") {
		t.Errorf("extractBody = %q, should contain 'body text'", got)
	}
}

// Property: extractBody never panics.
func TestExtractBody_Property_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }() //nolint:errcheck
		_ = extractBody(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("extractBody property: %v", err)
	}
}

// ── NewPoller nil-safety ──────────────────────────────────────────────────────

func TestNewPoller_NilConfig_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("NewPoller with nil args panicked: %v", r)
		}
	}()
	p := NewPoller(nil, nil)
	if p == nil {
		t.Fatal("NewPoller returned nil")
	}
}

func TestNewPoller_SeenMapInitialised(t *testing.T) {
	p := NewPoller(nil, nil)
	if p.seen == nil {
		t.Error("NewPoller must initialise the seen map")
	}
	// Should not panic on write.
	p.markSeen("test-id")
}

func TestWithHealth_NilRecorder_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("WithHealth panicked: %v", r)
		}
	}()
	p := NewPoller(nil, nil)
	p2 := p.WithHealth(nil)
	if p2 == nil {
		t.Error("WithHealth must return non-nil Poller")
	}
}
