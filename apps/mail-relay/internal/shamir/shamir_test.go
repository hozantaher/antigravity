package shamir

import (
	"bytes"
	"testing"
)

func TestSplitAndCombine(t *testing.T) {
	secret := []byte("this is a secret message for shamir testing")
	shares, err := Split(secret, 3, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(shares) != 5 {
		t.Fatalf("expected 5 shares, got %d", len(shares))
	}

	// Reconstruct from first 3 shares
	result, err := Combine(shares[:3], 3)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result, secret) {
		t.Fatalf("reconstructed secret mismatch")
	}
}

func TestCombineFromDifferentSubsets(t *testing.T) {
	secret := []byte("K-of-N reconstruction test")
	shares, _ := Split(secret, 2, 5)

	// Any 2 of 5 should work
	subsets := [][]Share{
		{shares[0], shares[1]},
		{shares[0], shares[4]},
		{shares[2], shares[3]},
		{shares[1], shares[4]},
	}

	for i, subset := range subsets {
		result, err := Combine(subset, 2)
		if err != nil {
			t.Fatalf("subset %d: %v", i, err)
		}
		if !bytes.Equal(result, secret) {
			t.Fatalf("subset %d: mismatch", i)
		}
	}
}

func TestTooFewShares(t *testing.T) {
	secret := []byte("need at least K")
	shares, _ := Split(secret, 3, 5)

	_, err := Combine(shares[:2], 3)
	if err != ErrTooFew {
		t.Fatalf("expected ErrTooFew, got %v", err)
	}
}

func TestSingleShareRevealsNothing(t *testing.T) {
	secret := []byte("single share should reveal nothing about me")
	shares, _ := Split(secret, 3, 5)

	// One share alone should not equal or contain the secret
	if bytes.Equal(shares[0].Data, secret) {
		t.Fatal("single share should not equal secret")
	}
}

func TestMinimalK2N2(t *testing.T) {
	secret := []byte("minimal split")
	shares, err := Split(secret, 2, 2)
	if err != nil {
		t.Fatal(err)
	}

	result, err := Combine(shares, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result, secret) {
		t.Fatal("mismatch")
	}
}

func TestEmptySecret(t *testing.T) {
	_, err := Split([]byte{}, 2, 3)
	if err != ErrEmptySecret {
		t.Fatalf("expected ErrEmptySecret, got %v", err)
	}
}

func TestInvalidParams(t *testing.T) {
	if _, err := Split([]byte("x"), 1, 3); err != ErrInvalidK {
		t.Fatalf("expected ErrInvalidK, got %v", err)
	}
	if _, err := Split([]byte("x"), 3, 2); err != ErrInvalidN {
		t.Fatalf("expected ErrInvalidN, got %v", err)
	}
}
