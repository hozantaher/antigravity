package audit

import (
	"context"
	"sync"
	"time"

	"privacy-gateway/internal/model"
)

type MemoryStore struct {
	mu       sync.RWMutex
	byTenant map[string][]model.AuditEvent
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		byTenant: make(map[string][]model.AuditEvent),
	}
}

func (s *MemoryStore) Append(_ context.Context, event model.AuditEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	next := cloneEvents(s.byTenant[event.TenantID])
	next = append(next, cloneEvent(event))
	s.byTenant[event.TenantID] = next
	return nil
}

func (s *MemoryStore) ListByTenant(_ context.Context, tenantID string) ([]model.AuditEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return cloneEvents(s.byTenant[tenantID]), nil
}

func (s *MemoryStore) PruneBefore(_ context.Context, cutoff time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	nextByTenant := make(map[string][]model.AuditEvent, len(s.byTenant))
	for tenantID, events := range s.byTenant {
		filtered := make([]model.AuditEvent, 0, len(events))
		for _, event := range events {
			if event.CreatedAt.Before(cutoff) {
				continue
			}
			filtered = append(filtered, cloneEvent(event))
		}
		if len(filtered) > 0 {
			nextByTenant[tenantID] = filtered
		}
	}
	s.byTenant = nextByTenant
	return nil
}

func cloneEvents(events []model.AuditEvent) []model.AuditEvent {
	out := make([]model.AuditEvent, 0, len(events))
	for _, event := range events {
		out = append(out, cloneEvent(event))
	}
	return out
}

func cloneEvent(event model.AuditEvent) model.AuditEvent {
	cloned := event
	cloned.Metadata = cloneMetadata(event.Metadata)
	return cloned
}
