package classify

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"contacts/exclusion"
)

// JobConfig configures the classify job.
type JobConfig struct {
	BatchSize int
	DryRun    bool
	ICPConfig ICPConfig
}

// JobResult holds the outcome of a classify run.
type JobResult struct {
	Processed   int
	HardBlocked int
	SoftBlocked int
	NeedsReview int
	Classified  int
	Scored      int
}

// ClassifyUpdate holds the classification result for a single company.
type ClassifyUpdate struct {
	ExclusionStatus  string
	ExclusionReasons []string
	NeedsReview      bool
	SectorTags       []string
	SectorPrimary    string
	SectorConfidence float64
	SectorSource     string
	ICPScore         float64
	ICPTier          string
	RegionNormalized string
	ICPFactorsJSON   string // JSON-encoded ICPFactors for storage in icp_factors JSONB column
}

// RunJob processes all unclassified companies in batches.
func RunJob(ctx context.Context, db *sql.DB, cfg JobConfig) (*JobResult, error) {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 5000
	}
	result := &JobResult{}
	lastID := 0

	for {
		rows, err := db.QueryContext(ctx, `
			SELECT id, COALESCE(name,''), COALESCE(ico,''), COALESCE(email,''),
				COALESCE(pravni_forma,''), COALESCE(category_path,''),
				COALESCE(categories_json,''),
				COALESCE(description,''), COALESCE(velikost_firmy,''),
				COALESCE(postal_code,''), COALESCE(address_locality,''),
				COALESCE(website,''), COALESCE(telephone,''),
				COALESCE(rating_value,0), COALESCE(rating_count,0),
				COALESCE(nace_codes,'{}'),
				COALESCE(v_insolvenci,false), COALESCE(v_likvidaci,false),
				datum_vzniku
			FROM companies
			WHERE classified_at IS NULL AND id > $1
			ORDER BY id LIMIT $2
		`, lastID, cfg.BatchSize)
		if err != nil {
			return result, fmt.Errorf("fetch batch: %w", err)
		}

		var batch []companyRow
		for rows.Next() {
			var r companyRow
			if err := rows.Scan(&r.ID, &r.Name, &r.ICO, &r.Email,
				&r.PravniForma, &r.CategoryPath, &r.CategoriesJSON,
				&r.Description, &r.VelikostFirmy,
				&r.PostalCode, &r.AddressLocality,
				&r.Website, &r.Telephone, &r.RatingValue, &r.RatingCount,
				&r.NACECodesRaw, &r.VInsolvenci, &r.VLikvidaci,
				&r.DatumVzniku,
			); err != nil {
				rows.Close()
				return result, fmt.Errorf("scan: %w", err)
			}
			batch = append(batch, r)
		}
		rows.Close()

		if len(batch) == 0 {
			break
		}

		type classified struct {
			row    companyRow
			update ClassifyUpdate
		}
		var updates []classified
		for _, r := range batch {
			lastID = r.ID
			update := classifyOne(r, cfg.ICPConfig)
			updates = append(updates, classified{r, update})

			result.Processed++
			switch update.ExclusionStatus {
			case "hard_block":
				result.HardBlocked++
			case "soft_block":
				result.SoftBlocked++
			}
			if update.NeedsReview {
				result.NeedsReview++
			}
			if update.SectorPrimary != "" {
				result.Classified++
			}
			if update.ICPScore > 0 {
				result.Scored++
			}
		}

		if !cfg.DryRun && len(updates) > 0 {
			ids := make([]int, len(updates))
			upds := make([]ClassifyUpdate, len(updates))
			for i, u := range updates {
				ids[i] = u.row.ID
				upds[i] = u.update
			}
			if err := persistBatch(ctx, db, ids, upds); err != nil {
				slog.Warn("classify persist batch error", "error", err)
			}
		}

		slog.Info("classify batch", "processed", result.Processed, "last_id", lastID)
	}

	return result, nil
}

func classifyOne(r companyRow, icpCfg ICPConfig) ClassifyUpdate {
	naceCodes := r.NACECodesSlice()

	// 1. Exclusion
	excl := exclusion.Detect(exclusion.Input{
		Name:        r.Name,
		PravniForma: r.PravniForma,
		ICO:         r.ICO,
		Email:       r.Email,
		NACECodes:   naceCodes,
		VInsolvenci: r.VInsolvenci,
		VLikvidaci:  r.VLikvidaci,
	})

	update := ClassifyUpdate{
		ExclusionStatus:  string(excl.Decision),
		ExclusionReasons: excl.Reasons,
		NeedsReview:      excl.NeedsReview,
	}

	if excl.Decision != exclusion.Pass {
		return update
	}

	// 2. Region
	update.RegionNormalized = NormalizeRegion(r.PostalCode, r.AddressLocality)

	// 3. Sector
	sectorTags := ClassifySector(ClassifyInput{
		NACECodes:      naceCodes,
		CategoryPath:   r.CategoryPath,
		CategoriesJSON: r.CategoriesJSON,
		Description:    r.Description,
	})
	update.SectorTags = TagCodes(sectorTags)
	update.SectorPrimary = PrimaryTag(sectorTags)
	update.SectorConfidence = PrimaryConfidence(sectorTags)
	update.SectorSource = PrimarySource(sectorTags)

	// 4. ICP
	icpScore, icpFactors := CalculateICPWithFactors(ICPInput{
		SectorTags:  update.SectorTags,
		CompanySize: r.VelikostFirmy,
		Region:      update.RegionNormalized,
		HasWebsite:  r.Website != "",
		HasEmail:    r.Email != "",
		HasPhone:    r.Telephone != "",
		RatingValue: r.RatingValue,
		RatingCount: r.RatingCount,
		DatumVzniku: r.datumVznikuPtr(),
		PravniForma: r.PravniForma,
	}, icpCfg)
	update.ICPScore = icpScore
	update.ICPTier = ICPTier(icpScore)
	if b, err := json.Marshal(icpFactors); err == nil {
		update.ICPFactorsJSON = string(b)
	}

	return update
}

// ReclassifyCategoryResult holds the outcome of a category_path reclassification run.
type ReclassifyCategoryResult struct {
	Candidates int
	Upgraded   int
	Unchanged  int
}

// RunReclassifyCategory re-classifies companies that previously had an empty
// category_path (classified via keywords or unclassified) but now have a populated
// category_path — typically after a BackfillCategoryPath sync from firmy DB.
//
// It resets classified_at to NULL for eligible companies so that RunJob will
// re-process them on the next cycle, picking up the higher-confidence category_path signal.
// Returns the number of companies whose classified_at was reset.
func RunReclassifyCategory(ctx context.Context, db *sql.DB, batchSize int) (*ReclassifyCategoryResult, error) {
	if batchSize <= 0 {
		batchSize = 5000
	}
	result := &ReclassifyCategoryResult{}

	for {
		// Find companies that:
		//   - have category_path populated now
		//   - were NOT classified by nace or category_path (i.e. keywords or unclassified)
		//   - already went through classification (classified_at IS NOT NULL)
		// Reset classified_at so RunJob re-processes them.
		res, err := db.ExecContext(ctx, `
			UPDATE companies SET
				classified_at = NULL,
				updated_at    = now()
			WHERE id IN (
				SELECT id FROM companies
				WHERE category_path IS NOT NULL
				  AND category_path != ''
				  AND classified_at IS NOT NULL
				  AND exclusion_status = 'pass'
				  AND (sector_source IS NULL OR sector_source NOT IN ('nace', 'category_path'))
				ORDER BY id
				LIMIT $1
			)`, batchSize)
		if err != nil {
			return result, fmt.Errorf("reclassify category reset: %w", err)
		}
		n, _ := res.RowsAffected()
		result.Candidates += int(n)
		result.Upgraded += int(n) // Each reset means RunJob will re-process it

		slog.Info("reclassify-category reset batch", "reset", n, "total", result.Candidates)

		if int(n) < batchSize {
			break
		}
	}

	return result, nil
}

// ReclassifyNACEResult holds the outcome of a NACE reclassification run.
type ReclassifyNACEResult struct {
	Candidates int
	Upgraded   int
	Unchanged  int
}

// RunReclassifyNACE re-classifies companies that have NACE codes from ARES
// but were originally classified by lower-confidence sources (category_path, keywords).
// This upgrades sector tags to 0.95 confidence and recalculates ICP scores.
func RunReclassifyNACE(ctx context.Context, db *sql.DB, icpCfg ICPConfig, batchSize int) (*ReclassifyNACEResult, error) {
	if batchSize <= 0 {
		batchSize = 5000
	}
	result := &ReclassifyNACEResult{}
	lastID := 0

	for {
		rows, err := db.QueryContext(ctx, `
			SELECT id, COALESCE(name,''), COALESCE(ico,''), COALESCE(email,''),
				COALESCE(pravni_forma,''), COALESCE(category_path,''),
				COALESCE(categories_json,''),
				COALESCE(description,''), COALESCE(velikost_firmy,''),
				COALESCE(postal_code,''), COALESCE(address_locality,''),
				COALESCE(website,''), COALESCE(telephone,''),
				COALESCE(rating_value,0), COALESCE(rating_count,0),
				COALESCE(nace_codes,'{}'),
				COALESCE(v_insolvenci,false), COALESCE(v_likvidaci,false),
				datum_vzniku
			FROM companies
			WHERE classified_at IS NOT NULL
			  AND nace_codes IS NOT NULL AND nace_codes != '{}'
			  AND (sector_source IS NULL OR sector_source != 'nace')
			  AND exclusion_status = 'pass'
			  AND id > $1
			ORDER BY id LIMIT $2
		`, lastID, batchSize)
		if err != nil {
			return result, fmt.Errorf("reclassify fetch: %w", err)
		}

		var batch []companyRow
		for rows.Next() {
			var r companyRow
			if err := rows.Scan(&r.ID, &r.Name, &r.ICO, &r.Email,
				&r.PravniForma, &r.CategoryPath, &r.CategoriesJSON,
				&r.Description, &r.VelikostFirmy,
				&r.PostalCode, &r.AddressLocality,
				&r.Website, &r.Telephone, &r.RatingValue, &r.RatingCount,
				&r.NACECodesRaw, &r.VInsolvenci, &r.VLikvidaci,
				&r.DatumVzniku,
			); err != nil {
				rows.Close()
				return result, fmt.Errorf("reclassify scan: %w", err)
			}
			batch = append(batch, r)
		}
		rows.Close()

		if len(batch) == 0 {
			break
		}

		for _, r := range batch {
			lastID = r.ID
			result.Candidates++

			update := classifyOne(r, icpCfg)

			// Only persist if sector source improved to NACE
			if update.SectorSource != "nace" {
				result.Unchanged++
				continue
			}

			if err := persistUpdate(ctx, db, r.ID, update); err != nil {
				slog.Warn("reclassify persist", "id", r.ID, "error", err)
				continue
			}
			result.Upgraded++
		}

		slog.Info("reclassify-nace batch", "candidates", result.Candidates,
			"upgraded", result.Upgraded, "last_id", lastID)
	}

	return result, nil
}

// persistBatch writes classification results for a whole batch in two round-trips:
// one bulk UPDATE on companies and one bulk UPDATE on outreach_contacts.
func persistBatch(ctx context.Context, db *sql.DB, ids []int, updates []ClassifyUpdate) error {
	if len(ids) == 0 {
		return nil
	}

	// Build VALUES list: (id, exclusion_status, exclusion_reasons, needs_review,
	//   sector_tags, sector_primary, sector_confidence, sector_source,
	//   icp_score, icp_tier, region_normalized, icp_factors)
	vals := make([]string, 0, len(ids))
	args := make([]any, 0, len(ids)*12)
	for i, id := range ids {
		u := updates[i]
		reasons := "{}"
		if len(u.ExclusionReasons) > 0 {
			reasons = "{" + strings.Join(u.ExclusionReasons, ",") + "}"
		}
		sectorTags := "{}"
		if len(u.SectorTags) > 0 {
			sectorTags = "{" + strings.Join(u.SectorTags, ",") + "}"
		}
		icpFactors := u.ICPFactorsJSON
		if icpFactors == "" {
			icpFactors = "{}"
		}
		base := i*12 + 1
		vals = append(vals, fmt.Sprintf(
			"($%d::int,$%d::text,$%d::text[],$%d::bool,$%d::text[],$%d::text,$%d::float8,$%d::text,$%d::float8,$%d::text,$%d::text,$%d::jsonb)",
			base, base+1, base+2, base+3, base+4, base+5, base+6, base+7, base+8, base+9, base+10, base+11,
		))
		args = append(args,
			id, u.ExclusionStatus, reasons, u.NeedsReview,
			sectorTags, u.SectorPrimary, u.SectorConfidence, u.SectorSource,
			u.ICPScore, u.ICPTier, u.RegionNormalized, icpFactors,
		)
	}

	query := `UPDATE companies SET
		exclusion_status      = d.exclusion_status,
		exclusion_reasons     = d.exclusion_reasons,
		needs_review          = d.needs_review,
		sector_tags           = d.sector_tags,
		sector_primary        = d.sector_primary,
		sector_confidence     = d.sector_confidence,
		sector_source         = d.sector_source,
		icp_score             = d.icp_score,
		icp_tier              = d.icp_tier,
		region_normalized     = d.region_normalized,
		icp_factors           = d.icp_factors,
		exclusion_checked_at  = now(),
		classified_at         = now(),
		updated_at            = now()
	FROM (VALUES ` + strings.Join(vals, ",") + `) AS d(
		id, exclusion_status, exclusion_reasons, needs_review,
		sector_tags, sector_primary, sector_confidence, sector_source,
		icp_score, icp_tier, region_normalized, icp_factors
	) WHERE companies.id = d.id`

	if _, err := db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("batch company update: %w", err)
	}

	// Propagate sector_tags → outreach_contacts for companies that have sector tags.
	// Build a separate batch UPDATE for contacts.
	var contactVals []string
	var contactArgs []any
	argIdx := 1
	for i, id := range ids {
		u := updates[i]
		if len(u.SectorTags) == 0 {
			continue
		}
		sectorTags := "{" + strings.Join(u.SectorTags, ",") + "}"
		contactVals = append(contactVals, fmt.Sprintf("($%d::int,$%d::text[],$%d::float8)", argIdx, argIdx+1, argIdx+2))
		contactArgs = append(contactArgs, id, sectorTags, u.SectorConfidence)
		argIdx += 3
	}
	if len(contactVals) > 0 {
		cq := `UPDATE outreach_contacts SET
			industry_tags       = d.sector_tags,
			industry_confidence = d.sector_confidence,
			updated_at          = now()
		FROM (VALUES ` + strings.Join(contactVals, ",") + `) AS d(company_id, sector_tags, sector_confidence)
		WHERE outreach_contacts.company_id = d.company_id
		  AND COALESCE(outreach_contacts.industry_confidence, 0) < d.sector_confidence`
		if _, err := db.ExecContext(ctx, cq, contactArgs...); err != nil {
			return fmt.Errorf("batch contact update: %w", err)
		}
	}

	return nil
}

func persistUpdate(ctx context.Context, db *sql.DB, id int, u ClassifyUpdate) error {
	reasons := "{}"
	if len(u.ExclusionReasons) > 0 {
		reasons = "{" + strings.Join(u.ExclusionReasons, ",") + "}"
	}
	sectorTags := "{}"
	if len(u.SectorTags) > 0 {
		sectorTags = "{" + strings.Join(u.SectorTags, ",") + "}"
	}

	icpFactors := u.ICPFactorsJSON
	if icpFactors == "" {
		icpFactors = "{}"
	}
	_, err := db.ExecContext(ctx, `
		UPDATE companies SET
			exclusion_status = $2,
			exclusion_reasons = $3,
			needs_review = $4,
			sector_tags = $5,
			sector_primary = $6,
			sector_confidence = $7,
			sector_source = $8,
			icp_score = $9,
			icp_tier = $10,
			region_normalized = $11,
			icp_factors = $12,
			exclusion_checked_at = now(),
			classified_at = now(),
			updated_at = now()
		WHERE id = $1
	`, id, u.ExclusionStatus, reasons, u.NeedsReview,
		sectorTags, u.SectorPrimary, u.SectorConfidence, u.SectorSource,
		u.ICPScore, u.ICPTier, u.RegionNormalized, icpFactors)
	if err != nil {
		return err
	}

	// Propagate sector_tags → outreach_contacts.industry_tags for contacts linked to
	// this company. Updates both empty tags AND contacts with lower-confidence
	// existing tags (e.g. keyword-classified at 0.1 upgraded to nace at 1.0).
	if len(u.SectorTags) > 0 {
		_, err = db.ExecContext(ctx, `
			UPDATE outreach_contacts
			SET industry_tags       = $2,
			    industry_confidence = $3,
			    updated_at          = now()
			WHERE company_id = $1
			  AND COALESCE(industry_confidence, 0) < $3
		`, id, sectorTags, u.SectorConfidence)
	}
	return err
}

type companyRow struct {
	ID              int
	Name            string
	ICO             string
	Email           string
	PravniForma     string
	CategoryPath    string
	CategoriesJSON  string
	Description     string
	VelikostFirmy   string
	PostalCode      string
	AddressLocality string
	Website         string
	Telephone       string
	RatingValue     float64
	RatingCount     int
	NACECodesRaw    string
	VInsolvenci     bool
	VLikvidaci      bool
	DatumVzniku     sql.NullTime // nullable DATE from ARES; use .Valid before accessing .Time
}

// datumVznikuPtr returns a *time.Time pointer usable by ICPInput, or nil if not set.
func (r companyRow) datumVznikuPtr() *time.Time {
	if !r.DatumVzniku.Valid {
		return nil
	}
	t := r.DatumVzniku.Time
	return &t
}

func (r companyRow) NACECodesSlice() []string {
	s := r.NACECodesRaw
	if s == "" || s == "{}" {
		return nil
	}
	s = s[1 : len(s)-1]
	var result []string
	for _, part := range strings.Split(s, ",") {
		if v := strings.TrimSpace(part); v != "" {
			result = append(result, v)
		}
	}
	return result
}
