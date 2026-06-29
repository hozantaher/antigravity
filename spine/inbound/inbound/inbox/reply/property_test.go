package reply

import (
	"context"
	"errors"
	"testing"
	"testing/quick"
)

// ── Property: Normalize is idempotent ──────────────────────────
// Normalize(Normalize(x)) == Normalize(x) for all string inputs.
func TestProperty_Normalize_Idempotent(t *testing.T) {
	f := func(s string) bool {
		first := Normalize(s)
		second := Normalize(string(first))
		return first == second
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Normalize output is always a member of known enum ──
// (ValidClasses ∪ {ClassUnknown}) for any input.
func TestProperty_Normalize_OutputInEnum(t *testing.T) {
	known := func(c Classification) bool {
		return ValidClasses[c] || c == ClassUnknown
	}
	f := func(s string) bool {
		return known(Normalize(s))
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Any string NOT in ValidClasses literal set → ClassUnknown ──
func TestProperty_Normalize_UnknownForNonEnum(t *testing.T) {
	f := func(s string) bool {
		// Skip inputs that happen to match a valid class exactly.
		if ValidClasses[Classification(s)] {
			return true
		}
		return Normalize(s) == ClassUnknown
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Normalize is case-sensitive ─────────────────────
// "Interested" (capital I) → ClassUnknown (does NOT match "interested").
// This locks the contract: LLM must return lowercase.
func TestProperty_Normalize_CaseSensitive(t *testing.T) {
	cases := []string{
		"Interested", "INTERESTED", "Meeting", "LATER", "NeGaTiVe",
	}
	for _, c := range cases {
		if Normalize(c) != ClassUnknown {
			t.Fatalf("case-variant %q should fall to ClassUnknown (LLM contract = lowercase)", c)
		}
	}
}

// ── Explicit pairwise table lock for all 6 valid classes ──────
// Catches any accidental rename/drift in ValidClasses ↔ constants.
func TestConstantsMatchValidClasses(t *testing.T) {
	constants := []Classification{
		ClassInterested, ClassMeeting, ClassLater,
		ClassObjection, ClassNegative, ClassOOO,
	}
	for _, c := range constants {
		if !ValidClasses[c] {
			t.Fatalf("constant %q missing from ValidClasses map", c)
		}
	}
	// Verse: no surprise entry in ValidClasses beyond the 6 constants.
	seen := map[Classification]bool{}
	for _, c := range constants {
		seen[c] = true
	}
	for k := range ValidClasses {
		if !seen[k] {
			t.Fatalf("ValidClasses has surprise entry %q — add constant or remove", k)
		}
	}
}

// ── Property: Normalize never panics ─────────────────────────
func TestProperty_Normalize_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = Normalize(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Normalize deterministic ────────────────────────
func TestProperty_Normalize_Deterministic(t *testing.T) {
	f := func(s string) bool {
		return Normalize(s) == Normalize(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Normalize(x) ∈ known classes for exact enum match ──
func TestProperty_Normalize_ExactMatchAllValid(t *testing.T) {
	validLiterals := []string{"interested", "meeting", "later", "objection", "negative", "ooo"}
	for _, s := range validLiterals {
		got := Normalize(s)
		if !ValidClasses[got] {
			t.Fatalf("exact literal %q must pass; got %q", s, got)
		}
		if Classification(s) != got {
			t.Fatalf("%q should round-trip as %q, got %q", s, s, got)
		}
	}
}

// ── Property: empty/ws strings → ClassUnknown ────────────────
func TestProperty_Normalize_EmptyUnknown(t *testing.T) {
	for _, s := range []string{"", " ", "\t", "\n", "   ws   "} {
		if Normalize(s) != ClassUnknown {
			t.Fatalf("empty/ws %q should be ClassUnknown", s)
		}
	}
}

// ── Property: LLMClassifier nil-safe ─────────────────────────
// Nil receiver or nil client → explicit error, never a panic.
func TestProperty_LLMClassifier_NilSafe(t *testing.T) {
	ctx := context.Background()

	// Nil receiver
	var c *LLMClassifier
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("nil-receiver panic: %v", r)
		}
	}()
	got, err := c.Classify(ctx, "non-empty reply")
	if err == nil {
		t.Fatal("nil receiver: want error")
	}
	if got != ClassUnknown {
		t.Fatalf("nil receiver: want ClassUnknown, got %q", got)
	}

	// Non-nil receiver, nil client
	c2 := &LLMClassifier{Client: nil}
	got, err = c2.Classify(ctx, "non-empty reply")
	if err == nil {
		t.Fatal("nil client: want error")
	}
	if got != ClassUnknown {
		t.Fatalf("nil client: want ClassUnknown, got %q", got)
	}
}

// ── Property: empty reply → ErrEmptyReply + ClassUnknown ─────
func TestProperty_LLMClassifier_EmptyReply(t *testing.T) {
	c := &LLMClassifier{Client: nil} // irrelevant; empty-body short-circuits
	got, err := c.Classify(context.Background(), "")
	if !errors.Is(err, ErrEmptyReply) {
		t.Fatalf("empty reply: want ErrEmptyReply, got %v", err)
	}
	if got != ClassUnknown {
		t.Fatalf("empty reply: want ClassUnknown, got %q", got)
	}
}
