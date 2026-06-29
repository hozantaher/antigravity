package llm

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// ── ContentGenerator interface ────────────────────────────────────────────────

// Verify AnthropicClient satisfies ContentGenerator at compile time.
var _ ContentGenerator = (*AnthropicClient)(nil)

// stubContent is a test-only ContentGenerator that returns a fixed opener.
type stubContent struct {
	opener string
	err    error
}

func (s *stubContent) GenerateOpener(_ context.Context, _, _, _ string) (string, error) {
	return s.opener, s.err
}

// ── GenerateOpener unit tests (using stub for no real API calls) ──────────────

func TestGenerateOpener_ReturnsNonEmpty(t *testing.T) {
	g := &stubContent{opener: "Zaujala nás vaše stavební firma."}
	out, err := g.GenerateOpener(context.Background(), "ACME s.r.o.", "Stavební práce", "CZ41")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Error("opener must not be empty")
	}
}

func TestGenerateOpener_PropagatesError(t *testing.T) {
	g := &stubContent{err: errors.New("api down")}
	_, err := g.GenerateOpener(context.Background(), "ACME s.r.o.", "popis", "CZ41")
	if err == nil {
		t.Error("expected error")
	}
}

// ── AnthropicClient.GenerateOpener prompt validation (no real API) ────────────

// mockAnthropicContent overrides the complete function to capture the prompt.
type mockAnthropicContent struct {
	captured string
	response string
	retErr   error
}

func (m *mockAnthropicContent) complete(_ context.Context, prompt string) (string, error) {
	m.captured = prompt
	if m.retErr != nil {
		return "", m.retErr
	}
	return m.response, nil
}

func TestAnthropicContentGenerator_PromptContainsFirma(t *testing.T) {
	g := &anthropicContentGenerator{
		completer: &mockAnthropicContent{response: "Personalizovaný opener."},
	}
	out, err := g.GenerateOpener(context.Background(), "Testová firma s.r.o.", "stavba", "CZ41")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Error("opener must not be empty")
	}
	if !strings.Contains(g.completer.(*mockAnthropicContent).captured, "Testová firma") {
		t.Errorf("prompt should contain firma name; got: %s", g.completer.(*mockAnthropicContent).captured)
	}
}

func TestAnthropicContentGenerator_EmptyFirmaFallback(t *testing.T) {
	g := &anthropicContentGenerator{
		completer: &mockAnthropicContent{response: "Opener bez jména."},
	}
	out, err := g.GenerateOpener(context.Background(), "", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Error("opener must not be empty even with empty inputs")
	}
}

func TestAnthropicContentGenerator_APIError(t *testing.T) {
	g := &anthropicContentGenerator{
		completer: &mockAnthropicContent{retErr: errors.New("api timeout")},
	}
	_, err := g.GenerateOpener(context.Background(), "firma", "popis", "CZ41")
	if err == nil {
		t.Error("expected error from API")
	}
}

func TestAnthropicContentGenerator_TrimOutput(t *testing.T) {
	g := &anthropicContentGenerator{
		completer: &mockAnthropicContent{response: "  Opener s mezerami.  \n"},
	}
	out, err := g.GenerateOpener(context.Background(), "firma", "popis", "CZ41")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != strings.TrimSpace("  Opener s mezerami.  \n") {
		t.Errorf("output not trimmed: %q", out)
	}
}

// ── AnthropicClient satisfies ContentGenerator (compile check done at top) ───
