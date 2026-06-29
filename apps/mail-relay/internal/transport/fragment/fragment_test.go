package fragment

import (
	"relay/internal/shamir"
	"bytes"
	"testing"
)

func TestFragmentAndReassemble(t *testing.T) {
	f := NewFragmenter(2, 3)
	secret := []byte("shared-secret-for-test-1234567890")
	sealed := []byte("this is the sealed message content to fragment")

	fragments, err := f.Fragment(sealed, secret, 12345)
	if err != nil {
		t.Fatal(err)
	}

	if len(fragments) != 3 {
		t.Fatalf("expected 3 fragments, got %d", len(fragments))
	}

	// All fragments should have different slot IDs
	for i := 0; i < len(fragments); i++ {
		for j := i + 1; j < len(fragments); j++ {
			if fragments[i].SlotID == fragments[j].SlotID {
				t.Fatal("fragment slot IDs should be unique")
			}
		}
	}

	// Reassemble from first 2
	result, err := f.Reassemble(fragments[:2])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result, sealed) {
		t.Fatal("reassembled content mismatch")
	}
}

func TestFragmentSlotIDDeterministic(t *testing.T) {
	f := NewFragmenter(2, 3)
	secret := []byte("deterministic-test-secret")

	ids1 := f.DeriveFragmentSlotIDs(secret, 100)
	ids2 := f.DeriveFragmentSlotIDs(secret, 100)

	for i := range ids1 {
		if ids1[i] != ids2[i] {
			t.Fatalf("slot ID %d not deterministic", i)
		}
	}
}

func TestFragmentNotEnoughShares(t *testing.T) {
	f := NewFragmenter(3, 5)
	sealed := []byte("test data")
	secret := []byte("secret")

	fragments, _ := f.Fragment(sealed, secret, 1)

	// Only 2 shares, need 3
	_, err := f.Reassemble(fragments[:2])
	if err == nil {
		t.Fatal("expected error with insufficient shares")
	}
}

func TestFragmentSingleShareRevealsNothing(t *testing.T) {
	f := NewFragmenter(2, 3)
	sealed := []byte("secret message that should not be visible from one share")
	secret := []byte("test-secret")

	fragments, _ := f.Fragment(sealed, secret, 1)

	// Single share data should not equal sealed content
	if bytes.Equal(fragments[0].Share.Data, sealed) {
		t.Fatal("single share should not equal original content")
	}
}

// Ensure shamir.Share is compatible
func TestFragmentShareType(t *testing.T) {
	f := NewFragmenter(2, 3)
	sealed := []byte("type test")
	secret := []byte("s")

	fragments, _ := f.Fragment(sealed, secret, 1)

	shares := make([]shamir.Share, len(fragments))
	for i, frag := range fragments {
		shares[i] = frag.Share
	}

	result, err := shamir.Combine(shares[:2], 2)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result, sealed) {
		t.Fatal("shamir.Combine from fragment shares failed")
	}
}
