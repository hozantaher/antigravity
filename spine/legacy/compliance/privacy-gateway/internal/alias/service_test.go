package alias

import (
	"context"
	"strings"
	"testing"

	"privacy-gateway/internal/model"
)

func TestCreateAliasUsesOwnedDomain(t *testing.T) {
	service := NewService(NewMemoryRepository(), "relay.example")
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateAliasInput{Label: "Support Team"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if !strings.HasSuffix(created.Email, "@relay.example") {
		t.Fatalf("expected alias domain relay.example, got %s", created.Email)
	}
	if created.UserID != actor.ID {
		t.Fatalf("expected alias to belong to %s, got %s", actor.ID, created.UserID)
	}
}

func TestGetOwnedRejectsDifferentActor(t *testing.T) {
	service := NewService(NewMemoryRepository(), "relay.example")
	owner := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	other := model.Actor{ID: "user-2", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), owner, model.CreateAliasInput{Label: "Ops"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if _, err := service.GetOwned(context.Background(), other, created.ID); err == nil {
		t.Fatal("expected GetOwned to reject different actor")
	}
}

func TestCreateAliasDefaultsEmptyLabel(t *testing.T) {
	service := NewService(NewMemoryRepository(), "Relay.EXAMPLE")
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateAliasInput{})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if created.Label != "alias" {
		t.Fatalf("expected default label alias, got %s", created.Label)
	}
	if !strings.HasSuffix(created.Email, "@relay.example") {
		t.Fatalf("expected lower-cased domain, got %s", created.Email)
	}
}

func TestListForActorReturnsOnlyOwnedAliases(t *testing.T) {
	service := NewService(NewMemoryRepository(), "relay.example")
	owner := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	other := model.Actor{ID: "user-2", TenantID: "tenant-1"}

	if _, err := service.Create(context.Background(), owner, model.CreateAliasInput{Label: "Support"}); err != nil {
		t.Fatalf("Create() owner error = %v", err)
	}
	if _, err := service.Create(context.Background(), other, model.CreateAliasInput{Label: "Ops"}); err != nil {
		t.Fatalf("Create() other error = %v", err)
	}

	aliases, err := service.ListForActor(context.Background(), owner)
	if err != nil {
		t.Fatalf("ListForActor() error = %v", err)
	}
	if len(aliases) != 1 {
		t.Fatalf("expected 1 alias for owner, got %d", len(aliases))
	}
	if aliases[0].UserID != owner.ID {
		t.Fatalf("expected alias for owner %s, got %s", owner.ID, aliases[0].UserID)
	}
}
