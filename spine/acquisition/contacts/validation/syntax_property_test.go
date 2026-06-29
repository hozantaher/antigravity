package validation

import (
	"context"
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: SyntaxValidator never panics on any input ─────────
func TestProperty_Syntax_NoPanic(t *testing.T) {
	v := &SyntaxValidator{}
	f := func(email string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", email, r)
			}
		}()
		_, _, err := v.Validate(context.Background(), email)
		return err == nil // no err expected on arbitrary input; reason is a string
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: empty, whitespace-only, no-@ always reject ────────
func TestProperty_Syntax_EmptyAlwaysRejected(t *testing.T) {
	v := &SyntaxValidator{}
	cases := []string{"", "   ", "\t", "\n", "\r\n"}
	for _, email := range cases {
		ok, reason, _ := v.Validate(context.Background(), email)
		if ok {
			t.Fatalf("empty/whitespace %q should be rejected, got ok=true (reason=%s)", email, reason)
		}
	}
}

// ── Property: strings with control characters always rejected ──
func TestProperty_Syntax_ControlCharsRejected(t *testing.T) {
	v := &SyntaxValidator{}
	// Note: strings.TrimSpace strips leading/trailing \r\n\t. Embed control chars mid-email.
	controls := []string{"a@b\rc.cz", "a@b\nc.cz", "a\t@b.cz", "a@b.cz\x00"}
	for _, e := range controls {
		ok, _, _ := v.Validate(context.Background(), e)
		if ok {
			t.Fatalf("control-char email %q should be rejected", e)
		}
	}
}

// ── Property: canonical valid emails always accepted ────────────
func TestProperty_Syntax_ValidEmails(t *testing.T) {
	v := &SyntaxValidator{}
	valid := []string{
		"a@b.cz",
		"user@example.com",
		"jan.novak@alpha.cz",
		"sales+tag@company.com",
		"foo.bar_baz@sub.example.co.uk",
		"ěščř@email.cz", // Czech local part — net/mail.ParseAddress accepts
	}
	for _, e := range valid {
		ok, reason, _ := v.Validate(context.Background(), e)
		if !ok {
			t.Fatalf("valid email %q should be accepted (reason=%s)", e, reason)
		}
	}
}

// ── Property: missing or misplaced @ always rejected ────────────
func TestProperty_Syntax_MisplacedAt(t *testing.T) {
	v := &SyntaxValidator{}
	bads := []string{
		"noAtSign",
		"@startsWithAt.cz",
		"endsWithAt@",
		"multi@at@signs.cz",  // RFC parse rejects most
		"@",
		"@@",
		"@.",
	}
	for _, e := range bads {
		ok, _, _ := v.Validate(context.Background(), e)
		if ok {
			t.Fatalf("bad @ shape %q should be rejected", e)
		}
	}
}

// ── Property: domain without dot rejected ──────────────────────
func TestProperty_Syntax_DomainNoTLD(t *testing.T) {
	v := &SyntaxValidator{}
	bads := []string{
		"a@localhost",
		"a@plain",
		"a@no-tld-here",
	}
	for _, e := range bads {
		ok, reason, _ := v.Validate(context.Background(), e)
		if ok {
			t.Fatalf("TLD-less %q should be rejected (got ok=true, reason=%s)", e, reason)
		}
	}
}

// ── Property: domain with leading/trailing dot rejected ────────
func TestProperty_Syntax_DomainBadDots(t *testing.T) {
	v := &SyntaxValidator{}
	bads := []string{
		"a@.cz",
		"a@b.",
		"a@.b.cz",
	}
	for _, e := range bads {
		ok, _, _ := v.Validate(context.Background(), e)
		if ok {
			t.Fatalf("bad domain dots %q should be rejected", e)
		}
	}
}

// ── Property: whitespace-trimming works ─────────────────────────
func TestProperty_Syntax_WhitespaceTrimmed(t *testing.T) {
	v := &SyntaxValidator{}
	// Leading/trailing whitespace should be trimmed before validation.
	ok, _, _ := v.Validate(context.Background(), "  a@b.cz  ")
	if !ok {
		t.Fatal("trimmed valid email should be accepted")
	}
}

// ── Property: Validate is a pure function (deterministic) ──────
func TestProperty_Syntax_Deterministic(t *testing.T) {
	v := &SyntaxValidator{}
	f := func(email string) bool {
		ok1, reason1, _ := v.Validate(context.Background(), email)
		ok2, reason2, _ := v.Validate(context.Background(), email)
		return ok1 == ok2 && reason1 == reason2
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Long-input robustness ──────────────────────────────────────
func TestProperty_Syntax_LongInput(t *testing.T) {
	v := &SyntaxValidator{}
	long := strings.Repeat("x", 10000) + "@" + strings.Repeat("y", 1000) + ".cz"
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on long input: %v", r)
		}
	}()
	_, _, _ = v.Validate(context.Background(), long)
	// Don't assert ok value; just verify no panic + completes quickly.
}
