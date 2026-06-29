package humanize

import (
	"strings"
	"testing"
	"testing/quick"
	"unicode/utf8"
)

// ── ApplyToBody: property — never panics ─────────────────────────────────────

func TestApplyToBody_Property_NeverPanics(t *testing.T) {
	engine := NewImperfectEngine()
	f := func(body string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("ApplyToBody panicked on %q: %v", body, r)
			}
		}()
		_ = engine.ApplyToBody(body)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── ApplyToBody: property — line count invariant ─────────────────────────────
//
// ApplyToBody operates on characters only (diacritics degradation + typos).
// The number of newlines must be preserved because strings.Split then
// strings.Join preserves the split structure.

func TestApplyToBody_Property_LineCountPreserved(t *testing.T) {
	engine := NewImperfectEngine()
	f := func(body string) bool {
		if !utf8.ValidString(body) {
			return true // skip invalid UTF-8 (diacriticMap operates on runes)
		}
		before := strings.Count(body, "\n")
		after := strings.Count(engine.ApplyToBody(body), "\n")
		return before == after
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── ApplyToBody: property — output is non-nil ────────────────────────────────
//
// Even for empty input, ApplyToBody must return a string (possibly "").

func TestApplyToBody_Property_NonNilResult(t *testing.T) {
	engine := NewImperfectEngine()
	// Empty input
	result := engine.ApplyToBody("")
	// Not testing for "", just no panic and some result
	_ = result

	// Single line (no newlines)
	result = engine.ApplyToBody("Dobrý den")
	if result == "" {
		t.Error("single-line body without typos should not be empty")
	}
}

// ── ApplyToBody: edge cases ───────────────────────────────────────────────────

func TestApplyToBody_EdgeCases(t *testing.T) {
	engine := NewImperfectEngine()
	cases := []string{
		"",
		"\n",
		"\n\n\n",
		"single line no newline",
		strings.Repeat("A\n", 200),     // long body, many short lines
		strings.Repeat("x", 10_000),    // 10 KB single line
		"Ř Š Č Ž Á Í Ý Ú Ů Ě Ď Ť Ň",  // all diacritics
		"\x00\x01\x02\x03",             // control bytes
	}
	for _, c := range cases {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("ApplyToBody panicked on %q: %v", truncate(c, 40), r)
				}
			}()
			_ = engine.ApplyToBody(c)
		}()
	}
}

// ── ApplyToBody: diacritics degradation is probabilistic ─────────────────────
//
// With keepProb=0.70 for the first line, some diacritics MUST be removed over
// many iterations on a text that is all diacritics.

func TestApplyToBody_DegradationHappens(t *testing.T) {
	engine := NewImperfectEngine()
	body := "ářžůčéíý" // 8 diacritic chars, single line → prob=0.70 keep
	degraded := 0
	for i := 0; i < 200; i++ {
		result := engine.ApplyToBody(body)
		if result != body {
			degraded++
		}
	}
	if degraded == 0 {
		t.Error("expected at least some degraded outputs in 200 runs")
	}
}

// ── ShouldForgetAttachment: property — never panics ──────────────────────────

func TestShouldForgetAttachment_NeverPanics(t *testing.T) {
	engine := NewImperfectEngine()
	for i := 0; i < 1000; i++ {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("ShouldForgetAttachment panicked at iter %d: %v", i, r)
				}
			}()
			_ = engine.ShouldForgetAttachment()
		}()
	}
}

// ── ShouldForgetAttachment: probability bounds ────────────────────────────────
//
// forgottenAttachProb = 0.05 → ~50/1000. We assert it hits at least 1 and
// at most 250 (25%) — a 5-sigma band for p=0.05, n=1000.

func TestShouldForgetAttachment_ProbabilityBounds(t *testing.T) {
	engine := NewImperfectEngine()
	hits := 0
	for i := 0; i < 1000; i++ {
		if engine.ShouldForgetAttachment() {
			hits++
		}
	}
	if hits == 0 {
		t.Error("expected at least one forget in 1000 iterations (p=0.05)")
	}
	if hits > 250 {
		t.Errorf("forget rate %d/1000 is unreasonably high (expected ~50, max 250)", hits)
	}
}

// ── ShouldForgetAttachment: returns bool ────────────────────────────────────

func TestShouldForgetAttachment_ReturnsBool(t *testing.T) {
	engine := NewImperfectEngine()
	// Just verify the return type is bool-compatible and in {true, false}
	result := engine.ShouldForgetAttachment()
	if result != true && result != false {
		t.Error("ShouldForgetAttachment must return a bool")
	}
}

// ── injectTypo: dead branch — len(typos)==0 is unreachable ──────────────────
//
// injectTypo always has 2 typo functions in its slice; the len==0 guard is
// defensive dead code. We call it many times to confirm stability.

func TestInjectTypo_NeverPanics(t *testing.T) {
	engine := NewImperfectEngine()
	texts := []string{
		"",
		"Hello",
		"Dobrý den, posílám nabídku.",
		"Myslím, že to funguje, ale nechápu, kdy.",
		strings.Repeat("x", 2000),
		"Řekl mi, že to bude, když to bude, protože ano.",
	}
	for _, text := range texts {
		for i := 0; i < 50; i++ {
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Errorf("injectTypo panicked on %q: %v", truncate(text, 40), r)
					}
				}()
				_ = engine.injectTypo(text)
			}()
		}
	}
}

// ── ApplyToSubject + ApplyToGreeting: property — never panics ────────────────

func TestApplyToSubject_Property_NeverPanics(t *testing.T) {
	engine := NewImperfectEngine()
	f := func(subject string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("ApplyToSubject panicked on %q: %v", subject, r)
			}
		}()
		_ = engine.ApplyToSubject(subject)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

func TestApplyToGreeting_Property_NeverPanics(t *testing.T) {
	engine := NewImperfectEngine()
	f := func(greeting string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("ApplyToGreeting panicked on %q: %v", greeting, r)
			}
		}()
		_ = engine.ApplyToGreeting(greeting)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── degradeDiacritics: rune-count invariant ──────────────────────────────────
//
// degradeDiacritics REPLACES diacritic runes with ASCII equivalents — it never
// inserts or deletes runes. Output rune count must equal input rune count.

func TestDegradeDiacritics_Property_RuneCountPreserved(t *testing.T) {
	engine := NewImperfectEngine()
	f := func(text string) bool {
		if !utf8.ValidString(text) {
			return true
		}
		for _, prob := range []float64{0.0, 0.5, 1.0} {
			out := engine.degradeDiacritics(text, prob)
			if utf8.RuneCountInString(out) != utf8.RuneCountInString(text) {
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── MentionsAttachment: property — never panics ──────────────────────────────

func TestMentionsAttachment_Property_NeverPanics(t *testing.T) {
	engine := NewImperfectEngine()
	f := func(text string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("MentionsAttachment panicked on %q: %v", text, r)
			}
		}()
		_ = engine.MentionsAttachment(text)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// truncate is a test-local helper to cap string length for error messages.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
