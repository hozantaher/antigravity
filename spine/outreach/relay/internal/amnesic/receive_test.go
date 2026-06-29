package amnesic

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestDeriveX25519KeyPairDeterministic(t *testing.T) {
	p1 := []byte("shared-secret-passphrase")
	p2 := []byte("shared-secret-passphrase")

	priv1, pub1 := DeriveX25519KeyPair(p1)
	priv2, pub2 := DeriveX25519KeyPair(p2)

	if !bytes.Equal(priv1, priv2) {
		t.Fatal("same passphrase should produce same private key")
	}
	if !bytes.Equal(pub1, pub2) {
		t.Fatal("same passphrase should produce same public key")
	}
}

func TestDeriveX25519DifferentPassphrases(t *testing.T) {
	priv1, pub1 := DeriveX25519KeyPair([]byte("passphrase-one"))
	priv2, pub2 := DeriveX25519KeyPair([]byte("passphrase-two"))

	if bytes.Equal(priv1, priv2) {
		t.Fatal("different passphrases should produce different private keys")
	}
	if bytes.Equal(pub1, pub2) {
		t.Fatal("different passphrases should produce different public keys")
	}
}

func TestDeriveX25519KeyLengths(t *testing.T) {
	priv, pub := DeriveX25519KeyPair([]byte("test"))
	if len(priv) != 32 {
		t.Fatalf("private key should be 32 bytes, got %d", len(priv))
	}
	if len(pub) != 32 {
		t.Fatalf("public key should be 32 bytes, got %d", len(pub))
	}
}

func TestDeriveX25519ValidHex(t *testing.T) {
	_, pub := DeriveX25519KeyPair([]byte("test-passphrase"))
	hexPub := hex.EncodeToString(pub)
	if len(hexPub) != 64 {
		t.Fatalf("hex public key should be 64 chars, got %d", len(hexPub))
	}
}

func TestSameSlotIDForSenderAndReceiver(t *testing.T) {
	passphrase := []byte("shared-between-sender-and-receiver")

	// Sender derives slot ID
	senderID := Derive(append([]byte{}, passphrase...))
	defer senderID.Zero()

	// Receiver derives slot ID
	receiverID := Derive(append([]byte{}, passphrase...))
	defer receiverID.Zero()

	if senderID.SlotID != receiverID.SlotID {
		t.Fatal("sender and receiver should derive the same slot ID from the same passphrase")
	}
}
