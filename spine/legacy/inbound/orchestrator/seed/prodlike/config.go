// Package prodlike generates synthetic test data whose statistical
// distribution mirrors the production database of machinery-outreach.
//
// All generated data is synthetic — never derived from real prod records —
// and uses .test TLD (RFC 6761) so it can never leak as real outbound
// email. ICOs use a 9-digit range (TEST_ prefix or 900-series) to avoid
// collision with real Czech business IDs (8-digit).
//
// The distribution ratios are calibrated against the production snapshot
// of 2026-04-16 (524 519 outreach_contacts, 1 087 176 firmy businesses).
// Update Ratios when quarterly drift tests reveal divergence.
package prodlike

// Scale defines the target dataset size. Each tier keeps the same
// distribution shape — only the row count changes.
type Scale string

const (
	// ScaleTiny mirrors the legacy seed in internal/seed/data.go:
	// 60 contacts, 20 companies. Used for fast CI unit tests.
	ScaleTiny Scale = "tiny"

	// ScaleSmall is the default for dev: ~1 000 contacts, ~400 companies,
	// ~200 domains. Seeds in under 15 seconds.
	ScaleSmall Scale = "small"

	// ScaleMedium targets integration tests and dashboard UI exercises:
	// ~10 000 contacts, ~4 000 companies, ~2 000 domains.
	ScaleMedium Scale = "medium"

	// ScaleLarge is for performance testing against realistic query plans:
	// ~100 000 contacts, ~40 000 companies, ~20 000 domains.
	ScaleLarge Scale = "large"
)

// Counts holds the target row counts for a given Scale.
type Counts struct {
	Contacts  int
	Companies int
	Domains   int
}

// ResolveCounts returns the target row counts for the given scale.
// Unknown scales default to ScaleSmall.
//
// Contact-to-company ratio is calibrated to match production, where
// only ~48 % of firmy_cz_businesses rows have an email (prospect
// filter `WHERE email IS NOT NULL` keeps the rest out of
// outreach_contacts). In prod: 524 519 contacts / 1 087 176 companies
// = 0.48. Translated to scale buckets that means Companies > Contacts
// by ~2.08× — the generator picks companies randomly for each
// contact, so ~52 % of companies organically end up with zero
// contacts, mirroring the "has no email" majority in prod.
//
// Tiny is a legacy bucket (matches the 60-contact E2E seed in
// internal/seed/data.go) and intentionally violates the prod ratio
// for CI speed.
func ResolveCounts(s Scale) Counts {
	switch s {
	case ScaleTiny:
		return Counts{Contacts: 60, Companies: 20, Domains: 20}
	case ScaleMedium:
		return Counts{Contacts: 10000, Companies: 21000, Domains: 4000}
	case ScaleLarge:
		return Counts{Contacts: 100000, Companies: 210000, Domains: 40000}
	default:
		return Counts{Contacts: 1000, Companies: 2100, Domains: 400}
	}
}

// Ratios holds the statistical parameters calibrated against production.
// All fractions are in the [0, 1] range and sum per group to 1.0.
type Ratios struct {
	// Consent tier distribution (outreach_contacts.targeting_score).
	// Prod 2026-04-16: auto 13.5 %, low 86.3 %, manual 0.26 %, block 0.002 %.
	ConsentAuto   float64 // >= 0.7
	ConsentLow    float64 // 0.4 - 0.7
	ConsentManual float64 // 0.2 - 0.4
	ConsentBlock  float64 // < 0.2

	// Domain type distribution (outreach_domains.domain_type).
	// Prod: corporate 85 %, unknown 13 %, business 1 %, gov 0.3 %, edu 0.02 %, freemail 0.01 %.
	// Freemail is boosted here (1.25 %) to ensure the penalty path gets coverage.
	DomainCorporate float64
	DomainUnknown   float64
	DomainBusiness  float64
	DomainGov       float64
	DomainEdu       float64
	DomainFreemail  float64

	// Email coverage: share of firmy_cz_businesses that have an email address.
	// Prod: 58.4 %. Below this threshold rows get no email (prospect filter path).
	EmailCoverage float64

	// ICOCoverage: share of companies with a non-empty ICO.
	// Prod: 76 %.
	ICOCoverage float64

	// PhoneCoverage: share with a telephone. Prod: 64 %.
	PhoneCoverage float64

	// WebsiteCoverage: share with a website. Prod: 61 %.
	WebsiteCoverage float64

	// VelikostFirmyEmpty: share of companies with NULL/empty velikost_firmy.
	// Prod: 91 %.
	VelikostFirmyEmpty float64

	// PrahaConcentration: share of contacts whose region is a Praha variant.
	// Prod: ~15 %.
	PrahaConcentration float64

	// ContactsPerDomainAlpha: Zipf exponent controlling how many contacts
	// share a domain. Prod exhibits a long power-law tail (few domains with
	// many contacts, most domains with 1–3). α=1.2 reproduces that shape.
	ContactsPerDomainAlpha float64

	// CompanyQualityTier distribution.
	QualityRaw      float64 // 60 %
	QualityEnriched float64 // 30 %
	QualityICPHigh  float64 // 8 %
	QualityICPTop   float64 // 2 %

	// ExclusionStatus distribution on companies.
	ExclusionPass      float64 // 70 %
	ExclusionPending   float64 // 20 %
	ExclusionSoftBlock float64 // 7 %
	ExclusionHardBlock float64 // 3 %

	// AresSyncCoverage: share of companies with a non-null ares_synced_at.
	AresSyncCoverage float64 // 80 %

	// TemporalRecentDays: window over which created_at is distributed
	// using an exponential decay (more recent rows weighted higher).
	TemporalRecentDays int // 180
}

// DefaultRatios returns the production-calibrated ratios snapshot from
// 2026-04-16. Override fields on the returned struct to experiment.
func DefaultRatios() Ratios {
	return Ratios{
		// Consent
		ConsentAuto:   0.135,
		ConsentLow:    0.863,
		ConsentManual: 0.0026,
		ConsentBlock:  0.00002,

		// Domain types (freemail lifted to 1.25 % for coverage)
		DomainCorporate: 0.85,
		DomainUnknown:   0.125,
		DomainBusiness:  0.01,
		DomainGov:       0.003,
		DomainEdu:       0.0005,
		DomainFreemail:  0.0125,

		// Coverage
		EmailCoverage:   0.584,
		ICOCoverage:     0.76,
		PhoneCoverage:   0.642,
		WebsiteCoverage: 0.61,

		// Empty defaults
		VelikostFirmyEmpty: 0.91,

		// Geographic skew
		PrahaConcentration: 0.15,

		// Power-law shape
		ContactsPerDomainAlpha: 1.2,

		// Company quality mix
		QualityRaw:      0.60,
		QualityEnriched: 0.30,
		QualityICPHigh:  0.08,
		QualityICPTop:   0.02,

		// Exclusion funnel
		ExclusionPass:      0.70,
		ExclusionPending:   0.20,
		ExclusionSoftBlock: 0.07,
		ExclusionHardBlock: 0.03,

		// ARES sync backlog
		AresSyncCoverage: 0.80,

		// Temporal horizon
		TemporalRecentDays: 180,
	}
}

// SourceTag is the canonical source value for prodlike-generated rows.
// All rows carry a source LIKE 'prodlike-%' so --clear-prodlike can
// target them surgically without touching e2e-seed or real data.
const SourceTag = "prodlike-v1"
