package inbox

import (
	"context"
	"sync"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

type cursorState struct {
	ProviderUID string    `json:"provider_uid"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type CursorStore struct {
	mu        sync.RWMutex
	path      string
	codec     filestore.Codec
	now       func() time.Time
	retention time.Duration
	cursors   map[string]cursorState
}

func NewCursorStore(path string) (*CursorStore, error) {
	return NewCursorStoreWithCodec(path, filestore.DefaultCodec())
}

func NewCursorStoreWithCodec(path string, codec filestore.Codec) (*CursorStore, error) {
	return NewCursorStoreWithCodecAndRetention(path, codec, 0)
}

func NewCursorStoreWithCodecAndRetention(path string, codec filestore.Codec, retention time.Duration) (*CursorStore, error) {
	state, err := readCursorStateWithCodec(path, codec)
	if err != nil {
		return nil, err
	}

	return &CursorStore{
		path:      path,
		codec:     codec,
		now:       time.Now,
		retention: retention,
		cursors:   cloneCursorStateMap(state),
	}, nil
}

func (s *CursorStore) Load(ctx context.Context, actor model.Actor) (string, error) {
	if err := s.pruneExpired(ctx); err != nil {
		return "", err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cursors[cursorKey(actor)].ProviderUID, nil
}

func (s *CursorStore) Save(ctx context.Context, actor model.Actor, providerUID string) error {
	if err := s.pruneExpired(ctx); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	next := cloneCursorStateMap(s.cursors)
	key := cursorKey(actor)
	if providerUID == "" {
		delete(next, key)
	} else {
		next[key] = cursorState{
			ProviderUID: providerUID,
			UpdatedAt:   s.now().UTC(),
		}
	}

	if err := filestore.WriteJSONAtomicWithCodec(s.path, next, s.codec); err != nil {
		return err
	}

	s.cursors = next
	return nil
}

func (s *CursorStore) PruneBefore(_ context.Context, cutoff time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	next := make(map[string]cursorState, len(s.cursors))
	for key, state := range s.cursors {
		if !state.UpdatedAt.IsZero() && state.UpdatedAt.Before(cutoff) {
			continue
		}
		next[key] = state
	}

	if err := filestore.WriteJSONAtomicWithCodec(s.path, next, s.codec); err != nil {
		return err
	}

	s.cursors = next
	return nil
}

func (s *CursorStore) pruneExpired(ctx context.Context) error {
	if s.retention <= 0 {
		return nil
	}
	return s.PruneBefore(ctx, s.now().UTC().Add(-s.retention))
}

func cursorKey(actor model.Actor) string {
	return actor.TenantID + ":" + actor.ID
}

func cloneCursorStateMap(in map[string]cursorState) map[string]cursorState {
	out := make(map[string]cursorState, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func readCursorStateWithCodec(path string, codec filestore.Codec) (map[string]cursorState, error) {
	state := map[string]cursorState{}
	if err := filestore.ReadJSONWithCodec(path, &state, codec); err == nil {
		return state, nil
	}

	legacy := map[string]string{}
	if err := filestore.ReadJSONWithCodec(path, &legacy, codec); err != nil {
		return nil, err
	}

	upgraded := make(map[string]cursorState, len(legacy))
	for key, value := range legacy {
		upgraded[key] = cursorState{ProviderUID: value}
	}
	return upgraded, nil
}
