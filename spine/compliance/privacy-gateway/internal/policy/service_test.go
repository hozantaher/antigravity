package policy

import (
	"context"
	"errors"
	"testing"

	"privacy-gateway/internal/alias"
	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
)

func TestSubmitRejectsHTMLBody(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliases := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	service := NewService(aliases, gateway, 10, 1024)

	created, err := aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "Support"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	_, err = service.Submit(context.Background(), actor, model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"user@example.com"},
		Subject:  "hello",
		TextBody: "body",
		HTMLBody: "<b>body</b>",
	})
	if err != ErrHTMLNotSupported {
		t.Fatalf("expected ErrHTMLNotSupported, got %v", err)
	}
}

func TestSubmitRecordsMessage(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliases := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	service := NewService(aliases, gateway, 10, 4096)

	created, err := aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "Support"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	record, err := service.Submit(context.Background(), actor, model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"User@example.com", "user@example.com"},
		Subject:  "hello",
		TextBody: "body",
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}

	if len(record.To) != 1 {
		t.Fatalf("expected deduplicated recipients, got %v", record.To)
	}
	if record.Sender != created.Email {
		t.Fatalf("expected sender %s, got %s", created.Email, record.Sender)
	}
}

func TestSubmitRejectsInvalidRecipient(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliases := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	service := NewService(aliases, gateway, 10, 4096)

	created, err := aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "Support"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	_, err = service.Submit(context.Background(), actor, model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"not-an-email"},
		Subject:  "hello",
		TextBody: "body",
	})
	if !errors.Is(err, ErrInvalidRecipient) {
		t.Fatalf("expected ErrInvalidRecipient, got %v", err)
	}
}

func TestSubmitRejectsOversizedMessage(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliases := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	service := NewService(aliases, gateway, 10, 20)

	created, err := aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "Support"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	_, err = service.Submit(context.Background(), actor, model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"user@example.com"},
		Subject:  "hello",
		TextBody: "this body is intentionally too large",
	})
	if err != ErrMessageTooLarge {
		t.Fatalf("expected ErrMessageTooLarge, got %v", err)
	}
}

func TestSubmitRejectsUnknownAlias(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliases := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	service := NewService(aliases, gateway, 10, 4096)

	_, err := service.Submit(context.Background(), actor, model.SendMessageInput{
		AliasID:  "missing",
		To:       []string{"user@example.com"},
		Subject:  "hello",
		TextBody: "body",
	})
	if err != alias.ErrAliasNotFound {
		t.Fatalf("expected ErrAliasNotFound, got %v", err)
	}
}

func TestSubmitRejectsInvalidSubjectEncoding(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliases := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	service := NewService(aliases, gateway, 10, 4096)

	created, err := aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "Support"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	_, err = service.Submit(context.Background(), actor, model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"user@example.com"},
		Subject:  string([]byte{0xff, 'a'}),
		TextBody: "body",
	})
	if err != ErrInvalidSubject {
		t.Fatalf("expected ErrInvalidSubject, got %v", err)
	}
}

func TestSubmitRejectsHeaderInjectionSubject(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliases := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	service := NewService(aliases, gateway, 10, 4096)

	created, err := aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "Support"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	_, err = service.Submit(context.Background(), actor, model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"user@example.com"},
		Subject:  "hello\r\nBCC: victim@example.com",
		TextBody: "body",
	})
	if err != ErrInvalidSubject {
		t.Fatalf("expected ErrInvalidSubject, got %v", err)
	}
}
