package pool

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"sync"
)

// PersistentPool wraps MixPool with encrypted disk persistence.
// On every Submit/Draw/Requeue, the pool state is serialized to disk.
// On restart, the pool is restored -- eliminates restart-timing side channel.
type PersistentPool struct {
	pool  *MixPool
	path  string
	codec filestore.Codec
	mu    sync.Mutex
}

// NewPersistentPool creates a pool that survives restarts.
func NewPersistentPool(minSize int, path string, codec filestore.Codec) (*PersistentPool, error) {
	p := &PersistentPool{
		pool:  NewMixPool(minSize),
		path:  path,
		codec: codec,
	}
	// Restore from disk
	var saved []model.Envelope
	if err := filestore.ReadJSON(path, codec, &saved); err != nil {
		return nil, err
	}
	for _, env := range saved {
		p.pool.Submit(env)
	}
	return p, nil
}

func (p *PersistentPool) Submit(env model.Envelope) {
	p.pool.Submit(env)
	p.save()
}

func (p *PersistentPool) Draw() (model.Envelope, bool) {
	env, isReal := p.pool.Draw()
	if isReal {
		p.save()
	}
	return env, isReal
}

func (p *PersistentPool) Requeue(env model.Envelope) {
	p.pool.Requeue(env)
	p.save()
}

func (p *PersistentPool) Size() int  { return p.pool.Size() }
func (p *PersistentPool) MinSize() int { return p.pool.MinSize() }

func (p *PersistentPool) save() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pool.mu.Lock()
	msgs := make([]model.Envelope, len(p.pool.messages))
	copy(msgs, p.pool.messages)
	p.pool.mu.Unlock()
	filestore.WriteJSONAtomic(p.path, p.codec, msgs)
}
