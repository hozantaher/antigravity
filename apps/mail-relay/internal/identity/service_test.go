package identity

import (
	"relay/internal/vault"
	"context"
	"encoding/base64"
	"path/filepath"
	"testing"
)

func testVault(t *testing.T) vault.Vault {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	v, err := vault.NewFileVault(
		filepath.Join(t.TempDir(), "vault.json"),
		base64.StdEncoding.EncodeToString(key),
		0,
	)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestIssueAlias(t *testing.T) {
	svc := NewService(testVault(t))

	token, err := svc.IssueAlias(context.Background(), "tenant-1", "real-user@example.com", "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != 32 {
		t.Fatalf("expected 32-char token, got %d", len(token))
	}
}

func TestIssueAndRevoke(t *testing.T) {
	svc := NewService(testVault(t))
	ctx := context.Background()

	token, _ := svc.IssueAlias(ctx, "tenant-1", "user@example.com", "test")
	err := svc.RevokeAlias(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
}

func TestIssueProducesUniqueTokens(t *testing.T) {
	svc := NewService(testVault(t))
	ctx := context.Background()

	t1, _ := svc.IssueAlias(ctx, "t", "a@b.com", "test")
	t2, _ := svc.IssueAlias(ctx, "t", "c@d.com", "test")

	if t1 == t2 {
		t.Fatal("tokens should be unique")
	}
}
