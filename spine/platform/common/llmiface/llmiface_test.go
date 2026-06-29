package llmiface_test

import (
	"context"
	"errors"
	"testing"

	"common/llmiface"
)

// ── compile-time interface satisfaction ────────────────────────────────────

// mockSentimentClassifier is a minimal implementation of SentimentClassifier
// used to verify the interface can be implemented outside the package.
type mockSentimentClassifier struct {
	response string
	err      error
}

func (m *mockSentimentClassifier) ClassifySentiment(_ context.Context, _ string) (string, error) {
	return m.response, m.err
}

// Static assertion: mockSentimentClassifier satisfies the interface.
var _ llmiface.SentimentClassifier = (*mockSentimentClassifier)(nil)

// ── interface contract tests ────────────────────────────────────────────────

func TestSentimentClassifier_ReturnsResponse(t *testing.T) {
	m := &mockSentimentClassifier{response: "interested"}
	got, err := m.ClassifySentiment(context.Background(), "test reply")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "interested" {
		t.Errorf("got %q, want %q", got, "interested")
	}
}

func TestSentimentClassifier_ReturnsError(t *testing.T) {
	sentinel := errors.New("transport failure")
	m := &mockSentimentClassifier{err: sentinel}
	got, err := m.ClassifySentiment(context.Background(), "test reply")
	if !errors.Is(err, sentinel) {
		t.Fatalf("got err=%v, want sentinel", err)
	}
	if got != "" {
		t.Errorf("got %q on error path, want empty string", got)
	}
}

func TestSentimentClassifier_AcceptsContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled
	m := &mockSentimentClassifier{response: "negative"}
	// Interface does not mandate ctx checking — verify it accepts a cancelled
	// context without panicking (implementations may or may not honour it).
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on cancelled context: %v", r)
		}
	}()
	_, _ = m.ClassifySentiment(ctx, "text")
}

func TestSentimentClassifier_EmptyReply_NoContractViolation(t *testing.T) {
	// The interface itself imposes no constraint on empty input — the
	// contract is enforced at the calling layer (inbox/reply.LLMClassifier).
	m := &mockSentimentClassifier{response: "unknown"}
	got, err := m.ClassifySentiment(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error for empty input: %v", err)
	}
	if got == "" {
		// Acceptable — stub returns whatever was configured.
		return
	}
	_ = got
}

func TestSentimentClassifier_ZeroValue_ReturnsZeroFields(t *testing.T) {
	// A zero-valued (but non-nil) mockSentimentClassifier has empty response
	// and nil error — verifies the interface method behaves predictably on a
	// default-initialised struct (Go zero value).
	m := &mockSentimentClassifier{} // response="", err=nil
	got, err := m.ClassifySentiment(context.Background(), "test")
	if err != nil {
		t.Fatalf("unexpected error on zero value: %v", err)
	}
	if got != "" {
		t.Errorf("got %q on zero value, want empty string", got)
	}
}

func TestSentimentClassifier_InterfaceIsImplementableInExternalPackage(t *testing.T) {
	// Verify that the interface is exported and usable as a function parameter.
	result := callWithClassifier(&mockSentimentClassifier{response: "meeting"})
	if result != "meeting" {
		t.Errorf("got %q, want %q", result, "meeting")
	}
}

// callWithClassifier demonstrates SentimentClassifier is usable as a parameter type.
func callWithClassifier(c llmiface.SentimentClassifier) string {
	resp, _ := c.ClassifySentiment(context.Background(), "schůzka prosím")
	return resp
}

func TestSentimentClassifier_MultipleImplementations_SameInterface(t *testing.T) {
	// Two different implementations satisfy the same interface — this is the
	// core value proposition of the cycle-break: callers accept the interface,
	// not a concrete type.
	impls := []llmiface.SentimentClassifier{
		&mockSentimentClassifier{response: "interested"},
		&mockSentimentClassifier{response: "negative"},
	}
	want := []string{"interested", "negative"}
	for i, impl := range impls {
		got, err := impl.ClassifySentiment(context.Background(), "text")
		if err != nil {
			t.Fatalf("[%d] unexpected error: %v", i, err)
		}
		if got != want[i] {
			t.Errorf("[%d] got %q, want %q", i, got, want[i])
		}
	}
}
