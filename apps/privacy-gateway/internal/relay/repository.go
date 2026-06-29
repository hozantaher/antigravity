package relay

import (
	"context"
	"time"

	"privacy-gateway/internal/model"
)

type Repository interface {
	Save(ctx context.Context, attempt model.RelayAttempt) error
	GetByID(ctx context.Context, id string) (model.RelayAttempt, error)
	ListByTenant(ctx context.Context, tenantID string) ([]model.RelayAttempt, error)
	PruneBefore(ctx context.Context, cutoff time.Time) error
}
