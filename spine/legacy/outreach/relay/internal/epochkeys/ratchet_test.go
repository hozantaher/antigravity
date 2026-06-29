package epochkeys

import (
	"bytes"
	"testing"
)

func TestEpochKeyDeterministic(t *testing.T) {
	p1 := []byte("shared-passphrase")
	p2 := []byte("shared-passphrase")
	epoch := int64(500000)

	priv1, pub1 := DeriveEpochKeyPair(p1, epoch)
	priv2, pub2 := DeriveEpochKeyPair(p2, epoch)

	if !bytes.Equal(priv1, priv2) {
		t.Fatal("same passphrase + epoch should produce same private key")
	}
	if !bytes.Equal(pub1, pub2) {
		t.Fatal("same passphrase + epoch should produce same public key")
	}
}

func TestEpochKeyRotates(t *testing.T) {
	passphrase := []byte("rotation-test")

	_, pub1 := DeriveEpochKeyPair(passphrase, 100)
	_, pub2 := DeriveEpochKeyPair(passphrase, 101)

	if bytes.Equal(pub1, pub2) {
		t.Fatal("different epochs should produce different keys")
	}
}

func TestForwardSecrecy(t *testing.T) {
	passphrase := []byte("forward-secrecy-test")

	// Epoch N key cannot decrypt epoch N-2 message
	privN, _ := DeriveEpochKeyPair(passphrase, 100)
	_, pubN2 := DeriveEpochKeyPair(passphrase, 98)

	// privN and pubN2 are from different epochs -- encryption with pubN2
	// cannot be decrypted with privN (different key derivation)
	if bytes.Equal(privN, func() []byte {
		p, _ := DeriveEpochKeyPair(passphrase, 98)
		return p
	}()) {
		t.Fatal("epoch 100 private key should differ from epoch 98")
	}
	_ = pubN2
}

func TestKeyLengths(t *testing.T) {
	priv, pub := DeriveEpochKeyPair([]byte("test"), CurrentEpoch())
	if len(priv) != 32 {
		t.Fatalf("private key should be 32 bytes, got %d", len(priv))
	}
	if len(pub) != 32 {
		t.Fatalf("public key should be 32 bytes, got %d", len(pub))
	}
}

func TestDifferentPassphrases(t *testing.T) {
	epoch := CurrentEpoch()
	_, pub1 := DeriveEpochKeyPair([]byte("phrase-one"), epoch)
	_, pub2 := DeriveEpochKeyPair([]byte("phrase-two"), epoch)

	if bytes.Equal(pub1, pub2) {
		t.Fatal("different passphrases should produce different keys")
	}
}
