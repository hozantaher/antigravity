package config

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: DomainFromEmail never panics ───────────────────
func TestProperty_DomainFromEmail_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = DomainFromEmail(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: DomainFromEmail is deterministic ───────────────
func TestProperty_DomainFromEmail_Deterministic(t *testing.T) {
	f := func(s string) bool {
		return DomainFromEmail(s) == DomainFromEmail(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: DomainFromEmail output is always lowercase ─────
func TestProperty_DomainFromEmail_Lowercase(t *testing.T) {
	f := func(s string) bool {
		out := DomainFromEmail(s)
		return out == strings.ToLower(out)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: DomainFromEmail no-@ → empty ───────────────────
func TestProperty_DomainFromEmail_NoAt(t *testing.T) {
	f := func(s string) bool {
		if strings.Contains(s, "@") {
			return true
		}
		return DomainFromEmail(s) == ""
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: DomainFromEmail explicit cases ─────────────────
func TestProperty_DomainFromEmail_Cases(t *testing.T) {
	cases := map[string]string{
		"user@example.com":    "example.com",
		"USER@EXAMPLE.COM":    "example.com",
		"a@b":                 "b",
		"":                    "",
		"noAtSign":            "",
		"@":                   "",
		"a@b@c.cz":            "b@c.cz", // SplitN(2) semantics
	}
	for in, want := range cases {
		if got := DomainFromEmail(in); got != want {
			t.Fatalf("DomainFromEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: hostOf == DomainFromEmail (alias invariant) ────
func TestProperty_HostOf_AliasesDomainFromEmail(t *testing.T) {
	f := func(s string) bool {
		return hostOf(s) == DomainFromEmail(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: isSandboxHost never panics ─────────────────────
func TestProperty_IsSandboxHost_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = isSandboxHost(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: isSandboxHost empty → true (unconfigured) ──────
func TestProperty_IsSandboxHost_EmptyTrue(t *testing.T) {
	for _, h := range []string{"", " ", "\t"} {
		if !isSandboxHost(h) {
			t.Fatalf("empty/ws %q: want sandbox=true", h)
		}
	}
}

// ── Property: isSandboxHost known sandbox hosts ──────────────
func TestProperty_IsSandboxHost_KnownSandbox(t *testing.T) {
	sandbox := []string{
		"localhost", "127.0.0.1", "::1",
		"mailpit", "greenmail", "smtp4dev", "maildev", "inbucket",
		"foo.test", "bar.example", "baz.invalid", "qux.localhost",
		"example.com", "sub.example.com",
		"example.org", "deep.sub.example.org",
		"example.net",
		"LOCALHOST",      // case-insensitive
		"  localhost  ",  // whitespace trimmed
	}
	for _, h := range sandbox {
		if !isSandboxHost(h) {
			t.Fatalf("%q: want sandbox=true", h)
		}
	}
}

// ── Property: isSandboxHost real-production domains rejected ──
func TestProperty_IsSandboxHost_Production(t *testing.T) {
	prod := []string{
		"seznam.cz",
		"gmail.com",
		"microsoft.com",
		"hozan.cz",
		"atlas.cz",
	}
	for _, h := range prod {
		if isSandboxHost(h) {
			t.Fatalf("%q: want sandbox=false (production host)", h)
		}
	}
}

// ── Property: validateTrackingBaseURL never panics ───────────
func TestProperty_ValidateTrackingBaseURL_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = validateTrackingBaseURL(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: validateTrackingBaseURL rejects empty/ws ───────
func TestProperty_ValidateTrackingBaseURL_RequiresNonEmpty(t *testing.T) {
	for _, s := range []string{"", " ", "\t", "   "} {
		if err := validateTrackingBaseURL(s); err == nil {
			t.Fatalf("empty/ws %q: want error", s)
		}
	}
}

// ── Property: validateTrackingBaseURL rejects non-HTTPS ──────
func TestProperty_ValidateTrackingBaseURL_HTTPSRequired(t *testing.T) {
	bad := []string{
		"http://example.com",
		"ftp://example.com",
		"ws://example.com",
		"example.com", // no scheme
	}
	for _, s := range bad {
		if err := validateTrackingBaseURL(s); err == nil {
			t.Fatalf("non-HTTPS %q: want error", s)
		}
	}
}

// ── Property: validateTrackingBaseURL rejects userinfo ───────
// Security: no inline credentials in tracking URL.
func TestProperty_ValidateTrackingBaseURL_NoUserinfo(t *testing.T) {
	bad := []string{
		"https://user@example.com/",
		"https://user:pass@track.example.com/",
	}
	for _, s := range bad {
		if err := validateTrackingBaseURL(s); err == nil {
			t.Fatalf("userinfo %q: want error", s)
		}
	}
}

// ── Property: validateTrackingBaseURL accepts valid HTTPS ────
func TestProperty_ValidateTrackingBaseURL_AcceptsValid(t *testing.T) {
	good := []string{
		"https://track.example.com",
		"https://track.example.com/",
		"https://example.com/pixel.gif",
		"https://sub.domain.example.com:8443/path",
	}
	for _, s := range good {
		if err := validateTrackingBaseURL(s); err != nil {
			t.Fatalf("valid %q: unexpected error %v", s, err)
		}
	}
}
