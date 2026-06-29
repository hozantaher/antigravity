package company

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Company represents a row in the companies table.
type Company struct {
	ID               int
	FirmyCzID        int
	ICO              string
	Name             string
	Email            string
	Telephone        string
	Website          string
	StreetAddress    string
	AddressLocality  string
	PostalCode       string
	Description      string
	VelikostFirmy    string
	PravniForma      string
	CategoryPath     string
	CategoriesJSON   string // raw JSON array: [{"name":"Czech category","url":"..."}]
	RatingValue      float64
	RatingCount      int
	QualityTier      string
	ContactCount     int
	ThreadCount      int
	TotalSent        int
	TotalReplied     int
	LastContacted    *time.Time
	LastReplied      *time.Time
	BestTargetingScore float64
	// Classification fields (populated by classify job)
	ExclusionStatus  string
	ExclusionReasons []string
	NeedsReview      bool
	NACECodes        []string
	NACEPrimary      string
	VInsolvenci      bool
	VLikvidaci       bool
	ARESSyncedAt     *time.Time
	SectorTags       []string
	SectorPrimary    string
	SectorConfidence float64
	SectorSource     string
	ICPScore         float64
	ICPTier          string
	RegionNormalized string
	ClassifiedAt     *time.Time
	SyncedAt         time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// QualityTier constants.
const (
	TierRaw       = "raw"
	TierEnriched  = "enriched"
	TierScored    = "scored"
	TierContacted = "contacted"
	TierEngaged   = "engaged"
)

// DB abstracts database operations for testability.
type DB interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Store provides CRUD operations on the companies table.
type Store struct {
	db DB
}

// NewStore creates a new company store.
func NewStore(db DB) *Store {
	return &Store{db: db}
}

// Upsert inserts or updates a company by firmy_cz_id.
func (s *Store) Upsert(ctx context.Context, c *Company) (int, error) {
	var id int
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO companies (firmy_cz_id, ico, name, email, telephone, website,
			street_address, address_locality, postal_code, description,
			velikost_firmy, pravni_forma, category_path, categories_json,
			rating_value, rating_count, synced_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now())
		ON CONFLICT (firmy_cz_id) DO UPDATE SET
			ico = EXCLUDED.ico,
			name = EXCLUDED.name,
			email = EXCLUDED.email,
			telephone = EXCLUDED.telephone,
			website = EXCLUDED.website,
			street_address = EXCLUDED.street_address,
			address_locality = EXCLUDED.address_locality,
			postal_code = EXCLUDED.postal_code,
			description = EXCLUDED.description,
			velikost_firmy = EXCLUDED.velikost_firmy,
			pravni_forma = EXCLUDED.pravni_forma,
			category_path = EXCLUDED.category_path,
			categories_json = EXCLUDED.categories_json,
			rating_value = EXCLUDED.rating_value,
			rating_count = EXCLUDED.rating_count,
			synced_at = now(),
			updated_at = now()
		RETURNING id`,
		c.FirmyCzID, c.ICO, c.Name, c.Email, c.Telephone, c.Website,
		c.StreetAddress, c.AddressLocality, c.PostalCode, c.Description,
		c.VelikostFirmy, c.PravniForma, c.CategoryPath, c.CategoriesJSON,
		c.RatingValue, c.RatingCount,
	).Scan(&id)
	return id, err
}

const companySelectCols = `id, firmy_cz_id, ico, name, email, telephone, website,
	street_address, address_locality, postal_code, description,
	velikost_firmy, pravni_forma, category_path, rating_value, rating_count,
	quality_tier, contact_count, thread_count, total_sent, total_replied,
	last_contacted, last_replied, best_targeting_score,
	COALESCE(exclusion_status,'pending'), COALESCE(exclusion_reasons,'{}'),
	COALESCE(needs_review,false),
	COALESCE(nace_codes,'{}'), COALESCE(nace_primary,''),
	COALESCE(v_insolvenci,false), COALESCE(v_likvidaci,false), ares_synced_at,
	COALESCE(sector_tags,'{}'), COALESCE(sector_primary,''),
	COALESCE(sector_confidence,0), COALESCE(sector_source,''),
	COALESCE(icp_score,0), COALESCE(icp_tier,'unscored'),
	COALESCE(region_normalized,''), classified_at,
	synced_at, created_at, updated_at`

// FindByID returns a company by primary key.
func (s *Store) FindByID(ctx context.Context, id int) (*Company, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+companySelectCols+` FROM companies WHERE id = $1`, id)
	return scanCompany(row)
}

// FindByFirmyCzID returns a company by its firmy-cz source ID.
func (s *Store) FindByFirmyCzID(ctx context.Context, firmyCzID int) (*Company, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+companySelectCols+` FROM companies WHERE firmy_cz_id = $1`, firmyCzID)
	return scanCompany(row)
}

// FindByICO returns a company by ICO.
func (s *Store) FindByICO(ctx context.Context, ico string) (*Company, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+companySelectCols+` FROM companies WHERE ico = $1 AND ico != ''`, ico)
	return scanCompany(row)
}

// LinkContactByFirmyCzID links outreach_contacts to companies via firmy_cz_id.
func (s *Store) LinkContactByFirmyCzID(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE outreach_contacts oc SET company_id = co.id
		FROM companies co
		WHERE co.firmy_cz_id = oc.firmy_cz_id
			AND oc.company_id IS NULL
			AND oc.firmy_cz_id IS NOT NULL`)
	if err != nil {
		return 0, fmt.Errorf("link by firmy_cz_id: %w", err)
	}
	return result.RowsAffected()
}

// LinkContactByICO links outreach_contacts to companies via ICO (fallback).
func (s *Store) LinkContactByICO(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE outreach_contacts oc SET company_id = co.id
		FROM companies co
		WHERE co.ico = oc.ico
			AND co.ico IS NOT NULL AND co.ico != ''
			AND oc.company_id IS NULL`)
	if err != nil {
		return 0, fmt.Errorf("link by ico: %w", err)
	}
	return result.RowsAffected()
}

// UpdateMetrics recomputes denormalized counters and quality_tier for all companies.
func (s *Store) UpdateMetrics(ctx context.Context) (int64, error) {
	// Step 1: Update companies that have linked contacts
	result, err := s.db.ExecContext(ctx, `
		UPDATE companies co SET
			contact_count = agg.cc,
			thread_count = agg.tc,
			total_sent = agg.ts,
			total_replied = agg.tr,
			last_contacted = agg.lc,
			last_replied = agg.lr,
			best_targeting_score = agg.bcs,
			quality_tier = CASE
				WHEN agg.has_replied THEN 'engaged'
				WHEN agg.tc > 0 THEN 'contacted'
				WHEN agg.bcs >= 0.4 THEN 'scored'
				ELSE 'enriched'
			END,
			updated_at = now()
		FROM (
			SELECT c.company_id,
				COUNT(DISTINCT c.id)::int AS cc,
				COUNT(DISTINCT t.id)::int AS tc,
				COALESCE(SUM(c.total_sent), 0)::int AS ts,
				COALESCE(SUM(c.total_replied), 0)::int AS tr,
				MAX(c.last_contacted) AS lc,
				MAX(c.last_replied) AS lr,
				COALESCE(MAX(c.targeting_score), 0) AS bcs,
				EXISTS(
					SELECT 1 FROM outreach_threads t2
					JOIN outreach_contacts c2 ON c2.id = t2.contact_id
					WHERE c2.company_id = c.company_id AND t2.status = 'replied'
				) AS has_replied
			FROM outreach_contacts c
			LEFT JOIN outreach_threads t ON t.contact_id = c.id
			WHERE c.company_id IS NOT NULL
			GROUP BY c.company_id
		) agg WHERE agg.company_id = co.id`)
	if err != nil {
		return 0, fmt.Errorf("update metrics: %w", err)
	}
	updated, _ := result.RowsAffected()

	// Step 2: Reset companies that lost all contacts back to raw
	_, err = s.db.ExecContext(ctx, `
		UPDATE companies SET
			quality_tier = 'raw',
			contact_count = 0, thread_count = 0,
			total_sent = 0, total_replied = 0,
			last_contacted = NULL, last_replied = NULL,
			best_targeting_score = 0,
			updated_at = now()
		WHERE quality_tier != 'raw'
			AND NOT EXISTS (
				SELECT 1 FROM outreach_contacts oc WHERE oc.company_id = companies.id
			)`)
	if err != nil {
		return updated, fmt.Errorf("reset orphaned metrics: %w", err)
	}

	return updated, nil
}

// TierStats returns company counts grouped by quality_tier.
func (s *Store) TierStats(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT quality_tier, COUNT(*)::int FROM companies GROUP BY quality_tier`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stats := make(map[string]int)
	for rows.Next() {
		var tier string
		var count int
		if err := rows.Scan(&tier, &count); err != nil {
			return nil, err
		}
		stats[tier] = count
	}
	return stats, rows.Err()
}

// EnsureForContact looks up or creates a company for a contact's firmy_cz_id,
// then sets company_id on the contact. Returns the company ID.
func (s *Store) EnsureForContact(ctx context.Context, contactID, firmyCzID int) (int, error) {
	// Try to find existing company
	var companyID int
	err := s.db.QueryRowContext(ctx,
		`SELECT id FROM companies WHERE firmy_cz_id = $1`, firmyCzID).Scan(&companyID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("lookup company: %w", err)
	}

	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil // Company doesn't exist yet; will be created by sync
	}

	// Link the contact
	_, err = s.db.ExecContext(ctx,
		`UPDATE outreach_contacts SET company_id = $1 WHERE id = $2 AND company_id IS NULL`,
		companyID, contactID)
	if err != nil {
		return companyID, fmt.Errorf("link contact: %w", err)
	}

	return companyID, nil
}

func scanCompany(row *sql.Row) (*Company, error) {
	var c Company
	var ico, email, tel, web, street, locality, postal sql.NullString
	var desc, velFirmy, pravniForma, catPath sql.NullString
	var lastContacted, lastReplied sql.NullTime
	var exclusionReasonsRaw, naceCodesRaw, sectorTagsRaw string
	var aresSyncedAt, classifiedAt sql.NullTime

	err := row.Scan(
		&c.ID, &c.FirmyCzID, &ico, &c.Name, &email, &tel, &web,
		&street, &locality, &postal, &desc,
		&velFirmy, &pravniForma, &catPath, &c.RatingValue, &c.RatingCount,
		&c.QualityTier, &c.ContactCount, &c.ThreadCount, &c.TotalSent, &c.TotalReplied,
		&lastContacted, &lastReplied, &c.BestTargetingScore,
		&c.ExclusionStatus, &exclusionReasonsRaw, &c.NeedsReview,
		&naceCodesRaw, &c.NACEPrimary,
		&c.VInsolvenci, &c.VLikvidaci, &aresSyncedAt,
		&sectorTagsRaw, &c.SectorPrimary,
		&c.SectorConfidence, &c.SectorSource,
		&c.ICPScore, &c.ICPTier,
		&c.RegionNormalized, &classifiedAt,
		&c.SyncedAt, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	c.ICO = ico.String
	c.Email = email.String
	c.Telephone = tel.String
	c.Website = web.String
	c.StreetAddress = street.String
	c.AddressLocality = locality.String
	c.PostalCode = postal.String
	c.Description = desc.String
	c.VelikostFirmy = velFirmy.String
	c.PravniForma = pravniForma.String
	c.CategoryPath = catPath.String
	if lastContacted.Valid {
		c.LastContacted = &lastContacted.Time
	}
	if lastReplied.Valid {
		c.LastReplied = &lastReplied.Time
	}
	c.ExclusionReasons = parsePgArray(exclusionReasonsRaw)
	c.NACECodes = parsePgArray(naceCodesRaw)
	c.SectorTags = parsePgArray(sectorTagsRaw)
	if aresSyncedAt.Valid {
		c.ARESSyncedAt = &aresSyncedAt.Time
	}
	if classifiedAt.Valid {
		c.ClassifiedAt = &classifiedAt.Time
	}

	return &c, nil
}

// parsePgArray parses a PostgreSQL text array literal like {a,b,c} into a Go slice.
func parsePgArray(s string) []string {
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
