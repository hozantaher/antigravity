package audit

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: MaskEmail never panics ──────────────────────────
func TestProperty_MaskEmail_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = MaskEmail(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: consistent — same email → same mask ─────────────
// Essential for log correlation: same address must always produce
// the same mask so entries can be grouped.
func TestProperty_MaskEmail_Consistent(t *testing.T) {
	f := func(s string) bool {
		return MaskEmail(s) == MaskEmail(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: different emails → different masks (anti-collision) ──
// With 4-hex fingerprint + positional local-part chars, collisions
// are improbable in a 1000-sample space.
func TestProperty_MaskEmail_DifferentInputsDifferentMasks(t *testing.T) {
	emails := []string{
		"a@b.cz", "b@b.cz", "a@c.cz",
		"jan.novak@example.com", "jan.novak@example.cz",
		"petr@x.cz", "petra@x.cz",
	}
	seen := make(map[string]string)
	for _, e := range emails {
		m := MaskEmail(e)
		if other, hit := seen[m]; hit {
			t.Fatalf("collision: %q and %q both → %q", other, e, m)
		}
		seen[m] = e
	}
}

// ── Property: mask never contains full local part ─────────────
// Privacy: must not be reversible to original PII.
func TestProperty_MaskEmail_LocalNotLeaked(t *testing.T) {
	cases := []string{
		"jan.novak@alpha.cz",
		"petra.horakova@beta.cz",
		"sensitive.user@x.cz",
	}
	for _, e := range cases {
		at := strings.LastIndex(e, "@")
		local := e[:at]
		if len(local) <= 2 {
			continue // too short — whole local IS shown by design
		}
		masked := MaskEmail(e)
		if strings.Contains(masked, local) {
			t.Fatalf("PII leak: mask %q contains full local %q", masked, local)
		}
	}
}

// ── Property: domain is preserved ─────────────────────────────
// Domain stays visible for MX debugging — confirm every test input.
func TestProperty_MaskEmail_DomainPreserved(t *testing.T) {
	cases := []string{
		"jan@alpha.cz",
		"petra@beta.co.uk",
		"user@sub.domain.com",
	}
	for _, e := range cases {
		at := strings.LastIndex(e, "@")
		domain := e[at:]
		masked := MaskEmail(e)
		if !strings.HasSuffix(masked, domain) {
			t.Fatalf("domain not preserved: %q → %q (want suffix %q)", e, masked, domain)
		}
	}
}

// ── Property: invalid email (no @) returns fixed placeholder ──
func TestProperty_MaskEmail_NoAtSign(t *testing.T) {
	for _, e := range []string{"noAtSign", "", "just text", "   "} {
		if got := MaskEmail(e); got != "[invalid-email]" {
			t.Fatalf("no-@ input %q: want [invalid-email], got %q", e, got)
		}
	}
}

// ── Property: output contains sha:XXXX fingerprint (4 hex chars) ──
func TestProperty_MaskEmail_ContainsFingerprint(t *testing.T) {
	f := func(local string) bool {
		if local == "" {
			local = "u"
		}
		email := local + "@x.cz"
		m := MaskEmail(email)
		return strings.Contains(m, "[sha:")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: unicode local parts handled without panic ───────
func TestProperty_MaskEmail_Unicode(t *testing.T) {
	cases := []string{
		"ěščřžýáíéůú@x.cz",
		"张三@example.com",
		"🚀@rocket.com",
	}
	for _, e := range cases {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic on %q: %v", e, r)
			}
		}()
		_ = MaskEmail(e)
	}
}

// ── Property: very long input doesn't blow up output ───────────
func TestProperty_MaskEmail_LongInput(t *testing.T) {
	long := strings.Repeat("a", 10000) + "@" + strings.Repeat("b", 1000) + ".cz"
	m := MaskEmail(long)
	// Output should be bounded (star count = len(local) - 2). Check bound loose.
	if len(m) > len(long)+20 {
		t.Fatalf("output grew abnormally: input=%d output=%d", len(long), len(m))
	}
}
