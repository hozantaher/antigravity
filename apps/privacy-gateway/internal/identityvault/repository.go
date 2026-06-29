package identityvault

import (
	"context"
	"time"

	"privacy-gateway/internal/model"
)

type Repository interface {
	Save(ctx context.Context, link model.IdentityLink) error
	GetByAliasID(ctx context.Context, tenantID, aliasID string) (model.IdentityLink, error)
	ListByTenant(ctx context.Context, tenantID string) ([]model.IdentityLink, error)
	PruneInactiveBefore(ctx context.Context, cutoff time.Time) error
}
