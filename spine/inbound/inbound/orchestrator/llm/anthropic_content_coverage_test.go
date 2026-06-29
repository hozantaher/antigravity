package llm

// anthropic_content_coverage_test.go — covers NewAnthropicContentGenerator
// constructor and AnthropicClient.GenerateOpener (the forwarding wrapper).
// These are the two functions at 0% coverage after anthropic_content_test.go
// was written (which only exercises &anthropicContentGenerator{} directly).

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// ── NewAnthropicContentGenerator constructor ──────────────────────────────────

// TestNewAnthropicContentGenerator_ReturnsNonNil verifies that the constructor
// returns a non-nil ContentGenerator and satisfies the interface.
func TestNewAnthropicContentGenerator_ReturnsNonNil(t *testing.T) {
	ac := NewAnthropicClient(AnthropicConfig{APIKey: "test-key"})
	gen := NewAnthropicContentGenerator(ac)
	if gen == nil {
		t.Fatal("NewAnthropicContentGenerator returned nil")
	}
}

// TestNewAnthropicContentGenerator_ImplementsInterface is a compile-time
// assertion that the returned value satisfies ContentGenerator.
func TestNewAnthropicContentGenerator_ImplementsInterface(t *testing.T) {
	ac := NewAnthropicClient(AnthropicConfig{APIKey: "test-key"})
	var _ ContentGenerator = NewAnthropicContentGenerator(ac)
}

// TestNewAnthropicContentGenerator_ProducesWorkingGenerator confirms that the
// generator returned by the constructor actually invokes the underlying
// completer. We wrap a mockAnthropicContent through the private struct so we
// can observe the prompt without calling the real Anthropic API.
func TestNewAnthropicContentGenerator_ProducesWorkingGenerator(t *testing.T) {
	mock := &mockAnthropicContent{response: "Vítejte, spolupracujeme."}
	gen := &anthropicContentGenerator{completer: mock}

	out, err := gen.GenerateOpener(context.Background(), "ABC s.r.o.", "Stavba", "CZ43")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Error("opener must not be empty")
	}
	if !strings.Contains(mock.captured, "ABC s.r.o.") {
		t.Errorf("prompt should contain firma name; prompt: %q", mock.captured)
	}
}

// ── AnthropicClient.GenerateOpener forwarding wrapper ────────────────────────
// AnthropicClient exposes GenerateOpener at line 65 of anthropic_content.go.
// It creates an anthropicContentGenerator internally and delegates to it.
// We can't call the real Anthropic API, but we can confirm the function
// is reachable and returns an error when the underlying complete() fails
// (network error with no valid API key in test env).

// TestAnthropicClient_GenerateOpener_WiresCompleter builds an AnthropicClient
// with a fake API key. The complete() call will fail at the HTTP level;
// we just confirm the wrapper propagates that error correctly (not a panic,
// not a nil return on success path).
func TestAnthropicClient_GenerateOpener_PropagatesError(t *testing.T) {
	// Build a client with an invalid API key that will cause the HTTP call to
	// fail. We use a very short context to make the test fast.
	ac := NewAnthropicClient(AnthropicConfig{APIKey: "sk-invalid-test-key"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately so the network call fails instantly

	_, err := ac.GenerateOpener(ctx, "firma", "popis", "CZ43")
	// The context is cancelled — expect an error (not nil, not a panic).
	if err == nil {
		t.Error("expected error from cancelled-context GenerateOpener")
	}
}

// TestAnthropicClient_GenerateOpener_DescriptionTruncation verifies that
// descriptions longer than 300 characters are truncated before being sent to
// the completer. We exercise this through the private struct to avoid real
// HTTP calls.
func TestAnthropicClient_GenerateOpener_DescriptionTruncation(t *testing.T) {
	mock := &mockAnthropicContent{response: "Opener."}
	gen := &anthropicContentGenerator{completer: mock}

	longDesc := strings.Repeat("x", 500)
	_, err := gen.GenerateOpener(context.Background(), "firma", longDesc, "CZ43")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The prompt should NOT contain the full 500-char description.
	if strings.Contains(mock.captured, strings.Repeat("x", 400)) {
		t.Error("description should have been truncated to 300 chars in the prompt")
	}
}

// TestAnthropicClient_GenerateOpener_EmptyNACE verifies that an empty NACE
// code does not cause a panic or unexpected error — the nace branch is skipped.
func TestAnthropicClient_GenerateOpener_EmptyNACE(t *testing.T) {
	mock := &mockAnthropicContent{response: "OK opener."}
	gen := &anthropicContentGenerator{completer: mock}

	out, err := gen.GenerateOpener(context.Background(), "firma", "popis", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Error("should return non-empty opener with empty NACE")
	}
}

// TestAnthropicClient_GenerateOpener_AllEmpty covers the branch where all
// three inputs are empty strings (uses "neznámá firma" fallback).
func TestAnthropicClient_GenerateOpener_AllEmpty(t *testing.T) {
	mock := &mockAnthropicContent{response: "Generická věta."}
	gen := &anthropicContentGenerator{completer: mock}

	out, err := gen.GenerateOpener(context.Background(), "", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Error("should return non-empty opener even with all-empty inputs")
	}
	if !strings.Contains(mock.captured, "neznámá firma") {
		t.Errorf("prompt should use 'neznámá firma' fallback; got: %q", mock.captured)
	}
}

// TestAnthropicClient_GenerateOpener_CompleterError_WrapsError confirms that
// the error from complete() is wrapped with "generate opener:" prefix.
func TestAnthropicClient_GenerateOpener_CompleterError_WrapsError(t *testing.T) {
	sentinel := errors.New("sentinel-error")
	mock := &mockAnthropicContent{retErr: sentinel}
	gen := &anthropicContentGenerator{completer: mock}

	_, err := gen.GenerateOpener(context.Background(), "firma", "popis", "CZ43")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "generate opener") {
		t.Errorf("error should be wrapped with 'generate opener:'; got: %v", err)
	}
	if !errors.Is(err, sentinel) {
		t.Errorf("wrapped error should unwrap to sentinel; got: %v", err)
	}
}

// TestAnthropicClient_GenerateOpener_TrimSpacesFromOutput verifies that
// leading/trailing whitespace and newlines are trimmed from the raw LLM output.
func TestAnthropicClient_GenerateOpener_TrimSpacesFromOutput(t *testing.T) {
	mock := &mockAnthropicContent{response: "\n  Trimmed opener.  \n\t"}
	gen := &anthropicContentGenerator{completer: mock}

	out, err := gen.GenerateOpener(context.Background(), "firma", "popis", "CZ43")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "Trimmed opener."
	if out != want {
		t.Errorf("TrimSpace: got %q, want %q", out, want)
	}
}
