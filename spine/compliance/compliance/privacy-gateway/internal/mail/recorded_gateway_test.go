package mail

import (
	"context"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

func TestRecordedGatewaySendAndListByActor(t *testing.T) {
	gateway := NewRecordedGateway()
	fixedTime := time.Date(2026, time.April, 2, 11, 30, 0, 0, time.FixedZone("UTC+2", 2*60*60))
	gateway.now = func() time.Time {
		return fixedTime
	}

	message := model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"one@example.com", "two@example.com"},
		Subject:  "hello",
		TextBody: "safe body",
	}

	record, err := gateway.Send(context.Background(), message)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	message.To[0] = "changed@example.com"

	if record.ID == "" {
		t.Fatal("expected message record ID to be set")
	}
	if record.CreatedAt != fixedTime.UTC() {
		t.Fatalf("expected UTC timestamp %v, got %v", fixedTime.UTC(), record.CreatedAt)
	}
	if record.To[0] != "one@example.com" {
		t.Fatalf("expected Send() to copy recipients, got %v", record.To)
	}

	_, err = gateway.Send(context.Background(), model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-2", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-2", Email: "ops@relay.example"},
		To:       []string{"three@example.com"},
		Subject:  "other",
		TextBody: "body",
	})
	if err != nil {
		t.Fatalf("second Send() error = %v", err)
	}

	records, err := gateway.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record for user-1, got %d", len(records))
	}
	if records[0].UserID != "user-1" {
		t.Fatalf("expected filtered record for user-1, got %s", records[0].UserID)
	}
}
