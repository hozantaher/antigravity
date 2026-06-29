package mail

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

func TestPersistentRecordedGatewayPersistsRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox.json")
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	gateway, err := NewPersistentRecordedGateway(path)
	if err != nil {
		t.Fatalf("NewPersistentRecordedGateway() error = %v", err)
	}
	fixedTime := time.Date(2026, time.April, 3, 7, 15, 0, 0, time.UTC)
	gateway.now = func() time.Time {
		return fixedTime
	}

	_, err = gateway.Send(context.Background(), model.SanitizedMessage{
		Actor:    actor,
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"one@example.com"},
		Subject:  "hello",
		TextBody: "body",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	reloaded, err := NewPersistentRecordedGateway(path)
	if err != nil {
		t.Fatalf("reload NewPersistentRecordedGateway() error = %v", err)
	}

	records, err := reloaded.ListByActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 persisted record, got %d", len(records))
	}
	if records[0].CreatedAt != fixedTime.UTC() {
		t.Fatalf("expected persisted UTC timestamp %v, got %v", fixedTime.UTC(), records[0].CreatedAt)
	}
}

func TestPersistentRecordedGatewayRejectsInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	if _, err := NewPersistentRecordedGateway(path); err == nil {
		t.Fatal("expected invalid JSON error")
	}
}

func TestPersistentRecordedGatewaySendReturnsPersistenceError(t *testing.T) {
	parentPath := filepath.Join(t.TempDir(), "parent")
	if err := os.WriteFile(parentPath, []byte("not-a-dir"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	gateway := &RecordedGateway{path: filepath.Join(parentPath, "outbox.json"), now: time.Now}
	_, err := gateway.Send(context.Background(), model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"one@example.com"},
		Subject:  "hello",
		TextBody: "body",
	})
	if err == nil {
		t.Fatal("expected Send() persistence error")
	}
}

func TestPersistentRecordedGatewayPrunesExpiredRecordsWhenRetentionEnabled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox.json")
	gateway, err := NewPersistentRecordedGatewayWithCodecAndRetention(path, filestore.DefaultCodec(), 24*time.Hour)
	if err != nil {
		t.Fatalf("NewPersistentRecordedGatewayWithCodecAndRetention() error = %v", err)
	}
	now := time.Date(2026, time.April, 5, 18, 0, 0, 0, time.UTC)
	gateway.now = func() time.Time { return now }

	gateway.records = []model.MessageRecord{
		{ID: "msg_old", UserID: "user-1", TenantID: "tenant-1", CreatedAt: now.Add(-48 * time.Hour)},
		{ID: "msg_new", UserID: "user-1", TenantID: "tenant-1", CreatedAt: now.Add(-2 * time.Hour)},
	}
	if err := filestore.WriteJSONAtomicWithCodec(path, gateway.records, filestore.DefaultCodec()); err != nil {
		t.Fatalf("WriteJSONAtomicWithCodec() error = %v", err)
	}

	records, err := gateway.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(records) != 1 || records[0].ID != "msg_new" {
		t.Fatalf("expected only retained outbox record, got %+v", records)
	}
}
