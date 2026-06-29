package sanitizer

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: NormalizeSubmissionProfile never panics ────────
func TestProperty_NormalizeSubmissionProfile_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = NormalizeSubmissionProfile(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: deterministic ──────────────────────────────────
func TestProperty_NormalizeSubmissionProfile_Deterministic(t *testing.T) {
	f := func(s string) bool {
		return NormalizeSubmissionProfile(s) == NormalizeSubmissionProfile(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: output is in enum {standard, strict, ""} ───────
func TestProperty_NormalizeSubmissionProfile_EnumRange(t *testing.T) {
	valid := map[string]bool{
		ProfileStandard: true,
		ProfileStrict:   true,
		"":              true,
	}
	f := func(s string) bool {
		return valid[NormalizeSubmissionProfile(s)]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: empty/whitespace defaults to standard ──────────
func TestProperty_NormalizeSubmissionProfile_EmptyDefault(t *testing.T) {
	for _, s := range []string{"", " ", "   ", "\t", "\n", " \t\n "} {
		got := NormalizeSubmissionProfile(s)
		if got != ProfileStandard {
			t.Fatalf("empty/ws %q: want standard, got %q", s, got)
		}
	}
}

// ── Property: case-insensitive for known values ──────────────
func TestProperty_NormalizeSubmissionProfile_CaseInsensitive(t *testing.T) {
	for _, base := range []string{ProfileStandard, ProfileStrict} {
		lower := NormalizeSubmissionProfile(strings.ToLower(base))
		upper := NormalizeSubmissionProfile(strings.ToUpper(base))
		mixed := NormalizeSubmissionProfile(strings.Title(base))
		if lower != upper || lower != mixed {
			t.Fatalf("case mismatch for %q: lower=%q upper=%q mixed=%q", base, lower, upper, mixed)
		}
	}
}

// ── Property: whitespace-tolerant for known values ───────────
func TestProperty_NormalizeSubmissionProfile_WhitespaceTolerant(t *testing.T) {
	cases := map[string]string{
		" standard":   ProfileStandard,
		"standard ":   ProfileStandard,
		"  standard ": ProfileStandard,
		" strict":     ProfileStrict,
		"strict\t":    ProfileStrict,
	}
	for in, want := range cases {
		if got := NormalizeSubmissionProfile(in); got != want {
			t.Fatalf("%q: want %q, got %q", in, want, got)
		}
	}
}

// ── Property: unknown inputs return empty (reject) ───────────
func TestProperty_NormalizeSubmissionProfile_UnknownRejected(t *testing.T) {
	bad := []string{
		"lenient",
		"permissive",
		"paranoid",
		"standard-plus",
		"STRICT_MODE",
		"DROP TABLE users",
		"../etc/passwd",
	}
	for _, s := range bad {
		if got := NormalizeSubmissionProfile(s); got != "" {
			t.Fatalf("unknown %q: want empty, got %q", s, got)
		}
	}
}

// ── Property: idempotent ─────────────────────────────────────
// Normalize(Normalize(x)) == Normalize(x) for valid outputs.
func TestProperty_NormalizeSubmissionProfile_Idempotent(t *testing.T) {
	f := func(s string) bool {
		first := NormalizeSubmissionProfile(s)
		second := NormalizeSubmissionProfile(first)
		// Unknown inputs → "" which re-normalizes to standard.
		// This breaks strict idempotency; test only for known outputs.
		if first == ProfileStandard || first == ProfileStrict {
			return second == first
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}
