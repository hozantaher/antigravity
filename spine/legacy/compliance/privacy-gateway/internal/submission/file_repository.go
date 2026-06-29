package submission

import (
	"context"
	"sort"
	"sync"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

type FileRepository struct {
	mu    sync.RWMutex
	path  string
	codec filestore.Codec
	items []model.Submission
}

func NewFileRepository(path string) (*FileRepository, error) {
	return NewFileRepositoryWithCodec(path, filestore.DefaultCodec())
}

func NewFileRepositoryWithCodec(path string, codec filestore.Codec) (*FileRepository, error) {
	var items []model.Submission
	if err := filestore.ReadJSONWithCodec(path, &items, codec); err != nil {
		return nil, err
	}

	return &FileRepository{
		path:  path,
		codec: codec,
		items: cloneSubmissions(items),
	}, nil
}

func (r *FileRepository) Save(_ context.Context, submission model.Submission) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := cloneSubmissions(r.items)
	updated := false
	for index, existing := range next {
		if existing.ID == submission.ID {
			next[index] = cloneSubmission(submission)
			updated = true
			break
		}
	}
	if !updated {
		next = append(next, cloneSubmission(submission))
	}

	sort.SliceStable(next, func(left, right int) bool {
		if next[left].CreatedAt.Equal(next[right].CreatedAt) {
			return next[left].ID < next[right].ID
		}
		return next[left].CreatedAt.Before(next[right].CreatedAt)
	})

	if err := filestore.WriteJSONAtomicWithCodec(r.path, next, r.codec); err != nil {
		return err
	}

	r.items = next
	return nil
}

func (r *FileRepository) GetByID(_ context.Context, id string) (model.Submission, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, submission := range r.items {
		if submission.ID == id {
			return cloneSubmission(submission), nil
		}
	}

	return model.Submission{}, ErrSubmissionNotFound
}

func (r *FileRepository) ListByTenant(_ context.Context, tenantID string) ([]model.Submission, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]model.Submission, 0, len(r.items))
	for _, submission := range r.items {
		if submission.TenantID == tenantID {
			out = append(out, cloneSubmission(submission))
		}
	}
	return out, nil
}

func (r *FileRepository) PruneBefore(_ context.Context, cutoff time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := make([]model.Submission, 0, len(r.items))
	for _, submission := range r.items {
		if shouldPruneSubmission(submission, cutoff) {
			continue
		}
		next = append(next, cloneSubmission(submission))
	}

	if err := filestore.WriteJSONAtomicWithCodec(r.path, next, r.codec); err != nil {
		return err
	}

	r.items = next
	return nil
}

func cloneSubmissions(items []model.Submission) []model.Submission {
	out := make([]model.Submission, 0, len(items))
	for _, item := range items {
		out = append(out, cloneSubmission(item))
	}
	return out
}
