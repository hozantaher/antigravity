package llm

import (
	"context"
	"fmt"
	"strings"

	anthropic "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// AnthropicClient implements Provider using the Anthropic Messages API.
// Configure ANTHROPIC_API_KEY in the environment; the SDK reads it
// automatically via option.WithAPIKey(os.Getenv("ANTHROPIC_API_KEY")).
type AnthropicClient struct {
	client anthropic.Client
	model  anthropic.Model
}

// AnthropicConfig for creating an AnthropicClient.
type AnthropicConfig struct {
	// APIKey is the Anthropic API key. Defaults to ANTHROPIC_API_KEY env var.
	APIKey string
	// Model to use. Defaults to claude-haiku-4-5-20251001 (cheapest, fast).
	Model anthropic.Model
}

// NewAnthropicClient creates an Anthropic-backed LLM provider.
func NewAnthropicClient(cfg AnthropicConfig) *AnthropicClient {
	model := cfg.Model
	if model == "" {
		model = anthropic.ModelClaudeHaiku4_5_20251001
	}

	opts := []option.RequestOption{}
	if cfg.APIKey != "" {
		opts = append(opts, option.WithAPIKey(cfg.APIKey))
	}

	return &AnthropicClient{
		client: anthropic.NewClient(opts...),
		model:  model,
	}
}

func (a *AnthropicClient) complete(ctx context.Context, prompt string) (string, error) {
	msg, err := a.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     a.model,
		MaxTokens: 256,
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(prompt)),
		},
	})
	if err != nil {
		return "", fmt.Errorf("anthropic messages.new: %w", err)
	}
	if len(msg.Content) == 0 {
		return "", fmt.Errorf("anthropic: empty response")
	}
	return msg.Content[0].Text, nil
}

// ClassifyIndustry uses Claude to classify a Czech business description.
func (a *AnthropicClient) ClassifyIndustry(ctx context.Context, description string) (*IndustryResult, error) {
	if description == "" {
		return &IndustryResult{Tags: []string{"other"}, Confidence: 0}, nil
	}
	if len(description) > 500 {
		description = description[:500]
	}

	prompt := fmt.Sprintf(industryPrompt, description)
	raw, err := a.complete(ctx, prompt)
	if err != nil {
		return nil, err
	}

	tags := extractTags(raw)
	if len(tags) == 0 {
		tags = []string{"other"}
	}
	return &IndustryResult{Tags: tags, Confidence: 0.8}, nil
}

// SummarizeDescription uses Claude to produce a concise Czech business summary.
func (a *AnthropicClient) SummarizeDescription(ctx context.Context, description string) (string, error) {
	if description == "" {
		return "", nil
	}
	prompt := fmt.Sprintf(
		"Shrň v 1-2 větách česky, čím se firma zabývá:\n\n%s\n\nShrnutí:",
		description,
	)
	raw, err := a.complete(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("anthropic summarize: %w", err)
	}
	return strings.TrimSpace(raw), nil
}

// ClassifySentiment classifies inbound reply sentiment using Claude.
func (a *AnthropicClient) ClassifySentiment(ctx context.Context, replyText string) (string, error) {
	prompt := fmt.Sprintf(
		"Classify this email reply sentiment as one of: positive, negative, neutral, question.\n\nReply: %s\n\nCategory:",
		replyText,
	)
	raw, err := a.complete(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("anthropic sentiment: %w", err)
	}
	cat := extractCategory(raw)
	if cat == "" {
		cat = "neutral"
	}
	return cat, nil
}

// Ping verifies that the Anthropic API is reachable with a minimal prompt.
func (a *AnthropicClient) Ping(ctx context.Context) error {
	_, err := a.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     a.model,
		MaxTokens: 1,
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock("ping")),
		},
	})
	if err != nil {
		return fmt.Errorf("anthropic ping: %w", err)
	}
	return nil
}
