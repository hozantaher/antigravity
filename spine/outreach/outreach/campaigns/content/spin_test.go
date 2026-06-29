package content

import (
	"math/rand"
	"strings"
	"testing"
)

func TestSpinBasic(t *testing.T) {
	input := "{Dobrý den|Zdravím|Hezký den}"
	result := ResolveSpin(input, 42)

	options := []string{"Dobrý den", "Zdravím", "Hezký den"}
	found := false
	for _, opt := range options {
		if result == opt {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("unexpected result: %q", result)
	}
}

func TestSpinDeterministic(t *testing.T) {
	input := "{A|B|C} loves {X|Y|Z}"
	r1 := ResolveSpin(input, 123)
	r2 := ResolveSpin(input, 123)

	if r1 != r2 {
		t.Fatalf("same seed should produce same result: %q vs %q", r1, r2)
	}
}

func TestSpinDifferentSeeds(t *testing.T) {
	input := "{A|B|C|D|E|F|G|H|I|J}"
	results := make(map[string]bool)

	for seed := int64(0); seed < 50; seed++ {
		result := ResolveSpin(input, seed)
		results[result] = true
	}

	if len(results) < 3 {
		t.Fatalf("expected multiple different results from different seeds, got %d", len(results))
	}
}

func TestSpinNested(t *testing.T) {
	input := "{We {buy|purchase}|We're looking to {acquire|buy}}"
	result := ResolveSpin(input, 99)

	// Should resolve to one of: "We buy", "We purchase", "We're looking to acquire", "We're looking to buy"
	valid := []string{"We buy", "We purchase", "We're looking to acquire", "We're looking to buy"}
	found := false
	for _, v := range valid {
		if result == v {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("unexpected nested spin result: %q", result)
	}
}

func TestSpinNoGroups(t *testing.T) {
	input := "No spin syntax here"
	result := ResolveSpin(input, 1)
	if result != input {
		t.Fatalf("no-spin input should pass through unchanged: %q", result)
	}
}

func TestSpinMultipleGroups(t *testing.T) {
	input := "{Hello|Hi}, {world|earth}!"
	result := ResolveSpin(input, 7)

	if !strings.HasSuffix(result, "!") {
		t.Fatalf("should end with !: %q", result)
	}
	if strings.Contains(result, "{") || strings.Contains(result, "}") {
		t.Fatalf("should have no braces left: %q", result)
	}
}

func TestSpinUniquePerContact(t *testing.T) {
	template := "{Dobrý den|Zdravím|Hezký den}, {hledáme|sháníme|máme zájem o} {použité|ojeté} {stroje|techniku}"
	results := make(map[string]bool)

	for contactID := int64(1); contactID <= 100; contactID++ {
		result := ResolveSpin(template, contactID)
		results[result] = true
	}

	// With 3*3*2*2=36 combinations, 100 contacts should produce many variants
	if len(results) < 10 {
		t.Fatalf("expected many unique variants, got %d", len(results))
	}
}

func TestSplitPipes_Simple(t *testing.T) {
	parts := splitPipes("a|b|c")
	if len(parts) != 3 || parts[0] != "a" || parts[1] != "b" || parts[2] != "c" {
		t.Errorf("splitPipes(a|b|c) = %v", parts)
	}
}

func TestSplitPipes_NoPipe(t *testing.T) {
	parts := splitPipes("hello")
	if len(parts) != 1 || parts[0] != "hello" {
		t.Errorf("splitPipes(hello) = %v", parts)
	}
}

func TestSplitPipes_NestedBraces(t *testing.T) {
	// pipe inside nested {} should NOT split — depth > 0
	parts := splitPipes("{a|b}|c")
	if len(parts) != 2 {
		t.Fatalf("splitPipes with nested = %v, want 2 parts", parts)
	}
	if parts[0] != "{a|b}" {
		t.Errorf("parts[0] = %q, want {a|b}", parts[0])
	}
	if parts[1] != "c" {
		t.Errorf("parts[1] = %q, want c", parts[1])
	}
}

func TestSplitPipes_Empty(t *testing.T) {
	parts := splitPipes("")
	if len(parts) != 1 || parts[0] != "" {
		t.Errorf("splitPipes('') = %v", parts)
	}
}

func TestSplitPipes_DeeplyNested(t *testing.T) {
	// Multiple brace levels — pipes inside all levels should not split
	parts := splitPipes("{{x|y}|z}|outer")
	if len(parts) != 2 {
		t.Fatalf("deeply nested = %v, want 2", parts)
	}
	if !strings.HasPrefix(parts[0], "{") {
		t.Errorf("first part should start with {, got %q", parts[0])
	}
}

func TestResolveSpin_UnclosedBrace(t *testing.T) {
	// Input has { but no } → resolveSpinRecursive !resolved branch → returns unchanged
	rng := rand.New(rand.NewSource(42))
	got := resolveSpinRecursive("hello {world", rng)
	if got != "hello {world" {
		t.Errorf("unclosed brace: got %q, want unchanged", got)
	}
}
