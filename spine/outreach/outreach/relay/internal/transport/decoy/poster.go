package decoy

import (
	"relay/internal/delivery/contentenc"
	"relay/internal/deaddrop"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"io"
)

// randReader is the random source used by generateDecoy and randomSlotID.
// Tests may replace it with a deterministic or error-injecting reader.
var randReader io.Reader = rand.Reader

// Poster adds decoy messages to random dead drop slots alongside real posts.
// Decoys are structurally identical to real messages -- same size, same encryption
// format -- but encrypted to throwaway keys. No recipient can decrypt them.
// This makes slot occupancy patterns uniform, defeating occupancy analysis.
type Poster struct {
	store      *deaddrop.Store
	sealer     *contentenc.Sealer
	decoyRatio int
}

// NewPoster creates a decoy poster with the given ratio.
// decoyRatio=3 means 3 decoy posts per real message.
func NewPoster(store *deaddrop.Store, decoyRatio int) *Poster {
	if decoyRatio < 0 {
		decoyRatio = 0
	}
	return &Poster{
		store:      store,
		sealer:     contentenc.NewSealer(),
		decoyRatio: decoyRatio,
	}
}

// PostWithDecoys posts the real payload to realSlotID and N decoys to random slots.
func (p *Poster) PostWithDecoys(realSlotID deaddrop.SlotID, payload []byte) error {
	// Post real message
	if err := p.store.Post(realSlotID, payload); err != nil {
		return err
	}

	// Post decoys to random slots
	for i := 0; i < p.decoyRatio; i++ {
		decoySlot := randomSlotID()
		decoyPayload, err := p.generateDecoy(len(payload))
		if err != nil {
			continue // best effort -- don't fail the real post
		}
		p.store.Post(decoySlot, decoyPayload) // ignore errors on decoys
	}

	return nil
}

// generateDecoy creates a sealed message encrypted to a throwaway key.
// Structurally identical to a real sealed message.
func (p *Poster) generateDecoy(size int) ([]byte, error) {
	// Generate throwaway X25519 key pair
	curve := ecdh.X25519()
	throwaway, err := curve.GenerateKey(randReader)
	if err != nil {
		return nil, err
	}

	// Random plaintext of similar size
	plaintext := make([]byte, size)
	randReader.Read(plaintext)

	// Seal with throwaway public key -- no one can decrypt
	sealed, err := p.sealer.Seal(plaintext, throwaway.PublicKey().Bytes())
	if err != nil {
		return nil, err
	}

	return []byte(hex.EncodeToString(sealed)), nil
}

func randomSlotID() deaddrop.SlotID {
	var id deaddrop.SlotID
	randReader.Read(id[:])
	return id
}
