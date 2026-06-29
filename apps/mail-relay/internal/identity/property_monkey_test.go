package identity

import (
	"relay/internal/model"
	"relay/internal/vault"
	"context"
	"encoding/base64"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"testing/quick"
)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func newSvc(t *testing.T) *Service {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 7)
	}
	v, err := vault.NewFileVault(
		filepath.Join(t.TempDir(), "vault.json"),
		base64.StdEncoding.EncodeToString(key),
		0,
	)
	if err != nil {
		t.Fatal(err)
	}
	return NewService(v)
}

// stubVault is a controllable Vault used for error-path / monkey tests.
type stubVault struct {
	registerErr error
	revokeErr   error
}

func (s *stubVault) Register(_ context.Context, tenantID, realIdentityRef, purpose string) (string, error) {
	if s.registerErr != nil {
		return "", s.registerErr
	}
	return "stub-token-" + tenantID, nil
}
func (s *stubVault) Resolve(_ context.Context, _ string) (string, error) { return "", nil }
func (s *stubVault) Revoke(_ context.Context, _ string) error             { return s.revokeErr }
func (s *stubVault) ListByTenant(_ context.Context, _ string) ([]model.AliasMapping, error) {
	return nil, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Property tests
// ─────────────────────────────────────────────────────────────────────────────

// TestIdentity_IssueAlias_NeverPanics_Property sends arbitrary inputs to
// IssueAlias and asserts the function never panics.
func TestIdentity_IssueAlias_NeverPanics_Property(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()

	f := func(tenantID, realIdentity, purpose string) bool {
		defer func() { recover() }()
		_, _ = svc.IssueAlias(ctx, tenantID, realIdentity, purpose)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("IssueAlias panicked: %v", err)
	}
}

// TestIdentity_RevokeAlias_NeverPanics_Property sends arbitrary alias tokens to
// RevokeAlias and asserts the function never panics.
func TestIdentity_RevokeAlias_NeverPanics_Property(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()

	f := func(token string) bool {
		defer func() { recover() }()
		_ = svc.RevokeAlias(ctx, token)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("RevokeAlias panicked: %v", err)
	}
}

// TestIdentity_IssueAlias_TokensUnique_Property verifies that issuing two aliases
// for distinct real identities always yields distinct tokens.
func TestIdentity_IssueAlias_TokensUnique_Property(t *testing.T) {
	ctx := context.Background()

	f := func(a, b string) bool {
		if a == b {
			return true // trivially true — same input may collide
		}
		defer func() { recover() }()
		svc := newSvc(t) // fresh service per check to avoid state bleed
		t1, err1 := svc.IssueAlias(ctx, "tenant", a, "prop-test")
		t2, err2 := svc.IssueAlias(ctx, "tenant", b, "prop-test")
		if err1 != nil || err2 != nil {
			return true // errors are acceptable for edge-case inputs
		}
		return t1 != t2
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Errorf("IssueAlias returned duplicate tokens: %v", err)
	}
}

// TestIdentity_EmptyAlias_RevokeReturnsError verifies that revoking an empty /
// unknown token surfaces an error rather than silently succeeding.
func TestIdentity_EmptyAlias_RevokeReturnsError(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	if err := svc.RevokeAlias(ctx, ""); err == nil {
		t.Error("expected error when revoking empty alias token, got nil")
	}
}

// TestIdentity_EmptyTenantID_IssueReturnsError asserts that an empty tenantID
// propagates an error from the vault.
func TestIdentity_EmptyTenantID_IssueReturnsError(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	_, err := svc.IssueAlias(ctx, "", "real@example.com", "test")
	if err == nil {
		t.Error("expected error for empty tenantID, got nil")
	}
}

// TestIdentity_EmptyRealIdentity_IssueReturnsError asserts that an empty
// realIdentity propagates an error.
func TestIdentity_EmptyRealIdentity_IssueReturnsError(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	_, err := svc.IssueAlias(ctx, "tenant-1", "", "test")
	if err == nil {
		t.Error("expected error for empty realIdentity, got nil")
	}
}

// TestIdentity_VaultRegisterError_Propagated asserts that a vault error on
// Register is propagated to the caller without panicking.
func TestIdentity_VaultRegisterError_Propagated(t *testing.T) {
	sentinel := errors.New("vault down")
	svc := NewService(&stubVault{registerErr: sentinel})
	ctx := context.Background()

	_, err := svc.IssueAlias(ctx, "tenant", "id", "purpose")
	if !errors.Is(err, sentinel) {
		t.Errorf("expected sentinel error, got %v", err)
	}
}

// TestIdentity_VaultRevokeError_Propagated asserts that a vault error on Revoke
// is propagated to the caller without panicking.
func TestIdentity_VaultRevokeError_Propagated(t *testing.T) {
	sentinel := errors.New("revoke failed")
	svc := NewService(&stubVault{revokeErr: sentinel})
	ctx := context.Background()

	err := svc.RevokeAlias(ctx, "some-token")
	if !errors.Is(err, sentinel) {
		t.Errorf("expected sentinel error, got %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Monkey tests
// ─────────────────────────────────────────────────────────────────────────────

// TestIdentity_Monkey_AllMethods calls every exported method on Service with
// zero / empty / adversarial values and asserts no unrecovered panic.
func TestIdentity_Monkey_AllMethods(t *testing.T) {
	ctx := context.Background()

	t.Run("IssueAlias_allEmpty", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		svc := newSvc(t)
		_, _ = svc.IssueAlias(ctx, "", "", "")
	})

	t.Run("IssueAlias_unicodeInputs", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		svc := newSvc(t)
		_, _ = svc.IssueAlias(ctx, "tëñänt-αβγ", "用户@例子.广告", "目的")
	})

	t.Run("IssueAlias_veryLongInputs", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		svc := newSvc(t)
		long := string(make([]byte, 65536))
		_, _ = svc.IssueAlias(ctx, long, long, long)
	})

	t.Run("IssueAlias_nullBytes", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		svc := newSvc(t)
		_, _ = svc.IssueAlias(ctx, "tenant\x00null", "id\x00id", "pur\x00pose")
	})

	t.Run("RevokeAlias_emptyToken", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		svc := newSvc(t)
		_ = svc.RevokeAlias(ctx, "")
	})

	t.Run("RevokeAlias_unknownToken", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		svc := newSvc(t)
		_ = svc.RevokeAlias(ctx, "tok_does_not_exist")
	})

	t.Run("RevokeAlias_veryLongToken", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		svc := newSvc(t)
		_ = svc.RevokeAlias(ctx, string(make([]byte, 65536)))
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency safety
// ─────────────────────────────────────────────────────────────────────────────

// TestIdentity_ConcurrentAccess_Safe runs IssueAlias and RevokeAlias from many
// goroutines simultaneously (use -race to detect data races).
func TestIdentity_ConcurrentAccess_Safe(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()

	// Pre-issue a token so the revoke goroutines have something to work with.
	token, err := svc.IssueAlias(ctx, "tenant-race", "seed@example.com", "seed")
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() { recover() }()
			if i%2 == 0 {
				_, _ = svc.IssueAlias(ctx, "tenant-race", "user@example.com", "concurrent")
			} else {
				_ = svc.RevokeAlias(ctx, token)
			}
		}(i)
	}
	wg.Wait()
}
