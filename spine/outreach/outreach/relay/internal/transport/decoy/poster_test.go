package decoy

import (
	"relay/internal/deaddrop"
	"testing"
	"time"
)

func TestPostWithDecoys(t *testing.T) {
	store := deaddrop.NewStore(deaddrop.Config{TTL: time.Hour, MaxSlotSize: 100})
	poster := NewPoster(store, 3)

	secret, _ := deaddrop.GenerateSharedSecret()
	realSlot := deaddrop.DeriveSlotID(secret, deaddrop.CurrentEpoch())

	err := poster.PostWithDecoys(realSlot, []byte("real message"))
	if err != nil {
		t.Fatal(err)
	}

	// Real slot should have 1 message
	if store.Peek(realSlot) != 1 {
		t.Fatalf("expected 1 message in real slot, got %d", store.Peek(realSlot))
	}

	// Total slots should be 1 (real) + 3 (decoys) = 4
	if store.SlotCount() < 2 {
		t.Fatalf("expected at least 2 slots (real + decoys), got %d", store.SlotCount())
	}
}

func TestDecoyRatioZero(t *testing.T) {
	store := deaddrop.NewStore(deaddrop.Config{TTL: time.Hour})
	poster := NewPoster(store, 0)

	secret, _ := deaddrop.GenerateSharedSecret()
	slot := deaddrop.DeriveSlotID(secret, deaddrop.CurrentEpoch())

	poster.PostWithDecoys(slot, []byte("no decoys"))

	if store.SlotCount() != 1 {
		t.Fatalf("expected 1 slot (no decoys), got %d", store.SlotCount())
	}
}
