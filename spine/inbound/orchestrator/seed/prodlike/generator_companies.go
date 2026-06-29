package prodlike

import (
	"fmt"
	"math/rand/v2"
	"time"
)

// CompanyDraft mirrors the columns inserted into the `companies` table
// by the seed orchestrator. Fields named with the Czech migrations are
// preserved as-is.
type CompanyDraft struct {
	FirmyCzID        int
	ICO              string // 9-digit "TEST_" surrogate, never valid Czech IČO
	Name             string
	Email            string
	Website          string
	Telephone        string
	AddressLocality  string
	StreetAddress    string
	PostalCode       string
	Description      string
	VelikostFirmy    string
	PravniForma      string
	CategoryPath     string
	QualityTier      string // raw | enriched | icp_high | icp_top
	ExclusionStatus  string // pass | pending | soft_block | hard_block
	ExclusionReasons []string
	NACEPrimary      string
	NACECodes        []string
	AresSyncedAt     *time.Time // nil if not synced
	ICPScore         float64
	ICPTier          string // unscored | low | med | high | top
	SectorPrimary    string
	SectorConfidence float64
	RegionNormalized string
	VInsolvenci      bool
	VLikvidaci       bool
	DatumZaniku      *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
	Source           string // tag for --clear-prodlike targeting
}

// Sector/industry tags that match what the enrichment keyword classifier
// (internal/enrich/industry.go) produces. Weights are taken from the
// prod snapshot (top-12) with two non-enrichment sectors (professional,
// it) added because they're common in companies.sector_tags even though
// they don't come from industry keywords.
var companySectorWeights = []struct {
	Tag    string
	Weight int
}{
	{"construction", 150},
	{"automotive", 100},
	{"machinery", 90},
	{"agriculture", 85},
	{"transport", 65},
	{"woodwork", 58},
	{"metalwork", 48},
	{"energy", 45},
	{"manufacturing", 40},
	{"food_processing", 30},
	{"plastics", 25},
	{"waste", 12},
}

// velikostFirmyBuckets are the production labels (incl. empty case).
// Weights calibrated to prod: 91 % empty, rest distributed across small
// buckets with the 1–5 bucket dominating non-empty rows.
var velikostFirmyBuckets = []struct {
	Label  string
	Weight int
}{
	{"", 910},
	{"Bez zaměstnanců", 39},
	{"Neuvedeno", 39},
	{"1 - 5 zaměstnanců", 8},
	{"6 - 9 zaměstnanců", 2},
	{"10 - 19 zaměstnanců", 1},
	{"20 - 24 zaměstnanci", 1},
}

// pravniFormaBuckets likewise; 91 % empty dominant.
var pravniFormaBuckets = []struct {
	Label  string
	Weight int
}{
	{"", 910},
	{"Fyzická osoba podnikající dle živnostenského zákona", 60},
	{"Společnost s ručením omezeným", 16},
	{"Fyzická osoba podnikající dle jiných zákonů než živnostenského a zákona o zemědělství", 5},
	{"Zemědělský podnikatel - fyzická osoba", 3},
	{"Akciová společnost", 2},
	{"Družstvo", 2},
	{"Spolek", 2},
}

// Top 12 NACE primary codes roughly covering manufacturing/trade/services.
// Weights are illustrative — the exact distribution from ARES is noisy.
var naceBuckets = []struct {
	Code   string
	Weight int
}{
	{"41.20", 80}, // Construction of buildings
	{"43.22", 60}, // Plumbing, heat and air-conditioning
	{"25.11", 50}, // Manufacture of metal structures
	{"47.30", 45}, // Retail sale of automotive fuel (NACE retail exclusion)
	{"49.41", 40}, // Freight transport by road
	{"28.41", 35}, // Manufacture of metal forming machinery
	{"46.73", 30}, // Wholesale of wood, construction materials
	{"01.11", 28}, // Growing of cereals
	{"16.10", 25}, // Sawmilling and planing of wood
	{"25.62", 22}, // Machining
	{"22.29", 18}, // Manufacture of other plastic products
	{"29.10", 15}, // Manufacture of motor vehicles
}

// GenerateCompanies produces n CompanyDrafts with distributions calibrated
// from prod. Company names are drawn from the root pool + Czech surname;
// IČOs are 9-digit surrogates prefixed to visibly differ from real 8-digit
// Czech IČO values.
func GenerateCompanies(rng *rand.Rand, n int, r Ratios, now time.Time) []CompanyDraft {
	if n <= 0 {
		return nil
	}
	cityPick := CachedCityPicker()
	sectorWeights := make([]float64, len(companySectorWeights))
	for i, s := range companySectorWeights {
		sectorWeights[i] = float64(s.Weight)
	}
	sectorIdx := NewWeightedIndexer(sectorWeights)

	velikostWeights := make([]float64, len(velikostFirmyBuckets))
	for i, b := range velikostFirmyBuckets {
		velikostWeights[i] = float64(b.Weight)
	}
	velikostIdx := NewWeightedIndexer(velikostWeights)

	pravniWeights := make([]float64, len(pravniFormaBuckets))
	for i, b := range pravniFormaBuckets {
		pravniWeights[i] = float64(b.Weight)
	}
	pravniIdx := NewWeightedIndexer(pravniWeights)

	naceWeights := make([]float64, len(naceBuckets))
	for i, b := range naceBuckets {
		naceWeights[i] = float64(b.Weight)
	}
	naceIdx := NewWeightedIndexer(naceWeights)

	qualityWeights := []float64{r.QualityRaw, r.QualityEnriched, r.QualityICPHigh, r.QualityICPTop}
	qualityLabels := []string{"raw", "enriched", "icp_high", "icp_top"}
	qualityIdx := NewWeightedIndexer(qualityWeights)

	excWeights := []float64{r.ExclusionPass, r.ExclusionPending, r.ExclusionSoftBlock, r.ExclusionHardBlock}
	excLabels := []string{"pass", "pending", "soft_block", "hard_block"}
	excIdx := NewWeightedIndexer(excWeights)

	out := make([]CompanyDraft, 0, n)
	for i := 0; i < n; i++ {
		sector := companySectorWeights[sectorIdx.Pick(rng)].Tag
		city := cityPick(rng)
		velikost := velikostFirmyBuckets[velikostIdx.Pick(rng)].Label
		// Weight velikost independently: 91% should be empty per prod.
		if BernoulliCoverage(rng, r.VelikostFirmyEmpty) {
			velikost = ""
		}
		pravni := pravniFormaBuckets[pravniIdx.Pick(rng)].Label
		nace := naceBuckets[naceIdx.Pick(rng)].Code
		surname := PickString(rng, CzechSurnames)

		quality := qualityLabels[qualityIdx.Pick(rng)]
		excStatus := excLabels[excIdx.Pick(rng)]

		var icp float64
		var icpTier string
		switch quality {
		case "icp_top":
			icp = 0.85 + rng.Float64()*0.15
			icpTier = "top"
		case "icp_high":
			icp = 0.65 + rng.Float64()*0.20
			icpTier = "high"
		case "enriched":
			icp = 0.30 + rng.Float64()*0.30
			icpTier = pickMedOrLow(rng)
		default:
			icp = 0
			icpTier = "unscored"
		}

		var aresSyncedAt *time.Time
		if BernoulliCoverage(rng, r.AresSyncCoverage) {
			t := RecentTimestamp(rng, now, r.TemporalRecentDays)
			aresSyncedAt = &t
		}

		name := fmt.Sprintf("%s %s s.r.o.", capitalise(sector), surname)
		// IČO surrogates: "9" prefix + 8 digits guarantees 9-digit length;
		// real Czech IČO is exactly 8 digits, so collisions are impossible.
		icoDigits := rng.IntN(100000000)
		ico := fmt.Sprintf("9%08d", icoDigits)

		var reasons []string
		var vInsolvenci, vLikvidaci bool
		var datumZaniku *time.Time
		switch excStatus {
		case "hard_block":
			reasons = []string{"insolvence"}
			vInsolvenci = true
		case "soft_block":
			reasons = []string{"nace_exclusion"}
		}
		// A rare liquidation branch, independent of exclusion status.
		if BernoulliCoverage(rng, 0.01) {
			d := RecentTimestamp(rng, now, r.TemporalRecentDays*2)
			datumZaniku = &d
			vLikvidaci = true
		}

		created := RecentTimestamp(rng, now, r.TemporalRecentDays)
		updated := created.Add(time.Duration(rng.IntN(86400)) * time.Second)

		out = append(out, CompanyDraft{
			FirmyCzID:        i + 1, // sequential; caller offsets if needed
			ICO:              ico,
			Name:             name,
			Email:            "", // populated in contacts pipeline, not here
			Website:          "",
			Telephone:        "",
			AddressLocality:  city,
			StreetAddress:    "",
			PostalCode:       "",
			Description:      fmt.Sprintf("Společnost %s se zabývá činností v odvětví %s.", name, sector),
			VelikostFirmy:    velikost,
			PravniForma:      pravni,
			CategoryPath:     "",
			QualityTier:      quality,
			ExclusionStatus:  excStatus,
			ExclusionReasons: reasons,
			NACEPrimary:      nace,
			NACECodes:        []string{nace},
			AresSyncedAt:     aresSyncedAt,
			ICPScore:         icp,
			ICPTier:          icpTier,
			SectorPrimary:    sector,
			SectorConfidence: 0.70 + rng.Float64()*0.25,
			RegionNormalized: normaliseCity(city),
			VInsolvenci:      vInsolvenci,
			VLikvidaci:       vLikvidaci,
			DatumZaniku:      datumZaniku,
			CreatedAt:        created,
			UpdatedAt:        updated,
			Source:           SourceTag,
		})
	}
	return out
}

// pickMedOrLow returns "med" or "low" with 50/50 odds.
func pickMedOrLow(rng *rand.Rand) string {
	if rng.IntN(2) == 0 {
		return "med"
	}
	return "low"
}

// capitalise returns the input with first rune upper-cased. Safe for
// pure-ASCII sector names ("construction" → "Construction").
func capitalise(s string) string {
	if s == "" {
		return s
	}
	b := []byte(s)
	if b[0] >= 'a' && b[0] <= 'z' {
		b[0] -= 32
	}
	return string(b)
}

// normaliseCity collapses "Praha, Vinohrady" etc. to "Praha" for the
// region_normalized column — matches prod's normalisation convention.
func normaliseCity(city string) string {
	for i := 0; i < len(city); i++ {
		if city[i] == ',' {
			return city[:i]
		}
	}
	return city
}
