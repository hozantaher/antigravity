package humanize

import (
	"strings"
	"testing"
	"testing/quick"
	"time"
)

// ── Property: isFeminineFirstName never panics on arbitrary input ──
func TestProperty_IsFeminineFirstName_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = isFeminineFirstName(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: isFeminineFirstName is case-insensitive ─────────
// "Anna" and "anna" and "ANNA" must all return the same result.
func TestProperty_IsFeminineFirstName_CaseInsensitive(t *testing.T) {
	cases := []string{
		"Anna", "Eva", "Jana", "Kateřina", "Marie",
		"Jan", "Petr", "Tomáš", "Jakub",
	}
	for _, name := range cases {
		upper := strings.ToUpper(name)
		lower := strings.ToLower(name)
		if isFeminineFirstName(name) != isFeminineFirstName(upper) {
			t.Fatalf("%q vs %q case mismatch", name, upper)
		}
		if isFeminineFirstName(name) != isFeminineFirstName(lower) {
			t.Fatalf("%q vs %q case mismatch", name, lower)
		}
	}
}

// ── Explicit: feminine names ending in 'a' detected ──────────
func TestProperty_IsFeminineFirstName_EndsInA(t *testing.T) {
	feminine := []string{"Anna", "Eva", "Jana", "Kateřina", "Petra", "Jarka", "Lenka", "Alena"}
	for _, name := range feminine {
		if !isFeminineFirstName(name) {
			t.Fatalf("%q should be feminine (ends in 'a')", name)
		}
	}
}

// ── Explicit: masculine names typically don't end in 'a' ──────
func TestProperty_IsFeminineFirstName_MasculineRejected(t *testing.T) {
	masculine := []string{"Jan", "Petr", "Tomáš", "Jakub", "Martin", "David", "Michal"}
	for _, name := range masculine {
		if isFeminineFirstName(name) {
			t.Fatalf("%q should NOT be feminine", name)
		}
	}
}

// ── Explicit: hardcoded feminine whitelist (non-'a' suffixes) ─
func TestProperty_IsFeminineFirstName_Whitelist(t *testing.T) {
	// Names in the hardcoded feminine list — don't end in 'a'.
	list := []string{"Dagmar", "Ester", "Elen", "Ren", "Carmen", "Judith", "Ruth", "Madeleine"}
	for _, name := range list {
		if !isFeminineFirstName(name) {
			t.Fatalf("whitelisted feminine %q not detected", name)
		}
	}
}

// ── Explicit: empty string → false ───────────────────────────
func TestProperty_IsFeminineFirstName_Empty(t *testing.T) {
	if isFeminineFirstName("") {
		t.Fatal("empty string should not be feminine")
	}
}

// ── Property: GreetingForStep never panics ────────────────────
func TestProperty_GreetingForStep_NoPanic(t *testing.T) {
	eng := NewToneEngine()
	f := func(step int, name string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on step=%d name=%q: %v", step, name, r)
			}
		}()
		_ = eng.GreetingForStep(step, name)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: GreetingForStep always returns non-empty string ─
func TestProperty_GreetingForStep_NonEmpty(t *testing.T) {
	eng := NewToneEngine()
	f := func(step int, name string) bool {
		got := eng.GreetingForStep(step, name)
		return got != ""
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Explicit: step 0 with feminine name uses "paní" form ──────
func TestProperty_GreetingForStep_FeminineStep0(t *testing.T) {
	eng := NewToneEngine()
	// Try enough iterations to hit both random branches.
	seenVazena := false
	seenDobryDen := false
	for i := 0; i < 20 && !(seenVazena && seenDobryDen); i++ {
		got := eng.GreetingForStep(0, "Eva")
		if strings.Contains(got, "Vážená paní") {
			seenVazena = true
		}
		if strings.Contains(got, "Dobrý den, paní") {
			seenDobryDen = true
		}
		// All results must include "paní" for Eva (not "pane")
		if strings.Contains(got, "pane Eva") {
			t.Fatalf("feminine Eva should use 'paní', got %q", got)
		}
	}
}

// ── Explicit: step 0 with masculine name uses "pane" form ─────
func TestProperty_GreetingForStep_MasculineStep0(t *testing.T) {
	eng := NewToneEngine()
	for i := 0; i < 20; i++ {
		got := eng.GreetingForStep(0, "Jan")
		// Must not mistakenly label Jan as paní
		if strings.Contains(got, "paní Jan") {
			t.Fatalf("masculine Jan should use 'pane', got %q", got)
		}
	}
}

// ── Property: ClosingForStep never panics + always non-empty ───
func TestProperty_ClosingForStep_NonEmpty(t *testing.T) {
	eng := NewToneEngine()
	f := func(step int) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on step=%d: %v", step, r)
			}
		}()
		got := eng.ClosingForStep(step)
		return got != ""
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: fatigueFactor always in [0, 2] range ────────────
// Fatigue is a multiplier for send count; outside [0, 2] would break
// daily capacity calculations.
func TestProperty_FatigueFactor_InRange(t *testing.T) {
	eng := NewToneEngine()
	for dow := time.Sunday; dow <= time.Saturday; dow++ {
		got := eng.fatigueFactor(dow)
		if got < 0 || got > 2 {
			t.Fatalf("fatigueFactor(%s) = %f out of [0,2] range", dow, got)
		}
	}
}

// ── Explicit: fatigueFactor deterministic per weekday ─────────
func TestProperty_FatigueFactor_Deterministic(t *testing.T) {
	eng := NewToneEngine()
	for dow := time.Sunday; dow <= time.Saturday; dow++ {
		a := eng.fatigueFactor(dow)
		b := eng.fatigueFactor(dow)
		if a != b {
			t.Fatalf("fatigueFactor(%s) non-deterministic: %f vs %f", dow, a, b)
		}
	}
}

// ── Property: ProfileForStep returns profile without panic ──────
func TestProperty_ProfileForStep_NoPanic(t *testing.T) {
	eng := NewToneEngine()
	f := func(step int) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on step=%d: %v", step, r)
			}
		}()
		_ = eng.ProfileForStep(step, time.Monday)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}
