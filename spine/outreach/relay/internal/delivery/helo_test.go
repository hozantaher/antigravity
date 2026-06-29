package delivery

import (
	"strings"
	"testing"
)

// pickHELODomain — chooses HELO/EHLO domain. Order: configured env >
// sender domain > "mail.local" fallback. Never empty, never "localhost".

func TestPickHELODomain_ConfiguredWins(t *testing.T) {
	got := pickHELODomain("relay.example.com", "anything@whatever")
	if got != "relay.example.com" {
		t.Fatalf("configured value must take precedence, got %q", got)
	}
}

func TestPickHELODomain_DerivesFromSenderEmail(t *testing.T) {
	got := pickHELODomain("", "mb1@email.cz")
	if got != "email.cz" {
		t.Fatalf("expected email.cz, got %q", got)
	}
}

func TestPickHELODomain_DerivesFromAngleAddrForm(t *testing.T) {
	got := pickHELODomain("", "Display Name <user@example.com>")
	if got != "example.com" {
		t.Fatalf("expected example.com from RFC 5322 angle form, got %q", got)
	}
}

func TestPickHELODomain_LowercasesDomain(t *testing.T) {
	got := pickHELODomain("", "user@EXAMPLE.COM")
	if got != "example.com" {
		t.Fatalf("expected lowercased domain, got %q", got)
	}
}

func TestPickHELODomain_TrimsSurroundingWhitespace(t *testing.T) {
	got := pickHELODomain("", "   user@example.com   ")
	if got != "example.com" {
		t.Fatalf("surrounding whitespace must be trimmed, got %q", got)
	}
}

func TestPickHELODomain_FallbackOnEmpty(t *testing.T) {
	got := pickHELODomain("", "")
	if got != "mail.local" {
		t.Fatalf("empty input must fall back to mail.local, got %q", got)
	}
}

func TestPickHELODomain_FallbackOnNoAtSign(t *testing.T) {
	got := pickHELODomain("", "garbage-no-at-sign")
	if got != "mail.local" {
		t.Fatalf("no-@-sign input must fall back, got %q", got)
	}
}

func TestPickHELODomain_FallbackOnEmptyDomainPart(t *testing.T) {
	got := pickHELODomain("", "user@")
	if got != "mail.local" {
		t.Fatalf("empty domain part must fall back, got %q", got)
	}
}

func TestPickHELODomain_FallbackOnBareLabelDomain(t *testing.T) {
	// Single-label "domains" fail the RFC 5321 §3.6 requirement — and
	// "localhost" is exactly this case (single label, no dot).
	got := pickHELODomain("", "user@relay")
	if got != "mail.local" {
		t.Fatalf("bare-label domain must fall back, got %q", got)
	}
	got = pickHELODomain("", "user@localhost")
	if got != "mail.local" {
		t.Fatalf("user@localhost must fall back to mail.local, got %q", got)
	}
}

func TestPickHELODomain_NeverReturnsLocalhost(t *testing.T) {
	// The whole point of this function is to never produce "localhost"
	// as a HELO claim. Sweep a representative set of inputs and assert.
	cases := []string{
		"",
		"localhost",
		"user@localhost",
		"user@",
		"@example.com",
		"<user@>",
		"garbage",
		"user@127.0.0.1", // IP literal — gets rejected at FQDN check
	}
	for _, in := range cases {
		got := pickHELODomain("", in)
		if got == "localhost" {
			t.Fatalf("input %q produced forbidden HELO 'localhost'", in)
		}
		if got == "" {
			t.Fatalf("input %q produced empty HELO", in)
		}
	}
}

func TestPickHELODomain_StripsHeaderInjectionBytes(t *testing.T) {
	// A malformed sender like "user@example.com\r\nX-Inject: yes" must
	// never let CRLF leak into the HELO line; the function stops at the
	// first non-DNS-safe byte (the \r) and the result is the safe prefix.
	got := pickHELODomain("", "foo@evil.com\r\nX-Inject: yes")
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("HELO must not contain CRLF, got %q", got)
	}
	if strings.Contains(got, "X-Inject") {
		t.Fatalf("injected header bytes leaked, got %q", got)
	}
}

func TestPickHELODomain_StripsTrailingDots(t *testing.T) {
	got := pickHELODomain("", "user@example.com.")
	if got != "example.com" {
		t.Fatalf("trailing dot should be stripped, got %q", got)
	}
}

func TestPickHELODomain_PreservesSubdomainFQDN(t *testing.T) {
	got := pickHELODomain("", "user@a.b.com")
	if got != "a.b.com" {
		t.Fatalf("multi-label FQDN must be preserved, got %q", got)
	}
}

func TestPickHELODomain_ConfiguredOverridesEvenInvalidShape(t *testing.T) {
	// The configured value bypasses the validation pipeline — operator
	// is trusted to know what they want, but they cannot pass empty
	// (which would fall through to the derivation path).
	got := pickHELODomain("CUSTOM_NO_DOTS", "mb@email.cz")
	if got != "CUSTOM_NO_DOTS" {
		t.Fatalf("configured value must be returned verbatim, got %q", got)
	}
}

func TestPickHELODomain_TableSweep(t *testing.T) {
	cases := []struct {
		name       string
		configured string
		from       string
		want       string
	}{
		{"all empty", "", "", "mail.local"},
		{"only configured", "relay.example.com", "", "relay.example.com"},
		{"only from", "", "mb@email.cz", "email.cz"},
		{"both", "relay.example.com", "mb@email.cz", "relay.example.com"},
		{"angle form", "", "Name <a@b.com>", "b.com"},
		{"uppercase", "", "u@EXAMPLE.COM", "example.com"},
		{"trailing dot", "", "u@example.com.", "example.com"},
		{"crlf injection", "", "u@example.com\r\nX: y", "example.com"},
		{"single label", "", "u@bare", "mail.local"},
		{"empty domain", "", "u@", "mail.local"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pickHELODomain(tc.configured, tc.from)
			if got != tc.want {
				t.Fatalf("pickHELODomain(%q, %q) = %q, want %q", tc.configured, tc.from, got, tc.want)
			}
		})
	}
}
