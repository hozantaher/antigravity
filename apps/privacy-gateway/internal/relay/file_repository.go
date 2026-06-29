package relay

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
	items []model.RelayAttempt
}

func NewFileRepository(path string) (*FileRepository, error) {
	return NewFileRepositoryWithCodec(path, filestore.DefaultCodec())
}

func NewFileRepositoryWithCodec(path string, codec filestore.Codec) (*FileRepository, error) {
	var items []model.RelayAttempt
	if err := filestore.ReadJSONWithCodec(path, &items, codec); err != nil {
		return nil, err
	}

	sortRelayAttempts(items)

	return &FileRepository{
		path:  path,
		codec: codec,
		items: cloneRelayAttempts(items),
	}, nil
}

func (r *FileRepository) Save(_ context.Context, attempt model.RelayAttempt) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := cloneRelayAttempts(r.items)
	updated := false
	for index, existing := range next {
		if existing.ID == attempt.ID {
			next[index] = cloneRelayAttempt(attempt)
			updated = true
			break
		}
	}
	if !updated {
		next = append(next, cloneRelayAttempt(attempt))
	}

	sortRelayAttempts(next)
	if err := filestore.WriteJSONAtomicWithCodec(r.path, next, r.codec); err != nil {
		return err
	}

	r.items = next
	return nil
}

func (r *FileRepository) GetByID(_ context.Context, id string) (model.RelayAttempt, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, attempt := range r.items {
		if attempt.ID == id {
			return cloneRelayAttempt(attempt), nil
		}
	}
	return model.RelayAttempt{}, ErrRelayAttemptNotFound
}

func (r *FileRepository) ListByTenant(_ context.Context, tenantID string) ([]model.RelayAttempt, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]model.RelayAttempt, 0, len(r.items))
	for _, attempt := range r.items {
		if attempt.TenantID == tenantID {
			out = append(out, cloneRelayAttempt(attempt))
		}
	}
	return out, nil
}

func (r *FileRepository) PruneBefore(_ context.Context, cutoff time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := make([]model.RelayAttempt, 0, len(r.items))
	for _, attempt := range r.items {
		if attempt.CreatedAt.Before(cutoff) {
			continue
		}
		next = append(next, cloneRelayAttempt(attempt))
	}

	if err := filestore.WriteJSONAtomicWithCodec(r.path, next, r.codec); err != nil {
		return err
	}

	r.items = next
	return nil
}

func cloneRelayAttempts(items []model.RelayAttempt) []model.RelayAttempt {
	out := make([]model.RelayAttempt, 0, len(items))
	for _, item := range items {
		out = append(out, cloneRelayAttempt(item))
	}
	return out
}

func sortRelayAttempts(items []model.RelayAttempt) {
	sort.SliceStable(items, func(left, right int) bool {
		if items[left].CreatedAt.Equal(items[right].CreatedAt) {
			return items[left].ID < items[right].ID
		}
		return items[left].CreatedAt.Before(items[right].CreatedAt)
	})
}
