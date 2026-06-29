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
	"privacy-gateway/internal/submission"
)

func TestMessagesGatewayCreatesSubmissionAndAuditBeforeRelay(t *testing.T) {
	submissions := submission.NewService(submission.NewMemoryRepository())
	sanitize := sanitizer.NewService()
	relayService := relay.NewService(mail.NewRecordedGateway(), "record-only")
	auditService := audit.NewService(audit.NewMemoryStore())
	gateway := NewMessagesGateway(submissions, sanitize, relayService, auditService)

	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	record, err := gateway.Send(context.Background(), model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Body",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if record.Subject != "Hello" {
		t.Fatalf("expected relayed record subject Hello, got %s", record.Subject)
	}

	storedSubmissions, err := submissions.ListForActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListForActor() submissions error = %v", err)
	}
	if len(storedSubmissions) != 1 {
		t.Fatalf("expected 1 submission, got %d", len(storedSubmissions))
	}
	if storedSubmissions[0].ChannelID != "alias-1" {
		t.Fatalf("expected alias-backed channel, got %s", storedSubmissions[0].ChannelID)
	}
	if storedSubmissions[0].Status != model.SubmissionStatusRelayed {
		t.Fatalf("expected relayed submission status, got %s", storedSubmissions[0].Status)
	}
	if storedSubmissions[0].RelayProvider != "record-only" {
		t.Fatalf("expected record-only relay provider, got %s", storedSubmissions[0].RelayProvider)
	}
	if storedSubmissions[0].RelayAttemptID == "" {
		t.Fatal("expected relay attempt id to be recorded")
	}
	if storedSubmissions[0].SourcePath != "messages_compat" {
		t.Fatalf("expected source path messages_compat, got %s", storedSubmissions[0].SourcePath)
	}

	events, err := auditService.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() audit error = %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 audit events, got %d", len(events))
	}
	if events[0].EventType != "relay_attempt_created" {
		t.Fatalf("expected relay_attempt_created event, got %s", events[0].EventType)
	}
	if events[0].ResourceID == "" {
		t.Fatal("expected relay attempt audit resource id")
	}
	if events[1].EventType != "message_compat_relay" {
		t.Fatalf("expected message_compat_relay event, got %s", events[1].EventType)
	}
}

func TestMessagesGatewayMarksSubmissionFailedWhenRelayFails(t *testing.T) {
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), audit.NewService(audit.NewMemoryStore()))
	relayService := relay.NewService(failingGateway{err: errors.New("smtp dial failed")}, "smtp")
	auditService := audit.NewService(audit.NewMemoryStore())
	gateway := NewMessagesGateway(submissions, sanitizer.NewService(), relayService, auditService)

	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	_, err := gateway.Send(context.Background(), model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Body",
	})
	if err == nil {
		t.Fatal("expected relay error")
	}

	storedSubmissions, err := submissions.ListForActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListForActor() submissions error = %v", err)
	}
	if len(storedSubmissions) != 1 {
		t.Fatalf("expected 1 submission, got %d", len(storedSubmissions))
	}
	if storedSubmissions[0].Status != model.SubmissionStatusFailed {
		t.Fatalf("expected failed submission status, got %s", storedSubmissions[0].Status)
	}
	if storedSubmissions[0].RelayProvider != "smtp" {
		t.Fatalf("expected smtp relay provider, got %s", storedSubmissions[0].RelayProvider)
	}
	if storedSubmissions[0].RelayFailureClass != "delivery_failed" {
		t.Fatalf("expected delivery_failed failure class, got %s", storedSubmissions[0].RelayFailureClass)
	}
	if storedSubmissions[0].RelayFailureDisposition != "terminal" {
		t.Fatalf("expected terminal failure disposition, got %s", storedSubmissions[0].RelayFailureDisposition)
	}
	if storedSubmissions[0].SourcePath != "messages_compat" {
		t.Fatalf("expected source path messages_compat, got %s", storedSubmissions[0].SourcePath)
	}

	events, err := auditService.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() audit error = %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 compat audit events, got %d", len(events))
	}
	if events[0].EventType != "relay_attempt_created" {
		t.Fatalf("expected relay_attempt_created event, got %s", events[0].EventType)
	}
	if events[0].Metadata["failure_disposition"] != "terminal" {
		t.Fatalf("expected terminal failure disposition in relay-attempt audit, got %+v", events[0].Metadata)
	}
	if events[1].EventType != "message_compat_relay_failed" {
		t.Fatalf("expected message_compat_relay_failed event, got %s", events[1].EventType)
	}
	if events[1].Metadata["relay_failure_disposition"] != "terminal" {
		t.Fatalf("expected terminal relay failure disposition in audit, got %+v", events[1].Metadata)
	}
}

func TestClassifyRelayFailure(t *testing.T) {
	cases := []struct {
		name        string
		err         error
		wantClass   string
		wantDisp    string
	}{
		// Sentinel errors
		{"deadline exceeded", context.DeadlineExceeded, "timeout", "retryable"},
		{"context canceled", context.Canceled, "canceled", "terminal"},
		{"starttls required", mail.ErrSMTPSTARTTLSRequired, "tls_required", "terminal"},
		{"host required", mail.ErrSMTPHostRequired, "config", "terminal"},
		{"credentials incomplete", mail.ErrSMTPCredentialsIncomplete, "auth_config", "terminal"},

		// Auth string match
		{"auth failed string", errors.New("535 authentication failed"), "auth_failed", "terminal"},
		{"auth error lowercase", errors.New("AUTH mechanism not supported"), "auth_failed", "terminal"},

		// TLS string match
		{"tls handshake", errors.New("tls handshake failed"), "tls_failed", "terminal"},

		// DNS failures
		{"no such host", errors.New("dial tcp: lookup mail.example.com: no such host"), "dns_failed", "terminal"},
		{"nxdomain", errors.New("NXDOMAIN for mail.example.com"), "dns_failed", "terminal"},
		{"no mx records", errors.New("no MX records found for domain"), "dns_failed", "terminal"},
		{"dns lookup fail", errors.New("dns lookup failed"), "dns_failed", "terminal"},
		{"server misbehaving", errors.New("server misbehaving"), "dns_failed", "terminal"},

		// SMTP permanent rejection (5xx)
		{"550 user unknown", errors.New("550 5.1.1 User unknown"), "rejected", "terminal"},
		{"551 forwarding", errors.New("551 User not local"), "rejected", "terminal"},
		{"552 exceeded storage", errors.New("552 Exceeded storage allocation"), "rejected", "terminal"},
		{"553 mailbox syntax", errors.New("553 Mailbox name not allowed"), "rejected", "terminal"},
		{"554 transaction failed", errors.New("554 Transaction failed"), "rejected", "terminal"},

		// SMTP temporary failures (4xx)
		{"421 service unavailable", errors.New("421 Service not available"), "deferred", "retryable"},
		{"450 mailbox unavailable", errors.New("450 Requested mail action not taken"), "deferred", "retryable"},
		{"451 local error", errors.New("451 Requested action aborted: local error"), "deferred", "retryable"},
		{"452 insufficient storage", errors.New("452 Insufficient system storage"), "deferred", "retryable"},

		// Transport failures
		{"connection refused", errors.New("dial tcp 1.2.3.4:25: connection refused"), "transport_failed", "retryable"},
		{"connection reset", errors.New("read: connection reset by peer"), "transport_failed", "retryable"},
		{"host unreachable", errors.New("connect: network is unreachable"), "transport_failed", "retryable"},
		{"dial tcp generic", errors.New("dial tcp failed"), "transport_failed", "retryable"},
		{"temporary error", errors.New("temporary failure"), "transport_failed", "retryable"},

		// Unknown / default
		{"unknown error", errors.New("something unexpected"), "delivery_failed", "terminal"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			class, disposition := ClassifyRelayFailure(tc.err)
			if class != tc.wantClass {
				t.Errorf("class = %q, want %q", class, tc.wantClass)
			}
			if disposition != tc.wantDisp {
				t.Errorf("disposition = %q, want %q", disposition, tc.wantDisp)
			}
		})
	}
}

type failingGateway struct {
	err error
}

func (g failingGateway) Send(_ context.Context, _ model.SanitizedMessage) (model.MessageRecord, error) {
	return model.MessageRecord{}, g.err
}

func (g failingGateway) ListByActor(_ context.Context, _ model.Actor) ([]model.MessageRecord, error) {
	return nil, nil
}
