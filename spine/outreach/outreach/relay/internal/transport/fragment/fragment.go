package fragment

import (
	"relay/internal/deaddrop"
	"relay/internal/shamir"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

var (
	ErrNotEnoughShares = errors.New("not enough shares to reassemble")
	ErrReassemblyFailed = errors.New("reassembly failed")
)

// FragmentedShare is one piece of a fragmented message.
type FragmentedShare struct {
	Index   int            `json:"index"`
	SlotID  deaddrop.SlotID `json:"slot_id"`
	Share   shamir.Share   `json:"share"`
}

// Fragmenter splits messages into K-of-N Shamir shares,
// each posted to a different dead drop slot.
type Fragmenter struct {
	k int
	n int
}

// NewFragmenter creates a fragmenter with the given K-of-N parameters.
// K=2, N=3 means split into 3 shares, any 2 reconstruct.
func NewFragmenter(k, n int) *Fragmenter {
	if k < 2 {
		k = 2
	}
	if n < k {
		n = k
	}
	return &Fragmenter{k: k, n: n}
}

// Fragment splits sealed content into N shares, each with its own slot ID.
// Slot IDs are derived deterministically so the recipient can compute them.
//
// SlotID[i] = HMAC-SHA256(sharedSecret, "deaddrop-fragment" || epoch || index)
func (f *Fragmenter) Fragment(sealed []byte, sharedSecret []byte, epoch int64) ([]FragmentedShare, error) {
	shares, err := shamir.Split(sealed, f.k, f.n)
	if err != nil {
		return nil, fmt.Errorf("shamir split: %w", err)
	}

	fragments := make([]FragmentedShare, f.n)
	for i, share := range shares {
		slotID := deriveFragmentSlotID(sharedSecret, epoch, i)
		fragments[i] = FragmentedShare{
			Index:  i,
			SlotID: slotID,
			Share:  share,
		}
	}

	return fragments, nil
}

// Reassemble reconstructs the original sealed content from K or more shares.
func (f *Fragmenter) Reassemble(fragments []FragmentedShare) ([]byte, error) {
	if len(fragments) < f.k {
		return nil, ErrNotEnoughShares
	}

	shares := make([]shamir.Share, len(fragments))
	for i, frag := range fragments {
		shares[i] = frag.Share
	}

	secret, err := shamir.Combine(shares, f.k)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrReassemblyFailed, err)
	}

	return secret, nil
}

// DeriveFragmentSlotIDs computes all N slot IDs for a given secret and epoch.
// Used by the recipient to know which slots to poll.
func (f *Fragmenter) DeriveFragmentSlotIDs(sharedSecret []byte, epoch int64) []deaddrop.SlotID {
	slots := make([]deaddrop.SlotID, f.n)
	for i := 0; i < f.n; i++ {
		slots[i] = deriveFragmentSlotID(sharedSecret, epoch, i)
	}
	return slots
}

// K returns the minimum shares needed.
func (f *Fragmenter) K() int { return f.k }

// N returns the total shares produced.
func (f *Fragmenter) N() int { return f.n }

func deriveFragmentSlotID(sharedSecret []byte, epoch int64, index int) deaddrop.SlotID {
	h := hmac.New(sha256.New, sharedSecret)
	h.Write([]byte("deaddrop-fragment"))
	var epochBuf [8]byte
	binary.BigEndian.PutUint64(epochBuf[:], uint64(epoch))
	h.Write(epochBuf[:])
	var indexBuf [4]byte
	binary.BigEndian.PutUint32(indexBuf[:], uint32(index))
	h.Write(indexBuf[:])
	var id deaddrop.SlotID
	copy(id[:], h.Sum(nil))
	return id
}
