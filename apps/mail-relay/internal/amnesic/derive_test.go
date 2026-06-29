package amnesic

import (
	"bytes"
	"testing"
)

func TestDeriveDeterministic(t *testing.T) {
	pass1 := []byte("correct horse battery staple")
	pass2 := []byte("correct horse battery staple")

	id1 := Derive(pass1)
	defer id1.Zero()
	id2 := Derive(pass2)
	defer id2.Zero()

	if !bytes.Equal(id1.PublicKey, id2.PublicKey) {
		t.Fatal("same passphrase should produce same public key")
	}
	if !bytes.Equal(id1.EncryptionKey.Bytes(), id2.EncryptionKey.Bytes()) {
		t.Fatal("same passphrase should produce same encryption key")
	}
	if id1.SlotID != id2.SlotID {
		t.Fatal("same passphrase should produce same slot ID (same epoch)")
	}
}

func TestDeriveDifferentPassphrases(t *testing.T) {
	id1 := Derive([]byte("real passphrase"))
	defer id1.Zero()
	id2 := Derive([]byte("duress passphrase"))
	defer id2.Zero()

	if bytes.Equal(id1.PublicKey, id2.PublicKey) {
		t.Fatal("different passphrases should produce different public keys")
	}
	if bytes.Equal(id1.EncryptionKey.Bytes(), id2.EncryptionKey.Bytes()) {
		t.Fatal("different passphrases should produce different encryption keys")
	}
}

func TestDeriveProducesValidKeyLengths(t *testing.T) {
	id := Derive([]byte("test passphrase"))
	defer id.Zero()

	if id.EncryptionKey.Len() != 32 {
		t.Fatalf("encryption key should be 32 bytes, got %d", id.EncryptionKey.Len())
	}
	if len(id.PublicKey) != 32 {
		t.Fatalf("public key should be 32 bytes, got %d", len(id.PublicKey))
	}
	if id.SigningKey.Len() != 64 {
		t.Fatalf("signing key should be 64 bytes, got %d", id.SigningKey.Len())
	}
}

func TestDeriveZeroWipesKeys(t *testing.T) {
	id := Derive([]byte("test passphrase"))

	// Capture key bytes before zero
	encKey := make([]byte, 32)
	copy(encKey, id.EncryptionKey.Bytes())

	id.Zero()

	// After zero, the secure buffer should be all zeros
	for _, b := range id.EncryptionKey.Bytes() {
		if b != 0 {
			t.Fatal("encryption key not zeroed after Zero()")
		}
	}
}

func TestDerivePassphraseZeroed(t *testing.T) {
	pass := []byte("sensitive passphrase")
	original := make([]byte, len(pass))
	copy(original, pass)

	_ = Derive(pass)

	// Passphrase should be zeroed by Derive()
	for _, b := range pass {
		if b != 0 {
			t.Fatal("passphrase should be zeroed after Derive()")
		}
	}
}
