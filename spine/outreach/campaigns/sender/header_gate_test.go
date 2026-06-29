package sender

import (
	"fmt"
	"net/mail"
	"strings"
	"testing"
)

// ═══════════════════════════════════════════════════════════════════════════
//  M8 / anti-trace HEADER GATE (unit)
//
// Locks in the invariants that "maximálně anonymizovaný" e-mail must satisfy
// at the buildMessage layer. These are the headers the Go sender controls
// directly; relay-level stripping (X-Originating-IP injected by the SMTP
// transport, Received chain rewriting) happens one layer down in the Rust
// anti-trace-relay and is validated by the integration test alongside.
//
// The gate rejects any regression that would let real-origin fingerprints
// slip into outbound mail.
// ═══════════════════════════════════════════════════════════════════════════

// parseHeaders parses the header block of a buildMessage output.
func parseHeaders(t *testing.T, msg []byte) mail.Header {
	t.Helper()
	m, err := mail.ReadMessage(strings.NewReader(string(msg)))
	if err != nil {
		t.Fatalf("mail.ReadMessage: %v", err)
	}
	return m.Header
}

func TestHeaderGate_NoXOriginatingIPByDefault(t *testing.T) {
	// buildMessage must NEVER auto-inject X-Originating-IP.
	msg := buildMessage("jan@alias.test", "biz@target.test", "Poptavka",
		"Dobry den.", "", nil, "id1@alias.test")
	h := parseHeaders(t, msg)
	if got := h.Get("X-Originating-IP"); got != "" {
		t.Errorf("X-Originating-IP must not be set, got %q", got)
	}
}

func TestHeaderGate_NoXMailerByDefault(t *testing.T) {
	msg := buildMessage("jan@alias.test", "biz@target.test", "S",
		"B", "", nil, "id@alias.test")
	h := parseHeaders(t, msg)
	if got := h.Get("X-Mailer"); got != "" {
		t.Errorf("X-Mailer must not be injected by default, got %q", got)
	}
}

func TestHeaderGate_NoXMailerWithEmptyHeaderMap(t *testing.T) {
	msg := buildMessage("jan@alias.test", "biz@target.test", "S",
		"B", "", map[string]string{}, "id@alias.test")
	h := parseHeaders(t, msg)
	if got := h.Get("X-Mailer"); got != "" {
		t.Errorf("empty headers map must not yield X-Mailer, got %q", got)
	}
}

func TestHeaderGate_NoUserAgentHeader(t *testing.T) {
	msg := buildMessage("jan@alias.test", "biz@target.test", "S",
		"B", "", nil, "id@alias.test")
	h := parseHeaders(t, msg)
	if got := h.Get("User-Agent"); got != "" {
		t.Errorf("User-Agent must not be set, got %q", got)
	}
}

func TestHeaderGate_NoXSenderHeader(t *testing.T) {
	msg := buildMessage("jan@alias.test", "biz@target.test", "S",
		"B", "", nil, "id@alias.test")
	h := parseHeaders(t, msg)
	for _, key := range []string{"X-Sender", "X-Originating-Client", "X-Source-IP"} {
		if got := h.Get(key); got != "" {
			t.Errorf("%s must not be set, got %q", key, got)
		}
	}
}

func TestHeaderGate_MessageIDUsesFromDomain(t *testing.T) {
	// When no Message-ID is provided, generateMessageID must use the
	// from-address domain — not the machine hostname, not a leaked origin.
	mid := generateMessageID("jan@alias.test")
	if !strings.HasSuffix(mid, "@alias.test") {
		t.Errorf("Message-ID must end with from-address domain; got %q", mid)
	}
	// Must not contain any hint of the local hostname.
	if strings.Contains(mid, "localhost") || strings.Contains(mid, ".local") {
		t.Errorf("Message-ID leaks local hostname: %q", mid)
	}
}

func TestHeaderGate_MessageIDUsesCallerSuppliedDomain(t *testing.T) {
	// When buildMessage is given an explicit Message-ID, it must be used
	// verbatim (modulo angle brackets) — that's the relay's chance to make
	// sure the ID's domain matches the alias, not the real origin.
	explicit := "abc.def@email.seznam.cz"
	msg := buildMessage("jan@technotrade.cz", "biz@target.test", "S", "B", "",
		map[string]string{"Message-ID": "<" + explicit + ">"}, "<"+explicit+">")
	h := parseHeaders(t, msg)
	if got := h.Get("Message-ID"); got != "<"+explicit+">" {
		t.Errorf("Message-ID must be caller-supplied verbatim, got %q, want <%s>", got, explicit)
	}
}

func TestHeaderGate_FromMatchesAlias(t *testing.T) {
	// From MUST equal the alias (mailbox.FromAddress), never the real-origin
	// operator identity. buildMessage takes `from` explicitly; just verify
	// that whatever comes in goes out unchanged.
	alias := "jan@alias.test"
	msg := buildMessage(alias, "biz@target.test", "S", "B", "", nil, "id@alias.test")
	h := parseHeaders(t, msg)
	if got := h.Get("From"); got != alias {
		t.Errorf("From = %q, want %q", got, alias)
	}
}

func TestHeaderGate_DateHeaderPreservedFromHumanize(t *testing.T) {
	// Humanize layer generates a Date matching the persona's timezone so a
	// mailbox in "Europe/Prague" never sends at 02:00 local time. buildMessage
	// must preserve that Date verbatim and must NOT overwrite with UTC or server time.
	humanizedDate := "Tue, 07 Apr 2026 10:15:23 +0200"
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "",
		map[string]string{"Date": humanizedDate}, "id@alias.test")
	h := parseHeaders(t, msg)
	got := h.Get("Date")
	if !strings.Contains(got, "+0200") {
		t.Errorf("Date timezone must be preserved: got %q", got)
	}
	if got != humanizedDate {
		t.Errorf("Date must be verbatim humanize value, got %q, want %q", got, humanizedDate)
	}
}

func TestHeaderGate_ListUnsubscribePresentWhenSupplied(t *testing.T) {
	// When content layer renders an unsubscribe link, buildMessage must pass
	// it through so mainstream ESP-style unsubscribe works.
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "",
		map[string]string{
			"List-Unsubscribe":      "<https://unsub.example/u?c=xyz>, <mailto:unsub@alias.test>",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		}, "id@alias.test")
	h := parseHeaders(t, msg)
	if got := h.Get("List-Unsubscribe"); got == "" {
		t.Error("List-Unsubscribe must be preserved when supplied")
	}
	if got := h.Get("List-Unsubscribe-Post"); got != "List-Unsubscribe=One-Click" {
		t.Errorf("List-Unsubscribe-Post = %q, want List-Unsubscribe=One-Click", got)
	}
}

func TestHeaderGate_NoReceivedHeaderEmitted(t *testing.T) {
	// buildMessage must not emit a Received: header. The SMTP transport adds
	// the top Received chain; anything we insert here would show up BEFORE
	// the relay's chain and leak origin.
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "", nil, "id@alias.test")
	h := parseHeaders(t, msg)
	if got := h.Get("Received"); got != "" {
		t.Errorf("Received header must not be emitted by buildMessage, got %q", got)
	}
}

func TestHeaderGate_CRLFInjectionInSubjectStripped(t *testing.T) {
	// Attacker-controlled subject with CRLF must not smuggle a second header.
	msg := buildMessage("jan@alias.test", "biz@target.test",
		"Hello\r\nBcc: evil@attacker.test",
		"B", "", nil, "id@alias.test")
	s := string(msg)
	// Key property: no fresh header line starting with Bcc:
	if strings.Contains(s, "\r\nBcc:") {
		t.Error("CRLF injection via Subject allowed Bcc header smuggling")
	}
	// Parsed headers must not contain a Bcc field.
	h := parseHeaders(t, msg)
	if got := h.Get("Bcc"); got != "" {
		t.Errorf("parsed Bcc must be empty after CRLF strip, got %q", got)
	}
}

func TestHeaderGate_CRLFInjectionInToStripped(t *testing.T) {
	msg := buildMessage("jan@alias.test",
		"biz@target.test\r\nBcc: spy@attacker.test",
		"S", "B", "", nil, "id@alias.test")
	s := string(msg)
	if strings.Contains(s, "\r\nBcc:") {
		t.Error("CRLF injection via To allowed Bcc header smuggling")
	}
	h := parseHeaders(t, msg)
	if got := h.Get("Bcc"); got != "" {
		t.Errorf("parsed Bcc must be empty, got %q", got)
	}
}

func TestHeaderGate_CRLFInjectionInFromStripped(t *testing.T) {
	msg := buildMessage("jan@alias.test\r\nReply-To: spy@attacker.test",
		"biz@target.test", "S", "B", "", nil, "id@alias.test")
	s := string(msg)
	if strings.Contains(s, "\r\nReply-To:") {
		t.Error("CRLF injection via From allowed Reply-To header smuggling")
	}
	h := parseHeaders(t, msg)
	if got := h.Get("Reply-To"); got != "" {
		t.Errorf("parsed Reply-To must be empty, got %q", got)
	}
}

func TestHeaderGate_CRLFInjectionInMessageIDStripped(t *testing.T) {
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "", nil,
		"id@alias.test\r\nReceived: from attacker.test")
	s := string(msg)
	if strings.Contains(s, "\r\nReceived:") {
		t.Error("CRLF injection via Message-ID allowed Received header smuggling")
	}
	h := parseHeaders(t, msg)
	if got := h.Get("Received"); got != "" {
		t.Errorf("parsed Received must be empty, got %q", got)
	}
}

func TestHeaderGate_CRLFInjectionInCustomHeaderKeyDropped(t *testing.T) {
	// Attacker-controlled header KEY with a colon or whitespace is dropped
	// entirely so "X-C\r\nBcc: spy@..." never turns into a Bcc header.
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "",
		map[string]string{
			"X-Legit":           "fine",
			"X-Smuggled\r\nBcc": "spy@attacker.test",
			"X:evil":            "spy@attacker.test",
			"X has space":       "spy@attacker.test",
		}, "id@alias.test")
	s := string(msg)
	// Must not create a Bcc header line.
	if strings.Contains(s, "\r\nBcc:") {
		t.Error("smuggled key produced Bcc header line")
	}
	h := parseHeaders(t, msg)
	if got := h.Get("Bcc"); got != "" {
		t.Errorf("parsed Bcc must be empty, got %q", got)
	}
	// Legit header still lands.
	if !strings.Contains(s, "X-Legit: fine") {
		t.Error("legit header dropped when it should have survived filter")
	}
}

func TestHeaderGate_CRLFInjectionInCustomHeaderValueStripped(t *testing.T) {
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "",
		map[string]string{
			"X-Tag": "legit\r\nBcc: spy@attacker.test",
		}, "id@alias.test")
	s := string(msg)
	// Must not create a Bcc header line (value with colon is OK as part of X-Tag).
	if strings.Contains(s, "\r\nBcc:") {
		t.Error("CRLF in custom header value produced Bcc header line")
	}
	h := parseHeaders(t, msg)
	if got := h.Get("Bcc"); got != "" {
		t.Errorf("parsed Bcc must be empty, got %q", got)
	}
}

func TestHeaderGate_CRLFSplitKeyCannotForgeBccHeader(t *testing.T) {
	// Hardest case: attacker splits the keyword "Bcc" itself across a CRLF,
	// so naive strip ("B\r\ncc" → "Bcc") would forge a Bcc header. The
	// filter must reject keys containing control characters entirely.
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "",
		map[string]string{
			"B\r\ncc":          "spy@attacker.test",
			"Rep\r\nly-To":     "spy@attacker.test",
			"Rece\r\nived":     "from attacker.test",
			"X-Origin\r\nating-IP": "1.2.3.4",
		}, "id@alias.test")
	h := parseHeaders(t, msg)
	for _, forged := range []string{"Bcc", "Reply-To", "Received", "X-Originating-IP"} {
		if got := h.Get(forged); got != "" {
			t.Errorf("CRLF-split key forged %s header: %q", forged, got)
		}
	}
}

func TestHeaderGate_MIMEVersionPresent(t *testing.T) {
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "", nil, "id@alias.test")
	h := parseHeaders(t, msg)
	if h.Get("MIME-Version") != "1.0" {
		t.Errorf("MIME-Version = %q, want 1.0", h.Get("MIME-Version"))
	}
}

func TestHeaderGate_NoBccLeaksForBenignInput(t *testing.T) {
	// Sanity: a perfectly benign message must NEVER contain a Bcc line.
	msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "", map[string]string{
		"List-Unsubscribe": "<https://unsub/x>",
		"X-Mailer":         "custom",
	}, "id@alias.test")
	h := parseHeaders(t, msg)
	if got := h.Get("Bcc"); got != "" {
		t.Errorf("unexpected Bcc: %q", got)
	}
}

func TestHeaderGate_HeaderOrderFromToSubjectFirst(t *testing.T) {
	// From, To, Subject must appear as the first three headers so downstream
	// relay parsers (which may stop scanning after first N headers) see them.
	msg := buildMessage("jan@alias.test", "biz@target.test", "My Subject", "B", "", nil, "id@alias.test")
	s := string(msg)
	fromIdx := strings.Index(s, "From: ")
	toIdx := strings.Index(s, "To: ")
	subjIdx := strings.Index(s, "Subject: ")
	if fromIdx < 0 || toIdx < 0 || subjIdx < 0 {
		t.Fatal("From/To/Subject missing")
	}
	if !(fromIdx < toIdx && toIdx < subjIdx) {
		t.Errorf("header order must be From → To → Subject (indices %d, %d, %d)",
			fromIdx, toIdx, subjIdx)
	}
}

// ─── Tracking-pixel absence ──────────────────────────────────────────────
//
// buildMessage never injects tracking pixels. Any tracking pixel that lands
// in the outbound message must come from an explicit caller choice (content
// layer generates <img src="/o?id=xyz">). The gate here is: when the caller
// doesn't supply a tracking pixel, none appears.

func TestHeaderGate_NoTrackingPixelInPlainBody(t *testing.T) {
	msg := buildMessage("jan@alias.test", "biz@target.test", "S",
		"Dobry den, rad bych navazal spolupraci.", "", nil, "id@alias.test")
	s := string(msg)
	if strings.Contains(s, "<img") {
		t.Error("plain-only message leaked an <img tag")
	}
	if strings.Contains(s, "/o?") || strings.Contains(s, "/o/") {
		t.Error("plain-only message leaked a tracking-pixel URL")
	}
}

func TestHeaderGate_NoTrackingPixelInHTMLBodyWhenNotProvided(t *testing.T) {
	htmlNoPixel := "<p>Dobry den, rad bych navazal spolupraci.</p>"
	msg := buildMessage("jan@alias.test", "biz@target.test", "S",
		"Dobry den.", htmlNoPixel, nil, "id@alias.test")
	s := string(msg)
	if strings.Contains(s, "<img") {
		t.Error("HTML body leaked an <img tag that wasn't caller-supplied")
	}
}

// ─── Canonical anti-trace envelope ──────────────────────────────────────

func TestHeaderGate_CanonicalAntiTraceEnvelope(t *testing.T) {
	// This is the full anti-trace shape: alias From, canonical Message-ID,
	// humanized Date, List-Unsubscribe, no tracking pixel, no origin leaks.
	alias := "jan@technotrade-eu.com"
	mid := "<" + fmt.Sprintf("%s@email.seznam.cz", "unique-abc-123") + ">"
	humanizedDate := "Mon, 13 Apr 2026 09:12:44 +0200"

	msg := buildMessage(
		alias,
		"sales@target-firma.cz",
		"Poptavka CNC stroju",
		"Dobry den,\n\nNabizime dodavku CNC stroju.\n\nJan Novak",
		"",
		map[string]string{
			"Date":                  humanizedDate,
			"Message-ID":            mid,
			"List-Unsubscribe":      "<https://unsub.example/u?c=xyz>, <mailto:unsub@technotrade-eu.com>",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
		mid,
	)
	h := parseHeaders(t, msg)

	gate := map[string]struct {
		mustEqual   string
		mustContain string
		mustBeEmpty bool
	}{
		"From":                  {mustEqual: alias},
		"Date":                  {mustEqual: humanizedDate},
		"Message-ID":            {mustEqual: mid},
		"List-Unsubscribe":      {mustContain: "unsub"},
		"List-Unsubscribe-Post": {mustEqual: "List-Unsubscribe=One-Click"},
		"MIME-Version":          {mustEqual: "1.0"},
		// Origin-leak vectors — MUST be empty.
		"X-Originating-IP":     {mustBeEmpty: true},
		"X-Mailer":             {mustBeEmpty: true},
		"X-Sender":             {mustBeEmpty: true},
		"X-Originating-Client": {mustBeEmpty: true},
		"X-Source-IP":          {mustBeEmpty: true},
		"User-Agent":           {mustBeEmpty: true},
		"Received":             {mustBeEmpty: true},
		"Bcc":                  {mustBeEmpty: true},
	}
	for key, expect := range gate {
		got := h.Get(key)
		switch {
		case expect.mustBeEmpty && got != "":
			t.Errorf("%s: must be empty, got %q", key, got)
		case expect.mustEqual != "" && got != expect.mustEqual:
			t.Errorf("%s: got %q, want %q", key, got, expect.mustEqual)
		case expect.mustContain != "" && !strings.Contains(got, expect.mustContain):
			t.Errorf("%s: got %q, want it to contain %q", key, got, expect.mustContain)
		}
	}
}

// ─── Header-case resistance ─────────────────────────────────────────────

func TestHeaderGate_DuplicateHeaderPreventionFromToSubject(t *testing.T) {
	// Caller includes From/To/Subject in the headers map — buildMessage's
	// skip-set must prevent them from being duplicated in the output.
	msg := buildMessage("real@alias.test", "real@target.test", "Real Subject", "B", "",
		map[string]string{
			"From":    "WRONG@forged.test",
			"To":      "WRONG@forged.test",
			"Subject": "WRONG Subject",
		},
		"id@alias.test")
	s := string(msg)
	if c := strings.Count(s, "From: "); c != 1 {
		t.Errorf("From header count = %d, want 1", c)
	}
	if c := strings.Count(s, "To: "); c != 1 {
		t.Errorf("To header count = %d, want 1", c)
	}
	if c := strings.Count(s, "Subject: "); c != 1 {
		t.Errorf("Subject header count = %d, want 1", c)
	}
	if strings.Contains(s, "forged.test") || strings.Contains(s, "WRONG Subject") {
		t.Error("caller's headers map overrode the alias/real From/To/Subject")
	}
}

func TestHeaderGate_CanonicalDomainInMessageID(t *testing.T) {
	// A mailbox can operate under multiple aliases (same mailbox, different
	// personas). Each alias must produce a Message-ID whose domain matches
	// that alias exactly — never the host's hostname, never a different alias.
	cases := []struct {
		alias      string
		wantSuffix string
	}{
		{"jan@technotrade-eu.com", "@technotrade-eu.com"},
		{"ops@seznam.cz", "@seznam.cz"},
		{"sales@firma.example", "@firma.example"},
	}
	for _, c := range cases {
		t.Run(c.alias, func(t *testing.T) {
			mid := generateMessageID(c.alias)
			if !strings.HasSuffix(mid, c.wantSuffix) {
				t.Errorf("Message-ID %q should end with %q", mid, c.wantSuffix)
			}
		})
	}
}

// Dynamic matrix: every known origin-leak header must stay empty across
// many combinations of caller-supplied header inputs.
func TestHeaderGate_OriginLeakHeaderMatrix(t *testing.T) {
	leakHeaders := []string{
		"X-Originating-IP",
		"X-Mailer",
		"X-Sender",
		"X-Originating-Client",
		"X-Source-IP",
		"User-Agent",
		"Received",
	}
	inputCases := []map[string]string{
		nil,
		{},
		{"List-Unsubscribe": "<https://u/x>"},
		{"Date": "Tue, 07 Apr 2026 10:00:00 +0200"},
		{"X-Custom-Tag": "internal=campaign-42"},
		// Leak headers explicitly passed — those DO appear (operator choice).
		// Excluded from this matrix; covered by a separate test.
	}
	for i, headers := range inputCases {
		t.Run(fmt.Sprintf("case%d", i), func(t *testing.T) {
			msg := buildMessage("jan@alias.test", "biz@target.test", "S", "B", "",
				headers, "id@alias.test")
			h := parseHeaders(t, msg)
			for _, leak := range leakHeaders {
				if got := h.Get(leak); got != "" {
					t.Errorf("%s must stay empty without explicit caller supply, got %q (case %d)", leak, got, i)
				}
			}
		})
	}
}
