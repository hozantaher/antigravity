// Package llmiface defines the minimal LLM-consumer interfaces shared across
// services. Placing them here breaks the inbox↔orchestrator module cycle
// (ADR-010) by giving inbox/reply a stable, common target to depend on
// instead of importing orchestrator/llm directly.
//
// Structural typing: any concrete LLM client that exposes the matching
// method signature satisfies these interfaces with zero boilerplate.
package llmiface

import "context"

// SentimentClassifier classifies the sentiment of a reply text.
// Implemented by *orchestrator/llm.Client.ClassifySentiment.
type SentimentClassifier interface {
	ClassifySentiment(ctx context.Context, replyText string) (string, error)
}
