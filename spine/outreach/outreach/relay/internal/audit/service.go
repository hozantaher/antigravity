package audit

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Service records minimal audit events.
// Entries contain NO content, NO IPs, NO real identities -- only
// event types, envelope IDs, and bucketed timestamps.
type Service struct {
	mu        sync.RWMutex
	path      string
	codec     filestore.Codec
	entries   []model.AuditEntry
	retention time.Duration
	now       func() time.Time
}

// NewService creates an audit service with retention-based pruning.
func NewService(path string, codec filestore.Codec, retention time.Duration) (*Service, error) {
	s := &Service{
		path:      path,
		codec:     codec,
		retention: retention,
		now:       time.Now,
	}
	if err := filestore.ReadJSON(path, codec, &s.entries); err != nil {
		return nil, err
	}
	return s, nil
}

// Record creates a minimal audit entry.
func (s *Service) Record(ctx context.Context, tenantID, eventType, envelopeID string) error {
	return s.RecordWithOutcome(ctx, tenantID, eventType, envelopeID, "", 0)
}

// RecordWithOutcome creates an audit entry that includes a delivery outcome and HTTP status.
// outcome should be model.OutcomeSuccess or model.OutcomeFailure (empty string for non-delivery events).
// httpStatus should be the downstream HTTP status code (0 for non-HTTP events).
func (s *Service) RecordWithOutcome(ctx context.Context, tenantID, eventType, envelopeID, outcome string, httpStatus int) error {
	id, err := generateAuditID()
	if err != nil {
		return err
	}

	entry := model.AuditEntry{
		ID:         id,
		TenantID:   tenantID,
		EventType:  eventType,
		EnvelopeID: envelopeID,
		BucketedAt: s.now().UTC().Truncate(15 * time.Minute),
		Outcome:    outcome,
		HTTPStatus: httpStatus,
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.entries = append(s.entries, entry)
	return s.persist()
}

// ListByTenant returns audit entries for a tenant.
func (s *Service) ListByTenant(ctx context.Context, tenantID string) ([]model.AuditEntry, error) {
	s.mu.Lock()
	s.pruneExpired()
	s.mu.Unlock()

	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []model.AuditEntry
	for _, e := range s.entries {
		if e.TenantID == tenantID {
			result = append(result, e)
		}
	}
	return result, nil
}

// ListByTenantFiltered returns audit entries matching optional filters.
func (s *Service) ListByTenantFiltered(ctx context.Context, tenantID string, eventType string, limit int) ([]model.AuditEntry, error) {
	s.mu.Lock()
	s.pruneExpired()
	s.mu.Unlock()

	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []model.AuditEntry
	for _, e := range s.entries {
		if e.TenantID != tenantID {
			continue
		}
		if eventType != "" && e.EventType != eventType {
			continue
		}
		result = append(result, e)
		if limit > 0 && len(result) >= limit {
			break
		}
	}
	return result, nil
}

func (s *Service) pruneExpired() {
	if s.retention <= 0 {
		return
	}
	cutoff := s.now().Add(-s.retention)
	kept := s.entries[:0]
	for _, e := range s.entries {
		if e.BucketedAt.After(cutoff) || e.BucketedAt.Equal(cutoff) {
			kept = append(kept, e)
		}
	}
	s.entries = kept
}

func (s *Service) persist() error {
	return filestore.WriteJSONAtomic(s.path, s.codec, s.entries)
}

func generateAuditID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "aud_" + hex.EncodeToString(b), nil
}
