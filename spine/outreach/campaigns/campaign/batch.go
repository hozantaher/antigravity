package campaign

import (
	"context"
	"fmt"
)

// BatchVerifyResult holds the outcome of a segment pre-flight batch check.
type BatchVerifyResult struct {
	SegmentID int64
	Count     int
	Ready     bool // true when Count > 0
}

// VerifySegmentBatch counts eligible companies in a segment's membership table.
// Used as a pre-flight check before launching a campaign against that segment.
func (r *Runner) VerifySegmentBatch(ctx context.Context, segmentID int64) (BatchVerifyResult, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM segment_memberships WHERE segment_id = $1`,
		segmentID,
	).Scan(&count)
	if err != nil {
		return BatchVerifyResult{}, fmt.Errorf("verify segment batch %d: %w", segmentID, err)
	}
	return BatchVerifyResult{
		SegmentID: segmentID,
		Count:     count,
		Ready:     count > 0,
	}, nil
}
