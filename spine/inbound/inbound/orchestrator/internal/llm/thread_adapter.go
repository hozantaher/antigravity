package llm

import (
	"context"

	"orchestrator/thread"
)

// PreClassifierAdapter bridges *Classifier (this package) to
// thread.ReplyPreClassifier (consumer). The adapter is a thin shim that
// converts the internal Classification struct into the cross-package
// thread.PreClassification value type. The two structs are intentionally
// kept apart so this package stays free of `orchestrator/thread`
// circular-import risk — the thread package never imports `internal/llm`.
type PreClassifierAdapter struct {
	C *Classifier
}

// NewThreadAdapter constructs a thread.ReplyPreClassifier from a built
// *Classifier. Returns nil when c is nil so callers can use a single
// chain with WithReplyPreClassifier(NewThreadAdapter(c)).
func NewThreadAdapter(c *Classifier) thread.ReplyPreClassifier {
	if c == nil {
		return nil
	}
	return &PreClassifierAdapter{C: c}
}

// ClassifyReply satisfies thread.ReplyPreClassifier.
func (a *PreClassifierAdapter) ClassifyReply(ctx context.Context, body string) (thread.PreClassification, error) {
	v, err := a.C.ClassifyReply(ctx, body)
	return thread.PreClassification{
		Intent:     v.Intent,
		Confidence: v.Confidence,
		Reasoning:  v.Reasoning,
		ModelUsed:  v.ModelUsed,
	}, err
}
