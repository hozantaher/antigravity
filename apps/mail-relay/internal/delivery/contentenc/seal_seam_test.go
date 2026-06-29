package contentenc

// seal_seam_test.go — white-box tests that inject errors via package-level seam
// vars to cover crypto error paths unreachable through normal operation.
//
// All tests are in the same package (contentenc) so they can access the
// unexported seam variables: newAESCipher, newGCM, randRead, ecdhGenKey.

import (
	"crypto/cipher"
	"crypto/ecdh"
	"errors"
	"io"
	"math/rand"
	"testing"
)

var errInjected = errors.New("injected crypto error")

// ── Seal error paths ──────────────────────────────────────────────────────────

// TestSeal_NewAESCipherError verifies that a failure in aes.NewCipher is
// propagated back to the caller and does not panic.
func TestSeal_NewAESCipherError(t *testing.T) {
	orig := newAESCipher
	newAESCipher = func(key []byte) (cipher.Block, error) { return nil, errInjected }
	defer func() { newAESCipher = orig }()

	_, pub, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	sealer := NewSealer()
	_, err = sealer.Seal([]byte("test"), pub)
	if err == nil {
		t.Fatal("expected error when newAESCipher fails")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// TestSeal_NewGCMError verifies that a failure in cipher.NewGCM is propagated.
func TestSeal_NewGCMError(t *testing.T) {
	orig := newGCM
	newGCM = func(block cipher.Block) (cipher.AEAD, error) { return nil, errInjected }
	defer func() { newGCM = orig }()

	_, pub, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	sealer := NewSealer()
	_, err = sealer.Seal([]byte("test"), pub)
	if err == nil {
		t.Fatal("expected error when newGCM fails")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// TestSeal_RandReadError verifies that a failure in rand.Read (nonce
// generation) is propagated and the function returns an error.
func TestSeal_RandReadError(t *testing.T) {
	orig := randRead
	randRead = func(b []byte) (int, error) { return 0, errInjected }
	defer func() { randRead = orig }()

	_, pub, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	sealer := NewSealer()
	_, err = sealer.Seal([]byte("test"), pub)
	if err == nil {
		t.Fatal("expected error when randRead fails")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// TestSeal_EcdhGenKeyError verifies that a failure generating the ephemeral
// keypair in Seal is propagated to the caller.
func TestSeal_EcdhGenKeyError(t *testing.T) {
	// Generate key pair BEFORE injecting the seam so setup is unaffected.
	_, pub, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}

	orig := ecdhGenKey
	ecdhGenKey = func(curve ecdh.Curve, r io.Reader) (*ecdh.PrivateKey, error) {
		return nil, errInjected
	}
	defer func() { ecdhGenKey = orig }()

	sealer := NewSealer()
	_, err = sealer.Seal([]byte("test"), pub)
	if err == nil {
		t.Fatal("expected error when ecdhGenKey fails in Seal")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// ── Open error paths ──────────────────────────────────────────────────────────

// TestOpen_NewAESCipherError verifies that a failure in aes.NewCipher during
// Open returns ErrDecryptionFailed.
func TestOpen_NewAESCipherError(t *testing.T) {
	sealer := NewSealer()
	priv, pub, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	sealed, err := sealer.Seal([]byte("secret"), pub)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	orig := newAESCipher
	newAESCipher = func(key []byte) (cipher.Block, error) { return nil, errInjected }
	defer func() { newAESCipher = orig }()

	_, err = sealer.Open(sealed, priv)
	if err == nil {
		t.Fatal("expected error when newAESCipher fails in Open")
	}
	if !errors.Is(err, ErrDecryptionFailed) {
		t.Fatalf("expected ErrDecryptionFailed, got: %v", err)
	}
}

// TestOpen_NewGCMError verifies that a failure in cipher.NewGCM during Open
// returns ErrDecryptionFailed.
func TestOpen_NewGCMError(t *testing.T) {
	sealer := NewSealer()
	priv, pub, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	sealed, err := sealer.Seal([]byte("secret"), pub)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	orig := newGCM
	newGCM = func(block cipher.Block) (cipher.AEAD, error) { return nil, errInjected }
	defer func() { newGCM = orig }()

	_, err = sealer.Open(sealed, priv)
	if err == nil {
		t.Fatal("expected error when newGCM fails in Open")
	}
	if !errors.Is(err, ErrDecryptionFailed) {
		t.Fatalf("expected ErrDecryptionFailed, got: %v", err)
	}
}

// ── GenerateKeyPair error path ────────────────────────────────────────────────

// TestGenerateKeyPair_EcdhGenKeyError verifies that a failure in the ECDH key
// generation is surfaced as an error from GenerateKeyPair.
func TestGenerateKeyPair_EcdhGenKeyError(t *testing.T) {
	orig := ecdhGenKey
	ecdhGenKey = func(curve ecdh.Curve, r io.Reader) (*ecdh.PrivateKey, error) {
		return nil, errInjected
	}
	defer func() { ecdhGenKey = orig }()

	_, _, err := GenerateKeyPair()
	if err == nil {
		t.Fatal("expected error when ecdhGenKey fails in GenerateKeyPair")
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error, got: %v", err)
	}
}

// ── Happy path + MONKEY ───────────────────────────────────────────────────────

// TestSealOpen_SeamsHappyPath confirms that restoring seams to real
// implementations after injection still produces correct round-trips.
func TestSealOpen_SeamsHappyPath(t *testing.T) {
	sealer := NewSealer()
	priv, pub, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}
	plaintext := []byte("seam happy path — confirm normal ops still work")
	sealed, err := sealer.Seal(plaintext, pub)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	opened, err := sealer.Open(sealed, priv)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if string(opened) != string(plaintext) {
		t.Fatalf("round-trip mismatch: got %q, want %q", opened, plaintext)
	}
}

// TestSealOpen_MonkeyRandom runs 200 round-trips with random key/plaintext
// combos and asserts no panic and correct round-trip decryption.
func TestSealOpen_MonkeyRandom(t *testing.T) {
	sealer := NewSealer()
	rng := rand.New(rand.NewSource(42)) //nolint:gosec // deterministic seed for repeatability

	for i := 0; i < 200; i++ {
		// Generate a key pair via the real crypto (seams are uninjected here).
		priv, pub, err := GenerateKeyPair()
		if err != nil {
			t.Fatalf("iter %d: GenerateKeyPair: %v", i, err)
		}

		// Random plaintext: 0–512 bytes.
		size := rng.Intn(513)
		plaintext := make([]byte, size)
		if _, err := rng.Read(plaintext); err != nil {
			t.Fatalf("iter %d: rng.Read: %v", i, err)
		}

		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("iter %d: panic: %v", i, r)
				}
			}()

			sealed, err := sealer.Seal(plaintext, pub)
			if err != nil {
				t.Errorf("iter %d: Seal: %v", i, err)
				return
			}

			opened, err := sealer.Open(sealed, priv)
			if err != nil {
				t.Errorf("iter %d: Open: %v", i, err)
				return
			}

			if string(opened) != string(plaintext) {
				t.Errorf("iter %d: round-trip mismatch (len %d)", i, size)
			}
		}()
	}
}
