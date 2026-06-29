package llm

import (
	"context"
	"testing"
)

// mockProvider is a test double for the Provider interface.
type mockProvider struct {
	classifyFn   func(ctx context.Context, desc string) (*IndustryResult, error)
	summarizeFn  func(ctx context.Context, desc string) (string, error)
	sentimentFn  func(ctx context.Context, text string) (string, error)
	pingFn       func(ctx context.Context) error
}

func (m *mockProvider) ClassifyIndustry(ctx context.Context, d string) (*IndustryResult, error) {
	return m.classifyFn(ctx, d)
}
func (m *mockProvider) SummarizeDescription(ctx context.Context, d string) (string, error) {
	return m.summarizeFn(ctx, d)
}
func (m *mockProvider) ClassifySentiment(ctx context.Context, t string) (string, error) {
	return m.sentimentFn(ctx, t)
}
func (m *mockProvider) Ping(ctx context.Context) error { return m.pingFn(ctx) }

// Ensure mockProvider satisfies Provider at compile time.
var _ Provider = (*mockProvider)(nil)

func TestProvider_OllamaClientSatisfiesInterface(t *testing.T) {
	// This test is purely a compile-time guard via the var _ Provider = (*Client)(nil)
	// assertion in provider.go. If it compiles, the test passes.
}

func TestProvider_MockCanBeDelegatedTo(t *testing.T) {
	called := false
	p := &mockProvider{
		classifyFn: func(_ context.Context, _ string) (*IndustryResult, error) {
			called = true
			return &IndustryResult{Tags: []string{"machinery"}, Confidence: 0.9}, nil
		},
		summarizeFn: func(_ context.Context, _ string) (string, error) { return "summary", nil },
		sentimentFn: func(_ context.Context, _ string) (string, error) { return "positive", nil },
		pingFn:      func(_ context.Context) error { return nil },
	}

	result, err := p.ClassifyIndustry(context.Background(), "výroba bagru")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("mock classifyFn not called")
	}
	if len(result.Tags) == 0 || result.Tags[0] != "machinery" {
		t.Errorf("unexpected tags: %v", result.Tags)
	}
}
