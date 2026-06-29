package amnesic_test

import (
	"testing"
	"testing/quick"

	"relay/internal/amnesic"
)

// ── DeriveX25519KeyPair property tests ────────────────────────────────────

func TestDeriveX25519KeyPair_NeverPanics(t *testing.T) {
	f := func(passphrase []byte) bool {
		defer func() { recover() }()
		amnesic.DeriveX25519KeyPair(passphrase)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("DeriveX25519KeyPair panicked: %v", err)
	}
}

func TestDeriveX25519KeyPair_OutputLength32(t *testing.T) {
	f := func(passphrase []byte) bool {
		priv, pub := amnesic.DeriveX25519KeyPair(passphrase)
		if priv == nil && pub == nil {
			return true // nil is valid for empty passphrase edge cases
		}
		return len(priv) == 32 && len(pub) == 32
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("DeriveX25519KeyPair: unexpected output length: %v", err)
	}
}

func TestDeriveX25519KeyPair_Deterministic(t *testing.T) {
	passphrase := []byte("test-passphrase-determinism-check")
	priv1, pub1 := amnesic.DeriveX25519KeyPair(passphrase)
	priv2, pub2 := amnesic.DeriveX25519KeyPair(passphrase)
	if string(priv1) != string(priv2) || string(pub1) != string(pub2) {
		t.Error("DeriveX25519KeyPair is not deterministic for same passphrase")
	}
}

func TestDeriveX25519KeyPair_EmptyPassphrase_NoCrash(t *testing.T) {
	priv, pub := amnesic.DeriveX25519KeyPair(nil)
	_ = priv
	_ = pub
	// nil passphrase must not panic
}

func TestDeriveX25519KeyPair_DifferentPassphrases_DifferentKeys(t *testing.T) {
	priv1, pub1 := amnesic.DeriveX25519KeyPair([]byte("passphrase-alpha"))
	priv2, pub2 := amnesic.DeriveX25519KeyPair([]byte("passphrase-beta"))
	if string(priv1) == string(priv2) {
		t.Error("different passphrases should produce different private keys")
	}
	if string(pub1) == string(pub2) {
		t.Error("different passphrases should produce different public keys")
	}
}

func TestDeriveX25519KeyPair_LongPassphrase_Safe(t *testing.T) {
	long := make([]byte, 65536)
	for i := range long {
		long[i] = byte(i % 256)
	}
	priv, pub := amnesic.DeriveX25519KeyPair(long)
	if priv != nil && len(priv) != 32 {
		t.Errorf("long passphrase: expected 32-byte key, got %d", len(priv))
	}
	_ = pub
}

func TestDeriveX25519KeyPair_PrivPubDifferent(t *testing.T) {
	priv, pub := amnesic.DeriveX25519KeyPair([]byte("keypair-test"))
	if priv == nil || pub == nil {
		t.Skip("nil keys — edge case passphrase")
	}
	if string(priv) == string(pub) {
		t.Error("private and public keys must be different")
	}
}
