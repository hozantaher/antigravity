package identityvault

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
	items []model.IdentityLink
}

func NewFileRepository(path string) (*FileRepository, error) {
	return NewFileRepositoryWithCodec(path, filestore.DefaultCodec())
}

func NewFileRepositoryWithCodec(path string, codec filestore.Codec) (*FileRepository, error) {
	var items []model.IdentityLink
	if err := filestore.ReadJSONWithCodec(path, &items, codec); err != nil {
		return nil, err
	}

	return &FileRepository{
		path:  path,
		codec: codec,
		items: cloneIdentityLinks(items),
	}, nil
}

func (r *FileRepository) Save(_ context.Context, link model.IdentityLink) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := cloneIdentityLinks(r.items)
	updated := false
	for index, existing := range next {
		if existing.TenantID == link.TenantID && existing.AliasID == link.AliasID {
			next[index] = cloneIdentityLink(link)
			updated = true
			break
		}
	}
	if !updated {
		next = append(next, cloneIdentityLink(link))
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

func (r *FileRepository) GetByAliasID(_ context.Context, tenantID, aliasID string) (model.IdentityLink, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, link := range r.items {
		if link.TenantID == tenantID && link.AliasID == aliasID {
			return cloneIdentityLink(link), nil
		}
	}
	return model.IdentityLink{}, ErrIdentityLinkNotFound
}

func (r *FileRepository) ListByTenant(_ context.Context, tenantID string) ([]model.IdentityLink, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]model.IdentityLink, 0, len(r.items))
	for _, link := range r.items {
		if link.TenantID == tenantID {
			out = append(out, cloneIdentityLink(link))
		}
	}
	return out, nil
}

func (r *FileRepository) PruneInactiveBefore(_ context.Context, cutoff time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := make([]model.IdentityLink, 0, len(r.items))
	for _, link := range r.items {
		if shouldPruneInactiveLink(link, cutoff) {
			continue
		}
		next = append(next, cloneIdentityLink(link))
	}

	if err := filestore.WriteJSONAtomicWithCodec(r.path, next, r.codec); err != nil {
		return err
	}

	r.items = next
	return nil
}

func cloneIdentityLinks(items []model.IdentityLink) []model.IdentityLink {
	return append([]model.IdentityLink(nil), items...)
}
