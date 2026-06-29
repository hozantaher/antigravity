package reply

import (
	"context"
	"errors"
	"testing"
)

// stubClassifier is a test double for llmiface.SentimentClassifier.
// It returns a fixed response or error, replacing the mock-HTTP-server approach
// that previously pulled in orchestrator/llm directly (ADR-010 cycle break).
type stubClassifier struct {
	response string
	err      error
}

func (s *stubClassifier) ClassifySentiment(_ context.Context, _ string) (string, error) {
	return s.response, s.err
}

// ── LLMClassifier with stub SentimentClassifier ────────────────────────────

func TestLLMClassifier_Success_Interested(t *testing.T) {
	cl := &LLMClassifier{Client: &stubClassifier{response: "interested"}}

	got, err := cl.Classify(context.Background(), "Jsem zájem o spolupráci")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != ClassInterested {
		t.Errorf("got %q, want %q", got, ClassInterested)
	}
}

func TestLLMClassifier_Success_Negative(t *testing.T) {
	cl := &LLMClassifier{Client: &stubClassifier{response: "negative"}}

	got, err := cl.Classify(context.Background(), "Nemáme zájem")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != ClassNegative {
		t.Errorf("got %q, want %q", got, ClassNegative)
	}
}

func TestLLMClassifier_ServerError(t *testing.T) {
	cl := &LLMClassifier{Client: &stubClassifier{err: errors.New("ollama HTTP 500")}}

	got, err := cl.Classify(context.Background(), "Some text")
	if err == nil {
		t.Error("expected error from Classify when underlying classifier fails")
	}
	if got != ClassUnknown {
		t.Errorf("got %q, want ClassUnknown on error", got)
	}
}

func TestLLMClassifier_Success_Meeting(t *testing.T) {
	cl := &LLMClassifier{Client: &stubClassifier{response: "meeting"}}

	got, err := cl.Classify(context.Background(), "Rád bych si domluvil schůzku")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != ClassMeeting {
		t.Errorf("got %q, want %q", got, ClassMeeting)
	}
}

func TestLLMClassifier_Success_Later(t *testing.T) {
	cl := &LLMClassifier{Client: &stubClassifier{response: "later"}}

	got, err := cl.Classify(context.Background(), "Vrátím se k tomu na podzim")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != ClassLater {
		t.Errorf("got %q, want %q", got, ClassLater)
	}
}

func TestLLMClassifier_Success_OOO(t *testing.T) {
	cl := &LLMClassifier{Client: &stubClassifier{response: "ooo"}}

	got, err := cl.Classify(context.Background(), "Mimo kancelář do 15.5.")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != ClassOOO {
		t.Errorf("got %q, want %q", got, ClassOOO)
	}
}

func TestLLMClassifier_Success_Objection(t *testing.T) {
	cl := &LLMClassifier{Client: &stubClassifier{response: "objection"}}

	got, err := cl.Classify(context.Background(), "Cena je příliš vysoká")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != ClassObjection {
		t.Errorf("got %q, want %q", got, ClassObjection)
	}
}

func TestLLMClassifier_UnknownLLMOutput_MapsToClassUnknown(t *testing.T) {
	// LLM returns a garbage string → Normalize maps to ClassUnknown.
	cl := &LLMClassifier{Client: &stubClassifier{response: "Category: interested"}}

	got, err := cl.Classify(context.Background(), "something")
	// No error — but the raw string "Category: interested" is not a valid enum member.
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The raw string has a prefix so Normalize returns ClassUnknown.
	if got != ClassUnknown {
		t.Errorf("got %q, want ClassUnknown for unrecognised LLM output", got)
	}
}

func TestLLMClassifier_StubSatisfiesInterface(t *testing.T) {
	// Compile-time proof that stubClassifier satisfies the SentimentClassifier
	// interface used by LLMClassifier.Client. If the interface changes without
	// updating this stub, this test fails to compile.
	var _ interface {
		ClassifySentiment(ctx context.Context, replyText string) (string, error)
	} = (*stubClassifier)(nil)
}
