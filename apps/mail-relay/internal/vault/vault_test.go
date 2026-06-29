package vault

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func testVaultKey() string {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	return base64.StdEncoding.EncodeToString(key)
}

func TestRegisterAndResolve(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")

	v, err := NewFileVault(path, testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	token, err := v.Register(ctx, "tenant-1", "real-identity@example.com", "intake")
	if err != nil {
		t.Fatal(err)
	}

	if len(token) != 32 { // 16 bytes hex encoded
		t.Fatalf("expected 32-char token, got %d: %s", len(token), token)
	}

	resolved, err := v.Resolve(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != "real-identity@example.com" {
		t.Fatalf("expected real-identity@example.com, got %s", resolved)
	}
}

func TestResolveAfterRevoke(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")

	v, err := NewFileVault(path, testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	token, _ := v.Register(ctx, "tenant-1", "person@example.com", "test")
	v.Revoke(ctx, token)

	_, err = v.Resolve(ctx, token)
	if err != ErrRevoked {
		t.Fatalf("expected ErrRevoked, got %v", err)
	}
}

func TestListByTenantHidesEncryptedRef(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")

	v, err := NewFileVault(path, testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	v.Register(ctx, "tenant-1", "person@example.com", "test")

	mappings, err := v.ListByTenant(ctx, "tenant-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(mappings) != 1 {
		t.Fatalf("expected 1 mapping, got %d", len(mappings))
	}
	if mappings[0].EncryptedRef != nil {
		t.Fatal("EncryptedRef should be nil in listing")
	}
}

func TestVaultPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")
	key := testVaultKey()

	v1, _ := NewFileVault(path, key, 0)
	ctx := context.Background()
	token, _ := v1.Register(ctx, "tenant-1", "person@example.com", "test")

	// Re-open vault from same file
	v2, err := NewFileVault(path, key, 0)
	if err != nil {
		t.Fatal(err)
	}

	resolved, err := v2.Resolve(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != "person@example.com" {
		t.Fatalf("expected person@example.com after reopen, got %s", resolved)
	}
}

func TestVaultSeparateKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")
	key := testVaultKey()

	v, _ := NewFileVault(path, key, 0)
	ctx := context.Background()
	v.Register(ctx, "tenant-1", "person@example.com", "test")

	// Try to read the file directly -- should be encrypted
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// The raw data should NOT contain the real identity in plaintext
	if contains(data, "person@example.com") {
		t.Fatal("vault file should not contain real identity in plaintext")
	}
}

func contains(data []byte, s string) bool {
	for i := 0; i <= len(data)-len(s); i++ {
		if string(data[i:i+len(s)]) == s {
			return true
		}
	}
	return false
}
