package content

// spin_monkey_test.go — additional property+monkey tests for ResolveSpin and splitPipes.
// Targets edge cases not covered by spin_property_test.go: unicode boundaries,
// deeply nested/adversarial inputs, pipe-only strings, and high-entropy random inputs.

import (
	"strings"
	"testing"
	"testing/quick"
	"unicode/utf8"
)

// ── Property: output is always valid UTF-8 ───────────────────
func TestProperty_ResolveSpin_OutputAlwaysValidUTF8(t *testing.T) {
	f := func(input string, seed int64) bool {
		out := ResolveSpin(input, seed)
		return utf8.ValidString(out)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: splitPipes never returns empty slice ────────────
// A non-empty input always yields at least one part.
func TestProperty_SplitPipes_NeverEmpty(t *testing.T) {
	f := func(s string) bool {
		parts := splitPipes(s)
		return len(parts) >= 1
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: splitPipes(s) joins back to s when no pipes ────
func TestProperty_SplitPipes_NoPipe_Roundtrip(t *testing.T) {
	f := func(s string) bool {
		if strings.ContainsAny(s, "|{}") {
			return true // skip — not a no-pipe input
		}
		parts := splitPipes(s)
		return len(parts) == 1 && parts[0] == s
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: splitPipes parts count == pipe count + 1 (flat) ─
func TestProperty_SplitPipes_PartCount(t *testing.T) {
	// Only for flat inputs (no braces) so depth logic doesn't interfere.
	inputs := []struct {
		s    string
		want int
	}{
		{"a|b|c", 3},
		{"x", 1},
		{"", 1},
		{"a|b", 2},
		{"one|two|three|four", 4},
	}
	for _, tc := range inputs {
		got := splitPipes(tc.s)
		if len(got) != tc.want {
			t.Errorf("splitPipes(%q) = %d parts, want %d", tc.s, len(got), tc.want)
		}
	}
}

// ── Monkey: deeply nested spin never panics ───────────────────
func TestMonkey_ResolveSpin_DeeplyNested(t *testing.T) {
	// Build {{a|{b|{c|{d|e}}}}} 10 levels deep.
	inner := "leaf"
	for i := 0; i < 10; i++ {
		inner = "{" + inner + "|alt" + strings.Repeat("x", i) + "}"
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on deeply nested spin: %v", r)
		}
	}()
	out := ResolveSpin(inner, 42)
	if out == "" && inner != "" {
		t.Error("deeply nested spin should not produce empty output for non-empty input")
	}
}

// ── Monkey: many spin groups in sequence never panics ─────────
func TestMonkey_ResolveSpin_ManyGroups(t *testing.T) {
	// 100 back-to-back spin groups.
	var sb strings.Builder
	for i := 0; i < 100; i++ {
		sb.WriteString("{option_a_")
		sb.WriteString(strings.Repeat("a", i%10))
		sb.WriteString("|option_b}")
	}
	input := sb.String()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on many groups: %v", r)
		}
	}()
	out := ResolveSpin(input, 17)
	if strings.Contains(out, "{") || strings.Contains(out, "}") {
		t.Errorf("well-formed multi-group should be fully resolved, got braces in: %q", out[:monkeyMin(100, len(out))])
	}
}

// ── Property: seed 0 and seed MaxInt64 both work ─────────────
func TestProperty_ResolveSpin_ExtremeSeedsNoPanic(t *testing.T) {
	inputs := []string{"", "{a|b}", "plain", "{x|y|z} and {p|q}", "{nested {a|b}|c}"}
	extremeSeeds := []int64{0, 1, -1, 1<<62 - 1, -1 << 62, 1<<31, -(1 << 31)}
	for _, in := range inputs {
		for _, seed := range extremeSeeds {
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Errorf("panic: input=%q seed=%d: %v", in, seed, r)
					}
				}()
				_ = ResolveSpin(in, seed)
			}()
		}
	}
}

// ── Property: single-option spin removes braces exactly ───────
func TestProperty_ResolveSpin_SingleOptionUnwrapped(t *testing.T) {
	// {word} with no pipe — implementation picks the only "option".
	words := []string{"hello", "world", "Dobrý", "", "x"}
	for _, w := range words {
		input := "{" + w + "}"
		out := ResolveSpin(input, 7)
		// Must not panic; must equal w (the only option).
		if out != w {
			t.Errorf("{%s} → want %q, got %q", w, w, out)
		}
	}
}

// ── Property: output shorter than input × 2 (monkey) ─────────
func TestProperty_ResolveSpin_OutputNotExploding(t *testing.T) {
	f := func(input string, seed int64) bool {
		out := ResolveSpin(input, seed)
		if len(input) == 0 {
			return len(out) == 0
		}
		return len(out) <= len(input)*2+1
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Monkey: only pipes, no braces ────────────────────────────
func TestMonkey_ResolveSpin_PipeOnlyInput(t *testing.T) {
	// Input with pipes but no braces — should pass through unchanged.
	inputs := []string{"|", "a|b|c", "|||", "x|", "|y"}
	for _, in := range inputs {
		out := ResolveSpin(in, 0)
		if out != in {
			t.Errorf("pipe-only input %q should pass through, got %q", in, out)
		}
	}
}

// ── Monkey: all-whitespace spin options ──────────────────────
func TestMonkey_ResolveSpin_WhitespaceOptions(t *testing.T) {
	inputs := []string{
		"{ | }",
		"{\t|\n}",
		"{  |  |  }",
	}
	for _, in := range inputs {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic on whitespace options %q: %v", in, r)
			}
		}()
		out := ResolveSpin(in, 99)
		// Must not contain braces in output.
		if strings.Contains(out, "{") || strings.Contains(out, "}") {
			t.Errorf("whitespace spin %q: braces in output %q", in, out)
		}
	}
}

func monkeyMin(a, b int) int {
	if a < b {
		return a
	}
	return b
}
