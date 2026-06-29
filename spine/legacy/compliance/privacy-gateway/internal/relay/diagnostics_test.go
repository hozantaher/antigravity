package relay

import (
	"context"
	"errors"
	"testing"

	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
)

func TestClassifyError(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		wantClass string
		wantDisp  string
	}{
		// Sentinel errors
		{"deadline exceeded", context.DeadlineExceeded, "timeout", "retryable"},
		{"context canceled", context.Canceled, "canceled", "terminal"},

		// Auth
		{"auth failed", errors.New("535 authentication failed"), "auth_failed", "terminal"},
		{"auth config", errors.New("auth credentials incomplete"), "auth_config", "terminal"},

		// TLS
		{"tls handshake", errors.New("tls handshake failed"), "tls_failed", "terminal"},
		{"starttls required", errors.New("STARTTLS required but not supported"), "tls_required", "terminal"},

		// DNS
		{"no such host", errors.New("dial tcp: lookup mail.example.com: no such host"), "dns_failed", "terminal"},
		{"nxdomain", errors.New("NXDOMAIN for mail.example.com"), "dns_failed", "terminal"},
		{"no mx", errors.New("no MX records found"), "dns_failed", "terminal"},
		{"dns lookup", errors.New("dns lookup failed"), "dns_failed", "terminal"},
		{"server misbehaving", errors.New("server misbehaving"), "dns_failed", "terminal"},

		// SMTP 5xx
		{"550 user unknown", errors.New("550 5.1.1 User unknown"), "rejected", "terminal"},
		{"551 forwarding", errors.New("551 User not local"), "rejected", "terminal"},
		{"552 storage", errors.New("552 Exceeded storage"), "rejected", "terminal"},
		{"553 mailbox", errors.New("553 Mailbox name not allowed"), "rejected", "terminal"},
		{"554 transaction", errors.New("554 Transaction failed"), "rejected", "terminal"},

		// SMTP 4xx
		{"421 service", errors.New("421 Service not available"), "deferred", "retryable"},
		{"450 mailbox", errors.New("450 Requested mail action not taken"), "deferred", "retryable"},
		{"451 local error", errors.New("451 local error in processing"), "deferred", "retryable"},
		{"452 storage", errors.New("452 Insufficient system storage"), "deferred", "retryable"},

		// Transport
		{"connection refused", errors.New("dial tcp: connection refused"), "transport_failed", "retryable"},
		{"connection reset", errors.New("read: connection reset by peer"), "transport_failed", "retryable"},
		{"unreachable", errors.New("network is unreachable"), "transport_failed", "retryable"},
		{"temporary", errors.New("temporary failure"), "transport_failed", "retryable"},

		// Config
		{"host required", errors.New("smtp host is required"), "config", "terminal"},

		// Default
		{"unknown", errors.New("something unexpected"), "delivery_failed", "terminal"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			diag := ClassifyError(tc.err)
			if diag.Class != tc.wantClass {
				t.Errorf("class = %q, want %q", diag.Class, tc.wantClass)
			}
			if diag.Disposition != tc.wantDisp {
				t.Errorf("disposition = %q, want %q", diag.Disposition, tc.wantDisp)
			}
			if diag.Reason != tc.err.Error() {
				t.Errorf("reason = %q, want %q", diag.Reason, tc.err.Error())
			}
		})
	}
}

func TestRelayWithDiagnosticsSuccess(t *testing.T) {
	repo := NewMemoryRepository()
	gateway := mail.NewRecordedGateway()
	service := NewServiceWithRepository(gateway, "test-provider", repo)

	msg := model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "test@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Test",
		TextBody: "Body",
	}

	attempt, record, err := service.RelayWithDiagnostics(context.Background(), "sub_1", msg)
	if err != nil {
		t.Fatalf("RelayWithDiagnostics() error = %v", err)
	}
	if attempt.Status != "sent" {
		t.Errorf("status = %q, want sent", attempt.Status)
	}
	if record.Subject != "Test" {
		t.Errorf("record subject = %q, want Test", record.Subject)
	}
}

func TestRelayWithDiagnosticsFailure(t *testing.T) {
	repo := NewMemoryRepository()
	failGw := &failingGatewayDiag{err: errors.New("550 5.1.1 User unknown")}
	service := NewServiceWithRepository(failGw, "test-provider", repo)

	msg := model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "test@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Test",
		TextBody: "Body",
	}

	attempt, _, err := service.RelayWithDiagnostics(context.Background(), "sub_1", msg)
	if err == nil {
		t.Fatal("expected relay error")
	}
	if attempt.Status != "failed" {
		t.Errorf("status = %q, want failed", attempt.Status)
	}
	if attempt.FailureClass != "rejected" {
		t.Errorf("failure_class = %q, want rejected", attempt.FailureClass)
	}
	if attempt.FailureDisposition != "terminal" {
		t.Errorf("failure_disposition = %q, want terminal", attempt.FailureDisposition)
	}

	// Verify attempt was persisted
	attempts, listErr := repo.ListByTenant(context.Background(), "tenant-1")
	if listErr != nil {
		t.Fatalf("ListByTenant() error = %v", listErr)
	}
	if len(attempts) != 1 {
		t.Fatalf("expected 1 persisted attempt, got %d", len(attempts))
	}
}

type failingGatewayDiag struct {
	err error
}

func (g *failingGatewayDiag) Send(_ context.Context, _ model.SanitizedMessage) (model.MessageRecord, error) {
	return model.MessageRecord{}, g.err
}

func (g *failingGatewayDiag) ListByActor(_ context.Context, _ model.Actor) ([]model.MessageRecord, error) {
	return nil, nil
}
