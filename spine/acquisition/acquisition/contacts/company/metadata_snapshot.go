package company

import (
	"context"
	"database/sql"
	"fmt"
)

// MetadataSnapshot represents the synchronization-relevant state of companies/categories.
type MetadataSnapshot struct {
	Companies            int64
	Classified           int64
	SectorPrimary        int64
	Pass                 int64
	HardBlock            int64
	SoftBlock            int64
	CategoriesRows       int64
	CategoriesCompanySum int64
}

// MetadataSnapshotDrift stores target-source deltas for each sync metric.
type MetadataSnapshotDrift struct {
	Aligned              bool
	Companies            int64
	Classified           int64
	SectorPrimary        int64
	Pass                 int64
	HardBlock            int64
	SoftBlock            int64
	CategoriesRows       int64
	CategoriesCompanySum int64
}

// LoadMetadataSnapshot reads sync-relevant aggregate metrics from the outreach DB.
func LoadMetadataSnapshot(ctx context.Context, db *sql.DB) (*MetadataSnapshot, error) {
	if db == nil {
		return nil, fmt.Errorf("snapshot DB is nil")
	}

	snap := &MetadataSnapshot{}
	err := db.QueryRowContext(ctx, `
		SELECT
			COUNT(*)::bigint AS companies,
			COUNT(*) FILTER (WHERE classified_at IS NOT NULL)::bigint AS classified,
			COUNT(*) FILTER (WHERE sector_primary IS NOT NULL AND sector_primary != '')::bigint AS sector_primary,
			COUNT(*) FILTER (WHERE exclusion_status = 'pass')::bigint AS pass_count,
			COUNT(*) FILTER (WHERE exclusion_status = 'hard_block')::bigint AS hard_block,
			COUNT(*) FILTER (WHERE exclusion_status = 'soft_block')::bigint AS soft_block
		FROM companies`).
		Scan(
			&snap.Companies,
			&snap.Classified,
			&snap.SectorPrimary,
			&snap.Pass,
			&snap.HardBlock,
			&snap.SoftBlock,
		)
	if err != nil {
		return nil, fmt.Errorf("snapshot companies aggregates: %w", err)
	}

	// Derive category-tree metrics from canonical company metadata instead of
	// relying on categories cache, which may be stale between environments.
	err = db.QueryRowContext(ctx, `
		WITH RECURSIVE expanded AS (
			SELECT category_path AS path
			FROM companies
			WHERE exclusion_status = 'pass'
			  AND category_path IS NOT NULL
			  AND category_path != ''

			UNION ALL

			SELECT CASE
				WHEN position(' > ' IN path) = 0 THEN NULL
				ELSE left(path, length(path) - length(reverse(split_part(reverse(path), ' > ', 1))) - 3)
			END
			FROM expanded
			WHERE position(' > ' IN path) > 0
		),
		counts AS (
			SELECT path, COUNT(*)::bigint AS company_count
			FROM expanded
			WHERE path IS NOT NULL
			GROUP BY path
		)
		SELECT
			COUNT(*)::bigint AS categories_rows,
			COALESCE(SUM(company_count), 0)::bigint AS categories_company_sum
		FROM counts`).
		Scan(&snap.CategoriesRows, &snap.CategoriesCompanySum)
	if err != nil {
		return nil, fmt.Errorf("snapshot categories aggregates: %w", err)
	}

	return snap, nil
}

// CompareMetadataSnapshots computes target-source deltas across snapshot metrics.
func CompareMetadataSnapshots(source, target *MetadataSnapshot) MetadataSnapshotDrift {
	drift := MetadataSnapshotDrift{}
	if source == nil || target == nil {
		return drift
	}

	drift.Companies = target.Companies - source.Companies
	drift.Classified = target.Classified - source.Classified
	drift.SectorPrimary = target.SectorPrimary - source.SectorPrimary
	drift.Pass = target.Pass - source.Pass
	drift.HardBlock = target.HardBlock - source.HardBlock
	drift.SoftBlock = target.SoftBlock - source.SoftBlock
	drift.CategoriesRows = target.CategoriesRows - source.CategoriesRows
	drift.CategoriesCompanySum = target.CategoriesCompanySum - source.CategoriesCompanySum

	drift.Aligned = drift.Companies == 0 &&
		drift.Classified == 0 &&
		drift.SectorPrimary == 0 &&
		drift.Pass == 0 &&
		drift.HardBlock == 0 &&
		drift.SoftBlock == 0 &&
		drift.CategoriesRows == 0 &&
		drift.CategoriesCompanySum == 0

	return drift
}
