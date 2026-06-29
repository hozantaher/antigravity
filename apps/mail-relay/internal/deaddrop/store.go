package deaddrop

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"sync"
	"time"
)

var (
	ErrSlotFull    = errors.New("dead drop slot is full")
	ErrSlotEmpty   = errors.New("dead drop slot is empty or expired")
	ErrPayloadSize = errors.New("payload exceeds maximum size")
)

// SlotID is an opaque 32-byte identifier derived from a shared secret.
// Without the secret, slot IDs are indistinguishable from random data.
type SlotID [32]byte

// DeriveSlotID computes a slot ID from a shared secret and the current epoch.
// The epoch rotates the slot ID periodically to prevent long-term correlation.
//
// SlotID = HMAC-SHA256(sharedSecret, "deaddrop-slot" || epochBytes)
func DeriveSlotID(sharedSecret []byte, epoch int64) SlotID {
	h := hmac.New(sha256.New, sharedSecret)
	h.Write([]byte("deaddrop-slot"))
	var epochBuf [8]byte
	binary.BigEndian.PutUint64(epochBuf[:], uint64(epoch))
	h.Write(epochBuf[:])
	var id SlotID
	copy(id[:], h.Sum(nil))
	return id
}

// CurrentEpoch returns the current epoch (hours since Unix epoch).
// Slot IDs rotate every hour.
func CurrentEpoch() int64 {
	return time.Now().Unix() / 3600
}

// Slot holds messages for one dead drop location.
type Slot struct {
	messages  [][]byte
	createdAt time.Time
}

// Store is an in-memory dead drop where senders post and recipients poll.
// Messages are stored under opaque slot IDs derived from shared secrets.
// The store cannot determine which sender or recipient owns which slot.
type Store struct {
	mu             sync.RWMutex
	slots          map[SlotID]*Slot
	ttl            time.Duration
	maxSlotSize    int // max messages per slot
	maxPayloadSize int // max bytes per message
	now            func() time.Time
}

// Config for the dead drop store.
type Config struct {
	TTL            time.Duration // slot expiry (default: 24h)
	MaxSlotSize    int           // max messages per slot (default: 100)
	MaxPayloadSize int           // max bytes per message (default: 65536)
}

// NewStore creates a dead drop store with the given configuration.
func NewStore(cfg Config) *Store {
	if cfg.TTL <= 0 {
		cfg.TTL = 24 * time.Hour
	}
	if cfg.MaxSlotSize <= 0 {
		cfg.MaxSlotSize = 100
	}
	if cfg.MaxPayloadSize <= 0 {
		cfg.MaxPayloadSize = 65536
	}
	return &Store{
		slots:          make(map[SlotID]*Slot),
		ttl:            cfg.TTL,
		maxSlotSize:    cfg.MaxSlotSize,
		maxPayloadSize: cfg.MaxPayloadSize,
		now:            time.Now,
	}
}

// Post adds a message to a slot. Creates the slot if it does not exist.
// The sender knows the SlotID but the store does not know the sender.
func (s *Store) Post(id SlotID, ciphertext []byte) error {
	if len(ciphertext) > s.maxPayloadSize {
		return ErrPayloadSize
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	slot, ok := s.slots[id]
	if !ok {
		slot = &Slot{createdAt: s.now()}
		s.slots[id] = slot
	}

	if len(slot.messages) >= s.maxSlotSize {
		return ErrSlotFull
	}

	// Copy to prevent caller from modifying stored data
	msg := make([]byte, len(ciphertext))
	copy(msg, ciphertext)
	slot.messages = append(slot.messages, msg)
	return nil
}

// Poll retrieves and removes all messages from a slot.
// The recipient polls on a schedule. After retrieval, messages are gone.
func (s *Store) Poll(id SlotID) ([][]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	slot, ok := s.slots[id]
	if !ok {
		return nil, nil // empty slot, not an error
	}

	// Check TTL
	if s.now().Sub(slot.createdAt) > s.ttl {
		delete(s.slots, id)
		return nil, nil
	}

	messages := slot.messages
	delete(s.slots, id) // remove slot after poll
	return messages, nil
}

// Peek returns the number of messages in a slot without removing them.
func (s *Store) Peek(id SlotID) int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	slot, ok := s.slots[id]
	if !ok {
		return 0
	}
	return len(slot.messages)
}

// GC removes expired slots. Call periodically.
func (s *Store) GC() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	removed := 0
	for id, slot := range s.slots {
		if now.Sub(slot.createdAt) > s.ttl {
			delete(s.slots, id)
			removed++
		}
	}
	return removed
}

// SlotCount returns the number of active slots.
func (s *Store) SlotCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.slots)
}

// GenerateSharedSecret creates a random 32-byte shared secret
// for deriving slot IDs. Share this between sender and recipient
// out-of-band. The relay never sees it.
func GenerateSharedSecret() ([]byte, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	return secret, nil
}
