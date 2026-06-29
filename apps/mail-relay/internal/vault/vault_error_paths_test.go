package vault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"relay/internal/model"
)

// ---------------------------------------------------------------------------
// Register — persist() error path (vault.go:89-91)
// ---------------------------------------------------------------------------

// TestRegisterPersistErrorReturnsError triggers the persist() error inside
// Register by making the vault directory read-only after vault creation.
func TestRegisterPersistErrorReturnsError(t *testing.T) {
	dir := t.TempDir()
	subdir := filepath.Join(dir, "vault-dir")
	if err := os.MkdirAll(subdir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(subdir, "vault.json")

	v, err := NewFileVault(path, testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	// Make the directory read-only so os.CreateTemp fails inside WriteJSONAtomic.
	if err := os.Chmod(subdir, 0500); err != nil {
		t.Skip("cannot chmod dir, skipping persist error test")
	}
	defer os.Chmod(subdir, 0700) // restore for cleanup

	ctx := context.Background()
	_, err = v.Register(ctx, "tenant-1", "id@example.com", "test")
	if err == nil {
		t.Fatal("expected error from Register when persist fails, got nil")
	}
}

// ---------------------------------------------------------------------------
// Resolve — vaultKey.Decrypt error path (vault.go:108-110)
// ---------------------------------------------------------------------------

// TestResolveDecryptErrorReturnsError injects a corrupted EncryptedRef directly
// into the in-memory mappings, then calls Resolve. The vaultKey.Decrypt call
// must fail and the error must propagate.
func TestResolveDecryptErrorReturnsError(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	// Inject a mapping with garbage EncryptedRef that the vault key cannot decrypt.
	v.mu.Lock()
	v.mappings = append(v.mappings, model.AliasMapping{
		AliasToken:   "corrupt-token",
		TenantID:     "t1",
		EncryptedRef: []byte("this is not a valid aes-gcm ciphertext"),
		CreatedBucket: v.now().UTC().Truncate(15 * time.Minute),
	})
	v.mu.Unlock()

	_, err = v.Resolve(context.Background(), "corrupt-token")
	if err == nil {
		t.Fatal("expected error when vaultKey.Decrypt fails on corrupt EncryptedRef, got nil")
	}
}

// ---------------------------------------------------------------------------
// Register — generateAliasToken error (vault.go:68-70) via vaultKey.Encrypt
// ---------------------------------------------------------------------------

// TestRegisterEncryptErrorReturnsError injects a broken vaultKey that always
// fails Encrypt, so the error in Register at line 72-75 is hit.
// We achieve this by using a DefaultCodec (no key) which passes through, then
// corrupting the path to prevent persist, but that covers 89-91, not 73-75.
//
// Lines 73-75 require vaultKey.Encrypt to fail, which only happens if the key
// is somehow invalid after vault construction. We test the closest feasible
// path: using a vault where vaultKey is a DefaultCodec (passthrough) so
// Encrypt never fails, confirming the *normal* path is covered. The error path
// at 73-75 is unreachable with a correctly-keyed vault (AES-256-GCM with a
// 32-byte key will not error on Encrypt). We document this as a known
// untestable line for production determinism.

// TestRegisterAndResolveConcurrent verifies that Register and Resolve are
// safe under concurrent access from multiple goroutines.
func TestRegisterAndResolveConcurrent(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	done := make(chan struct{})

	var tokens [10]string
	// Register 10 mappings concurrently
	for i := 0; i < 10; i++ {
		go func(idx int) {
			tok, e := v.Register(ctx, "tenant", "id@example.com", "p")
			if e == nil {
				tokens[idx] = tok
			}
			done <- struct{}{}
		}(i)
	}
	for i := 0; i < 10; i++ {
		<-done
	}

	// Resolve all non-empty tokens (no panics, no errors on valid tokens)
	for _, tok := range tokens {
		if tok == "" {
			continue
		}
		_, err := v.Resolve(ctx, tok)
		if err != nil {
			t.Fatalf("Resolve(%q): %v", tok, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Revoke — persist error path via bad vault path
// ---------------------------------------------------------------------------

// TestRevokePersistErrorReturnsError makes the vault directory read-only after
// registration, then calls Revoke. The persist() inside Revoke should fail.
func TestRevokePersistErrorReturnsError(t *testing.T) {
	dir := t.TempDir()
	subdir := filepath.Join(dir, "vault-revoke-dir")
	if err := os.MkdirAll(subdir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(subdir, "vault.json")

	v, err := NewFileVault(path, testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	// Register succeeds (directory is still writable).
	tok, err := v.Register(ctx, "t1", "person@example.com", "test")
	if err != nil {
		t.Fatal(err)
	}

	// Make directory read-only so Revoke's persist() call fails.
	if err := os.Chmod(subdir, 0500); err != nil {
		t.Skip("cannot chmod dir, skipping revoke persist error test")
	}
	defer os.Chmod(subdir, 0700)

	err = v.Revoke(ctx, tok)
	if err == nil {
		t.Fatal("expected error from Revoke when persist fails, got nil")
	}
}
