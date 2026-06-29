package identityvault

import (
	"context"
	"errors"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

func TestServiceCreateLinkStoresLink(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}

	link, err := service.CreateLink(context.Background(), model.Actor{
		ID:       "user-1",
		TenantID: "tenant-1",
	}, "alias-1", "user@example.com", "support", time.Time{})
	if err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}
	if link.ID == "" {
		t.Fatal("expected link id")
	}
	if link.AliasID != "alias-1" {
		t.Fatalf("expected alias-1, got %s", link.AliasID)
	}
	if link.CreatedAt != time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC) {
		t.Fatalf("unexpected created_at %v", link.CreatedAt)
	}
	if link.RealIdentityRef != "user@example.com" {
		t.Fatalf("expected normalized real identity ref, got %s", link.RealIdentityRef)
	}
}

func TestServiceCreateLinkRejectsMissingAliasID(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.CreateLink(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, "", "user@example.com", "support", time.Time{})
	if !errors.Is(err, ErrAliasIDRequired) {
		t.Fatalf("expected ErrAliasIDRequired, got %v", err)
	}
}

func TestServiceCreateLinkRejectsMissingRealIdentityRef(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.CreateLink(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, "alias-1", "", "support", time.Time{})
	if !errors.Is(err, ErrRealIdentityRefRequired) {
		t.Fatalf("expected ErrRealIdentityRefRequired, got %v", err)
	}
}

func TestServiceCreateLinkRejectsInvalidRealIdentityRef(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	_, err := service.CreateLink(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}, "alias-1", "not-an-email", "support", time.Time{})
	if !errors.Is(err, ErrInvalidRealIdentityRef) {
		t.Fatalf("expected ErrInvalidRealIdentityRef, got %v", err)
	}
}

func TestServiceCreateLinkRejectsPastExpiry(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}

	_, err := service.CreateLink(
		context.Background(),
		model.Actor{ID: "user-1", TenantID: "tenant-1"},
		"alias-1",
		"user@example.com",
		"support",
		time.Date(2026, time.April, 3, 11, 0, 0, 0, time.UTC),
	)
	if !errors.Is(err, ErrExpiresAtInPast) {
		t.Fatalf("expected ErrExpiresAtInPast, got %v", err)
	}
}

func TestServiceGetByAliasIDReturnsStoredLink(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.CreateLink(context.Background(), actor, "alias-1", "user@example.com", "support", time.Time{})
	if err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}

	stored, err := service.GetByAliasID(context.Background(), actor, "alias-1")
	if err != nil {
		t.Fatalf("GetByAliasID() error = %v", err)
	}
	if stored.ID != created.ID {
		t.Fatalf("expected %s, got %s", created.ID, stored.ID)
	}
}

func TestServiceListForActorReturnsTenantLinks(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)

	actorA := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	actorB := model.Actor{ID: "user-2", TenantID: "tenant-2"}

	if _, err := service.CreateLink(context.Background(), actorA, "alias-1", "user1@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() actorA error = %v", err)
	}
	if _, err := service.CreateLink(context.Background(), actorB, "alias-2", "user2@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() actorB error = %v", err)
	}

	list, err := service.ListForActor(context.Background(), actorA)
	if err != nil {
		t.Fatalf("ListForActor() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 tenant link, got %d", len(list))
	}
	if list[0].TenantID != "tenant-1" {
		t.Fatalf("expected tenant-1, got %s", list[0].TenantID)
	}
}

func TestServiceGetByAliasIDReturnsNotFoundForExpiredLink(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.CreateLink(
		context.Background(),
		actor,
		"alias-1",
		"user@example.com",
		"support",
		time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected created link id")
	}

	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 14, 0, 0, 0, time.UTC)
	}

	_, err = service.GetByAliasID(context.Background(), actor, "alias-1")
	if !errors.Is(err, ErrIdentityLinkNotFound) {
		t.Fatalf("expected ErrIdentityLinkNotFound, got %v", err)
	}
}

func TestServiceListForActorExcludesExpiredLinks(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}

	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if _, err := service.CreateLink(
		context.Background(),
		actor,
		"alias-active",
		"active@example.com",
		"support",
		time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC),
	); err != nil {
		t.Fatalf("CreateLink() active error = %v", err)
	}

	if _, err := service.CreateLink(
		context.Background(),
		actor,
		"alias-expiring",
		"expired@example.com",
		"support",
		time.Date(2026, time.April, 3, 12, 30, 0, 0, time.UTC),
	); err != nil {
		t.Fatalf("CreateLink() expiring error = %v", err)
	}

	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 45, 0, 0, time.UTC)
	}

	list, err := service.ListForActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListForActor() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 non-expired link, got %d", len(list))
	}
	if list[0].AliasID != "alias-active" {
		t.Fatalf("expected alias-active, got %s", list[0].AliasID)
	}
}

func TestServiceRevokeByAliasIDStoresRevokedAt(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if _, err := service.CreateLink(context.Background(), actor, "alias-1", "user@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}

	service.now = func() time.Time {
		return time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC)
	}

	revoked, err := service.RevokeByAliasID(context.Background(), actor, "alias-1")
	if err != nil {
		t.Fatalf("RevokeByAliasID() error = %v", err)
	}
	if revoked.RevokedAt.IsZero() {
		t.Fatal("expected revoked_at to be set")
	}
	if !revoked.RevokedAt.Equal(time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC)) {
		t.Fatalf("unexpected revoked_at %v", revoked.RevokedAt)
	}
}

func TestServiceGetByAliasIDReturnsNotFoundForRevokedLink(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if _, err := service.CreateLink(context.Background(), actor, "alias-1", "user@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}
	if _, err := service.RevokeByAliasID(context.Background(), actor, "alias-1"); err != nil {
		t.Fatalf("RevokeByAliasID() error = %v", err)
	}

	_, err := service.GetByAliasID(context.Background(), actor, "alias-1")
	if !errors.Is(err, ErrIdentityLinkNotFound) {
		t.Fatalf("expected ErrIdentityLinkNotFound, got %v", err)
	}
}

func TestServiceListForActorExcludesRevokedLinks(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if _, err := service.CreateLink(context.Background(), actor, "alias-active", "active@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() active error = %v", err)
	}
	if _, err := service.CreateLink(context.Background(), actor, "alias-revoked", "revoked@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() revoked error = %v", err)
	}
	if _, err := service.RevokeByAliasID(context.Background(), actor, "alias-revoked"); err != nil {
		t.Fatalf("RevokeByAliasID() error = %v", err)
	}

	list, err := service.ListForActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListForActor() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 active link, got %d", len(list))
	}
	if list[0].AliasID != "alias-active" {
		t.Fatalf("expected alias-active, got %s", list[0].AliasID)
	}
}

func TestServiceRevokeByAliasIDRejectsAlreadyRevokedLink(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewService(repo)
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if _, err := service.CreateLink(context.Background(), actor, "alias-1", "user@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}
	if _, err := service.RevokeByAliasID(context.Background(), actor, "alias-1"); err != nil {
		t.Fatalf("RevokeByAliasID() first error = %v", err)
	}

	_, err := service.RevokeByAliasID(context.Background(), actor, "alias-1")
	if !errors.Is(err, ErrIdentityLinkRevoked) {
		t.Fatalf("expected ErrIdentityLinkRevoked, got %v", err)
	}
}

func TestServiceListForActorPrunesInactiveLinksPastRetention(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewServiceWithRetention(repo, 24*time.Hour)
	service.now = func() time.Time {
		return time.Date(2026, time.April, 5, 12, 0, 0, 0, time.UTC)
	}

	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if err := repo.Save(context.Background(), model.IdentityLink{
		ID:              "idl_expired_old",
		TenantID:        actor.TenantID,
		AliasID:         "alias-expired-old",
		RealIdentityRef: "expired-old@example.com",
		CreatedAt:       time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC),
		ExpiresAt:       time.Date(2026, time.April, 3, 11, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() expired-old error = %v", err)
	}
	if err := repo.Save(context.Background(), model.IdentityLink{
		ID:              "idl_revoked_old",
		TenantID:        actor.TenantID,
		AliasID:         "alias-revoked-old",
		RealIdentityRef: "revoked-old@example.com",
		CreatedAt:       time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC),
		RevokedAt:       time.Date(2026, time.April, 3, 10, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() revoked-old error = %v", err)
	}
	if err := repo.Save(context.Background(), model.IdentityLink{
		ID:              "idl_active",
		TenantID:        actor.TenantID,
		AliasID:         "alias-active",
		RealIdentityRef: "active@example.com",
		CreatedAt:       time.Date(2026, time.April, 5, 10, 0, 0, 0, time.UTC),
		ExpiresAt:       time.Date(2026, time.April, 6, 10, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() active error = %v", err)
	}

	list, err := service.ListForActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListForActor() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 active link after prune, got %d", len(list))
	}
	if list[0].AliasID != "alias-active" {
		t.Fatalf("expected alias-active, got %s", list[0].AliasID)
	}

	stored, err := repo.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("expected 1 physically retained link, got %d", len(stored))
	}
	if stored[0].AliasID != "alias-active" {
		t.Fatalf("expected physically retained alias-active, got %s", stored[0].AliasID)
	}
}
