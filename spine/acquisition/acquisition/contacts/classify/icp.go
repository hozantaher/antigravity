package classify

// ICP scoring gates industry fit as a necessary condition, not an optional
// factor. Non-sector polish (size, data completeness, rating, age, legal
// form) cannot lift a wrong-industry row above "irrelevant" / "marginal".
// Acceptance gate: internal/classify/icp_realism_test.go — do not weaken
// caps without updating that file first.

import (
	"strings"
	"time"
)

// ICPConfig defines the target customer profile.
type ICPConfig struct {
	TargetSectors []string
	TargetRegions []string // empty = all regions match
}

// DefaultICPConfig returns the default ICP for machinery B2B outreach.
func DefaultICPConfig() ICPConfig {
	return ICPConfig{
		TargetSectors: []string{
			"machinery", "machinery_cnc", "machinery_hydraulic", "machinery_agricultural",
			"metalwork", "metalwork_stamping", "metalwork_casting",
			"construction", "construction_civil", "construction_specialized",
			"automotive", "automotive_parts",
			"manufacturing", "woodwork", "plastics", "food_processing",
			"energy", "agriculture", "transport", "waste", "mining",
			"chemicals", "electronics",
		},
	}
}

// ICPInput contains all signals for ICP calculation.
type ICPInput struct {
	SectorTags  []string
	CompanySize string
	Region      string
	HasWebsite  bool
	HasEmail    bool
	HasPhone    bool
	RatingValue float64
	RatingCount int
	// Enriched from ARES
	DatumVzniku *time.Time
	PravniForma string
}

// ICPFactors breaks down ICP score components for operator transparency.
// Parallels TargetingFactors on outreach_contacts.
type ICPFactors struct {
	SectorFit    float64 `json:"sector_fit"`
	SizeFit      float64 `json:"size_fit"`
	Completeness float64 `json:"completeness"`
	RegionFit    float64 `json:"region_fit"`
	RatingSignal float64 `json:"rating_signal"`
	AgeStability float64 `json:"age_stability"`
	LegalFormFit float64 `json:"legal_form_fit"`
}

// CalculateICPWithFactors computes the ICP score and returns the factor breakdown.
//
// The weighted sum is clamped to [0, 1] and then capped according to business
// rules (see the ceiling comment below). Structural factors still contribute
// inside the cap — the cap is a ceiling, not a clamp to exactly that value.
func CalculateICPWithFactors(input ICPInput, config ICPConfig) (float64, ICPFactors) {
	f := ICPFactors{
		SectorFit:    sectorFit(input.SectorTags, config.TargetSectors),
		SizeFit:      sizeFit(input.CompanySize),
		Completeness: dataCompleteness(input),
		RegionFit:    regionFit(input.Region, config.TargetRegions),
		RatingSignal: ratingSignal(input.RatingValue, input.RatingCount),
		AgeStability: ageStabilitySignal(input.DatumVzniku),
		LegalFormFit: legalFormFit(input.PravniForma),
	}
	score := f.SectorFit*0.35 +
		f.SizeFit*0.20 +
		f.Completeness*0.10 +
		f.RegionFit*0.10 +
		f.RatingSignal*0.05 +
		f.AgeStability*0.10 +
		f.LegalFormFit*0.10
	if score > 1 {
		score = 1
	}
	if score < 0 {
		score = 0
	}

	// Business ceiling: industry fit is necessary, not optional. No amount of
	// size/data polish turns a law firm into an excavator buyer. The caps below
	// stack (anti-target → no-sector → micro-size); we always apply the
	// tightest ceiling that matches.
	ceiling := 1.0
	if hasAntiTargetSector(input.SectorTags) {
		// Tagged with a structurally wrong sector (retail, hospitality, IT,
		// professional services, etc.): irrelevant to a heavy-machinery dealer.
		ceiling = 0.15
	} else if f.SectorFit == 0 {
		// No target-sector match at all (unknown or untagged industry):
		// the row might be in-sector but we have no evidence, so cap to
		// just-above-irrelevant until a human confirms.
		ceiling = 0.2
	}
	if isMicroSize(input.CompanySize) {
		// Solo / 1-5 micro firms even in the right sector cannot close a
		// new-excavator deal. Tier them as "marginal" (just below the 0.4
		// "good" threshold) so they can still be enriched and followed up.
		if ceiling > 0.39 {
			ceiling = 0.39
		}
	}

	if score > ceiling {
		score = ceiling
	}
	return score, f
}

// hasAntiTargetSector returns true if any of the company's sector tags is a
// known-irrelevant sector for heavy-machinery outreach. See AntiTargetSectors
// in nace_map.go for the list and rationale.
func hasAntiTargetSector(tags []string) bool {
	for _, t := range tags {
		if AntiTargetSectors[t] {
			return true
		}
	}
	return false
}

// isMicroSize returns true for company-size buckets that are structurally too
// small to close a new-machinery deal, regardless of industry fit.
// The string forms are the exact enum values that firmy.cz / ARES emit and
// that sizeFit already switches on.
func isMicroSize(size string) bool {
	switch strings.TrimSpace(size) {
	case "Bez zaměstnanců", "1 - 5 zaměstnanců":
		return true
	}
	return false
}

// CalculateICP computes the Ideal Customer Profile score (0.0-1.0).
func CalculateICP(input ICPInput, config ICPConfig) float64 {
	score, _ := CalculateICPWithFactors(input, config)
	return score
}

// ICPTier returns the ICP tier label for a given score.
func ICPTier(score float64) string {
	switch {
	case score >= 0.7:
		return "ideal"
	case score >= 0.4:
		return "good"
	case score >= 0.2:
		return "marginal"
	default:
		return "irrelevant"
	}
}

func sectorFit(tags, targets []string) float64 {
	if len(tags) == 0 || len(targets) == 0 {
		return 0
	}
	targetSet := make(map[string]bool, len(targets))
	for _, t := range targets {
		targetSet[t] = true
	}
	matches := 0
	for _, tag := range tags {
		if targetSet[tag] {
			matches++
		}
	}
	if matches == 0 {
		return 0
	}
	return min64(float64(matches)*0.6, 1.0)
}

func sizeFit(size string) float64 {
	switch size {
	case "10 - 19 zaměstnanců", "20 - 24 zaměstnanci", "25 - 49 zaměstnanců":
		return 1.0
	case "50 - 99 zaměstnanců", "100 - 199 zaměstnanců":
		return 0.8
	case "6 - 9 zaměstnanců":
		return 0.7
	case "200 - 249 zaměstnanců", "250 - 499 zaměstnanců":
		return 0.5
	case "1 - 5 zaměstnanců":
		return 0.4
	case "500 - 999 zaměstnanců":
		return 0.3
	case "Bez zaměstnanců":
		return 0.1
	default:
		return 0.3
	}
}

func dataCompleteness(input ICPInput) float64 {
	score := 0.0
	if input.HasEmail {
		score += 0.5
	}
	if input.HasWebsite {
		score += 0.25
	}
	if input.HasPhone {
		score += 0.25
	}
	return score
}

func regionFit(region string, targets []string) float64 {
	if len(targets) == 0 {
		return 1.0
	}
	for _, t := range targets {
		if strings.EqualFold(region, t) {
			return 1.0
		}
	}
	return 0.3
}

func ratingSignal(value float64, count int) float64 {
	if count == 0 {
		return 0.3
	}
	if value >= 4.0 && count >= 5 {
		return 1.0
	}
	if value >= 3.0 {
		return 0.6
	}
	return 0.2
}

// ageStabilitySignal returns a stability score based on company age.
// Sweet spot: 5–15 years (established, still agile).
// Returns 0.5 for unknown founding date.
func ageStabilitySignal(datumVzniku *time.Time) float64 {
	if datumVzniku == nil || datumVzniku.IsZero() {
		return 0.5
	}
	years := time.Since(*datumVzniku).Hours() / 8760
	switch {
	case years >= 5 && years < 15:
		return 1.0
	case years >= 15:
		return 0.7
	case years >= 2:
		return 0.5
	default:
		return 0.2
	}
}

// legalFormFit scores Czech legal forms for B2B outreach suitability.
// s.r.o. and a.s. have clear decision structures; FO/OSVČ are harder to reach.
func legalFormFit(forma string) float64 {
	f := strings.ToLower(strings.TrimSpace(forma))
	switch {
	case strings.Contains(f, "s.r.o") || strings.Contains(f, "spol. s r.o") ||
		strings.Contains(f, "společnost s ručením"):
		return 1.0
	case strings.Contains(f, "a.s") || strings.Contains(f, "akciová"):
		return 0.9
	case strings.Contains(f, "k.s") || strings.Contains(f, "komanditní"):
		return 0.7
	case strings.Contains(f, "v.o.s") || strings.Contains(f, "veřejná obchodní"):
		return 0.7
	case strings.Contains(f, "osvč") || strings.Contains(f, "fyzická osoba") ||
		strings.Contains(f, "fo "):
		return 0.4
	case f == "":
		return 0.5
	default:
		return 0.5
	}
}
