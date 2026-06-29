package llm

import (
	"context"
	"fmt"
	"log/slog"
)

// IndustryClassifier adapts the LLM client to the enrich.IndustryClassifier interface.
type IndustryClassifier struct {
	client   *Client
	fallback bool // if true, falls back to keyword matching on LLM error
}

// NewIndustryClassifier creates an LLM-based industry classifier.
// If fallback is true, falls back to keyword matching on LLM errors.
func NewIndustryClassifier(client *Client, fallback bool) *IndustryClassifier {
	return &IndustryClassifier{client: client, fallback: fallback}
}

// Classify uses the LLM to classify a business description.
func (c *IndustryClassifier) Classify(ctx context.Context, description string) ([]string, float64, error) {
	result, err := c.client.ClassifyIndustry(ctx, description)
	if err != nil {
		if c.fallback {
			slog.Warn("llm classify error, falling back to keywords", "op", "IndustryClassifier.Classify/fallback", "error", err)
			return nil, 0, nil // pipeline will use empty tags
		}
		return nil, 0, err
	}

	return result.Tags, result.Confidence, nil
}

// DescriptionSummarizer adapts the LLM client to the enrich.DescriptionSummarizer interface.
type DescriptionSummarizer struct {
	client *Client
}

// NewDescriptionSummarizer creates an LLM-based description summarizer.
func NewDescriptionSummarizer(client *Client) *DescriptionSummarizer {
	return &DescriptionSummarizer{client: client}
}

// Summarize uses the LLM to summarize a Czech business description.
func (d *DescriptionSummarizer) Summarize(ctx context.Context, description string) (string, error) {
	summary, err := d.client.SummarizeDescription(ctx, description)
	if err != nil {
		return "", fmt.Errorf("summarize description: %w", err)
	}
	return summary, nil
}

// ReplySentimentClassifier adapts the LLM client to the thread.SentimentClassifier interface.
type ReplySentimentClassifier struct {
	client *Client
}

// NewReplySentimentClassifier creates an LLM-based reply sentiment classifier.
func NewReplySentimentClassifier(client *Client) *ReplySentimentClassifier {
	return &ReplySentimentClassifier{client: client}
}

// ClassifySentiment uses the LLM to classify a reply's sentiment category.
func (r *ReplySentimentClassifier) ClassifySentiment(ctx context.Context, replyText string) (string, error) {
	category, err := r.client.ClassifySentiment(ctx, replyText)
	if err != nil {
		return "", fmt.Errorf("classify sentiment: %w", err)
	}
	return category, nil
}
