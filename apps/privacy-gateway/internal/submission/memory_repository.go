package submission

import (
	"context"
	"errors"
	"sync"
	"time"

	"privacy-gateway/internal/model"
)

var ErrSubmissionNotFound = errors.New("submission not found")

type MemoryRepository struct {
	mu       sync.RWMutex
	byID     map[string]model.Submission
	byTenant map[string][]string
}

func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{
		byID:     make(map[string]model.Submission),
		byTenant: make(map[string][]string),
	}
}

func (r *MemoryRepository) Save(_ context.Context, submission model.Submission) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.byID[submission.ID]; !exists {
		r.byTenant[submission.TenantID] = append(r.byTenant[submission.TenantID], submission.ID)
	}
	r.byID[submission.ID] = cloneSubmission(submission)
	return nil
}

func (r *MemoryRepository) GetByID(_ context.Context, id string) (model.Submission, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	submission, ok := r.byID[id]
	if !ok {
		return model.Submission{}, ErrSubmissionNotFound
	}
	return cloneSubmission(submission), nil
}

func (r *MemoryRepository) ListByTenant(_ context.Context, tenantID string) ([]model.Submission, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	ids := r.byTenant[tenantID]
	out := make([]model.Submission, 0, len(ids))
	for _, id := range ids {
		out = append(out, cloneSubmission(r.byID[id]))
	}
	return out, nil
}

func (r *MemoryRepository) PruneBefore(_ context.Context, cutoff time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	nextByID := make(map[string]model.Submission, len(r.byID))
	nextByTenant := make(map[string][]string, len(r.byTenant))
	for id, submission := range r.byID {
		if shouldPruneSubmission(submission, cutoff) {
			continue
		}
		cloned := cloneSubmission(submission)
		nextByID[id] = cloned
		nextByTenant[submission.TenantID] = append(nextByTenant[submission.TenantID], id)
	}

	r.byID = nextByID
	r.byTenant = nextByTenant
	return nil
}

func cloneSubmission(submission model.Submission) model.Submission {
	cloned := submission
	cloned.To = append([]string(nil), submission.To...)
	cloned.AttachmentsSummary = append([]model.SubmissionAttachmentSummary(nil), submission.AttachmentsSummary...)
	return cloned
}

func shouldPruneSubmission(submission model.Submission, cutoff time.Time) bool {
	switch submission.Status {
	case model.SubmissionStatusRelayed, model.SubmissionStatusFailed, model.SubmissionStatusBlocked:
		return submission.CreatedAt.Before(cutoff)
	default:
		return false
	}
}
