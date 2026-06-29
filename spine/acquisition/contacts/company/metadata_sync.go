package company

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

const (
	postgresMaxParams      = 65535
	metadataColsPerRow     = 18
	maxMetadataRowsPerExec = postgresMaxParams / metadataColsPerRow
)

// MetadataSyncConfig configures production-metadata synchronization.
type MetadataSyncConfig struct {
	BatchSize        int
	StartAfterID     int
	UseCheckpoint    bool
	CheckpointSource string
	MaxBatches       int
}

// MetadataSyncResult captures a metadata sync run.
type MetadataSyncResult struct {
	SourceRows    int
	UpdatedRows   int
	Batches       int
	LastFirmyCzID int
}

// MetadataSyncer copies classification/enrichment metadata from source outreach DB
// (typically production) into target outreach DB (typically localhost) by firmy_cz_id.
type MetadataSyncer struct {
	sourceDB *sql.DB
	targetDB *sql.DB
	cfg      MetadataSyncConfig
}

// NewMetadataSyncer creates a metadata syncer.
func NewMetadataSyncer(sourceDB, targetDB *sql.DB, cfg MetadataSyncConfig) *MetadataSyncer {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 5000
	}
	if cfg.StartAfterID < 0 {
		cfg.StartAfterID = 0
	}
	if cfg.MaxBatches < 0 {
		cfg.MaxBatches = 0
	}
	if cfg.CheckpointSource == "" {
		cfg.CheckpointSource = "outreach-prod-metadata-sync"
	}
	return &MetadataSyncer{
		sourceDB: sourceDB,
		targetDB: targetDB,
		cfg:      cfg,
	}
}

type metadataRow struct {
	FirmyCzID        int
	ExclusionStatus  string
	ExclusionReasons string
	NeedsReview      bool
	NACECodes        string
	NACEPrimary      string
	VInsolvenci      bool
	VLikvidaci       bool
	SectorTags       string
	SectorPrimary    string
	SectorConfidence float64
	SectorSource     string
	ICPScore         float64
	ICPTier          string
	RegionNormalized string
	CategoryPath     string
	CategoriesJSON   string
	ClassifiedAt     sql.NullTime
}

// Run performs a full metadata copy in batches ordered by firmy_cz_id.
func (s *MetadataSyncer) Run(ctx context.Context) (*MetadataSyncResult, error) {
	if s.sourceDB == nil {
		return nil, fmt.Errorf("source DB is nil")
	}
	if s.targetDB == nil {
		return nil, fmt.Errorf("target DB is nil")
	}

	result := &MetadataSyncResult{}
	lastID := s.cfg.StartAfterID
	if s.cfg.UseCheckpoint && lastID == 0 {
		checkpointID, err := s.loadCheckpoint(ctx)
		if err != nil {
			return result, fmt.Errorf("load metadata checkpoint: %w", err)
		}
		lastID = checkpointID
	}

	for {
		batch, maxID, err := s.fetchBatch(ctx, lastID)
		if err != nil {
			return result, fmt.Errorf("fetch metadata batch after id=%d: %w", lastID, err)
		}
		if len(batch) == 0 {
			break
		}

		updated, err := s.applyBatch(ctx, batch)
		if err != nil {
			return result, fmt.Errorf("apply metadata batch after id=%d: %w", lastID, err)
		}

		result.SourceRows += len(batch)
		result.UpdatedRows += updated
		result.Batches++
		lastID = maxID
		result.LastFirmyCzID = maxID

		if s.cfg.UseCheckpoint {
			if err := s.saveCheckpoint(ctx, int64(maxID), int64(len(batch))); err != nil {
				return result, fmt.Errorf("save metadata checkpoint after id=%d: %w", maxID, err)
			}
		}
		if s.cfg.MaxBatches > 0 && result.Batches >= s.cfg.MaxBatches {
			break
		}
	}

	return result, nil
}

func (s *MetadataSyncer) loadCheckpoint(ctx context.Context) (int, error) {
	var lastSourceID int
	err := s.targetDB.QueryRowContext(ctx,
		`SELECT last_source_id FROM sync_checkpoints WHERE source = $1`,
		s.cfg.CheckpointSource,
	).Scan(&lastSourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if lastSourceID < 0 {
		return 0, nil
	}
	return lastSourceID, nil
}

func (s *MetadataSyncer) saveCheckpoint(ctx context.Context, lastSourceID, recordsSynced int64) error {
	_, err := s.targetDB.ExecContext(ctx, `
		INSERT INTO sync_checkpoints (source, last_source_id, last_run_at, records_synced, updated_at)
		VALUES ($1, $2, now(), $3, now())
		ON CONFLICT (source) DO UPDATE SET
			last_source_id = GREATEST(sync_checkpoints.last_source_id, EXCLUDED.last_source_id),
			records_synced = sync_checkpoints.records_synced + EXCLUDED.records_synced,
			last_run_at    = now(),
			updated_at     = now()`,
		s.cfg.CheckpointSource, lastSourceID, recordsSynced,
	)
	return err
}

func (s *MetadataSyncer) fetchBatch(ctx context.Context, afterID int) ([]metadataRow, int, error) {
	rows, err := s.sourceDB.QueryContext(ctx, `
		SELECT firmy_cz_id,
			COALESCE(exclusion_status, 'pending') AS exclusion_status,
			COALESCE(exclusion_reasons::text, '{}') AS exclusion_reasons,
			COALESCE(needs_review, false) AS needs_review,
			COALESCE(nace_codes::text, '{}') AS nace_codes,
			COALESCE(nace_primary, '') AS nace_primary,
			COALESCE(v_insolvenci, false) AS v_insolvenci,
			COALESCE(v_likvidaci, false) AS v_likvidaci,
			COALESCE(sector_tags::text, '{}') AS sector_tags,
			COALESCE(sector_primary, '') AS sector_primary,
			COALESCE(sector_confidence, 0) AS sector_confidence,
			COALESCE(sector_source, '') AS sector_source,
			COALESCE(icp_score, 0) AS icp_score,
			COALESCE(icp_tier, 'unscored') AS icp_tier,
			COALESCE(region_normalized, '') AS region_normalized,
			COALESCE(category_path, '') AS category_path,
			COALESCE(categories_json, '') AS categories_json,
			classified_at
		FROM companies
		WHERE firmy_cz_id > $1
		ORDER BY firmy_cz_id
		LIMIT $2`,
		afterID, s.cfg.BatchSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	batch := make([]metadataRow, 0, s.cfg.BatchSize)
	maxID := afterID
	for rows.Next() {
		var r metadataRow
		if err := rows.Scan(
			&r.FirmyCzID,
			&r.ExclusionStatus,
			&r.ExclusionReasons,
			&r.NeedsReview,
			&r.NACECodes,
			&r.NACEPrimary,
			&r.VInsolvenci,
			&r.VLikvidaci,
			&r.SectorTags,
			&r.SectorPrimary,
			&r.SectorConfidence,
			&r.SectorSource,
			&r.ICPScore,
			&r.ICPTier,
			&r.RegionNormalized,
			&r.CategoryPath,
			&r.CategoriesJSON,
			&r.ClassifiedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scan metadata row: %w", err)
		}
		if r.FirmyCzID > maxID {
			maxID = r.FirmyCzID
		}
		batch = append(batch, r)
	}

	return batch, maxID, rows.Err()
}

func (s *MetadataSyncer) applyBatch(ctx context.Context, batch []metadataRow) (int, error) {
	if len(batch) == 0 {
		return 0, nil
	}

	totalUpdated := 0
	for start := 0; start < len(batch); start += maxMetadataRowsPerExec {
		end := start + maxMetadataRowsPerExec
		if end > len(batch) {
			end = len(batch)
		}
		updated, err := s.applyBatchChunk(ctx, batch[start:end])
		if err != nil {
			return totalUpdated, err
		}
		totalUpdated += updated
	}
	return totalUpdated, nil
}

func (s *MetadataSyncer) applyBatchChunk(ctx context.Context, batch []metadataRow) (int, error) {
	if len(batch) == 0 {
		return 0, nil
	}

	vals := make([]string, 0, len(batch))
	args := make([]any, 0, len(batch)*metadataColsPerRow)

	for i, r := range batch {
		base := i * metadataColsPerRow
		vals = append(vals, fmt.Sprintf(
			"($%d::int,$%d::text,$%d::text,$%d::boolean,$%d::text,$%d::text,$%d::boolean,$%d::boolean,$%d::text,$%d::text,$%d::double precision,$%d::text,$%d::double precision,$%d::text,$%d::text,$%d::text,$%d::text,$%d::timestamptz)",
			base+1, base+2, base+3, base+4, base+5, base+6, base+7, base+8,
			base+9, base+10, base+11, base+12, base+13, base+14, base+15, base+16, base+17, base+18,
		))

		var classifiedAt any
		if r.ClassifiedAt.Valid {
			classifiedAt = r.ClassifiedAt.Time
		}

		args = append(args,
			r.FirmyCzID,
			r.ExclusionStatus,
			r.ExclusionReasons,
			r.NeedsReview,
			r.NACECodes,
			r.NACEPrimary,
			r.VInsolvenci,
			r.VLikvidaci,
			r.SectorTags,
			r.SectorPrimary,
			r.SectorConfidence,
			r.SectorSource,
			r.ICPScore,
			r.ICPTier,
			r.RegionNormalized,
			r.CategoryPath,
			r.CategoriesJSON,
			classifiedAt,
		)
	}

	query := fmt.Sprintf(`
		UPDATE companies AS c SET
			exclusion_status = v.exclusion_status,
			exclusion_reasons = v.exclusion_reasons::text[],
			needs_review = v.needs_review,
			nace_codes = v.nace_codes::text[],
			nace_primary = v.nace_primary,
			v_insolvenci = v.v_insolvenci,
			v_likvidaci = v.v_likvidaci,
			sector_tags = v.sector_tags::text[],
			sector_primary = v.sector_primary,
			sector_confidence = v.sector_confidence,
			sector_source = v.sector_source,
			icp_score = v.icp_score,
			icp_tier = v.icp_tier,
			region_normalized = v.region_normalized,
			category_path = v.category_path,
			categories_json = v.categories_json,
			classified_at = v.classified_at,
			updated_at = now()
		FROM (VALUES %s) AS v(
			firmy_cz_id,
			exclusion_status,
			exclusion_reasons,
			needs_review,
			nace_codes,
			nace_primary,
			v_insolvenci,
			v_likvidaci,
			sector_tags,
			sector_primary,
			sector_confidence,
			sector_source,
			icp_score,
			icp_tier,
			region_normalized,
			category_path,
			categories_json,
			classified_at
		)
		WHERE c.firmy_cz_id = v.firmy_cz_id
		  AND (
			c.exclusion_status IS DISTINCT FROM v.exclusion_status OR
			c.exclusion_reasons IS DISTINCT FROM v.exclusion_reasons::text[] OR
			c.needs_review IS DISTINCT FROM v.needs_review OR
			c.nace_codes IS DISTINCT FROM v.nace_codes::text[] OR
			c.nace_primary IS DISTINCT FROM v.nace_primary OR
			c.v_insolvenci IS DISTINCT FROM v.v_insolvenci OR
			c.v_likvidaci IS DISTINCT FROM v.v_likvidaci OR
			c.sector_tags IS DISTINCT FROM v.sector_tags::text[] OR
			c.sector_primary IS DISTINCT FROM v.sector_primary OR
			c.sector_confidence IS DISTINCT FROM v.sector_confidence OR
			c.sector_source IS DISTINCT FROM v.sector_source OR
			c.icp_score IS DISTINCT FROM v.icp_score OR
			c.icp_tier IS DISTINCT FROM v.icp_tier OR
			c.region_normalized IS DISTINCT FROM v.region_normalized OR
			c.category_path IS DISTINCT FROM v.category_path OR
			c.categories_json IS DISTINCT FROM v.categories_json OR
			c.classified_at IS DISTINCT FROM v.classified_at
		  )`, joinStrings(vals, ","))

	res, err := s.targetDB.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}
