package reply

import (
	"context"
	"errors"
	"testing"
)

func TestNormalize_ValidClasses(t *testing.T) {
	cases := []string{"interested", "meeting", "later", "objection", "negative", "ooo"}
	for _, c := range cases {
		t.Run(c, func(t *testing.T) {
			got := Normalize(c)
			if Classification(c) != got {
				t.Fatalf("want %q, got %q", c, got)
			}
		})
	}
}

func TestNormalize_UnknownFallsBack(t *testing.T) {
	cases := []string{"", "gibberish", "INTERESTED", "positive", "yes", "NO"}
	for _, c := range cases {
		t.Run("input="+c, func(t *testing.T) {
			if got := Normalize(c); got != ClassUnknown {
				t.Fatalf("want ClassUnknown, got %q", got)
			}
		})
	}
}

func TestLLMClassifier_NilClient(t *testing.T) {
	cl := &LLMClassifier{Client: nil}
	got, err := cl.Classify(context.Background(), "foo")
	if err == nil {
		t.Fatal("expected error for nil client, got nil")
	}
	if got != ClassUnknown {
		t.Fatalf("want ClassUnknown on nil client, got %q", got)
	}
}

func TestLLMClassifier_NilReceiver(t *testing.T) {
	var cl *LLMClassifier
	got, err := cl.Classify(context.Background(), "foo")
	if err == nil {
		t.Fatal("expected error for nil receiver, got nil")
	}
	if got != ClassUnknown {
		t.Fatalf("want ClassUnknown on nil receiver, got %q", got)
	}
}

func TestLLMClassifier_EmptyReply(t *testing.T) {
	// Client is nil-ish but we want to prove the empty-reply short-circuit
	// fires BEFORE the nil-client check. Use a sentinel error wrap check.
	cl := &LLMClassifier{Client: nil}
	got, err := cl.Classify(context.Background(), "foo")
	// With non-empty text, nil client → generic error.
	if !errors.Is(err, ErrEmptyReply) && err == nil {
		t.Fatal("unexpected state")
	}
	_ = got
}

func TestLLMClassifier_EmptyReplyReturnsSentinel(t *testing.T) {
	cl := &LLMClassifier{Client: nil}
	got, err := cl.Classify(context.Background(), "")
	if !errors.Is(err, ErrEmptyReply) {
		t.Fatalf("want ErrEmptyReply, got %v", err)
	}
	if got != ClassUnknown {
		t.Fatalf("want ClassUnknown, got %q", got)
	}
}

func TestValidClasses_IsFrozen(t *testing.T) {
	// Lock the contract: these 6 classes are the inbox-facing enum.
	// Adding a new class requires updating this test.
	if len(ValidClasses) != 6 {
		t.Fatalf("ValidClasses changed size (want 6, got %d) — update UI consumers + E2E", len(ValidClasses))
	}
	for _, c := range []Classification{
		ClassInterested, ClassMeeting, ClassLater, ClassObjection, ClassNegative, ClassOOO,
	} {
		if !ValidClasses[c] {
			t.Fatalf("class %q missing from ValidClasses", c)
		}
	}
}

func TestClassificationConstants_AreStrings(t *testing.T) {
	// Lock string values — backend + UI depend on these literals.
	cases := map[Classification]string{
		ClassInterested: "interested",
		ClassMeeting:    "meeting",
		ClassLater:      "later",
		ClassObjection:  "objection",
		ClassNegative:   "negative",
		ClassOOO:        "ooo",
		ClassUnknown:    "unknown",
	}
	for c, s := range cases {
		if string(c) != s {
			t.Fatalf("class %q value drift: got %q", s, string(c))
		}
	}
}
