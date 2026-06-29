package compat

import (
	"context"
	"errors"
	"testing"

	"privacy-gateway/internal/audit"
	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
	"privacy-gateway/internal/relay"
	"privacy-gateway/internal/sanitizer"
)

// TestMessagesGatewayWithoutSubmissionsService exercises the compat path that
// has no submissions service configured.
func TestMessagesGatewayWithoutSubmissionsService(t *testing.T) {
	gateway := mail.NewRecordedGateway()
	relayService := relay.NewService(gateway, "record-only")
	auditService := audit.NewService(audit.NewMemoryStore())
	compat := NewMessagesGateway(nil, nil, relayService, auditService)

	actor := model.Actor{ID: "user-a", TenantID: "tenant-a"}
	record, err := compat.Send(context.Background(), model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-x", Email: "support@relay.example"},
		To:       []string{"dest@example.com"},
		Subject:  "No submissions path",
		TextBody: "Body",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if record.Subject != "No submissions path" {
		t.Fatalf("expected subject preserved, got %q", record.Subject)
	}

	events, err := auditService.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 audit events (attempt + compat_relay), got %d", len(events))
	}
	if events[0].EventType != "relay_attempt_created" {
		t.Fatalf("expected relay_attempt_created event, got %s", events[0].EventType)
	}
	if events[1].EventType != "message_compat_relay" {
		t.Fatalf("expected message_compat_relay event, got %s", events[1].EventType)
	}
	if events[1].Metadata["alias_id"] != "alias-x" {
		t.Fatalf("expected alias_id in metadata, got %+v", events[1].Metadata)
	}
}

// TestMessagesGatewayWithoutSubmissionsRelayFailurePath covers the failure
// branch of Send when submissions service is nil.
func TestMessagesGatewayWithoutSubmissionsRelayFailurePath(t *testing.T) {
	relayService := relay.NewService(failingGateway{err: errors.New("dial tcp: connection refused")}, "smtp")
	auditService := audit.NewService(audit.NewMemoryStore())
	compat := NewMessagesGateway(nil, nil, relayService, auditService)

	actor := model.Actor{ID: "user-b", TenantID: "tenant-b"}
	_, err := compat.Send(context.Background(), model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-y", Email: "support@relay.example"},
		To:       []string{"dest@example.com"},
		Subject:  "Fail",
		TextBody: "Body",
	})
	if err == nil {
		t.Fatal("expected relay error")
	}

	events, err := auditService.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 compat audit events, got %d", len(events))
	}
	if events[1].EventType != "message_compat_relay_failed" {
		t.Fatalf("expected message_compat_relay_failed event, got %s", events[1].EventType)
	}
	if events[1].Metadata["relay_failure_class"] != "transport_failed" {
		t.Fatalf("expected transport_failed class, got %+v", events[1].Metadata)
	}
}

// TestMessagesGatewayWithoutAuditService verifies the optional-audit branches
// do not fail when audit is nil.
func TestMessagesGatewayWithoutAuditService(t *testing.T) {
	gateway := mail.NewRecordedGateway()
	relayService := relay.NewService(gateway, "record-only")
	compat := NewMessagesGateway(nil, nil, relayService, nil)

	actor := model.Actor{ID: "user-c", TenantID: "tenant-c"}
	if _, err := compat.Send(context.Background(), model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-z", Email: "support@relay.example"},
		To:       []string{"dest@example.com"},
		Subject:  "No audit",
		TextBody: "Body",
	}); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
}

// TestMessagesGatewayListByActorDelegates ensures the gateway forwards to the
// relay service's ListByActor.
func TestMessagesGatewayListByActorDelegates(t *testing.T) {
	gateway := mail.NewRecordedGateway()
	relayService := relay.NewService(gateway, "record-only")
	compat := NewMessagesGateway(nil, sanitizer.NewService(), relayService, nil)

	actor := model.Actor{ID: "user-list", TenantID: "tenant-list"}
	if _, err := compat.Send(context.Background(), model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-list", Email: "ops@relay.example"},
		To:       []string{"dest@example.com"},
		Subject:  "One",
		TextBody: "Body",
	}); err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	records, err := compat.ListByActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(records))
	}
	if records[0].Subject != "One" {
		t.Fatalf("expected subject One, got %q", records[0].Subject)
	}
}

// TestRelayProviderNameNilService verifies the nil-service branch returns "".
func TestRelayProviderNameNilService(t *testing.T) {
	if got := relayProviderName(nil); got != "" {
		t.Fatalf("expected empty provider name for nil service, got %q", got)
	}
}
