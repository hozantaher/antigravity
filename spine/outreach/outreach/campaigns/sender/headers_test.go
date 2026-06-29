package sender

// Anti-trace anonymity bundle — per-fix unit tests + integration.
//
// Each test maps to one of the three FIXes called out in the
// 2026-05-01 brutal anonymity audit (17/100):
//
//   FIX 1 — per-recipient Message-ID HMAC (TestBuildMessageIDHeader_*)
//   FIX 2 — From: "Display Name <addr>"   (TestBuildFromHeader_*)
//   FIX 3 — Date: mailbox.Timezone        (TestBuildDateHeader_*)
//
// Plus an end-to-end test that exercises the full
// applyAnonymityHeaders contract. Total: ≥10 cases per the
// repo-wide extreme-testing rule (memory feedback_extreme_testing).

import (
	"net/mail"
	"strings"
	"testing"
	"time"
)

// nowForTests returns a deterministic timestamp so Message-ID's nanos
// stay stable across runs and Date-header timezone tests have a known
// reference clock.
func nowForTests() time.Time {
	// 2026-05-01 12:34:56 UTC — past DST transition, mid-day.
	return time.Date(2026, time.May, 1, 12, 34, 56, 789012345, time.UTC)
}

// ─── FIX 1 — Message-ID per-recipient HMAC ───────────────────────────────

func TestBuildMessageIDHeader_SameRecipientSameEnvelopeStableHash(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	now := nowForTests()
	a := BuildMessageIDHeader("recipient@target.cz", "envid-123", "sender@alias.cz", key, now)
	b := BuildMessageIDHeader("recipient@target.cz", "envid-123", "sender@alias.cz", key, now)
	if a != b {
		t.Errorf("same recipient + envelope + clock should yield same Message-ID; got %q vs %q", a, b)
	}
}

func TestBuildMessageIDHeader_DifferentRecipientsDifferentHash(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	now := nowForTests()
	a := BuildMessageIDHeader("alice@target.cz", "envid-123", "sender@alias.cz", key, now)
	b := BuildMessageIDHeader("bob@target.cz", "envid-123", "sender@alias.cz", key, now)
	if a == b {
		t.Errorf("different recipients must yield different hashes; both %q", a)
	}
}

func TestBuildMessageIDHeader_DifferentEnvelopesDifferentHash(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	now := nowForTests()
	a := BuildMessageIDHeader("recipient@target.cz", "env1", "sender@alias.cz", key, now)
	b := BuildMessageIDHeader("recipient@target.cz", "env2", "sender@alias.cz", key, now)
	if a == b {
		t.Errorf("different envelope ids must yield different hashes; both %q", a)
	}
}

func TestBuildMessageIDHeader_FormatRFC5322(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	mid := BuildMessageIDHeader("to@x", "env-1", "from@alias.example", key, nowForTests())
	// <hex16.nanos@domain>
	if !strings.HasPrefix(mid, "<") || !strings.HasSuffix(mid, ">") {
		t.Fatalf("Message-ID must be in angle brackets: %q", mid)
	}
	inner := mid[1 : len(mid)-1]
	if !strings.HasSuffix(inner, "@alias.example") {
		t.Errorf("Message-ID must end with @alias.example, got %q", inner)
	}
	parts := strings.SplitN(inner, "@", 2)
	if len(parts) != 2 {
		t.Fatalf("Message-ID local@domain split failed: %q", inner)
	}
	leftDot := strings.SplitN(parts[0], ".", 2)
	if len(leftDot) != 2 {
		t.Fatalf("Message-ID local must be hex.nanos: %q", parts[0])
	}
	if len(leftDot[0]) != 16 {
		t.Errorf("hex prefix must be 16 chars (got %d): %q", len(leftDot[0]), leftDot[0])
	}
}

func TestBuildMessageIDHeader_NilKeyFallsThroughToLegacy(t *testing.T) {
	mid := BuildMessageIDHeader("to@x", "env-1", "from@alias.example", nil, nowForTests())
	if mid == "" {
		t.Fatal("nil key fallback must still produce a Message-ID")
	}
	if !strings.Contains(mid, "@alias.example") {
		t.Errorf("legacy fallback must still embed sender domain, got %q", mid)
	}
}

func TestBuildMessageIDHeader_EmptyFromAddressUsesPlaceholderDomain(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	mid := BuildMessageIDHeader("to@x", "env-1", "", key, nowForTests())
	if !strings.Contains(mid, "@alias.local") {
		t.Errorf("empty fromAddress should fall back to alias.local, got %q", mid)
	}
}

// ─── FIX 2 — From: "Display Name <email>" ────────────────────────────────

func TestBuildFromHeader_ExplicitDisplayName(t *testing.T) {
	got := BuildFromHeader("Jan Novák", "jan.novak@firma.cz")
	want := "Jan Novák <jan.novak@firma.cz>"
	if got != want {
		t.Errorf("BuildFromHeader = %q, want %q", got, want)
	}
}

func TestBuildFromHeader_FallbackTitleCases_FirstInitial(t *testing.T) {
	got := BuildFromHeader("", "a.mazher@email.cz")
	want := "A. Mazher <a.mazher@email.cz>"
	if got != want {
		t.Errorf("BuildFromHeader fallback = %q, want %q", got, want)
	}
}

func TestBuildFromHeader_FallbackTitleCases_FullNames(t *testing.T) {
	cases := []struct {
		email string
		want  string
	}{
		{"jan.novak@firma.cz", "Jan Novak <jan.novak@firma.cz>"},
		{"info@firma.cz", "Info <info@firma.cz>"},
		{"sales_team@firma.cz", "Sales Team <sales_team@firma.cz>"},
		{"a.b.c@firma.cz", "A. B C <a.b.c@firma.cz>"},
	}
	for _, c := range cases {
		t.Run(c.email, func(t *testing.T) {
			got := BuildFromHeader("", c.email)
			if got != c.want {
				t.Errorf("BuildFromHeader(\"\", %q) = %q, want %q", c.email, got, c.want)
			}
		})
	}
}

func TestBuildFromHeader_QuoteWhenSpecials(t *testing.T) {
	// Display name with a comma (RFC 5322 special) must be quoted.
	got := BuildFromHeader("Novak, Jan", "jan@firma.cz")
	want := `"Novak, Jan" <jan@firma.cz>`
	if got != want {
		t.Errorf("BuildFromHeader = %q, want %q", got, want)
	}
}

func TestBuildFromHeader_ParsesViaNetMail(t *testing.T) {
	// The Go stdlib mail.ParseAddress accepts RFC 5322 address-spec; if
	// ours parses cleanly, Python email.utils.parseaddr will too.
	got := BuildFromHeader("Jan Novak", "jan@firma.cz")
	addr, err := mail.ParseAddress(got)
	if err != nil {
		t.Fatalf("mail.ParseAddress(%q) failed: %v", got, err)
	}
	if addr.Name != "Jan Novak" {
		t.Errorf("parsed Name = %q, want %q", addr.Name, "Jan Novak")
	}
	if addr.Address != "jan@firma.cz" {
		t.Errorf("parsed Address = %q, want %q", addr.Address, "jan@firma.cz")
	}
}

func TestBuildFromHeader_FallbackParsesViaNetMail(t *testing.T) {
	// Fallback path must also produce a parseable header.
	got := BuildFromHeader("", "a.mazher@email.cz")
	addr, err := mail.ParseAddress(got)
	if err != nil {
		t.Fatalf("mail.ParseAddress(%q) failed: %v", got, err)
	}
	if addr.Name != "A. Mazher" {
		t.Errorf("parsed Name = %q, want %q", addr.Name, "A. Mazher")
	}
}

// ─── FIX 3 — Date: mailbox.Timezone ──────────────────────────────────────

func TestBuildDateHeader_RespectsExplicitTimezone_Prague(t *testing.T) {
	// 2026-05-01 12:34:56 UTC = 14:34:56 +0200 Prague (CEST, post-DST).
	got := BuildDateHeader("Europe/Prague", nowForTests())
	if !strings.Contains(got, "+0200") {
		t.Errorf("Prague summer-time offset must be +0200, got %q", got)
	}
	if !strings.Contains(got, "Fri, 01 May 2026 14:34:56") {
		t.Errorf("Prague-local hour must be 14:34:56, got %q", got)
	}
}

func TestBuildDateHeader_RespectsExplicitTimezone_NewYork(t *testing.T) {
	// 2026-05-01 12:34:56 UTC = 08:34:56 -0400 New York (EDT).
	got := BuildDateHeader("America/New_York", nowForTests())
	if !strings.Contains(got, "-0400") {
		t.Errorf("NY summer-time offset must be -0400, got %q", got)
	}
	if !strings.Contains(got, "08:34:56") {
		t.Errorf("NY local hour must be 08:34:56, got %q", got)
	}
}

func TestBuildDateHeader_EmptyTzFallsBackToPrague(t *testing.T) {
	got := BuildDateHeader("", nowForTests())
	if !strings.Contains(got, "+0200") {
		t.Errorf("empty tz must fall back to Prague (+0200), got %q", got)
	}
}

func TestBuildDateHeader_BogusTzFallsBackToPrague(t *testing.T) {
	got := BuildDateHeader("Mars/Olympus_Mons", nowForTests())
	if !strings.Contains(got, "+0200") {
		t.Errorf("bogus tz must fall back to Prague (+0200), got %q", got)
	}
}

func TestBuildDateHeader_ParsesViaNetMail(t *testing.T) {
	header := "Date: " + BuildDateHeader("Europe/Prague", nowForTests()) + "\r\n\r\n"
	msg, err := mail.ReadMessage(strings.NewReader(header))
	if err != nil {
		t.Fatalf("mail.ReadMessage: %v", err)
	}
	parsed, err := mail.ParseDate(msg.Header.Get("Date"))
	if err != nil {
		t.Fatalf("mail.ParseDate: %v", err)
	}
	// 2026-05-01 12:34:56 UTC must round-trip (ignoring sub-second precision
	// — RFC 5322 Date format only carries second granularity).
	wantSec := nowForTests().Truncate(time.Second)
	if !parsed.Equal(wantSec) {
		t.Errorf("Date round-trip mismatch: got %v, want %v", parsed.UTC(), wantSec)
	}
}

// ─── End-to-end: applyAnonymityHeaders ───────────────────────────────────

func TestApplyAnonymityHeaders_AllThreeFieldsSet(t *testing.T) {
	dst := map[string]string{
		// Pre-populated by humanize fingerprint — the bundle MUST override.
		"Message-ID": "<old-humanize@email.seznam.cz>",
		"From":       "info@alias.cz",
		"Date":       "Mon, 01 Jan 2025 00:00:00 +0000",
	}
	envID, mid, from, date := applyAnonymityHeaders(
		dst, "to@target.cz",
		"sender@alias.cz", "Jan Novak", "Europe/Prague",
		[]byte("0123456789abcdef0123456789abcdef"),
		nowForTests(),
	)
	if envID == "" {
		t.Error("envelope id must be returned")
	}
	if dst["Message-ID"] != mid || mid == "<old-humanize@email.seznam.cz>" {
		t.Errorf("Message-ID must be overridden; got dst=%q mid=%q", dst["Message-ID"], mid)
	}
	if dst["From"] != from || from == "info@alias.cz" {
		t.Errorf("From must be overridden; got dst=%q from=%q", dst["From"], from)
	}
	if dst["Date"] != date || date == "Mon, 01 Jan 2025 00:00:00 +0000" {
		t.Errorf("Date must be overridden; got dst=%q date=%q", dst["Date"], date)
	}
}

func TestApplyAnonymityHeaders_NilDstStillReturnsValues(t *testing.T) {
	envID, mid, from, date := applyAnonymityHeaders(
		nil, "to@target.cz",
		"sender@alias.cz", "Jan Novak", "Europe/Prague",
		[]byte("0123456789abcdef0123456789abcdef"),
		nowForTests(),
	)
	if envID == "" || mid == "" || from == "" || date == "" {
		t.Errorf("nil-dst path must still return all four values; got %q %q %q %q",
			envID, mid, from, date)
	}
}

func TestApplyAnonymityHeaders_EnvelopeIDsUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		envID, _, _, _ := applyAnonymityHeaders(
			map[string]string{}, "to@target.cz",
			"sender@alias.cz", "Jan Novak", "Europe/Prague",
			[]byte("0123456789abcdef0123456789abcdef"),
			nowForTests(),
		)
		if seen[envID] {
			t.Fatalf("duplicate envelope id at iteration %d: %q", i, envID)
		}
		seen[envID] = true
	}
}

// ─── CRLF injection hardening (adversarial sweep 2026-05-05 F2) ─────────────

// TestBuildFromHeader_CRLFInDisplayNameIsStripped verifies that CRLF in a
// display name is removed before formatting — so BuildFromHeader is safe
// regardless of whether the result passes through buildMessage.stripCRLF.
func TestBuildFromHeader_CRLFInDisplayNameIsStripped(t *testing.T) {
	cases := []struct {
		name        string
		displayName string
		email       string
	}{
		{"CR+LF newline", "Jan Novak\r\nBcc: attacker@evil.com", "jan@firma.cz"},
		{"bare LF", "Jan Novak\nBcc: attacker@evil.com", "jan@firma.cz"},
		{"bare CR", "Jan Novak\rBcc: attacker@evil.com", "jan@firma.cz"},
		{"multi CRLF", "A\r\nB\r\nC", "x@y.cz"},
		{"CRLF only", "\r\n", "x@y.cz"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := BuildFromHeader(tc.displayName, tc.email)
			if strings.ContainsAny(got, "\r\n") {
				t.Errorf("BuildFromHeader returned CRLF: %q", got)
			}
			// The result must never contain a raw "Bcc:" that could
			// be parsed as a header by an SMTP server — it should either
			// be stripped or absorbed into the display name string
			// (which is fine since the CRLF that would delimit it is gone).
			lines := strings.Split(got, "\n")
			for _, line := range lines {
				trimmed := strings.TrimSpace(line)
				if strings.HasPrefix(trimmed, "Bcc:") || strings.HasPrefix(trimmed, "bcc:") {
					t.Errorf("potential Bcc: header found in BuildFromHeader output: %q", got)
				}
			}
		})
	}
}

// TestBuildFromHeader_CRLFPurgePreservesValidName verifies that stripping CRLF
// does not corrupt a clean display name.
func TestBuildFromHeader_CRLFPurgePreservesValidName(t *testing.T) {
	got := BuildFromHeader("Jan Novák", "jan.novak@firma.cz")
	want := "Jan Novák <jan.novak@firma.cz>"
	if got != want {
		t.Errorf("BuildFromHeader = %q, want %q", got, want)
	}
}

// ─── Title-case helper coverage ──────────────────────────────────────────

func TestTitleCaseLocalPart_Empty(t *testing.T) {
	if got := titleCaseLocalPart(""); got != "" {
		t.Errorf("empty input must yield empty, got %q", got)
	}
}

func TestTitleCaseLocalPart_NoLocalPart(t *testing.T) {
	if got := titleCaseLocalPart("@domain"); got != "" {
		t.Errorf("missing local part must yield empty, got %q", got)
	}
}

func TestTitleCaseLocalPart_NonASCII(t *testing.T) {
	got := titleCaseLocalPart("nováková@firma.cz")
	if got != "Nováková" {
		t.Errorf("non-ASCII title case = %q, want %q", got, "Nováková")
	}
}
