// Package enrichment provides a multi-source enrichment layer for Czech
// B2B prospect data (KT-A9). Sources include ARES (autoritativní registr),
// firmy.cz (kontaktní údaje), and justice.cz (záložní zdroj — stub).
//
// The package is intentionally separate from the legacy
// `services/contacts/enrichment` package which owns suppression + the
// existing single-source ARES pipeline. This package introduces the
// EnrichmentSource interface and per-field authority merge so the legacy
// pipeline can be migrated incrementally.
package enrichment

import (
	"context"
	"errors"
	"time"
)

// SourceName is the closed vocabulary identifying an enrichment source.
type SourceName string

const (
	SourceARES      SourceName = "ares"
	SourceFirmyCZ   SourceName = "firmy_cz"
	SourceJusticeCZ SourceName = "justice_cz"
)

// EnrichmentSource is the contract every enrichment provider implements.
// Small interface (4 methods) — accept interfaces, return structs.
type EnrichmentSource interface {
	// Name returns the closed-vocabulary identifier of this source.
	Name() SourceName

	// Priority returns the source priority. Lower number = higher priority.
	// ARES = 1, firmy.cz = 2, justice.cz = 3.
	Priority() int

	// IsAvailable reports whether the source is reachable / non-degraded.
	// Health-aware sources (e.g. ARES with KT-A7 cooldown) return false
	// when the source is in cooldown to avoid wasted fetches.
	IsAvailable(ctx context.Context) bool

	// Lookup fetches company data for the given ICO. The contract:
	//   - (data, nil) → success, data populated.
	//   - (nil, nil) → not found (e.g. ARES 404 or firmy.cz cache miss).
	//   - (nil, err) → transport / parse error; caller may retry per source policy.
	Lookup(ctx context.Context, ico string) (*CompanyData, error)
}

// CompanyData is the unified per-source payload. Each source fills in only
// the fields it knows about. Empty strings / zero values mean "this source
// has no value for this field" (caller falls back per the authority matrix).
type CompanyData struct {
	// Identifying
	ICO         string
	DIC         string
	Name        string
	PravniForma string
	DatumVzniku string // ISO date "2003-08-26" or ""

	// Sídlo (registered seat)
	StreetAddress string
	City          string
	PostalCode    string

	// Klasifikace
	NACECodes   []string
	NACEPrimary string

	// Kontakt (typically firmy.cz authoritative)
	Email   string
	Phone   string
	Website string

	// Volný text / metadata
	VelikostFirmy  string // odhad počtu zaměstnanců
	DatovaSchranka string
	Description    string
}

// IsEmpty reports whether this CompanyData has no usable fields.
// Used to decide whether to skip a source's payload entirely.
func (c *CompanyData) IsEmpty() bool {
	if c == nil {
		return true
	}
	return c.ICO == "" && c.DIC == "" && c.Name == "" && c.PravniForma == "" &&
		c.DatumVzniku == "" && c.StreetAddress == "" && c.City == "" &&
		c.PostalCode == "" && c.NACEPrimary == "" && len(c.NACECodes) == 0 &&
		c.Email == "" && c.Phone == "" && c.Website == "" &&
		c.VelikostFirmy == "" && c.DatovaSchranka == "" && c.Description == ""
}

// MergeConflict records a single per-field conflict encountered during
// merge. Persisted to enrichment_log.merge_conflicts_json for audit.
type MergeConflict struct {
	Field      string     `json:"field"`
	ARESValue  string     `json:"ares,omitempty"`
	FirmyValue string     `json:"firmy_cz,omitempty"`
	Resolved   SourceName `json:"resolved"`
}

// EnrichmentOutcome is the closed vocabulary stored in
// enrichment_log.enrichment_source_used.
type EnrichmentOutcome string

const (
	OutcomeARESOnly        EnrichmentOutcome = "ares_only"
	OutcomeFirmyOnly       EnrichmentOutcome = "firmy_cz_only"
	OutcomeMerged          EnrichmentOutcome = "merged"
	OutcomeFirmyFallback   EnrichmentOutcome = "firmy_cz_fallback"
	OutcomeJusticeFallback EnrichmentOutcome = "justice_cz_fallback"
	OutcomeNone            EnrichmentOutcome = "none"
)

// LogRow is one audit row in enrichment_log. Inserted once per pipeline run.
type LogRow struct {
	CreatedAt         time.Time
	ContactID         int64
	ICO               string
	SourcesAttempted  []SourceName
	SourcesSuccess    []SourceName
	MergeConflicts    []MergeConflict
	EnrichmentOutcome EnrichmentOutcome
	DurationMS        int
}

// ErrICORequired is returned by sources when called with an empty ICO.
var ErrICORequired = errors.New("enrichment: ICO is required")
