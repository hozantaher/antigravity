package identityvault

import (
	"context"
	"errors"
	"sync"
	"time"

	"privacy-gateway/internal/model"
)

var ErrIdentityLinkNotFound = errors.New("identity link not found")

type MemoryRepository struct {
	mu       sync.RWMutex
	byAlias  map[string]model.IdentityLink
	byTenant map[string][]string
}

func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{
		byAlias:  make(map[string]model.IdentityLink),
		byTenant: make(map[string][]string),
	}
}

func (r *MemoryRepository) Save(_ context.Context, link model.IdentityLink) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	key := tenantAliasKey(link.TenantID, link.AliasID)
	if _, exists := r.byAlias[key]; !exists {
		r.byTenant[link.TenantID] = append(r.byTenant[link.TenantID], key)
	}
	r.byAlias[key] = cloneIdentityLink(link)
	return nil
}

func (r *MemoryRepository) GetByAliasID(_ context.Context, tenantID, aliasID string) (model.IdentityLink, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	link, ok := r.byAlias[tenantAliasKey(tenantID, aliasID)]
	if !ok {
		return model.IdentityLink{}, ErrIdentityLinkNotFound
	}
	return cloneIdentityLink(link), nil
}

func (r *MemoryRepository) ListByTenant(_ context.Context, tenantID string) ([]model.IdentityLink, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	keys := r.byTenant[tenantID]
	out := make([]model.IdentityLink, 0, len(keys))
	for _, key := range keys {
		out = append(out, cloneIdentityLink(r.byAlias[key]))
	}
	return out, nil
}

func (r *MemoryRepository) PruneInactiveBefore(_ context.Context, cutoff time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	nextByAlias := make(map[string]model.IdentityLink, len(r.byAlias))
	nextByTenant := make(map[string][]string, len(r.byTenant))
	for key, link := range r.byAlias {
		if shouldPruneInactiveLink(link, cutoff) {
			continue
		}
		cloned := cloneIdentityLink(link)
		nextByAlias[key] = cloned
		nextByTenant[link.TenantID] = append(nextByTenant[link.TenantID], key)
	}

	r.byAlias = nextByAlias
	r.byTenant = nextByTenant
	return nil
}

func cloneIdentityLink(link model.IdentityLink) model.IdentityLink {
	return link
}

func shouldPruneInactiveLink(link model.IdentityLink, cutoff time.Time) bool {
	if !link.RevokedAt.IsZero() && link.RevokedAt.Before(cutoff) {
		return true
	}
	if !link.ExpiresAt.IsZero() && link.ExpiresAt.Before(cutoff) {
		return true
	}
	return false
}

func tenantAliasKey(tenantID, aliasID string) string {
	return tenantID + ":" + aliasID
}
