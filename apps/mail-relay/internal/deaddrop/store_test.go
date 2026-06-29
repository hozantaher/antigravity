package deaddrop

import (
	"testing"
	"time"
)

func TestPostAndPoll(t *testing.T) {
	store := NewStore(Config{TTL: time.Hour})

	secret, _ := GenerateSharedSecret()
	slotID := DeriveSlotID(secret, CurrentEpoch())

	// Post
	if err := store.Post(slotID, []byte("encrypted message 1")); err != nil {
		t.Fatal(err)
	}
	if err := store.Post(slotID, []byte("encrypted message 2")); err != nil {
		t.Fatal(err)
	}

	if store.Peek(slotID) != 2 {
		t.Fatalf("expected 2 messages, got %d", store.Peek(slotID))
	}

	// Poll
	msgs, err := store.Poll(slotID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}

	// After poll, slot should be empty
	if store.Peek(slotID) != 0 {
		t.Fatal("slot should be empty after poll")
	}
}

func TestPollEmptySlot(t *testing.T) {
	store := NewStore(Config{TTL: time.Hour})

	secret, _ := GenerateSharedSecret()
	slotID := DeriveSlotID(secret, CurrentEpoch())

	msgs, err := store.Poll(slotID)
	if err != nil {
		t.Fatal(err)
	}
	if msgs != nil {
		t.Fatal("expected nil for empty slot")
	}
}

func TestSlotTTL(t *testing.T) {
	store := NewStore(Config{TTL: time.Millisecond})
	store.now = time.Now

	secret, _ := GenerateSharedSecret()
	slotID := DeriveSlotID(secret, CurrentEpoch())

	store.Post(slotID, []byte("message"))
	time.Sleep(5 * time.Millisecond)

	// Should be expired
	msgs, _ := store.Poll(slotID)
	if len(msgs) != 0 {
		t.Fatal("expected empty after TTL")
	}
}

func TestSlotFull(t *testing.T) {
	store := NewStore(Config{MaxSlotSize: 2})

	secret, _ := GenerateSharedSecret()
	slotID := DeriveSlotID(secret, CurrentEpoch())

	store.Post(slotID, []byte("msg1"))
	store.Post(slotID, []byte("msg2"))

	err := store.Post(slotID, []byte("msg3"))
	if err != ErrSlotFull {
		t.Fatalf("expected ErrSlotFull, got %v", err)
	}
}

func TestPayloadSizeLimit(t *testing.T) {
	store := NewStore(Config{MaxPayloadSize: 10})

	secret, _ := GenerateSharedSecret()
	slotID := DeriveSlotID(secret, CurrentEpoch())

	err := store.Post(slotID, make([]byte, 100))
	if err != ErrPayloadSize {
		t.Fatalf("expected ErrPayloadSize, got %v", err)
	}
}

func TestGC(t *testing.T) {
	store := NewStore(Config{TTL: time.Millisecond})

	secret1, _ := GenerateSharedSecret()
	secret2, _ := GenerateSharedSecret()
	id1 := DeriveSlotID(secret1, CurrentEpoch())
	id2 := DeriveSlotID(secret2, CurrentEpoch())

	store.Post(id1, []byte("msg1"))
	store.Post(id2, []byte("msg2"))

	time.Sleep(5 * time.Millisecond)

	removed := store.GC()
	if removed != 2 {
		t.Fatalf("expected 2 removed, got %d", removed)
	}
	if store.SlotCount() != 0 {
		t.Fatalf("expected 0 slots, got %d", store.SlotCount())
	}
}

func TestSlotIDDeterministic(t *testing.T) {
	secret := []byte("test-secret-32-bytes-long-xxxxx")
	epoch := int64(12345)

	id1 := DeriveSlotID(secret, epoch)
	id2 := DeriveSlotID(secret, epoch)

	if id1 != id2 {
		t.Fatal("same secret + epoch should produce same slot ID")
	}
}

func TestSlotIDRotatesWithEpoch(t *testing.T) {
	secret := []byte("test-secret-32-bytes-long-xxxxx")

	id1 := DeriveSlotID(secret, 100)
	id2 := DeriveSlotID(secret, 101)

	if id1 == id2 {
		t.Fatal("different epochs should produce different slot IDs")
	}
}

func TestDifferentSecretsProduceDifferentSlots(t *testing.T) {
	s1, _ := GenerateSharedSecret()
	s2, _ := GenerateSharedSecret()
	epoch := CurrentEpoch()

	id1 := DeriveSlotID(s1, epoch)
	id2 := DeriveSlotID(s2, epoch)

	if id1 == id2 {
		t.Fatal("different secrets should produce different slot IDs")
	}
}
