package audit

import (
	"context"
	"sort"
	"sync"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

type FileStore struct {
	mu    sync.RWMutex
	path  string
	codec filestore.Codec
	items []model.AuditEvent
}

func NewFileStore(path string) (*FileStore, error) {
	return NewFileStoreWithCodec(path, filestore.DefaultCodec())
}

func NewFileStoreWithCodec(path string, codec filestore.Codec) (*FileStore, error) {
	var items []model.AuditEvent
	if err := filestore.ReadJSONWithCodec(path, &items, codec); err != nil {
		return nil, err
	}

	return &FileStore{
		path:  path,
		codec: codec,
		items: cloneEvents(items),
	}, nil
}

func (s *FileStore) Append(_ context.Context, event model.AuditEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	next := cloneEvents(s.items)
	next = append(next, cloneEvent(event))
	sort.SliceStable(next, func(left, right int) bool {
		if next[left].CreatedAt.Equal(next[right].CreatedAt) {
			return next[left].ID < next[right].ID
		}
		return next[left].CreatedAt.Before(next[right].CreatedAt)
	})

	if err := filestore.WriteJSONAtomicWithCodec(s.path, next, s.codec); err != nil {
		return err
	}

	s.items = next
	return nil
}

func (s *FileStore) ListByTenant(_ context.Context, tenantID string) ([]model.AuditEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]model.AuditEvent, 0, len(s.items))
	for _, event := range s.items {
		if event.TenantID == tenantID {
			out = append(out, cloneEvent(event))
		}
	}
	return out, nil
}

func (s *FileStore) PruneBefore(_ context.Context, cutoff time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	next := make([]model.AuditEvent, 0, len(s.items))
	for _, event := range s.items {
		if event.CreatedAt.Before(cutoff) {
			continue
		}
		next = append(next, cloneEvent(event))
	}

	if err := filestore.WriteJSONAtomicWithCodec(s.path, next, s.codec); err != nil {
		return err
	}

	s.items = next
	return nil
}
