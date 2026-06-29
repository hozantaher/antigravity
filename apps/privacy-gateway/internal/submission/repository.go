package submission

import (
	"context"
	"time"

	"privacy-gateway/internal/model"
)

type Repository interface {
	Save(ctx context.Context, submission model.Submission) error
	GetByID(ctx context.Context, id string) (model.Submission, error)
	ListByTenant(ctx context.Context, tenantID string) ([]model.Submission, error)
	PruneBefore(ctx context.Context, cutoff time.Time) error
}
