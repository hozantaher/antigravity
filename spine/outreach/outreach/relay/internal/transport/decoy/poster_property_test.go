package decoy

import (
	"relay/internal/deaddrop"
	"sync"
	"testing"
	"testing/quick"
	"time"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func newTestStore() *deaddrop.Store {
	return deaddrop.NewStore(deaddrop.Config{
		TTL:            time.Hour,
		MaxSlotSize:    200,
		MaxPayloadSize: 65536,
	})
}

func realSlot() deaddrop.SlotID {
	secret, _ := deaddrop.GenerateSharedSecret()
	return deaddrop.DeriveSlotID(secret, deaddrop.CurrentEpoch())
}

// ---------------------------------------------------------------------------
// Nil / edge-case safety
// ---------------------------------------------------------------------------

// TestNewPoster_NegativeRatio verifies that a negative decoyRatio is clamped
// to zero and PostWithDecoys still posts exactly one slot (the real one).
func TestNewPoster_NegativeRatio(t *testing.T) {
	store := newTestStore()
	poster := NewPoster(store, -5)

	slot := realSlot()
	if err := poster.PostWithDecoys(slot, []byte("payload")); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if store.SlotCount() != 1 {
		t.Fatalf("expected 1 slot, got %d", store.SlotCount())
	}
}

// TestPoster_EmptyPayload verifies that zero-length payloads don't panic.
func TestPoster_EmptyPayload(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on empty payload: %v", r)
		}
	}()
	store := newTestStore()
	poster := NewPoster(store, 2)
	slot := realSlot()
	// empty payload: generateDecoy will try rand.Read([]byte{}) — must not panic
	_ = poster.PostWithDecoys(slot, []byte{})
}

// TestPoster_LargePayload verifies no panic/hang for oversized payloads
// (the store will reject the Post with ErrPayloadSize; we don't crash).
func TestPoster_LargePayload(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on large payload: %v", r)
		}
	}()
	store := deaddrop.NewStore(deaddrop.Config{TTL: time.Hour, MaxPayloadSize: 32})
	poster := NewPoster(store, 1)
	slot := realSlot()
	// payload bigger than MaxPayloadSize → store.Post returns ErrPayloadSize
	err := poster.PostWithDecoys(slot, make([]byte, 1024))
	if err == nil {
		t.Fatal("expected error for oversized payload")
	}
}

// ---------------------------------------------------------------------------
// Property: decoy count is bounded
// ---------------------------------------------------------------------------

// TestPoster_DecoyCount_Property checks that after one PostWithDecoys call
// the store contains at most decoyRatio+1 slots (real + up to N decoys).
func TestPoster_DecoyCount_Property(t *testing.T) {
	f := func(ratio uint8) bool {
		r := int(ratio) % 10 // keep max ratio at 9 for speed
		store := newTestStore()
		poster := NewPoster(store, r)
		slot := realSlot()

		if err := poster.PostWithDecoys(slot, []byte("prop-test")); err != nil {
			return false
		}
		// Slot count can be <= r+1 because random decoy slots might collide
		// with each other (astronomically unlikely but allowed).
		return store.SlotCount() <= r+1
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// Property: real slot always gets exactly one message
// ---------------------------------------------------------------------------

// TestPoster_RealSlotAlwaysOne verifies the real message always lands in the
// expected slot regardless of the decoy ratio.
func TestPoster_RealSlotAlwaysOne(t *testing.T) {
	f := func(ratio uint8) bool {
		r := int(ratio) % 8
		store := newTestStore()
		poster := NewPoster(store, r)
		slot := realSlot()

		if err := poster.PostWithDecoys(slot, []byte("real")); err != nil {
			return false
		}
		return store.Peek(slot) == 1
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// Property: NeverPanics with arbitrary payload bytes
// ---------------------------------------------------------------------------

// TestPoster_NeverPanics_Property exercises PostWithDecoys with arbitrary
// byte slices up to 4096 bytes to prove no panics.
func TestPoster_NeverPanics_Property(t *testing.T) {
	f := func(payload []byte) bool {
		defer func() { recover() }()

		store := newTestStore()
		poster := NewPoster(store, 2)
		slot := realSlot()
		_ = poster.PostWithDecoys(slot, payload)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// generateDecoy: structural integrity
// ---------------------------------------------------------------------------

// TestGenerateDecoy_ReturnsHexEncoded verifies that generateDecoy output is
// valid hex (non-empty, even length, all hex chars) for common sizes.
func TestGenerateDecoy_ReturnsHexEncoded(t *testing.T) {
	p := NewPoster(newTestStore(), 0)
	for _, size := range []int{0, 1, 16, 64, 512} {
		out, err := p.generateDecoy(size)
		if err != nil {
			t.Fatalf("generateDecoy(%d) error: %v", size, err)
		}
		if len(out)%2 != 0 {
			t.Fatalf("generateDecoy(%d) returned odd-length hex: %d bytes", size, len(out))
		}
		for _, b := range out {
			if !isHexByte(b) {
				t.Fatalf("generateDecoy(%d) returned non-hex byte 0x%02x", size, b)
			}
		}
	}
}

func isHexByte(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

// ---------------------------------------------------------------------------
// Monkey: concurrent PostWithDecoys on shared store
// ---------------------------------------------------------------------------

// TestPoster_ConcurrentPost_NoRace fires multiple goroutines posting to the
// same store concurrently and verifies no data races (run with -race).
func TestPoster_ConcurrentPost_NoRace(t *testing.T) {
	store := newTestStore()
	poster := NewPoster(store, 2)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			slot := realSlot()
			_ = poster.PostWithDecoys(slot, []byte("concurrent"))
		}()
	}
	wg.Wait()

	// 16 real posts → at least 16 slots, at most 16*3 = 48 (plus collisions).
	count := store.SlotCount()
	if count < 16 {
		t.Fatalf("expected ≥16 slots after 16 concurrent posts, got %d", count)
	}
}

// ---------------------------------------------------------------------------
// randomSlotID: statistical uniqueness (internal function, white-box)
// ---------------------------------------------------------------------------

// TestRandomSlotID_Unique generates 1000 slot IDs and verifies no collisions.
func TestRandomSlotID_Unique(t *testing.T) {
	const n = 1000
	seen := make(map[deaddrop.SlotID]struct{}, n)
	for i := 0; i < n; i++ {
		id := randomSlotID()
		if _, dup := seen[id]; dup {
			t.Fatalf("collision at iteration %d — randomSlotID not unique", i)
		}
		seen[id] = struct{}{}
	}
}
