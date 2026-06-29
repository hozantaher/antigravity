package audit

import (
	"context"
	"testing"
	"time"
)

func TestServiceRecordAppendsAuditEvent(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}

	event, err := service.Record(context.Background(), "tenant-1", "user-1", "vault_lookup", "alias-1", map[string]string{
		"reason": "support",
	})
	if err != nil {
		t.Fatalf("Record() error = %v", err)
	}

	if event.ID == "" {
		t.Fatal("expected event id")
	}
	if event.CreatedAt != time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC) {
		t.Fatalf("unexpected created_at %v", event.CreatedAt)
	}
	if event.Metadata["reason"] != "support" {
		t.Fatalf("expected metadata reason=support, got %+v", event.Metadata)
	}
}

func TestServiceListByTenantReturnsTenantEvents(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store)

	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "vault_lookup", "alias-1", nil); err != nil {
		t.Fatalf("Record() tenant-1 error = %v", err)
	}
	if _, err := service.Record(context.Background(), "tenant-2", "user-2", "relay_send", "sub-1", nil); err != nil {
		t.Fatalf("Record() tenant-2 error = %v", err)
	}

	events, err := service.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 tenant event, got %d", len(events))
	}
	if events[0].TenantID != "tenant-1" {
		t.Fatalf("expected tenant-1 event, got %s", events[0].TenantID)
	}
}

func TestServiceListByTenantFilteredAppliesEventTypeAndLimit(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store)

	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-1", nil); err != nil {
		t.Fatalf("Record() submission_created error = %v", err)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "relay_sent", "rly-1", nil); err != nil {
		t.Fatalf("Record() relay_sent error = %v", err)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-2", nil); err != nil {
		t.Fatalf("Record() second submission_created error = %v", err)
	}

	events, err := service.ListByTenantFiltered(context.Background(), "tenant-1", ListOptions{
		EventType: "submission_created",
		Limit:     1,
	})
	if err != nil {
		t.Fatalf("ListByTenantFiltered() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 filtered event, got %d", len(events))
	}
	if events[0].EventType != "submission_created" {
		t.Fatalf("expected submission_created event, got %s", events[0].EventType)
	}
}

func TestServiceListByTenantFilteredAppliesResourceID(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store)

	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-1", nil); err != nil {
		t.Fatalf("Record() first event error = %v", err)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "identity_link_revoked", "idl-1", nil); err != nil {
		t.Fatalf("Record() second event error = %v", err)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-2", nil); err != nil {
		t.Fatalf("Record() third event error = %v", err)
	}

	events, err := service.ListByTenantFiltered(context.Background(), "tenant-1", ListOptions{
		ResourceID: "idl-1",
	})
	if err != nil {
		t.Fatalf("ListByTenantFiltered() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 resource-filtered event, got %d", len(events))
	}
	if events[0].ResourceID != "idl-1" {
		t.Fatalf("expected resource id idl-1, got %s", events[0].ResourceID)
	}
}

func TestServiceListByTenantFilteredAppliesSubmissionID(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store)

	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-1", nil); err != nil {
		t.Fatalf("Record() first event error = %v", err)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "relay_attempt_created", "rly-1", map[string]string{
		"submission_id": "sub-1",
	}); err != nil {
		t.Fatalf("Record() second event error = %v", err)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "relay_attempt_created", "rly-2", map[string]string{
		"submission_id": "sub-2",
	}); err != nil {
		t.Fatalf("Record() third event error = %v", err)
	}

	events, err := service.ListByTenantFiltered(context.Background(), "tenant-1", ListOptions{
		SubmissionID: "sub-1",
	})
	if err != nil {
		t.Fatalf("ListByTenantFiltered() error = %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 submission-filtered events, got %d", len(events))
	}
	if events[0].ResourceID != "sub-1" {
		t.Fatalf("expected direct submission resource first, got %s", events[0].ResourceID)
	}
	if events[1].Metadata["submission_id"] != "sub-1" {
		t.Fatalf("expected metadata submission_id=sub-1, got %+v", events[1].Metadata)
	}
}

func TestServiceListByTenantFilteredAppliesSince(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store)

	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-1", nil); err != nil {
		t.Fatalf("Record() first event error = %v", err)
	}

	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-2", nil); err != nil {
		t.Fatalf("Record() second event error = %v", err)
	}

	events, err := service.ListByTenantFiltered(context.Background(), "tenant-1", ListOptions{
		Since: time.Date(2026, time.April, 3, 12, 30, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("ListByTenantFiltered() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event after since filter, got %d", len(events))
	}
	if events[0].ResourceID != "sub-2" {
		t.Fatalf("expected sub-2 after since filter, got %s", events[0].ResourceID)
	}
}

func TestServiceListByTenantFilteredAppliesRetentionCutoff(t *testing.T) {
	store := NewMemoryStore()
	service := NewServiceWithRetention(store, 24*time.Hour)

	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-old", nil); err != nil {
		t.Fatalf("Record() old event error = %v", err)
	}

	service.now = func() time.Time {
		return time.Date(2026, time.April, 5, 11, 0, 0, 0, time.UTC)
	}
	if _, err := service.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub-new", nil); err != nil {
		t.Fatalf("Record() new event error = %v", err)
	}

	events, err := service.ListByTenantFiltered(context.Background(), "tenant-1", ListOptions{})
	if err != nil {
		t.Fatalf("ListByTenantFiltered() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 retained event, got %d", len(events))
	}
	if events[0].ResourceID != "sub-new" {
		t.Fatalf("expected retained event sub-new, got %s", events[0].ResourceID)
	}

	storedEvents, err := service.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(storedEvents) != 1 {
		t.Fatalf("expected 1 physically retained event, got %d", len(storedEvents))
	}
	if storedEvents[0].ResourceID != "sub-new" {
		t.Fatalf("expected physically retained event sub-new, got %s", storedEvents[0].ResourceID)
	}
}
