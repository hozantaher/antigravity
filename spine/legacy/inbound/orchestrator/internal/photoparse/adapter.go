package photoparse

import (
	"context"

	"orchestrator/thread"
)

// Adapter wraps a *Processor so it satisfies thread.PhotoProcessor.
// We keep the wrapper instead of letting *Processor implement the
// interface directly because the photo-pipeline contract should
// remain owned by the photoparse package — adding the thread-typed
// signature on Processor would force test code to import the thread
// package just to construct a fake.
type Adapter struct {
	inner *Processor
}

// NewAdapter wraps a Processor for use with
// (*thread.InboundProcessor).WithPhotoProcessor.
func NewAdapter(p *Processor) *Adapter {
	return &Adapter{inner: p}
}

// IsImage implements thread.PhotoProcessor.
func (a *Adapter) IsImage(ct string) bool {
	if a == nil || a.inner == nil {
		return false
	}
	return a.inner.IsImage(ct)
}

// Process implements thread.PhotoProcessor by translating the
// thread-shaped input into the photoparse-shaped one. The translation
// is a 1:1 field copy — no extra logic.
func (a *Adapter) Process(ctx context.Context, in thread.PhotoInput) (int64, error) {
	if a == nil || a.inner == nil {
		return 0, nil
	}
	return a.inner.Process(ctx, Photo{
		ThreadID:    in.ThreadID,
		MessageID:   in.MessageID,
		Filename:    in.Filename,
		ContentType: in.ContentType,
		Data:        in.Data,
	})
}
