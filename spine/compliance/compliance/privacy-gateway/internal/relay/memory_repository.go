package relay

import (
	"context"
	"errors"
	"sync"
	"time"

	"privacy-gateway/internal/model"
)

var ErrRelayAttemptNotFound = errors.New("relay attempt not found")

type MemoryRepository struct {
	mu    sync.RWMutex
	items map[string]model.RelayAttempt
}

func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{
		items: make(map[string]model.RelayAttempt),
	}
}

func (r *MemoryRepository) Save(_ context.Context, attempt model.RelayAttempt) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.items[attempt.ID] = cloneRelayAttempt(attempt)
	return nil
}

func (r *MemoryRepository) GetByID(_ context.Context, id string) (model.RelayAttempt, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	attempt, ok := r.items[id]
	if !ok {
		return model.RelayAttempt{}, ErrRelayAttemptNotFound
	}
	return cloneRelayAttempt(attempt), nil
}

func (r *MemoryRepository) ListByTenant(_ context.Context, tenantID string) ([]model.RelayAttempt, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]model.RelayAttempt, 0, len(r.items))
	for _, attempt := range r.items {
		if attempt.TenantID == tenantID {
			out = append(out, cloneRelayAttempt(attempt))
		}
	}
	sortRelayAttempts(out)
	return out, nil
}

func (r *MemoryRepository) PruneBefore(_ context.Context, cutoff time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for id, attempt := range r.items {
		if attempt.CreatedAt.Before(cutoff) {
			delete(r.items, id)
		}
	}
	return nil
}

func cloneRelayAttempt(attempt model.RelayAttempt) model.RelayAttempt {
	return attempt
}
