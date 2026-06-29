package audit

import (
	"context"
	"errors"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

var errAudit = errors.New("audit test error")

// ── stubStore with configurable error injection ──

type stubStore struct {
	appendErr     error
	listErr       error
	pruneErr      error
	events        []model.AuditEvent
}

func (s *stubStore) Append(_ context.Context, e model.AuditEvent) error {
	if s.appendErr != nil {
		return s.appendErr
	}
	s.events = append(s.events, e)
	return nil
}

func (s *stubStore) ListByTenant(_ context.Context, tenantID string) ([]model.AuditEvent, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	var out []model.AuditEvent
	for _, e := range s.events {
		if e.TenantID == tenantID {
			out = append(out, e)
		}
	}
	return out, nil
}

func (s *stubStore) PruneBefore(_ context.Context, _ time.Time) error {
	return s.pruneErr
}

// ── Record: store.Append error (line 66-68) ──

func TestRecord_AppendError(t *testing.T) {
	store := &stubStore{appendErr: errAudit}
	svc := NewService(store)
	_, err := svc.Record(context.Background(), "t1", "a1", "test", "r1", nil)
	if err == nil {
		t.Error("expected error from Record when Append fails")
	}
}

// ── Record: pruneExpired error (line 47-49) via retention ──

func TestRecord_PruneError(t *testing.T) {
	store := &stubStore{pruneErr: errAudit}
	svc := NewServiceWithRetention(store, time.Hour) // retention set → pruneExpired runs
	_, err := svc.Record(context.Background(), "t1", "a1", "test", "r1", nil)
	if err == nil {
		t.Error("expected error from Record when pruneExpired fails")
	}
}

// ── ListByTenantFiltered: pruneExpired error (line 77-79) ──

func TestListByTenantFiltered_PruneError(t *testing.T) {
	store := &stubStore{pruneErr: errAudit}
	svc := NewServiceWithRetention(store, time.Hour)
	_, err := svc.ListByTenantFiltered(context.Background(), "t1", ListOptions{})
	if err == nil {
		t.Error("expected error from ListByTenantFiltered when prune fails")
	}
}

// ── ListByTenantFiltered: store.ListByTenant error (line 82-84) ──

func TestListByTenantFiltered_ListError(t *testing.T) {
	store := &stubStore{listErr: errAudit}
	svc := NewService(store)
	_, err := svc.ListByTenantFiltered(context.Background(), "t1", ListOptions{})
	if err == nil {
		t.Error("expected error from ListByTenantFiltered when List fails")
	}
}

// ── matchesSubmissionID (line 124-126): event without submission in metadata ──

func TestMatchesSubmissionID_NoMetadata(t *testing.T) {
	e := model.AuditEvent{Metadata: nil}
	if matchesSubmissionID(e, "sub-1") {
		t.Error("expected false for event with nil metadata")
	}
}

func TestMatchesSubmissionID_WrongID(t *testing.T) {
	e := model.AuditEvent{Metadata: map[string]string{"submission_id": "other"}}
	if matchesSubmissionID(e, "sub-1") {
		t.Error("expected false for wrong submission_id")
	}
}

func TestMatchesSubmissionID_Match(t *testing.T) {
	e := model.AuditEvent{Metadata: map[string]string{"submission_id": "sub-1"}}
	if !matchesSubmissionID(e, "sub-1") {
		t.Error("expected true for matching submission_id")
	}
}

// ── auditID: crypto/rand error is practically impossible; test the happy path ──

func TestAuditID_UniquePerCall(t *testing.T) {
	id1, err := auditID()
	if err != nil {
		t.Fatalf("auditID: %v", err)
	}
	id2, err := auditID()
	if err != nil {
		t.Fatalf("auditID: %v", err)
	}
	if id1 == id2 {
		t.Error("auditID should generate unique IDs")
	}
}
