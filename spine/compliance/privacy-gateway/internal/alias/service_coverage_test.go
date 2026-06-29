package alias

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

// TestNewServiceWithRetentionTrimsAndLowersDomain ensures the retention-aware
// constructor normalizes the domain and wires retention duration.
func TestNewServiceWithRetentionTrimsAndLowersDomain(t *testing.T) {
	service := NewServiceWithRetention(NewMemoryRepository(), "  Relay.EXAMPLE  ", 48*time.Hour)
	if service.domain != "relay.example" {
		t.Fatalf("expected normalized domain relay.example, got %q", service.domain)
	}
	if service.retention != 48*time.Hour {
		t.Fatalf("expected retention 48h, got %v", service.retention)
	}
}

// TestServicePruneExpiredDeletesOlderAliases exercises the retention branch of
// pruneExpired.
func TestServicePruneExpiredDeletesOlderAliases(t *testing.T) {
	repo := NewMemoryRepository()
	service := NewServiceWithRetention(repo, "relay.example", time.Hour)

	now := time.Date(2026, time.April, 5, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }

	if err := repo.Save(context.Background(), model.Alias{
		ID:        "al_old",
		UserID:    "u1",
		TenantID:  "t1",
		CreatedAt: now.Add(-2 * time.Hour),
	}); err != nil {
		t.Fatalf("Save(old) error = %v", err)
	}

	// Create a new alias; this will invoke pruneExpired and should remove the old one.
	_, err := service.Create(context.Background(), model.Actor{ID: "u1", TenantID: "t1"}, model.CreateAliasInput{Label: "new"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	// The old alias must have been pruned.
	if _, err := repo.GetByID(context.Background(), "al_old"); !errors.Is(err, ErrAliasNotFound) {
		t.Fatalf("expected old alias to be pruned, got err = %v", err)
	}
}

// TestMemoryRepositoryPruneBeforeRemovesOldRecords covers MemoryRepository.PruneBefore.
func TestMemoryRepositoryPruneBeforeRemovesOldRecords(t *testing.T) {
	repo := NewMemoryRepository()
	old := model.Alias{
		ID:        "al_old",
		UserID:    "u1",
		TenantID:  "t1",
		CreatedAt: time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC),
	}
	recent := model.Alias{
		ID:        "al_new",
		UserID:    "u1",
		TenantID:  "t1",
		CreatedAt: time.Date(2026, time.April, 1, 0, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	if err := repo.Save(context.Background(), recent); err != nil {
		t.Fatal(err)
	}

	cutoff := time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC)
	if err := repo.PruneBefore(context.Background(), cutoff); err != nil {
		t.Fatalf("PruneBefore() error = %v", err)
	}

	remaining, err := repo.ListByOwner(context.Background(), "t1", "u1")
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 {
		t.Fatalf("expected 1 remaining alias, got %d", len(remaining))
	}
	if remaining[0].ID != "al_new" {
		t.Fatalf("expected al_new to survive, got %s", remaining[0].ID)
	}
	if _, err := repo.GetByID(context.Background(), "al_old"); !errors.Is(err, ErrAliasNotFound) {
		t.Fatalf("expected ErrAliasNotFound for pruned alias, got %v", err)
	}
}

// TestGetOwnedReturnsRepoErrors verifies the non-forbidden error path.
func TestGetOwnedReturnsRepoErrors(t *testing.T) {
	service := NewService(NewMemoryRepository(), "relay.example")
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	if _, err := service.GetOwned(context.Background(), actor, "missing"); !errors.Is(err, ErrAliasNotFound) {
		t.Fatalf("expected ErrAliasNotFound, got %v", err)
	}
}

// TestGetOwnedRejectsDifferentTenant verifies the cross-tenant forbidden path.
func TestGetOwnedRejectsDifferentTenant(t *testing.T) {
	service := NewService(NewMemoryRepository(), "relay.example")
	owner := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	otherTenant := model.Actor{ID: "user-1", TenantID: "tenant-2"}

	created, err := service.Create(context.Background(), owner, model.CreateAliasInput{Label: "Support"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if _, err := service.GetOwned(context.Background(), otherTenant, created.ID); !errors.Is(err, ErrAliasForbidden) {
		t.Fatalf("expected ErrAliasForbidden for cross-tenant access, got %v", err)
	}
}

// TestSanitizeLabelEdgeCases exercises sanitizeLabel branches: truncation,
// strip of invalid chars, trimming of dashes.
func TestSanitizeLabelEdgeCases(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"trim spaces", "  Support Team  ", "support-team"},
		{"strip invalid", "ops#@!team", "opsteam"},
		{"trim dashes", "---hello---", "hello"},
		{"truncate long", "abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrst"},
		{"empty becomes blank", "   ", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeLabel(tc.input); got != tc.want {
				t.Fatalf("sanitizeLabel(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

// TestCreateAliasWithDifferentLabelCases verifies ID prefix and email format.
func TestCreateAliasWithDifferentLabelCases(t *testing.T) {
	service := NewService(NewMemoryRepository(), "relay.example")
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}

	created, err := service.Create(context.Background(), actor, model.CreateAliasInput{Label: "Ops"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if !strings.HasPrefix(created.ID, "al_") {
		t.Fatalf("expected id prefix al_, got %q", created.ID)
	}
	if !strings.HasPrefix(created.Email, "ops-") {
		t.Fatalf("expected email label prefix ops-, got %q", created.Email)
	}
	if !strings.HasSuffix(created.Email, "@relay.example") {
		t.Fatalf("expected domain suffix, got %q", created.Email)
	}
}

// TestRandomHexReturnsExpectedLength sanity-checks the helper.
func TestRandomHexReturnsExpectedLength(t *testing.T) {
	out, err := randomHex(4)
	if err != nil {
		t.Fatalf("randomHex() error = %v", err)
	}
	if len(out) != 8 {
		t.Fatalf("expected 8 hex chars, got %d (%q)", len(out), out)
	}
}
