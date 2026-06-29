package audit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"privacy-gateway/internal/model"
)

type Store interface {
	Append(ctx context.Context, event model.AuditEvent) error
	ListByTenant(ctx context.Context, tenantID string) ([]model.AuditEvent, error)
	PruneBefore(ctx context.Context, cutoff time.Time) error
}

type Service struct {
	store     Store
	now       func() time.Time
	retention time.Duration
}

type ListOptions struct {
	EventType    string
	ResourceID   string
	SubmissionID string
	Limit        int
	Since        time.Time
}

func NewService(store Store) *Service {
	return &Service{
		store: store,
		now:   time.Now,
	}
}

func NewServiceWithRetention(store Store, retention time.Duration) *Service {
	service := NewService(store)
	service.retention = retention
	return service
}

func (s *Service) Record(ctx context.Context, tenantID, actorID, eventType, resourceID string, metadata map[string]string) (model.AuditEvent, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return model.AuditEvent{}, err
	}

	id, err := auditID()
	if err != nil {
		return model.AuditEvent{}, err
	}

	event := model.AuditEvent{
		ID:         id,
		TenantID:   tenantID,
		ActorID:    actorID,
		EventType:  eventType,
		ResourceID: resourceID,
		Metadata:   cloneMetadata(metadata),
		CreatedAt:  s.now().UTC(),
	}

	if err := s.store.Append(ctx, event); err != nil {
		return model.AuditEvent{}, err
	}
	return event, nil
}

func (s *Service) ListByTenant(ctx context.Context, tenantID string) ([]model.AuditEvent, error) {
	return s.store.ListByTenant(ctx, tenantID)
}

func (s *Service) ListByTenantFiltered(ctx context.Context, tenantID string, options ListOptions) ([]model.AuditEvent, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return nil, err
	}

	events, err := s.store.ListByTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	eventType := strings.TrimSpace(options.EventType)
	resourceID := strings.TrimSpace(options.ResourceID)
	submissionID := strings.TrimSpace(options.SubmissionID)
	since := options.Since
	if s.retention > 0 {
		retentionCutoff := s.now().UTC().Add(-s.retention)
		if since.IsZero() || since.Before(retentionCutoff) {
			since = retentionCutoff
		}
	}
	filtered := make([]model.AuditEvent, 0, len(events))
	for _, event := range events {
		if eventType != "" && event.EventType != eventType {
			continue
		}
		if resourceID != "" && event.ResourceID != resourceID {
			continue
		}
		if submissionID != "" && !matchesSubmissionID(event, submissionID) {
			continue
		}
		if !since.IsZero() && event.CreatedAt.Before(since) {
			continue
		}
		filtered = append(filtered, event)
	}

	if options.Limit > 0 && len(filtered) > options.Limit {
		filtered = filtered[:options.Limit]
	}

	return filtered, nil
}

func matchesSubmissionID(event model.AuditEvent, submissionID string) bool {
	if event.ResourceID == submissionID {
		return true
	}
	if event.Metadata == nil {
		return false
	}
	return strings.TrimSpace(event.Metadata["submission_id"]) == submissionID
}

func (s *Service) pruneExpired(ctx context.Context) error {
	if s.retention <= 0 {
		return nil
	}
	return s.store.PruneBefore(ctx, s.now().UTC().Add(-s.retention))
}

func auditID() (string, error) {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "aud_" + hex.EncodeToString(buf), nil
}

func cloneMetadata(metadata map[string]string) map[string]string {
	if len(metadata) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(metadata))
	for key, value := range metadata {
		cloned[key] = value
	}
	return cloned
}
