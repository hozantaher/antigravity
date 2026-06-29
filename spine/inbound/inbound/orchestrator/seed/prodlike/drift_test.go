package prodlike

import (
	"math"
	"testing"
	"time"
)

// prodSnapshot holds the production distribution the synthetic data is
// calibrated to mirror. Captured from a direct query against the Railway
// outreach DB on 2026-04-16. Refresh quarterly when the live dataset
// drifts materially.
var prodSnapshot = struct {
	// Consent tier shares (fractions, sum to 1.0).
	ConsentAuto, ConsentLow, ConsentManual, ConsentBlock float64
	// Top industry tag shares (only the dominant 6 listed; minor tags
	// have too much Monte-Carlo variance to anchor to).
	TopIndustries map[string]float64
	// Domain type shares — corporate dominates in prod.
	DomainCorporate, DomainFreemailGov float64
}{
	ConsentAuto:       0.135,
	ConsentLow:        0.863,
	ConsentManual:     0.0026,
	ConsentBlock:      0.00002,
	TopIndustries: map[string]float64{
		"construction": 0.147,
		"automotive":   0.095,
		"machinery":    0.082,
		"agriculture":  0.081,
		"transport":    0.062,
		"woodwork":     0.054,
	},
	DomainCorporate:   0.85,
	DomainFreemailGov: 0.015, // freemail + gov + edu combined (rare buckets)
}

// TestProdlikeDriftConsentTiers fails if the generated consent-tier
// distribution drifts more than 20 % from the recorded prod snapshot.
// The 20 % tolerance accounts for Monte-Carlo noise at n=5 000 samples
// while still catching structural drift (e.g. a rewrite of the tier
// assignment that silently flips the auto/low split).
func TestProdlikeDriftConsentTiers(t *testing.T) {
	rng := NewRNGFromSeed(42)
	ratios := DefaultRatios()
	now := time.Now().UTC()
	domains := GenerateDomains(rng, 500, ratios)
	companies := GenerateCompanies(rng, 500, ratios, now)
	contacts := GenerateContacts(rng, 5000, companies, domains, ratios, now)

	counts := map[string]int{}
	for _, c := range contacts {
		counts[tierOf(c.TargetingScore)]++
	}
	total := float64(len(contacts))

	assertWithin(t, "consent.auto", float64(counts["auto"])/total, prodSnapshot.ConsentAuto, 0.20)
	assertWithin(t, "consent.low", float64(counts["low"])/total, prodSnapshot.ConsentLow, 0.05)
	// manual + block tiers are rare enough that 20 % relative tolerance
	// would allow near-zero false positives; use absolute bounds instead.
	manualShare := float64(counts["manual"]) / total
	if manualShare > 0.02 {
		t.Errorf("manual tier share %.4f too large (absolute cap 0.02)", manualShare)
	}
}

// TestProdlikeDriftIndustryCoverage fails if the top-6 industry tags
// from prod are under-represented in the synthetic output. This catches
// the pathological case where the weight table is accidentally reset
// to uniform.
func TestProdlikeDriftIndustryCoverage(t *testing.T) {
	rng := NewRNGFromSeed(42)
	ratios := DefaultRatios()
	now := time.Now().UTC()
	domains := GenerateDomains(rng, 200, ratios)
	companies := GenerateCompanies(rng, 400, ratios, now)
	contacts := GenerateContacts(rng, 5000, companies, domains, ratios, now)

	counts := map[string]int{}
	for _, c := range contacts {
		for _, tag := range c.IndustryTags {
			counts[tag]++
		}
	}
	total := 0
	for _, n := range counts {
		total += n
	}
	for tag, want := range prodSnapshot.TopIndustries {
		got := float64(counts[tag]) / float64(total)
		// 60 % relative tolerance — the prod snapshot counts include
		// non-keyword-classifier tags (professional, hospitality, it,
		// health) that the synthetic generator never emits, inflating
		// its per-tag shares proportionally. The test exists to catch
		// structural breakage (single tag at 0 % or 80 %), not to
		// match prod ratios exactly.
		assertWithin(t, "industry."+tag, got, want, 0.60)
	}
}

// TestProdlikeDriftDomainTypes fails if the corporate domain share
// drops below 0.75 (prod is 0.85). A material drop would mean freemail
// contacts are over-represented and the consent penalty dominates.
func TestProdlikeDriftDomainTypes(t *testing.T) {
	rng := NewRNGFromSeed(42)
	domains := GenerateDomains(rng, 2000, DefaultRatios())
	counts := map[string]int{}
	for _, d := range domains {
		counts[d.DomainType]++
	}
	total := float64(len(domains))
	corp := float64(counts["corporate"]) / total
	if corp < 0.75 {
		t.Errorf("corporate share %.4f below floor 0.75", corp)
	}
	// Freemail+gov+edu combined should be a small minority.
	rare := float64(counts["freemail"]+counts["gov"]+counts["edu"]) / total
	assertWithin(t, "domain.rare_buckets", rare, prodSnapshot.DomainFreemailGov, 0.50)
}

// tierOf classifies a targeting score into the four production tiers.
func tierOf(score float64) string {
	switch {
	case score >= 0.7:
		return "auto"
	case score >= 0.4:
		return "low"
	case score >= 0.2:
		return "manual"
	default:
		return "block"
	}
}

// assertWithin checks that `got` is within (1±tol) * want. Used across
// all drift tests so failures report consistent diagnostics.
func assertWithin(t *testing.T, label string, got, want, tol float64) {
	t.Helper()
	if want == 0 {
		if got != 0 {
			t.Errorf("%s: got %.4f, expected 0", label, got)
		}
		return
	}
	delta := math.Abs(got-want) / want
	if delta > tol {
		t.Errorf("%s: got %.4f (want %.4f ± %.0f%%; actual drift %.2f%%)",
			label, got, want, tol*100, delta*100)
	}
}
