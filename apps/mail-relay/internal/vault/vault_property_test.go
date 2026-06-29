package vault

import (
	"context"
	"encoding/base64"
	"math/rand/v2"
	"path/filepath"
	"testing"
	"testing/quick"
)

// ---------------------------------------------------------------------------
// Encrypt/Decrypt round-trip (property)
// ---------------------------------------------------------------------------

// TestEncryptDecryptRoundTrip verifies that for any 32-byte key and any
// plaintext slice, Encrypt followed by Decrypt returns the original input.
func TestEncryptDecryptRoundTrip(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	f := func(plaintext []byte) bool {
		if len(plaintext) == 0 {
			plaintext = []byte("non-empty") // codec may reject empty
		}
		ciphertext, err := v.vaultKey.Encrypt(plaintext)
		if err != nil {
			return false
		}
		decrypted, err := v.vaultKey.Decrypt(ciphertext)
		if err != nil {
			return false
		}
		if len(decrypted) != len(plaintext) {
			return false
		}
		for i := range plaintext {
			if decrypted[i] != plaintext[i] {
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatalf("round-trip property failed: %v", err)
	}
}

// TestEncryptNeverPanicsProperty confirms that Encrypt never panics,
// regardless of key material or plaintext content.
func TestEncryptNeverPanicsProperty(t *testing.T) {
	f := func(keyBytes [32]byte, plaintext []byte) bool {
		defer func() { recover() }()

		key := base64.StdEncoding.EncodeToString(keyBytes[:])
		dir := t.TempDir()
		v, err := NewFileVault(filepath.Join(dir, "vault.json"), key, 0)
		if err != nil {
			// Invalid vault key — not a panic, acceptable
			return true
		}
		if len(plaintext) == 0 {
			plaintext = []byte("x")
		}
		v.vaultKey.Encrypt(plaintext)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatalf("Encrypt panic property failed: %v", err)
	}
}

// TestDecryptCorruptedCiphertextReturnsError verifies that tampered
// ciphertext (bit-flip, truncation, garbage) is rejected with an error.
func TestDecryptCorruptedCiphertextReturnsError(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	plaintext := []byte("sensitive data that must be protected")
	ciphertext, err := v.vaultKey.Encrypt(plaintext)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name       string
		corrupt    func([]byte) []byte
	}{
		{
			name: "truncated ciphertext",
			corrupt: func(b []byte) []byte {
				if len(b) < 4 {
					return []byte{0x01}
				}
				return b[:len(b)/2]
			},
		},
		{
			name: "random garbage",
			corrupt: func(_ []byte) []byte {
				return []byte("not-a-valid-ciphertext-envelope!!!")
			},
		},
		{
			name: "bit-flip in ciphertext",
			corrupt: func(b []byte) []byte {
				out := make([]byte, len(b))
				copy(out, b)
				// Flip a byte near the end (inside the GCM tag area)
				if len(out) > 5 {
					out[len(out)-5] ^= 0xFF
				}
				return out
			},
		},
		{
			name: "empty bytes",
			corrupt: func(_ []byte) []byte {
				return []byte{}
			},
		},
		{
			name: "valid JSON but wrong algorithm",
			corrupt: func(_ []byte) []byte {
				return []byte(`{"version":1,"algorithm":"aes-128-cbc","nonce":"AAAA","ciphertext":"BBBB"}`)
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			corrupted := tc.corrupt(ciphertext)
			_, err := v.vaultKey.Decrypt(corrupted)
			if err == nil {
				t.Fatal("expected error decrypting corrupted ciphertext, got nil")
			}
		})
	}
}

// TestDecryptWrongKeyReturnsError verifies that decryption with a different
// key consistently returns an error (no silent data corruption).
func TestDecryptWrongKeyReturnsError(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	plaintext := []byte("message encrypted under original key")
	ciphertext, err := v.vaultKey.Encrypt(plaintext)
	if err != nil {
		t.Fatal(err)
	}

	// Build a different vault with a different key
	wrongKey := make([]byte, 32)
	for i := range wrongKey {
		wrongKey[i] = byte(255 - i) // clearly different from testVaultKey
	}
	wrongKeyB64 := base64.StdEncoding.EncodeToString(wrongKey)

	dir2 := t.TempDir()
	v2, err := NewFileVault(filepath.Join(dir2, "vault.json"), wrongKeyB64, 0)
	if err != nil {
		t.Fatal(err)
	}

	_, err = v2.vaultKey.Decrypt(ciphertext)
	if err == nil {
		t.Fatal("expected error when decrypting with wrong key, got nil")
	}
}

// TestEncryptProducesDistinctCiphertexts confirms that two encryptions of the
// same plaintext yield different ciphertexts (random nonce per call).
func TestEncryptProducesDistinctCiphertexts(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	plaintext := []byte("same message every time")
	ct1, err := v.vaultKey.Encrypt(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	ct2, err := v.vaultKey.Encrypt(plaintext)
	if err != nil {
		t.Fatal(err)
	}

	if string(ct1) == string(ct2) {
		t.Fatal("two encryptions of the same plaintext must produce distinct ciphertexts (IND-CPA)")
	}
}

// TestRegisterMultipleTokensUnique verifies that many registrations produce
// distinct alias tokens (collision resistance via property check).
func TestRegisterMultipleTokensUnique(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	seen := make(map[string]struct{})
	for i := 0; i < 100; i++ {
		tok, err := v.Register(ctx, "tenant", "identity@example.com", "purpose")
		if err != nil {
			t.Fatalf("Register[%d]: %v", i, err)
		}
		if _, dup := seen[tok]; dup {
			t.Fatalf("duplicate alias token at iteration %d: %s", i, tok)
		}
		seen[tok] = struct{}{}
	}
}

// TestResolveNeverPanicsProperty confirms Resolve does not panic on arbitrary
// token strings (important for API boundary robustness).
func TestResolveNeverPanicsProperty(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// Pre-populate a few real tokens
	for i := 0; i < 5; i++ {
		v.Register(ctx, "t1", "id@example.com", "p")
	}

	f := func(token string) bool {
		defer func() { recover() }()
		v.Resolve(ctx, token)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatalf("Resolve panic property failed: %v", err)
	}
}

// TestEncryptDecryptLargePayload verifies round-trip on a large plaintext
// (> 1 MiB) to confirm there is no size limit or buffer overflow.
func TestEncryptDecryptLargePayload(t *testing.T) {
	dir := t.TempDir()
	v, err := NewFileVault(filepath.Join(dir, "vault.json"), testVaultKey(), 0)
	if err != nil {
		t.Fatal(err)
	}

	size := 1024 * 1024 // 1 MiB
	plain := make([]byte, size)
	r := rand.New(rand.NewPCG(0xdeadbeef, 0xcafebabe))
	for i := range plain {
		plain[i] = byte(r.Uint32())
	}

	ct, err := v.vaultKey.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt large payload: %v", err)
	}
	got, err := v.vaultKey.Decrypt(ct)
	if err != nil {
		t.Fatalf("Decrypt large payload: %v", err)
	}
	if len(got) != len(plain) {
		t.Fatalf("length mismatch: got %d want %d", len(got), len(plain))
	}
	for i := range plain {
		if got[i] != plain[i] {
			t.Fatalf("byte mismatch at index %d", i)
			break
		}
	}
}
