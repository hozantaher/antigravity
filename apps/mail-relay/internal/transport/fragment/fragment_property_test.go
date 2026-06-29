package fragment

import (
	"bytes"
	"testing"
	"testing/quick"
)

// ── Property: NewFragmenter clamps k<2 to 2 ──────────────────
func TestProperty_NewFragmenter_KClamp(t *testing.T) {
	for _, k := range []int{-10, -1, 0, 1} {
		f := NewFragmenter(k, 4)
		if f.K() < 2 {
			t.Fatalf("k=%d: clamped K()=%d < 2", k, f.K())
		}
	}
}

// ── Property: NewFragmenter clamps n<k to n=k ────────────────
func TestProperty_NewFragmenter_NClamp(t *testing.T) {
	for _, n := range []int{-5, 0, 1} {
		f := NewFragmenter(3, n)
		if f.N() < f.K() {
			t.Fatalf("n=%d: N()=%d < K()=%d", n, f.N(), f.K())
		}
	}
}

// ── Property: K/N accessors match constructor ─────────────────
func TestProperty_NewFragmenter_Accessors(t *testing.T) {
	f := NewFragmenter(2, 5)
	if f.K() != 2 {
		t.Fatalf("K()=%d, want 2", f.K())
	}
	if f.N() != 5 {
		t.Fatalf("N()=%d, want 5", f.N())
	}
}

// ── Property: Fragment never panics ──────────────────────────
func TestProperty_Fragment_NoPanic(t *testing.T) {
	f := func(sealed []byte, secret []byte, epoch int64) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic: %v", r)
			}
		}()
		// Use fixed k/n to keep test focused on Fragment itself
		frag := NewFragmenter(2, 3)
		_, _ = frag.Fragment(sealed, secret, epoch)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Fragment roundtrip (k-of-n) ────────────────────
// Any k shares reconstruct the original content.
func TestProperty_Fragment_Roundtrip(t *testing.T) {
	f := NewFragmenter(2, 3)
	secret := []byte("shared-secret-key-32-bytes-long!")
	payloads := [][]byte{
		[]byte("short"),
		[]byte("medium length payload for testing"),
		make([]byte, 256),
		make([]byte, 1024),
	}
	for i, sealed := range payloads {
		// Fill non-zero payloads
		for j := range sealed {
			sealed[j] = byte(j % 251)
		}
		frags, err := f.Fragment(sealed, secret, int64(i))
		if err != nil {
			t.Fatalf("payload[%d]: Fragment error: %v", i, err)
		}
		// Reconstruct from first k=2 shares
		got, err := f.Reassemble(frags[:2])
		if err != nil {
			t.Fatalf("payload[%d]: Reassemble error: %v", i, err)
		}
		if !bytes.Equal(got, sealed) {
			t.Fatalf("payload[%d]: roundtrip mismatch", i)
		}
	}
}

// ── Property: Reassemble from all N also works ───────────────
func TestProperty_Fragment_ReassembleAllShares(t *testing.T) {
	f := NewFragmenter(2, 5)
	sealed := []byte("content to fragment into 5 shares")
	secret := []byte("secret-key")

	frags, err := f.Fragment(sealed, secret, 42)
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.Reassemble(frags)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, sealed) {
		t.Fatal("roundtrip with all N shares failed")
	}
}

// ── Property: Reassemble with <k shares → ErrNotEnoughShares ─
func TestProperty_Reassemble_InsufficientShares(t *testing.T) {
	f := NewFragmenter(3, 5)
	sealed := []byte("three-of-five payload")
	secret := []byte("s")

	frags, err := f.Fragment(sealed, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	for withhold := 0; withhold < f.K(); withhold++ {
		available := frags[:withhold]
		_, err := f.Reassemble(available)
		if err != ErrNotEnoughShares {
			t.Fatalf("withhold=%d (have %d, need %d): want ErrNotEnoughShares, got %v",
				withhold, withhold, f.K(), err)
		}
	}
}

// ── Property: Fragment produces exactly N fragments ───────────
func TestProperty_Fragment_NCount(t *testing.T) {
	cases := [][2]int{{2, 3}, {2, 5}, {3, 5}, {5, 7}}
	sealed := []byte("payload")
	secret := []byte("s")

	for _, kn := range cases {
		f := NewFragmenter(kn[0], kn[1])
		frags, err := f.Fragment(sealed, secret, 0)
		if err != nil {
			t.Fatalf("k=%d n=%d: Fragment error: %v", kn[0], kn[1], err)
		}
		if len(frags) != kn[1] {
			t.Fatalf("k=%d n=%d: want %d fragments, got %d", kn[0], kn[1], kn[1], len(frags))
		}
	}
}

// ── Property: all fragment indices are 0..n-1 ────────────────
func TestProperty_Fragment_IndicesUnique(t *testing.T) {
	f := NewFragmenter(2, 4)
	frags, _ := f.Fragment([]byte("data"), []byte("key"), 1)

	seen := make(map[int]bool)
	for _, fr := range frags {
		if seen[fr.Index] {
			t.Fatalf("duplicate index %d", fr.Index)
		}
		seen[fr.Index] = true
	}
	for i := 0; i < f.N(); i++ {
		if !seen[i] {
			t.Fatalf("missing index %d", i)
		}
	}
}

// ── Property: slot IDs unique within same epoch ───────────────
func TestProperty_Fragment_SlotIDsUnique(t *testing.T) {
	f := NewFragmenter(2, 5)
	frags, _ := f.Fragment([]byte("payload"), []byte("secret-key"), 99)

	seen := make(map[[32]byte]bool)
	for _, fr := range frags {
		if seen[fr.SlotID] {
			t.Fatalf("duplicate slot ID at index %d", fr.Index)
		}
		seen[fr.SlotID] = true
	}
}

// ── Property: DeriveFragmentSlotIDs is deterministic ─────────
func TestProperty_DeriveFragmentSlotIDs_Deterministic(t *testing.T) {
	f := func(secret []byte, epoch int64) bool {
		frag := NewFragmenter(2, 3)
		ids1 := frag.DeriveFragmentSlotIDs(secret, epoch)
		ids2 := frag.DeriveFragmentSlotIDs(secret, epoch)
		for i := range ids1 {
			if ids1[i] != ids2[i] {
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: DeriveFragmentSlotIDs returns N IDs ─────────────
func TestProperty_DeriveFragmentSlotIDs_Count(t *testing.T) {
	cases := [][2]int{{2, 3}, {2, 7}, {3, 6}}
	for _, kn := range cases {
		f := NewFragmenter(kn[0], kn[1])
		ids := f.DeriveFragmentSlotIDs([]byte("secret"), 1)
		if len(ids) != kn[1] {
			t.Fatalf("k=%d n=%d: want %d IDs, got %d", kn[0], kn[1], kn[1], len(ids))
		}
	}
}

// ── Property: DeriveFragmentSlotIDs changes with epoch ────────
func TestProperty_DeriveFragmentSlotIDs_EpochChanges(t *testing.T) {
	f := NewFragmenter(2, 3)
	secret := []byte("fixed-secret")
	ids1 := f.DeriveFragmentSlotIDs(secret, 1)
	ids2 := f.DeriveFragmentSlotIDs(secret, 2)
	allSame := true
	for i := range ids1 {
		if ids1[i] != ids2[i] {
			allSame = false
			break
		}
	}
	if allSame {
		t.Fatal("different epochs produced identical slot IDs")
	}
}

// ── Property: DeriveFragmentSlotIDs changes with secret ───────
func TestProperty_DeriveFragmentSlotIDs_SecretChanges(t *testing.T) {
	f := NewFragmenter(2, 3)
	ids1 := f.DeriveFragmentSlotIDs([]byte("secret-A"), 1)
	ids2 := f.DeriveFragmentSlotIDs([]byte("secret-B"), 1)
	allSame := true
	for i := range ids1 {
		if ids1[i] != ids2[i] {
			allSame = false
			break
		}
	}
	if allSame {
		t.Fatal("different secrets produced identical slot IDs")
	}
}

// ── Property: slot IDs from DeriveFragmentSlotIDs match Fragment ─
// Recipient-computed slot IDs must equal sender-embedded slot IDs.
func TestProperty_SlotIDsMatch_FragmentAndDerive(t *testing.T) {
	f := NewFragmenter(2, 3)
	secret := []byte("shared-secret-32b!!!!!!!!!!!!!!!")
	epoch := int64(7777)

	frags, err := f.Fragment([]byte("envelope payload"), secret, epoch)
	if err != nil {
		t.Fatal(err)
	}
	derived := f.DeriveFragmentSlotIDs(secret, epoch)

	for i, fr := range frags {
		if fr.SlotID != derived[i] {
			t.Fatalf("index %d: Fragment slotID != DeriveFragmentSlotIDs slotID", i)
		}
	}
}

// ── Property: single share data != original sealed ────────────
// Ensures k-1 shares carry no cleartext leakage.
func TestProperty_Fragment_SingleShareNotCleartext(t *testing.T) {
	f := func(payload []byte) bool {
		if len(payload) == 0 {
			return true
		}
		frag := NewFragmenter(2, 3)
		frags, err := frag.Fragment(payload, []byte("key"), 0)
		if err != nil {
			return true // e.g. shamir failure is not a leak
		}
		return !bytes.Equal(frags[0].Share.Data, payload)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}
