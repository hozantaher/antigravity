// Package reply hosts domain-specific reply classification — the slice of
// LLM work that belongs to inbox (as opposed to llm.ClassifyIndustry which
// belongs to contacts/enrichment).
//
// This package depends on the common/llmiface.SentimentClassifier interface
// rather than the concrete *orchestrator/llm.Client, breaking the
// inbox↔orchestrator module cycle (ADR-010).
package reply

import (
	"context"
	"errors"

	"common/llmiface"
)

// Classification is the reply category returned by the LLM.
// Values match the sentimentPrompt categories in outreach/llm/classify.go.
type Classification string

const (
	ClassInterested Classification = "interested"
	ClassMeeting    Classification = "meeting"
	ClassLater      Classification = "later"
	ClassObjection  Classification = "objection"
	ClassNegative   Classification = "negative"
	ClassOOO        Classification = "ooo"
	// ClassUnknown is the fallback when the LLM returns something the inbox
	// domain doesn't recognize. Never bubbles up an error to callers.
	ClassUnknown Classification = "unknown"
)

// ValidClasses enumerates the classifications a well-behaved classifier
// returns. Used in tests + contract assertions.
var ValidClasses = map[Classification]bool{
	ClassInterested: true,
	ClassMeeting:    true,
	ClassLater:      true,
	ClassObjection:  true,
	ClassNegative:   true,
	ClassOOO:        true,
}

// Classifier is the inbox-domain interface over LLM.
// Allows test doubles + future swap of transport.
type Classifier interface {
	Classify(ctx context.Context, replyText string) (Classification, error)
}

// ErrEmptyReply is returned when the caller passes empty/whitespace text.
// Callers SHOULD treat this as a benign skip — the inbox still renders the
// row, just without a category label.
var ErrEmptyReply = errors.New("reply text is empty")

// LLMClassifier is the Classifier backed by any llmiface.SentimentClassifier.
// Pass a *orchestrator/llm.Client (or any compatible implementation) at the
// call site — this package no longer imports orchestrator directly.
type LLMClassifier struct {
	Client llmiface.SentimentClassifier
}

// Classify delegates to the underlying SentimentClassifier and normalizes the
// output into the Classification enum. Unknown LLM outputs map to
// ClassUnknown (never an error).
func (c *LLMClassifier) Classify(ctx context.Context, replyText string) (Classification, error) {
	if len(replyText) == 0 {
		return ClassUnknown, ErrEmptyReply
	}
	if c == nil || c.Client == nil {
		return ClassUnknown, errors.New("reply: nil classifier or client")
	}
	raw, err := c.Client.ClassifySentiment(ctx, replyText)
	if err != nil {
		// Bubble up transport errors — caller decides whether to retry.
		return ClassUnknown, err
	}
	return Normalize(raw), nil
}

// Normalize maps an arbitrary string to the Classification enum.
// Returns ClassUnknown for anything outside ValidClasses.
// Safe to call with trimmed/cased input.
func Normalize(raw string) Classification {
	c := Classification(raw)
	if ValidClasses[c] {
		return c
	}
	return ClassUnknown
}
