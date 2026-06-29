package delivery

import (
	"regexp"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// A2: anonymizeMessageID — uses sender FQDN, RFC 5322 §3.6.4 compliant
// ---------------------------------------------------------------------------

// T-A2-1: existing Message-ID is replaced (original value gone, new value present)
func TestAnonymizeMessageIDReplaces(t *testing.T) {
	in := map[string]string{
		"Message-ID": "<original-id@seznam.cz>",
		"Date":       "Mon, 07 Apr 2025 10:00:00 +0000",
	}
	out := anonymizeMessageID(in, "user@example.com")
	if out["Message-ID"] == "<original-id@seznam.cz>" {
		t.Fatal("original Message-ID must be replaced")
	}
	if !strings.HasSuffix(out["Message-ID"], "@example.com>") {
		t.Fatalf("new Message-ID must use sender FQDN, got %q", out["Message-ID"])
	}
}

// T-A2-2: missing Message-ID gets a fresh one injected
func TestAnonymizeMessageIDInjectsWhenAbsent(t *testing.T) {
	in := map[string]string{"Subject": "Hello"}
	out := anonymizeMessageID(in, "mazher.a@email.cz")
	mid, ok := out["Message-ID"]
	if !ok || mid == "" {
		t.Fatal("Message-ID must be injected when absent")
	}
	if !strings.HasSuffix(mid, "@email.cz>") {
		t.Fatalf("injected Message-ID must use sender FQDN, got %q", mid)
	}
}

// T-A2-3: original domain (recipient/old) is not present in the new Message-ID
// when the sender FQDN differs.
func TestAnonymizeMessageIDOriginalDomainGone(t *testing.T) {
	in := map[string]string{"Message-ID": "<xyz@mail.seznam.cz>"}
	out := anonymizeMessageID(in, "sender@email.cz")
	if strings.Contains(out["Message-ID"], "seznam.cz") {
		t.Fatalf("original domain must not appear in new Message-ID, got %q", out["Message-ID"])
	}
	if !strings.Contains(out["Message-ID"], "email.cz") {
		t.Fatalf("sender FQDN must appear in new Message-ID, got %q", out["Message-ID"])
	}
}

// T-A2-4: other headers are preserved unchanged
func TestAnonymizeMessageIDPreservesOtherHeaders(t *testing.T) {
	in := map[string]string{
		"Message-ID": "<id@host>",
		"Date":       "Tue, 08 Apr 2025 09:00:00 +0000",
		"X-Custom":   "keep-me",
	}
	out := anonymizeMessageID(in, "a@a.com")
	if out["Date"] != in["Date"] {
		t.Fatalf("Date header changed, got %q", out["Date"])
	}
	if out["X-Custom"] != "keep-me" {
		t.Fatalf("X-Custom header lost, got %q", out["X-Custom"])
	}
}

// T-A2-5: case-insensitive key match (message-id, MESSAGE-ID, etc.)
func TestAnonymizeMessageIDCaseInsensitive(t *testing.T) {
	variants := []string{"message-id", "MESSAGE-ID", "Message-Id", "mEsSaGe-Id"}
	for _, k := range variants {
		in := map[string]string{k: "<old@host>"}
		out := anonymizeMessageID(in, "sender@example.com")
		// The old key with its exact casing must be gone (or rewritten).
		if v, ok := out[k]; ok && v == "<old@host>" {
			t.Fatalf("key %q: original value not removed", k)
		}
		// A canonical replacement must exist.
		if _, ok := out["Message-ID"]; !ok {
			t.Fatalf("key %q: canonical Message-ID not injected; map=%v", k, out)
		}
	}
}

// T-A2-6: 100 consecutive calls all produce distinct Message-IDs
func TestAnonymizeMessageIDUniqueness(t *testing.T) {
	seen := make(map[string]struct{}, 100)
	for i := 0; i < 100; i++ {
		out := anonymizeMessageID(map[string]string{}, "user@example.com")
		mid := out["Message-ID"]
		if _, dup := seen[mid]; dup {
			t.Fatalf("duplicate Message-ID on iteration %d: %q", i, mid)
		}
		seen[mid] = struct{}{}
	}
}

// T-A2-7: input map is not mutated
func TestAnonymizeMessageIDDoesNotMutateInput(t *testing.T) {
	in := map[string]string{"Message-ID": "<keep@host>", "Date": "unchanged"}
	_ = anonymizeMessageID(in, "a@a.com")
	if in["Message-ID"] != "<keep@host>" {
		t.Fatal("anonymizeMessageID must not mutate the input map")
	}
}

// ---------------------------------------------------------------------------
// A2 NEW: sender FQDN extraction + RFC 5322 §3.6.4 compliance
// (the bug: <hex@relay> with bare label "relay" triggered Seznam silent drop)
// ---------------------------------------------------------------------------

// T-A2-FQDN-Standard: standard sender → uses sender domain
func TestAnonymizeMessageIDUsesSenderDomain(t *testing.T) {
	out := anonymizeMessageID(map[string]string{}, "mazher.a@email.cz")
	if !strings.HasSuffix(out["Message-ID"], "@email.cz>") {
		t.Fatalf("expected @email.cz suffix, got %q", out["Message-ID"])
	}
}

// T-A2-FQDN-Empty: empty sender → fallback to mail.local (defensive,
// always a valid FQDN, never a bare label like "relay")
func TestAnonymizeMessageIDEmptySenderFallback(t *testing.T) {
	out := anonymizeMessageID(map[string]string{}, "")
	if !strings.HasSuffix(out["Message-ID"], "@mail.local>") {
		t.Fatalf("empty sender should fall back to @mail.local, got %q", out["Message-ID"])
	}
}

// T-A2-FQDN-NoAt: malformed sender (no '@') → fallback domain
func TestAnonymizeMessageIDMalformedSenderFallback(t *testing.T) {
	out := anonymizeMessageID(map[string]string{}, "not-an-email")
	if !strings.HasSuffix(out["Message-ID"], "@mail.local>") {
		t.Fatalf("malformed sender should fall back, got %q", out["Message-ID"])
	}
}

// T-A2-FQDN-Subdomain: sender with subdomain (foo@a.b.com) → uses "a.b.com"
func TestAnonymizeMessageIDSubdomainSender(t *testing.T) {
	out := anonymizeMessageID(map[string]string{}, "foo@a.b.com")
	if !strings.HasSuffix(out["Message-ID"], "@a.b.com>") {
		t.Fatalf("subdomain sender should use full FQDN, got %q", out["Message-ID"])
	}
}

// T-A2-FQDN-AngleForm: RFC 5322 angle-addr form ("Name <a@b.com>") → uses
// "b.com"
func TestAnonymizeMessageIDAngleAddrSender(t *testing.T) {
	out := anonymizeMessageID(map[string]string{}, "Display Name <user@example.com>")
	if !strings.HasSuffix(out["Message-ID"], "@example.com>") {
		t.Fatalf("angle-addr form should extract domain, got %q", out["Message-ID"])
	}
}

// T-A2-FQDN-Sanitize: sender with weird chars → sanitized (header injection
// guard — never let a malformed envelope.From smuggle CRLF/spaces into the
// outgoing Message-ID right-hand side)
func TestAnonymizeMessageIDSanitizesWeirdChars(t *testing.T) {
	out := anonymizeMessageID(map[string]string{}, "foo@evil.com\r\nX-Inject: yes")
	mid := out["Message-ID"]
	if strings.ContainsAny(mid, "\r\n") {
		t.Fatalf("Message-ID must not contain CRLF, got %q", mid)
	}
	if strings.Contains(mid, "X-Inject") {
		t.Fatalf("injected header bytes must be sanitized, got %q", mid)
	}
}

// T-A2-FQDN-RFC5322: RFC 5322 §3.6.4 compliance — the right-hand side
// MUST be a multi-label FQDN (contains a dot). The previous "<hex@relay>"
// shape failed this test and triggered Seznam silent spam drop.
func TestAnonymizeMessageIDRFC5322Compliant(t *testing.T) {
	cases := []struct {
		name   string
		sender string
	}{
		{"valid sender", "user@example.com"},
		{"empty sender", ""},
		{"no at", "garbage"},
		{"bare label after at", "user@bare"},
		{"angle form", "Name <a@b.com>"},
	}
	// matches "<localpart@domain.with.at-least.one.dot>"
	rx := regexp.MustCompile(`^<[a-z0-9]+@[a-z0-9.-]+\.[a-z0-9-]+>$`)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := anonymizeMessageID(map[string]string{}, tc.sender)
			mid := out["Message-ID"]
			if !rx.MatchString(mid) {
				t.Fatalf("Message-ID %q does not match RFC 5322 FQDN shape", mid)
			}
			// Explicitly forbid the legacy "@relay>" shape that caused the
			// Seznam silent-drop incident.
			if strings.HasSuffix(mid, "@relay>") {
				t.Fatalf("Message-ID must not use the legacy bare-label '@relay' suffix, got %q", mid)
			}
		})
	}
}

// T-A2-FQDN-NoLocalLeak: the local part is fresh hex entropy — nothing of
// the original Message-ID's local part survives.
func TestAnonymizeMessageIDNoLocalPartLeak(t *testing.T) {
	in := map[string]string{"Message-ID": "<secret-tracking-id-do-not-leak@old.example>"}
	out := anonymizeMessageID(in, "sender@example.com")
	if strings.Contains(out["Message-ID"], "secret-tracking-id") {
		t.Fatalf("original local part leaked into anonymized Message-ID: %q", out["Message-ID"])
	}
}

// T-A2-FQDN-Format: the local part is exactly 32 hex chars (16 random bytes
// formatted with %x), separated from the domain by a single '@'.
func TestAnonymizeMessageIDFormatValid(t *testing.T) {
	out := anonymizeMessageID(map[string]string{}, "sender@example.com")
	mid := out["Message-ID"]

	if !strings.HasPrefix(mid, "<") || !strings.HasSuffix(mid, ">") {
		t.Fatalf("Message-ID must be wrapped in angle brackets, got %q", mid)
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(mid, "<"), ">"), "@")
	if len(parts) != 2 {
		t.Fatalf("Message-ID must have exactly one @, got: %q", mid)
	}
	if len(parts[0]) != 32 {
		t.Fatalf("local part must be 32 hex chars, got %d in %q", len(parts[0]), mid)
	}
}

// ---------------------------------------------------------------------------
// extractMessageIDDomain — focused unit tests
// ---------------------------------------------------------------------------

func TestExtractMessageIDDomain_Table(t *testing.T) {
	cases := []struct {
		name   string
		in     string
		expect string
	}{
		{"empty", "", "mail.local"},
		{"whitespace", "   ", "mail.local"},
		{"no at", "no-at-symbol", "mail.local"},
		{"empty domain", "user@", "mail.local"},
		{"bare label", "user@relay", "mail.local"},
		{"single dot fqdn", "u@a.com", "a.com"},
		{"subdomain fqdn", "u@a.b.com", "a.b.com"},
		{"uppercase", "u@EXAMPLE.COM", "example.com"},
		{"angle addr", "Name <u@example.com>", "example.com"},
		{"crlf injection", "u@example.com\r\nX: y", "example.com"},
		{"trailing dot stripped", "u@example.com.", "example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractMessageIDDomain(tc.in)
			if got != tc.expect {
				t.Fatalf("extractMessageIDDomain(%q) = %q, want %q", tc.in, got, tc.expect)
			}
			if got == "" {
				t.Fatal("must never return empty string")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// A3: stripPrivacyHeaders (unchanged from previous behaviour)
// ---------------------------------------------------------------------------

// T-A3-1: Received header is removed
func TestStripPrivacyHeadersReceived(t *testing.T) {
	in := map[string]string{"Received": "from mx1.example.com", "Subject": "Hi"}
	out := stripPrivacyHeaders(in)
	if _, ok := out["Received"]; ok {
		t.Fatal("Received must be stripped")
	}
}

// T-A3-2: X-Originating-IP is removed
func TestStripPrivacyHeadersXOriginatingIP(t *testing.T) {
	in := map[string]string{"X-Originating-IP": "1.2.3.4"}
	out := stripPrivacyHeaders(in)
	if _, ok := out["X-Originating-IP"]; ok {
		t.Fatal("X-Originating-IP must be stripped")
	}
}

// T-A3-3: X-Forwarded-For is removed
func TestStripPrivacyHeadersXForwardedFor(t *testing.T) {
	in := map[string]string{"X-Forwarded-For": "10.0.0.1"}
	out := stripPrivacyHeaders(in)
	if _, ok := out["X-Forwarded-For"]; ok {
		t.Fatal("X-Forwarded-For must be stripped")
	}
}

// T-A3-4: X-Mailer is removed
func TestStripPrivacyHeadersXMailer(t *testing.T) {
	in := map[string]string{"X-Mailer": "Outlook 16.0", "From": "a@b.com"}
	out := stripPrivacyHeaders(in)
	if _, ok := out["X-Mailer"]; ok {
		t.Fatal("X-Mailer must be stripped")
	}
}

// T-A3-5: User-Agent is removed
func TestStripPrivacyHeadersUserAgent(t *testing.T) {
	in := map[string]string{"User-Agent": "Thunderbird/91", "To": "b@b.com"}
	out := stripPrivacyHeaders(in)
	if _, ok := out["User-Agent"]; ok {
		t.Fatal("User-Agent must be stripped")
	}
}

// T-A3-6: Subject, From, and To are preserved
func TestStripPrivacyHeadersPreservesStructural(t *testing.T) {
	in := map[string]string{
		"Subject":  "Test",
		"From":     "a@a.com",
		"To":       "b@b.com",
		"X-Mailer": "bad",
	}
	out := stripPrivacyHeaders(in)
	for _, key := range []string{"Subject", "From", "To"} {
		if out[key] != in[key] {
			t.Fatalf("header %q must be preserved, got %q", key, out[key])
		}
	}
}

// T-A3-7: map with no privacy headers passes through unchanged (same length)
func TestStripPrivacyHeadersCleanMapUnchanged(t *testing.T) {
	in := map[string]string{
		"Date":    "Mon, 07 Apr 2025 10:00:00 +0000",
		"Subject": "Hello",
	}
	out := stripPrivacyHeaders(in)
	if len(out) != len(in) {
		t.Fatalf("clean map should not lose entries: got %d, want %d", len(out), len(in))
	}
}

// T-A3-8: case-insensitive matching for all five headers
func TestStripPrivacyHeadersCaseInsensitive(t *testing.T) {
	in := map[string]string{
		"RECEIVED":         "from host",
		"X-ORIGINATING-IP": "1.2.3.4",
		"x-forwarded-for":  "10.0.0.1",
		"X-Mailer":         "Outlook",
		"user-agent":       "Thunderbird",
		"subject":          "keep me",
	}
	out := stripPrivacyHeaders(in)
	for _, banned := range []string{"RECEIVED", "X-ORIGINATING-IP", "x-forwarded-for", "X-Mailer", "user-agent"} {
		if _, ok := out[banned]; ok {
			t.Fatalf("key %q should have been stripped", banned)
		}
	}
	if _, ok := out["subject"]; !ok {
		t.Fatal("non-privacy header 'subject' must survive")
	}
}

// T-A3-9: input map is not mutated
func TestStripPrivacyHeadersDoesNotMutateInput(t *testing.T) {
	in := map[string]string{
		"X-Mailer": "keep-original",
		"Date":     "unchanged",
	}
	_ = stripPrivacyHeaders(in)
	if in["X-Mailer"] != "keep-original" {
		t.Fatal("stripPrivacyHeaders must not mutate the input map")
	}
}

// ---------------------------------------------------------------------------
// A2-Engine: isEngineMessageID + Engine HMAC dot-nanos preservation
//
// Sprint U1 (2026-05-04, docs/initiatives/2026-05-04-anti-trace-rollout-and-cleanup.md):
// services/campaigns/sender BuildMessageIDHeader emits HMAC dot-nanos
// Message-IDs that the orchestrator pins to send_events.message_id for
// reply / DSN correlation. The previous unconditional replace silently
// broke that correlation for every Engine-originated send. These tests
// lock the new "preserve Engine MIDs, replace external client MIDs"
// behaviour.
// ---------------------------------------------------------------------------

// T-A2E-1: realistic Engine HMAC dot-nanos shape passes the predicate
func TestIsEngineMessageID_RealEngineFormat(t *testing.T) {
	if !isEngineMessageID("<a88d6c34e396500a.1777908810842389386@email.cz>") {
		t.Fatal("real Engine HMAC dot-nanos shape must be recognized")
	}
}

// T-A2E-2: minimum hex length (8) and minimum digit length (1)
func TestIsEngineMessageID_MinimumViableShape(t *testing.T) {
	if !isEngineMessageID("<deadbeef.0@a.b>") {
		t.Fatal("8-hex.1-digit@a.b must be recognized as Engine MID")
	}
}

// T-A2E-3: maximum hex length (32) and 20-digit timestamp
func TestIsEngineMessageID_MaximumWidth(t *testing.T) {
	hex32 := "0123456789abcdef0123456789abcdef"
	if !isEngineMessageID("<" + hex32 + ".18446744073709551615@example.com>") {
		t.Fatal("32-hex.20-digit shape must be recognized")
	}
}

// T-A2E-4: hex too short (7 chars) → reject
func TestIsEngineMessageID_HexTooShort(t *testing.T) {
	if isEngineMessageID("<abcdef1.123@example.com>") {
		t.Fatal("7-hex must be rejected (minimum is 8)")
	}
}

// T-A2E-5: hex too long (33 chars) → reject
func TestIsEngineMessageID_HexTooLong(t *testing.T) {
	hex33 := "0123456789abcdef0123456789abcdef0"
	if isEngineMessageID("<" + hex33 + ".0@example.com>") {
		t.Fatal("33-hex must be rejected (maximum is 32)")
	}
}

// T-A2E-6: no dot in local part → reject (Outlook-style random ID shape)
func TestIsEngineMessageID_NoDotInLocal(t *testing.T) {
	if isEngineMessageID("<abcdef1234567890@example.com>") {
		t.Fatal("local part without dot must be rejected (not Engine shape)")
	}
}

// T-A2E-7: digit token empty → reject
func TestIsEngineMessageID_NoDigits(t *testing.T) {
	if isEngineMessageID("<abcdef12.@example.com>") {
		t.Fatal("empty digit token must be rejected")
	}
}

// T-A2E-8: non-hex local → reject
func TestIsEngineMessageID_NonHexLocal(t *testing.T) {
	if isEngineMessageID("<xyzghijk.123@example.com>") {
		t.Fatal("non-hex local token must be rejected")
	}
}

// T-A2E-9: digit token contains non-digit → reject
func TestIsEngineMessageID_NonDigitTimestamp(t *testing.T) {
	if isEngineMessageID("<abcdef12.123abc@example.com>") {
		t.Fatal("non-digit timestamp must be rejected")
	}
}

// T-A2E-10: bare-label domain (no dot) → reject even when local matches
func TestIsEngineMessageID_BareDomain(t *testing.T) {
	if isEngineMessageID("<abcdef12.123@relay>") {
		t.Fatal("bare-label domain must be rejected (Seznam silent-drop guard)")
	}
}

// T-A2E-11: leading dot in domain → reject
func TestIsEngineMessageID_LeadingDotDomain(t *testing.T) {
	if isEngineMessageID("<abcdef12.123@.example.com>") {
		t.Fatal("domain with leading dot must be rejected")
	}
}

// T-A2E-12: trailing dot in domain → reject
func TestIsEngineMessageID_TrailingDotDomain(t *testing.T) {
	if isEngineMessageID("<abcdef12.123@example.com.>") {
		t.Fatal("domain with trailing dot must be rejected")
	}
}

// T-A2E-13: missing angle brackets → reject
func TestIsEngineMessageID_NoBrackets(t *testing.T) {
	if isEngineMessageID("abcdef12.123@example.com") {
		t.Fatal("Message-ID without angle brackets must be rejected")
	}
}

// T-A2E-14: empty / blank input → reject
func TestIsEngineMessageID_EmptyAndBlank(t *testing.T) {
	for _, in := range []string{"", " ", "<>", "< >"} {
		if isEngineMessageID(in) {
			t.Fatalf("input %q must be rejected", in)
		}
	}
}

// T-A2E-15: CRLF / header injection bytes → reject
func TestIsEngineMessageID_CRLFInjection(t *testing.T) {
	for _, in := range []string{
		"<abcdef12.123@example.com\r\nX: y>",
		"<abc\rdef.123@example.com>",
		"<abcdef12.\n123@example.com>",
		"<abcdef12.123 @example.com>",
	} {
		if isEngineMessageID(in) {
			t.Fatalf("input %q must be rejected (header-injection guard)", in)
		}
	}
}

// T-A2E-16: leading/trailing whitespace → trimmed and accepted
func TestIsEngineMessageID_TrimsSurroundingWhitespace(t *testing.T) {
	if !isEngineMessageID("   <abcdef12.123@example.com>   ") {
		t.Fatal("surrounding whitespace must be trimmed before check")
	}
}

// T-A2E-17: anonymizeMessageID preserves Engine HMAC input verbatim
func TestAnonymizeMessageID_PreservesEngineHMAC(t *testing.T) {
	engineMID := "<a88d6c34e396500a.1777908810842389386@email.cz>"
	in := map[string]string{
		"Message-ID": engineMID,
		"Date":       "Mon, 04 May 2026 17:21:34 +0200",
	}
	out := anonymizeMessageID(in, "mazher.a@email.cz")
	if out["Message-ID"] != engineMID {
		t.Fatalf("Engine HMAC MID must be preserved verbatim\nwant: %s\ngot:  %s",
			engineMID, out["Message-ID"])
	}
}

// T-A2E-18: anonymizeMessageID replaces non-Engine MIDs (no observability leak
// of upstream client identifiers like Outlook tracking IDs)
func TestAnonymizeMessageID_ReplacesNonEngineFormats(t *testing.T) {
	cases := []string{
		"<outlook-tracking-12345@mailclient.example.com>",
		"<secret-tracking-id-do-not-leak@old.example>",
		"<abcdef1234567890@example.com>",  // 16-hex-no-dot legacy raw-smtp-test
		"<original-id@seznam.cz>",
	}
	for _, mid := range cases {
		in := map[string]string{"Message-ID": mid}
		out := anonymizeMessageID(in, "sender@example.com")
		if out["Message-ID"] == mid {
			t.Fatalf("non-Engine MID %q must be replaced", mid)
		}
		if !strings.HasSuffix(out["Message-ID"], "@example.com>") {
			t.Fatalf("replacement MID must use sender FQDN, got %q", out["Message-ID"])
		}
	}
}

// T-A2E-19: same Engine MID input → identical output across many calls.
// Critical for reply correlation: orchestrator stores send_events.message_id
// once and matches inbound DSN/reply In-Reply-To later. If preservation
// were stochastic, correlation would break randomly.
func TestAnonymizeMessageID_PreservationIsDeterministic(t *testing.T) {
	engineMID := "<deadbeef00112233.1700000000000000000@email.cz>"
	in := map[string]string{"Message-ID": engineMID}
	for i := 0; i < 20; i++ {
		out := anonymizeMessageID(in, "user@email.cz")
		if out["Message-ID"] != engineMID {
			t.Fatalf("iteration %d: preservation must be deterministic, got %q",
				i, out["Message-ID"])
		}
	}
}

// T-A2E-20: BuildMessage end-to-end — Engine HMAC MID survives into
// the wire-format MIME bytes (regression guard for the Sprint U1 fix).
func TestBuildMessagePreservesEngineMessageIDInWire(t *testing.T) {
	engineMID := "<a88d6c34e396500a.1777908810842389386@email.cz>"
	headers := map[string]string{
		"Message-ID":   engineMID,
		"Date":         "Mon, 04 May 2026 17:21:34 +0200",
		"MIME-Version": "1.0",
	}
	msg := string(BuildMessage("mazher.a@email.cz", []string{"b@seznam.cz"}, "Test", "body", "", headers))
	if !strings.Contains(msg, "Message-ID: "+engineMID) {
		t.Fatalf("wire MIME must contain Engine HMAC MID verbatim;\nfull message:\n%s", msg)
	}
}

// ---------------------------------------------------------------------------
// Integration: BuildMessage applies privacy pipeline end-to-end
// ---------------------------------------------------------------------------

// T-INT-1: BuildMessage strips X-Mailer from the outgoing headers
func TestBuildMessageStripsXMailer(t *testing.T) {
	headers := map[string]string{
		"X-Mailer": "Outlook 16.0",
		"Date":     "Mon, 07 Apr 2025 10:00:00 +0000",
	}
	msg := string(BuildMessage("a@a.com", []string{"b@b.com"}, "Hi", "body", "", headers))
	if strings.Contains(msg, "X-Mailer: Outlook") {
		t.Fatal("BuildMessage must strip X-Mailer supplied in headers map")
	}
}

// T-INT-2: BuildMessage produces an anonymized Message-ID with the sender
// FQDN as the right-hand side (the fix — previously this was the bare
// literal "@relay>" which is not RFC 5322 §3.6.4 compliant and triggered
// Seznam silent spam drop).
func TestBuildMessageAnonymizesMessageIDWithSenderFQDN(t *testing.T) {
	headers := map[string]string{
		"Message-ID": "<real-id@seznam.cz>",
	}
	msg := string(BuildMessage("mazher.a@email.cz", []string{"b@seznam.cz"}, "Hi", "body", "", headers))
	if strings.Contains(msg, "real-id@seznam.cz") {
		t.Fatal("original Message-ID must not survive into the final message")
	}
	if !strings.Contains(msg, "@email.cz>") {
		t.Fatal("anonymized Message-ID must use sender FQDN (email.cz)")
	}
	if strings.Contains(msg, "@relay>") {
		t.Fatal("legacy '@relay' bare-label suffix must not appear (Seznam compliance)")
	}
}

// T-INT-3: BuildMessage injects Message-ID even when headers map is nil
func TestBuildMessageInjectsMessageIDWhenNil(t *testing.T) {
	msg := string(BuildMessage("user@example.com", []string{"b@b.com"}, "Hi", "body", "", nil))
	if !strings.Contains(msg, "Message-ID:") {
		t.Fatal("BuildMessage must always inject a Message-ID")
	}
	if !strings.Contains(msg, "@example.com>") {
		t.Fatal("injected Message-ID must use sender FQDN")
	}
}

// ---------------------------------------------------------------------------
// A4: sanitizeHeaders — full pipeline (privacy headers + anonymize Message-ID)
// ---------------------------------------------------------------------------

// T-A4-1: sanitizeHeaders applies both stripping and anonymizing
func TestSanitizeHeaders_FullPipeline(t *testing.T) {
	in := map[string]string{
		"Message-ID":       "<original@seznam.cz>",
		"X-Mailer":         "Outlook",
		"X-Originating-IP": "1.2.3.4",
		"Date":             "Mon, 07 Apr 2025 10:00:00 +0000",
	}
	out := sanitizeHeaders(in, "sender@email.cz")

	// X-Mailer and X-Originating-IP must be stripped
	if _, ok := out["X-Mailer"]; ok {
		t.Fatal("X-Mailer must be stripped")
	}
	if _, ok := out["X-Originating-IP"]; ok {
		t.Fatal("X-Originating-IP must be stripped")
	}

	// Message-ID must be anonymized (not original value) using sender FQDN
	if out["Message-ID"] == in["Message-ID"] {
		t.Fatal("Message-ID must be anonymized")
	}
	if !strings.HasSuffix(out["Message-ID"], "@email.cz>") {
		t.Fatalf("anonymized Message-ID must use sender FQDN, got %q", out["Message-ID"])
	}

	// Date must be preserved
	if out["Date"] != in["Date"] {
		t.Fatal("Date header must be preserved")
	}
}

// T-A4-2: sanitizeHeaders with nil input
func TestSanitizeHeaders_NilInput(t *testing.T) {
	out := sanitizeHeaders(nil, "sender@example.com")
	if out == nil {
		t.Fatal("sanitizeHeaders must not return nil")
	}
	if _, ok := out["Message-ID"]; !ok {
		t.Fatal("sanitizeHeaders must inject Message-ID")
	}
}

// T-A4-3: sanitizeHeaders input is not mutated
func TestSanitizeHeaders_DoesNotMutateInput(t *testing.T) {
	in := map[string]string{
		"Message-ID": "<original@host>",
		"X-Mailer":   "keep-original",
	}
	originalID := in["Message-ID"]
	sanitizeHeaders(in, "sender@example.com")
	if in["Message-ID"] != originalID {
		t.Fatal("sanitizeHeaders must not mutate input map")
	}
}

// T-A4-4: sanitizeHeaders strips X-Test-Run-ID header (privacy leak regression)
// Regression test for bug discovered in 2026-05-05 brutal pre-launch test:
// X-Test-Run-ID was present in delivered messages, exposing internal test run
// correlation IDs to recipients. Fixed by adding "x-test-run-id" to
// privacySensitiveHeaders.
func TestSanitizeHeaders_StripsXTestRunID(t *testing.T) {
	in := map[string]string{
		"Date":          "Tue, 05 May 2026 17:37:43 +0200",
		"X-Test-Run-ID": "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
	}
	out := sanitizeHeaders(in, "sender@email.cz")
	if _, ok := out["X-Test-Run-ID"]; ok {
		t.Fatal("X-Test-Run-ID must be stripped by sanitizeHeaders")
	}
	// Verify the key is stripped regardless of case
	for k := range out {
		if strings.EqualFold(k, "x-test-run-id") {
			t.Fatalf("X-Test-Run-ID (case-insensitive) must be stripped, got key %q", k)
		}
	}
	// Non-sensitive headers must be preserved
	if out["Date"] != in["Date"] {
		t.Fatal("Date header must be preserved")
	}
}

// T-A4-5: stripPrivacyHeaders strips all X-* fingerprint headers
func TestStripPrivacyHeaders_AllFingerprints(t *testing.T) {
	sensitiveHeaders := []string{
		"Received", "X-Originating-IP", "X-Forwarded-For",
		"X-Mailer", "User-Agent", "X-Test-Run-ID",
	}
	in := make(map[string]string)
	for _, h := range sensitiveHeaders {
		in[h] = "should-be-stripped"
	}
	in["Date"] = "kept"
	in["Message-ID"] = "<kept@host>"

	out := stripPrivacyHeaders(in)
	for _, h := range sensitiveHeaders {
		if _, ok := out[h]; ok {
			t.Errorf("sensitive header %q must be stripped", h)
		}
		// Also check lowercase variant
		if _, ok := out[strings.ToLower(h)]; ok {
			t.Errorf("sensitive header %q (lowercase) must be stripped", h)
		}
	}
	if out["Date"] != "kept" {
		t.Fatal("Date header must be preserved")
	}
}
