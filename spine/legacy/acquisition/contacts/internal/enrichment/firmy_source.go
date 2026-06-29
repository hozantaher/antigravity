package enrichment

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// FirmyDB is the small DB contract this source needs. Defined consumer-side.
// *sql.DB satisfies this interface in production; sqlmock satisfies it in
// tests.
type FirmyDB interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// firmyLookupQuery selects the most recent firmy_cz_businesses row for a
// given ICO scraped within the staleness window.
const firmyLookupQuery = `
	SELECT name, email, telephone, website, street_address, address_locality,
	       postal_code, ico, pravni_forma, velikost_firmy, datova_schranka, description
	FROM firmy_cz_businesses
	WHERE ico = $1
	  AND scraped_at > NOW() - $2::interval
	ORDER BY scraped_at DESC
	LIMIT 1
`

// FirmyCZSource adapts the firmy_cz_businesses Postgres table to the
// EnrichmentSource contract. Authoritative for: email, phone, website,
// velikost_firmy, description.
//
// This source is read-only: it does not trigger an on-demand scrape. KT-A10
// keeps the cache warm; cache misses return (nil, nil) and the pipeline
// falls back to other sources.
type FirmyCZSource struct {
	db        FirmyDB
	staleness time.Duration
	probe     HealthProbe
}

// NewFirmyCZSource constructs a FirmyCZSource.
//
// staleness is the maximum age of a scraped row that is still considered
// usable; rows older than this are ignored. Default per design = 90 days.
// probe may be nil.
func NewFirmyCZSource(db FirmyDB, staleness time.Duration, probe HealthProbe) *FirmyCZSource {
	if staleness <= 0 {
		staleness = 90 * 24 * time.Hour
	}
	return &FirmyCZSource{db: db, staleness: staleness, probe: probe}
}

// Name returns the closed-vocabulary identifier.
func (s *FirmyCZSource) Name() SourceName { return SourceFirmyCZ }

// Priority returns 2 — secondary to ARES.
func (s *FirmyCZSource) Priority() int { return 2 }

// IsAvailable consults the optional health probe.
func (s *FirmyCZSource) IsAvailable(ctx context.Context) bool {
	if ctx.Err() != nil {
		return false
	}
	if s.probe == nil {
		return true
	}
	return s.probe() >= 0.3
}

// Lookup fetches a firmy.cz row by ICO.
//
// Contract:
//   - empty ICO → ErrICORequired.
//   - cache miss (no recent row) → (nil, nil).
//   - DB error → (nil, wrapped err).
func (s *FirmyCZSource) Lookup(ctx context.Context, ico string) (*CompanyData, error) {
	if ico == "" {
		return nil, ErrICORequired
	}
	if s.db == nil {
		return nil, fmt.Errorf("enrichment.FirmyCZSource: db is nil (op=FirmyCZSource.Lookup/no-db)")
	}

	// Postgres interval literal e.g. "90 days".
	intervalArg := fmt.Sprintf("%d seconds", int(s.staleness.Seconds()))

	row := s.db.QueryRowContext(ctx, firmyLookupQuery, ico, intervalArg)

	var (
		name, email, phone, website                   sql.NullString
		street, locality, postal                      sql.NullString
		icoOut, pravniForma, velikost, datovaSchranka sql.NullString
		description                                   sql.NullString
	)
	err := row.Scan(
		&name, &email, &phone, &website,
		&street, &locality, &postal,
		&icoOut, &pravniForma, &velikost, &datovaSchranka, &description,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("firmy.cz lookup %s: %w", ico, err)
	}

	// Build payload without ICO fallback first so we can detect an all-NULL
	// row and treat it as a miss.
	data := &CompanyData{
		ICO:            icoOut.String,
		Name:           name.String,
		Email:          email.String,
		Phone:          phone.String,
		Website:        website.String,
		StreetAddress:  street.String,
		City:           locality.String,
		PostalCode:     postal.String,
		PravniForma:    pravniForma.String,
		VelikostFirmy:  velikost.String,
		DatovaSchranka: datovaSchranka.String,
		Description:    description.String,
	}
	if data.IsEmpty() {
		// Defensive: row exists but every column is NULL → treat as miss.
		return nil, nil
	}
	// Partial row: at least one field present. Fall back to queried ICO when
	// the column is NULL — common on older firmy_cz_businesses rows.
	if data.ICO == "" {
		data.ICO = ico
	}
	return data, nil
}
