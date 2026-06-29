package identityvault

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

func TestFileRepositoryPersistsIdentityLinks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity-links.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	link := model.IdentityLink{
		ID:              "idl_1",
		TenantID:        "tenant-1",
		AliasID:         "alias-1",
		RealIdentityRef: "user@example.com",
		Purpose:         "support",
		CreatedAt:       time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), link); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	reloaded, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("reloaded NewFileRepository() error = %v", err)
	}

	stored, err := reloaded.GetByAliasID(context.Background(), "tenant-1", "alias-1")
	if err != nil {
		t.Fatalf("GetByAliasID() error = %v", err)
	}
	if stored.ID != "idl_1" {
		t.Fatalf("expected idl_1, got %s", stored.ID)
	}
}

func TestFileRepositoryListsByTenant(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity-links.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	if err := repo.Save(context.Background(), model.IdentityLink{
		ID:        "idl_1",
		TenantID:  "tenant-1",
		AliasID:   "alias-1",
		CreatedAt: time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() tenant-1 error = %v", err)
	}
	if err := repo.Save(context.Background(), model.IdentityLink{
		ID:        "idl_2",
		TenantID:  "tenant-2",
		AliasID:   "alias-2",
		CreatedAt: time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() tenant-2 error = %v", err)
	}

	links, err := repo.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(links) != 1 {
		t.Fatalf("expected 1 tenant link, got %d", len(links))
	}
}

func TestFileRepositoryPruneInactiveBeforePersistsTrimmedLinks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity-links.json")
	repo, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("NewFileRepository() error = %v", err)
	}

	for _, link := range []model.IdentityLink{
		{
			ID:              "idl_expired_old",
			TenantID:        "tenant-1",
			AliasID:         "alias-expired-old",
			RealIdentityRef: "expired-old@example.com",
			CreatedAt:       time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC),
			ExpiresAt:       time.Date(2026, time.April, 2, 12, 0, 0, 0, time.UTC),
		},
		{
			ID:              "idl_active",
			TenantID:        "tenant-1",
			AliasID:         "alias-active",
			RealIdentityRef: "active@example.com",
			CreatedAt:       time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC),
			ExpiresAt:       time.Date(2026, time.April, 6, 12, 0, 0, 0, time.UTC),
		},
	} {
		if err := repo.Save(context.Background(), link); err != nil {
			t.Fatalf("Save() error = %v", err)
		}
	}

	if err := repo.PruneInactiveBefore(context.Background(), time.Date(2026, time.April, 4, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("PruneInactiveBefore() error = %v", err)
	}

	reloaded, err := NewFileRepository(path)
	if err != nil {
		t.Fatalf("reloaded NewFileRepository() error = %v", err)
	}

	links, err := reloaded.ListByTenant(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListByTenant() error = %v", err)
	}
	if len(links) != 1 {
		t.Fatalf("expected 1 retained identity link, got %d", len(links))
	}
	if links[0].AliasID != "alias-active" {
		t.Fatalf("expected alias-active, got %s", links[0].AliasID)
	}
}
