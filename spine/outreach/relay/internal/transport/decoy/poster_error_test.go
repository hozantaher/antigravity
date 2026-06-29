package decoy

import (
	"errors"
	"relay/internal/deaddrop"
	"testing"
	"time"
)

// errReader is an io.Reader that always returns an error.
type errReader struct{}

func (errReader) Read(_ []byte) (int, error) {
	return 0, errors.New("injected rand failure")
}

// TestGenerateDecoy_RandReaderError verifies that generateDecoy returns an error
// when the random reader fails (covers lines 60-62: curve.GenerateKey error path).
func TestGenerateDecoy_RandReaderError(t *testing.T) {
	orig := randReader
	randReader = errReader{}
	t.Cleanup(func() { randReader = orig })

	p := NewPoster(deaddrop.NewStore(deaddrop.Config{TTL: time.Hour}), 0)
	_, err := p.generateDecoy(16)
	if err == nil {
		t.Fatal("expected error when rand reader fails in generateDecoy")
	}
}

// TestPostWithDecoys_GenerateDecoyError verifies that PostWithDecoys continues
// gracefully (does not fail) when generateDecoy returns an error for decoys
// (covers the continue path at line 45-46).
func TestPostWithDecoys_GenerateDecoyError(t *testing.T) {
	orig := randReader
	randReader = errReader{}
	t.Cleanup(func() { randReader = orig })

	// Use a real slot ID derived before we swap the reader.
	var slot deaddrop.SlotID
	// Set the slot manually with known bytes.
	for i := range slot {
		slot[i] = byte(i)
	}

	store := deaddrop.NewStore(deaddrop.Config{TTL: time.Hour, MaxSlotSize: 10, MaxPayloadSize: 65536})
	poster := &Poster{
		store:      store,
		sealer:     nil, // not reached: generateDecoy fails before sealing
		decoyRatio: 3,
	}

	// Post the real message directly to bypass the poster's sealer.
	// We test the continue path in PostWithDecoys: the real Post succeeds
	// but all generateDecoy calls fail, so we continue without panicking.
	err := store.Post(slot, []byte("real"))
	if err != nil {
		t.Fatalf("real post setup failed: %v", err)
	}

	// Now call PostWithDecoys on a different slot for the real post.
	var slot2 deaddrop.SlotID
	for i := range slot2 {
		slot2[i] = byte(i + 100)
	}
	// PostWithDecoys will succeed for real post, then try decoys.
	// Decoys will fail in generateDecoy due to errReader, so they are skipped.
	// PostWithDecoys must not return an error.
	err = poster.PostWithDecoys(slot2, []byte("test payload"))
	if err != nil {
		t.Fatalf("PostWithDecoys should not fail when decoy generation errors: %v", err)
	}
}
