package llm

import "context"

// Provider is the common interface for all LLM backends (Ollama, Anthropic, …).
// Callers depend on this interface so that the backend can be swapped without
// changing adapter or intelligence code.
type Provider interface {
	// ClassifyIndustry returns NACE sector tags and a confidence score for the
	// given Czech business description.
	ClassifyIndustry(ctx context.Context, description string) (*IndustryResult, error)

	// SummarizeDescription returns a concise Czech summary of a business
	// description.
	SummarizeDescription(ctx context.Context, description string) (string, error)

	// ClassifySentiment classifies the sentiment of an inbound reply email.
	// Returns one of: positive, negative, neutral, question.
	ClassifySentiment(ctx context.Context, replyText string) (string, error)

	// Ping checks that the backend is reachable.
	Ping(ctx context.Context) error
}

// Ensure concrete types satisfy the interface at compile time.
var _ Provider = (*Client)(nil)
var _ Provider = (*AnthropicClient)(nil)
