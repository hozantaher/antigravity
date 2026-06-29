package identityvault

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

// TestServiceCreateLinkRejectsInvalidPurpose exercises the invalid-purpose
// branch (non-UTF8 / control chars).
func TestServiceCreateLinkRejectsInvalidPurpose(t *testing.T) {
	service := NewService(NewMemoryRepository())
	actor := model.Actor{ID: "u1", TenantID: "t1"}

	_, err := service.CreateLink(context.Background(), actor, "alias-1", "user@example.com", "has\nnewline", time.Time{})
	if !errors.Is(err, ErrInvalidPurpose) {
		t.Fatalf("expected ErrInvalidPurpose, got %v", err)
	}

	// Non-UTF-8 purpose is also rejected.
	_, err = service.CreateLink(context.Background(), actor, "alias-2", "user@example.com", string([]byte{0xff, 0xfe}), time.Time{})
	if !errors.Is(err, ErrInvalidPurpose) {
		t.Fatalf("expected ErrInvalidPurpose for non-UTF-8, got %v", err)
	}
}

// TestServiceRevokeByAliasIDNotFound exercises the missing-link branch.
func TestServiceRevokeByAliasIDNotFound(t *testing.T) {
	service := NewService(NewMemoryRepository())
	actor := model.Actor{ID: "u1", TenantID: "t1"}

	_, err := service.RevokeByAliasID(context.Background(), actor, "alias-missing")
	if !errors.Is(err, ErrIdentityLinkNotFound) {
		t.Fatalf("expected ErrIdentityLinkNotFound, got %v", err)
	}
}

// TestServiceRevokeByAliasIDExpiredLinkReturnsNotFound covers the
// expired-before-revoke branch.
func TestServiceRevokeByAliasIDExpiredLinkReturnsNotFound(t *testing.T) {
	service := NewService(NewMemoryRepository())
	service.now = func() time.Time { return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC) }
	actor := model.Actor{ID: "u1", TenantID: "t1"}

	if _, err := service.CreateLink(
		context.Background(),
		actor,
		"alias-1",
		"user@example.com",
		"support",
		time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC),
	); err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}

	// Advance time past expiry.
	service.now = func() time.Time { return time.Date(2026, time.April, 3, 14, 0, 0, 0, time.UTC) }

	_, err := service.RevokeByAliasID(context.Background(), actor, "alias-1")
	if !errors.Is(err, ErrIdentityLinkNotFound) {
		t.Fatalf("expected ErrIdentityLinkNotFound for expired link, got %v", err)
	}
}

// TestServiceCreateLinkNormalizesEmail verifies lowercasing of the parsed
// address.
func TestServiceCreateLinkNormalizesEmail(t *testing.T) {
	service := NewService(NewMemoryRepository())
	actor := model.Actor{ID: "u1", TenantID: "t1"}

	link, err := service.CreateLink(context.Background(), actor, "alias-1", "User@Example.COM", "support", time.Time{})
	if err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}
	if link.RealIdentityRef != strings.ToLower("User@Example.COM") {
		t.Fatalf("expected lowercased real_identity_ref, got %q", link.RealIdentityRef)
	}
}

// TestServiceGetByAliasIDNotFoundForMissingAlias covers the
// repo-missing-alias branch.
func TestServiceGetByAliasIDNotFoundForMissingAlias(t *testing.T) {
	service := NewService(NewMemoryRepository())
	_, err := service.GetByAliasID(context.Background(), model.Actor{ID: "u1", TenantID: "t1"}, "nope")
	if !errors.Is(err, ErrIdentityLinkNotFound) {
		t.Fatalf("expected ErrIdentityLinkNotFound, got %v", err)
	}
}
