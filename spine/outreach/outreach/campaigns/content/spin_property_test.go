package content

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: ResolveSpin never panics on any input ────────────
func TestProperty_ResolveSpin_NoPanic(t *testing.T) {
	f := func(input string, seed int64) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on input %q seed=%d: %v", input, seed, r)
			}
		}()
		_ = ResolveSpin(input, seed)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: text without spin syntax → returned unchanged ─────
func TestProperty_ResolveSpin_PassthroughNoSpin(t *testing.T) {
	f := func(text string, seed int64) bool {
		if strings.Contains(text, "{") {
			return true // skip — has spin syntax
		}
		return ResolveSpin(text, seed) == text
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: deterministic by seed ────────────────────────────
func TestProperty_ResolveSpin_Deterministic(t *testing.T) {
	inputs := []string{
		"{Dobrý den|Zdravím}",
		"We {have|offer} {great|amazing} {deals|prices}.",
		"{A|B|C|D|E}",
		"plain text",
		"",
		"{single option}",
	}
	seeds := []int64{0, 1, 42, -1, 1<<31, -(1 << 31)}
	for _, s := range seeds {
		for _, in := range inputs {
			a := ResolveSpin(in, s)
			b := ResolveSpin(in, s)
			if a != b {
				t.Fatalf("non-deterministic for %q seed=%d: %q vs %q", in, s, a, b)
			}
		}
	}
}

// ── Property: output of resolved spin contains ONE of the options ──
func TestProperty_ResolveSpin_PicksOneOption(t *testing.T) {
	// Simple single-level spin.
	options := []string{"apple", "banana", "cherry"}
	input := "{" + strings.Join(options, "|") + "}"
	for seed := int64(0); seed < 100; seed++ {
		out := ResolveSpin(input, seed)
		hit := false
		for _, o := range options {
			if out == o {
				hit = true
				break
			}
		}
		if !hit {
			t.Fatalf("seed=%d output %q matches no option", seed, out)
		}
	}
}

// ── Property: after resolution, no unmatched { or } remain for
// well-formed input. ───────────────────────────────────────────
func TestProperty_ResolveSpin_BalancedOutput(t *testing.T) {
	// Input with balanced braces (the only well-formed shape).
	valid := []string{
		"{a|b}",
		"{one|two|three}",
		"prefix {a|b} suffix",
		"{x {y|z}|w}",                // nested
		"{option A|option B}",
		"leading {a|b} middle {c|d} trailing",
	}
	for _, in := range valid {
		for seed := int64(0); seed < 20; seed++ {
			out := ResolveSpin(in, seed)
			// If function couldn't resolve something it may leave braces,
			// but for these well-formed inputs braces should NOT remain.
			if strings.Contains(out, "{") || strings.Contains(out, "}") {
				t.Fatalf("balanced input %q (seed=%d) left braces in output: %q", in, seed, out)
			}
		}
	}
}

// ── Property: output length reasonable relative to input ───────
// Spin resolution should reduce or preserve length — never amplify
// beyond the longest option path.
func TestProperty_ResolveSpin_LengthBounded(t *testing.T) {
	// For a simple spin, output length ≤ sum of raw input length.
	// Tests pathological pathological inputs don't blow up output.
	inputs := []string{
		"{a|b|c}",
		strings.Repeat("{a|b}", 20),
		strings.Repeat("plain ", 100) + "{x|y}",
	}
	for _, in := range inputs {
		for seed := int64(0); seed < 10; seed++ {
			out := ResolveSpin(in, seed)
			if len(out) > len(in)*2 {
				t.Fatalf("output grew abnormally: input len=%d, output len=%d (input=%q, out=%q)", len(in), len(out), in, out)
			}
		}
	}
}

// ── Explicit: Czech unicode spin preserved ─────────────────────
func TestProperty_ResolveSpin_CzechUnicode(t *testing.T) {
	input := "{Dobrý den|Zdravím|Ahoj}"
	out := ResolveSpin(input, 42)
	valid := map[string]bool{"Dobrý den": true, "Zdravím": true, "Ahoj": true}
	if !valid[out] {
		t.Fatalf("Czech spin output %q not in valid set", out)
	}
}

// ── Edge: empty input ─────────────────────────────────────────
func TestProperty_ResolveSpin_Empty(t *testing.T) {
	if got := ResolveSpin("", 42); got != "" {
		t.Fatalf("empty input → want empty string, got %q", got)
	}
}

// ── Edge: input with only brace but no pipe (not a spin) ───────
func TestProperty_ResolveSpin_NoBraceEscape(t *testing.T) {
	// "{abc}" without pipes — behavior is implementation-defined but must not panic.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on {abc}: %v", r)
		}
	}()
	_ = ResolveSpin("{abc}", 42)
}

// ── Edge: unclosed brace ──────────────────────────────────────
func TestProperty_ResolveSpin_UnclosedBrace(t *testing.T) {
	// Must not panic; behavior of leaving the brace in is fine.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on unclosed brace: %v", r)
		}
	}()
	_ = ResolveSpin("text {unclosed", 42)
}
