package llm

import (
	"context"
	"fmt"
	"strings"
)

// ContentGenerator generates personalized email opening lines using an LLM.
type ContentGenerator interface {
	// GenerateOpener returns a one-sentence Czech opener personalized for the
	// given company, business description, and NACE sector code.
	GenerateOpener(ctx context.Context, firma, description, nace string) (string, error)
}

// completer is the minimal interface that anthropicContentGenerator needs.
// Allows test injection without the full Anthropic SDK.
type completer interface {
	complete(ctx context.Context, prompt string) (string, error)
}

// anthropicContentGenerator wraps a completer to generate openers.
type anthropicContentGenerator struct {
	completer completer
}

// NewAnthropicContentGenerator returns a ContentGenerator backed by an
// AnthropicClient. The AnthropicClient must have been created via NewAnthropicClient.
func NewAnthropicContentGenerator(c *AnthropicClient) ContentGenerator {
	return &anthropicContentGenerator{completer: c}
}

// GenerateOpener implements ContentGenerator.
func (g *anthropicContentGenerator) GenerateOpener(ctx context.Context, firma, description, nace string) (string, error) {
	var b strings.Builder
	b.WriteString("Napiš jednu krátkou (1–2 věty) českou personalizovanou větu jako úvodní oslovení pro B2B obchodní email od dealera těžké techniky.\n")
	b.WriteString("Firma: ")
	if firma != "" {
		b.WriteString(firma)
	} else {
		b.WriteString("neznámá firma")
	}
	b.WriteString("\nObor: ")
	if nace != "" {
		b.WriteString(nace)
	}
	if description != "" {
		b.WriteString("\nPopis: ")
		if len(description) > 300 {
			description = description[:300]
		}
		b.WriteString(description)
	}
	b.WriteString("\n\nÚvodní věta:")

	raw, err := g.completer.complete(ctx, b.String())
	if err != nil {
		return "", fmt.Errorf("generate opener: %w", err)
	}
	return strings.TrimSpace(raw), nil
}

// GenerateOpener wires AnthropicClient as a ContentGenerator via the
// anthropicContentGenerator helper. This satisfies the ContentGenerator interface.
func (a *AnthropicClient) GenerateOpener(ctx context.Context, firma, description, nace string) (string, error) {
	g := &anthropicContentGenerator{completer: a}
	return g.GenerateOpener(ctx, firma, description, nace)
}
