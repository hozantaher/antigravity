package pool

import (
	"relay/internal/model"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"sync"
	"time"
)

// MixPool holds messages and emits them in random order.
// Messages enter via Submit(). The constant-rate Emitter calls Draw() on each tick.
//
// The pool is the core anonymity mechanism: an adversary who sees a message
// enter and later exit cannot determine which exit corresponds to which entry
// better than 1/N probability, where N is the pool size.
//
// If the pool has fewer than minSize real messages, Draw() returns cover traffic
// to maintain the anonymity set guarantee.
type MixPool struct {
	mu       sync.Mutex
	messages []model.Envelope
	minSize  int
}

// NewMixPool creates a pool with the given minimum size.
// minSize is the anonymity set -- the pool won't emit real messages
// until it holds at least this many.
func NewMixPool(minSize int) *MixPool {
	if minSize < 1 {
		minSize = 1
	}
	return &MixPool{
		minSize: minSize,
	}
}

// Submit adds a message to the pool. Returns immediately.
// The message will exit at some future tick, selected randomly.
func (p *MixPool) Submit(env model.Envelope) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.messages = append(p.messages, env)
}

// Requeue returns a message to the pool after failed delivery.
func (p *MixPool) Requeue(env model.Envelope) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.messages = append(p.messages, env)
}

// Draw selects and removes one random message from the pool.
// If pool size < minSize, returns cover traffic instead (isReal=false).
// Called by the Emitter on each tick.
func (p *MixPool) Draw() (model.Envelope, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.messages) < p.minSize {
		return generateCover(), false
	}

	// Select uniformly at random using crypto/rand
	idx, err := cryptoRandIntn(len(p.messages))
	if err != nil {
		// Fallback: take first (degraded security, should not happen)
		idx = 0
	}

	env := p.messages[idx]
	// Remove by swap with last
	p.messages[idx] = p.messages[len(p.messages)-1]
	p.messages = p.messages[:len(p.messages)-1]

	return env, true
}

// Size returns the current pool size.
func (p *MixPool) Size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.messages)
}

// MinSize returns the anonymity set threshold.
func (p *MixPool) MinSize() int {
	return p.minSize
}

// generateCover creates a cover envelope indistinguishable from real traffic.
func generateCover() model.Envelope {
	id := make([]byte, 8)
	rand.Read(id)

	token := make([]byte, 16)
	rand.Read(token)

	// Use random size class
	classes := model.SizeClasses()
	classIdx, _ := cryptoRandIntn(len(classes))
	sc := classes[classIdx]

	content := make([]byte, sc)
	rand.Read(content)

	return model.Envelope{
		ID:            "env_" + hex.EncodeToString(id),
		AliasToken:    hex.EncodeToString(token),
		SealedContent: content,
		SizeClass:     sc,
		BucketedAt:    time.Now().UTC().Truncate(15 * time.Minute),
		IntakeChannel: "cover",
		Status:        model.StatusScheduled,
		IsCover:       true,
	}
}

func cryptoRandIntn(n int) (int, error) {
	if n <= 0 {
		return 0, nil
	}
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return 0, err
	}
	return int(binary.BigEndian.Uint64(buf[:]) % uint64(n)), nil
}
