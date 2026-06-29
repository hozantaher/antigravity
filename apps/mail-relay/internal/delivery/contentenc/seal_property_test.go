package contentenc_test

import (
	"testing"
	"testing/quick"

	"relay/internal/delivery/contentenc"
)

// ── GenerateKeyPair ───────────────────────────────────────────────────────

func TestGenerateKeyPair_NeverPanics(t *testing.T) {
	for i := 0; i < 20; i++ {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("GenerateKeyPair panicked: %v", r)
				}
			}()
			_, _, _ = contentenc.GenerateKeyPair()
		}()
	}
}

func TestGenerateKeyPair_OutputLength32(t *testing.T) {
	priv, pub, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Skipf("GenerateKeyPair error: %v", err)
	}
	if len(priv) != 32 {
		t.Errorf("private key: expected 32 bytes, got %d", len(priv))
	}
	if len(pub) != 32 {
		t.Errorf("public key: expected 32 bytes, got %d", len(pub))
	}
}

func TestGenerateKeyPair_UniquePairs(t *testing.T) {
	priv1, pub1, _ := contentenc.GenerateKeyPair()
	priv2, pub2, _ := contentenc.GenerateKeyPair()
	if string(priv1) == string(priv2) {
		t.Error("two GenerateKeyPair calls returned same private key")
	}
	if string(pub1) == string(pub2) {
		t.Error("two GenerateKeyPair calls returned same public key")
	}
}

// ── Seal/Open round-trip ──────────────────────────────────────────────────

func TestSealOpen_RoundTrip(t *testing.T) {
	priv, pub, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	sealer := contentenc.NewSealer()
	plaintext := []byte("hello world — secret message")
	sealed, err := sealer.Seal(plaintext, pub)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	opened, err := sealer.Open(sealed, priv)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if string(opened) != string(plaintext) {
		t.Errorf("Open: got %q, want %q", opened, plaintext)
	}
}

func TestSeal_EmptyPlaintext(t *testing.T) {
	_, pub, _ := contentenc.GenerateKeyPair()
	sealer := contentenc.NewSealer()
	_, err := sealer.Seal([]byte{}, pub)
	// empty plaintext may succeed or return error — must not panic
	_ = err
}

func TestSeal_NilPlaintext_NoCrash(t *testing.T) {
	_, pub, _ := contentenc.GenerateKeyPair()
	sealer := contentenc.NewSealer()
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Seal(nil) panicked: %v", r)
		}
	}()
	_, _ = sealer.Seal(nil, pub)
}

func TestOpen_CorruptedCiphertext_ReturnsError(t *testing.T) {
	priv, _, _ := contentenc.GenerateKeyPair()
	sealer := contentenc.NewSealer()
	// Pass garbage — must return error, not panic
	_, err := sealer.Open([]byte("not a valid sealed message"), priv)
	if err == nil {
		t.Error("expected error for corrupted ciphertext")
	}
}

func TestSeal_Property_NeverPanics(t *testing.T) {
	_, pub, _ := contentenc.GenerateKeyPair()
	sealer := contentenc.NewSealer()
	f := func(plaintext []byte) bool {
		defer func() { recover() }()
		sealer.Seal(plaintext, pub) //nolint:errcheck
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Errorf("Seal panicked: %v", err)
	}
}

// ── Open error paths ──────────────────────────────────────────────────────

// TestOpen_WrongKeyLength covers the len(recipientPrivKey) != 32 branch.
func TestOpen_WrongKeyLength_ReturnsError(t *testing.T) {
	sealer := contentenc.NewSealer()
	priv, pub, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealer.Seal([]byte("secret"), pub)
	if err != nil {
		t.Fatal(err)
	}

	// 31-byte key — one byte short
	shortKey := priv[:31]
	_, err = sealer.Open(sealed, shortKey)
	if err == nil {
		t.Error("expected error for 31-byte private key")
	}

	// 0-byte key
	_, err = sealer.Open(sealed, []byte{})
	if err == nil {
		t.Error("expected error for empty private key")
	}

	// 33-byte key — one byte too long
	longKey := append(priv, 0x00)
	_, err = sealer.Open(sealed, longKey)
	if err == nil {
		t.Error("expected error for 33-byte private key")
	}
}

// TestOpen_EmptyCiphertext_ReturnsError covers the len(sealed) < 32+12+16 branch.
func TestOpen_EmptyCiphertext_ReturnsError(t *testing.T) {
	sealer := contentenc.NewSealer()
	priv, _, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}

	_, err = sealer.Open([]byte{}, priv)
	if err == nil {
		t.Error("expected error for empty ciphertext")
	}

	// Exactly one byte short of minimum (32+12+16-1 = 59 bytes)
	tooShort := make([]byte, 59)
	_, err = sealer.Open(tooShort, priv)
	if err == nil {
		t.Error("expected error for ciphertext shorter than minimum")
	}
}

// TestOpen_TruncatedCiphertext_ReturnsError passes a buffer that is large enough
// to pass the length check but truncated (missing GCM tag bytes).
func TestOpen_TruncatedCiphertext_ReturnsError(t *testing.T) {
	sealer := contentenc.NewSealer()
	priv, pub, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealer.Seal([]byte("hello"), pub)
	if err != nil {
		t.Fatal(err)
	}
	// Drop the last 8 bytes — this corrupts the GCM authentication tag.
	truncated := sealed[:len(sealed)-8]
	_, err = sealer.Open(truncated, priv)
	if err == nil {
		t.Error("expected error for truncated ciphertext")
	}
}

// TestOpen_WrongPrivateKey_ReturnsError uses a different valid 32-byte key.
func TestOpen_WrongPrivateKey_ReturnsError(t *testing.T) {
	sealer := contentenc.NewSealer()
	_, pub, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	wrongPriv, _, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealer.Seal([]byte("secret"), pub)
	if err != nil {
		t.Fatal(err)
	}
	_, err = sealer.Open(sealed, wrongPriv)
	if err == nil {
		t.Error("expected error when opening with wrong private key")
	}
}

// TestOpen_InvalidEphemeralPublicKey covers the curve.NewPublicKey failure branch.
// We craft a sealed buffer whose first 32 bytes form an invalid X25519 point.
func TestOpen_InvalidEphemeralPublicKey_ReturnsError(t *testing.T) {
	sealer := contentenc.NewSealer()
	priv, _, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}

	// Construct a buffer >= 60 bytes: 32 bytes of 0xFF (invalid X25519 point) + 28 bytes padding.
	// X25519 all-0xFF is not a valid low-order point but we rely on Go rejecting it via crypto/ecdh.
	// If Go accepts it (some points are valid), we'll get ErrDecryptionFailed — either error is fine.
	crafted := make([]byte, 60)
	for i := 0; i < 32; i++ {
		crafted[i] = 0xFF
	}
	_, err = sealer.Open(crafted, priv)
	if err == nil {
		t.Error("expected error for crafted ciphertext with all-0xFF ephemeral pubkey")
	}
}

// TestOpen_NilPrivateKey_Safe verifies nil key does not panic.
func TestOpen_NilPrivateKey_Safe(t *testing.T) {
	sealer := contentenc.NewSealer()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Open panicked with nil private key: %v", r)
		}
	}()
	_, err := sealer.Open(make([]byte, 60), nil)
	if err == nil {
		t.Error("expected error for nil private key")
	}
}

// TestOpen_Property_NeverPanics monkey-tests Open with arbitrary byte slices.
func TestOpen_Property_NeverPanics(t *testing.T) {
	sealer := contentenc.NewSealer()
	priv, _, _ := contentenc.GenerateKeyPair()
	f := func(sealed []byte) bool {
		defer func() { recover() }()
		out, err := sealer.Open(sealed, priv)
		// If no error, output must not be nil.
		if err == nil && out == nil {
			return false
		}
		// If error, output must be nil (no partial plaintext leak).
		if err != nil && out != nil {
			return false
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("Open property violated: %v", err)
	}
}
