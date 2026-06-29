package alias

import (
	"context"
	"sort"
	"sync"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

type FileRepository struct {
	mu    sync.RWMutex
	path  string
	codec filestore.Codec
	items []model.Alias
}

func NewFileRepository(path string) (*FileRepository, error) {
	return NewFileRepositoryWithCodec(path, filestore.DefaultCodec())
}

func NewFileRepositoryWithCodec(path string, codec filestore.Codec) (*FileRepository, error) {
	var items []model.Alias
	if err := filestore.ReadJSONWithCodec(path, &items, codec); err != nil {
		return nil, err
	}

	return &FileRepository{
		path:  path,
		codec: codec,
		items: cloneAliases(items),
	}, nil
}

func (r *FileRepository) Save(_ context.Context, alias model.Alias) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := cloneAliases(r.items)
	updated := false
	for index, existing := range next {
		if existing.ID == alias.ID {
			next[index] = alias
			updated = true
			break
		}
	}
	if !updated {
		next = append(next, alias)
	}

	sort.SliceStable(next, func(left, right int) bool {
		if next[left].CreatedAt.Equal(next[right].CreatedAt) {
			return next[left].ID < next[right].ID
		}
		return next[left].CreatedAt.Before(next[right].CreatedAt)
	})

	if err := filestore.WriteJSONAtomicWithCodec(r.path, next, r.codec); err != nil {
		return err
	}

	r.items = next
	return nil
}

func (r *FileRepository) GetByID(_ context.Context, id string) (model.Alias, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, alias := range r.items {
		if alias.ID == id {
			return alias, nil
		}
	}

	return model.Alias{}, ErrAliasNotFound
}

func (r *FileRepository) ListByOwner(_ context.Context, tenantID, userID string) ([]model.Alias, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]model.Alias, 0, len(r.items))
	for _, alias := range r.items {
		if alias.TenantID == tenantID && alias.UserID == userID {
			out = append(out, alias)
		}
	}

	return out, nil
}

func (r *FileRepository) PruneBefore(_ context.Context, cutoff time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := make([]model.Alias, 0, len(r.items))
	for _, a := range r.items {
		if a.CreatedAt.Before(cutoff) {
			continue
		}
		next = append(next, a)
	}

	if err := filestore.WriteJSONAtomicWithCodec(r.path, next, r.codec); err != nil {
		return err
	}

	r.items = next
	return nil
}

func cloneAliases(items []model.Alias) []model.Alias {
	return append([]model.Alias(nil), items...)
}
