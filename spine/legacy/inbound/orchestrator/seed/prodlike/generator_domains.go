package prodlike

import (
	"math/rand/v2"
)

// DomainDraft is the in-memory representation of one outreach_domains row
// before it's inserted. The generator stage returns a slice of these; the
// seed orchestrator inserts them in bulk within a transaction.
type DomainDraft struct {
	Domain       string
	DomainType   string // corporate | unknown | business | gov | edu | freemail
	MXVerified   bool
	DailySendCap int
}

// domainTypeWeights returns the WeightedIndexer buckets used to draw a
// domain_type honouring the Ratios. Order matches returnTypes below.
func domainTypeWeights(r Ratios) []float64 {
	return []float64{
		r.DomainCorporate,
		r.DomainUnknown,
		r.DomainBusiness,
		r.DomainGov,
		r.DomainEdu,
		r.DomainFreemail,
	}
}

var domainTypeLabels = []string{"corporate", "unknown", "business", "gov", "edu", "freemail"}

// GenerateDomains produces `n` unique DomainDrafts with types distributed
// per Ratios. Corporate domains come from GenerateCorporateDomains;
// freemail/gov/edu/business use their curated fixture slices.
//
// Determinism: the output depends only on (rng, n, r). Re-running with
// the same seed yields identical Domain strings in the same order.
func GenerateDomains(rng *rand.Rand, n int, r Ratios) []DomainDraft {
	if n <= 0 {
		return nil
	}
	out := make([]DomainDraft, 0, n)

	// Compute how many of each type we need based on ratios.
	targets := plannedDomainCounts(n, r)

	// Pool of corporate names, large enough to cover "corporate" target
	// with unique host strings.
	corpPool := GenerateCorporateDomains(targets[0])

	// Shuffle corpPool deterministically so consecutive calls with the
	// same rng still produce stable order.
	rng.Shuffle(len(corpPool), func(i, j int) { corpPool[i], corpPool[j] = corpPool[j], corpPool[i] })

	// Emit corporate
	for i := 0; i < targets[0] && i < len(corpPool); i++ {
		out = append(out, DomainDraft{
			Domain:       corpPool[i],
			DomainType:   "corporate",
			MXVerified:   true,
			DailySendCap: 10,
		})
	}

	// Unknown: use a fresh corporate-style pool but flag as unknown so
	// ClassifyDomain's fallback path gets exercised.
	unknownPool := GenerateCorporateDomains(targets[1])
	rng.Shuffle(len(unknownPool), func(i, j int) { unknownPool[i], unknownPool[j] = unknownPool[j], unknownPool[i] })
	// Prefix to visually separate from corporate in logs.
	for i := 0; i < targets[1] && i < len(unknownPool); i++ {
		out = append(out, DomainDraft{
			Domain:       "unk-" + unknownPool[i],
			DomainType:   "unknown",
			MXVerified:   false,
			DailySendCap: 3,
		})
	}

	// Business — hard-coded fixture, cycle if we need more than available.
	for i := 0; i < targets[2]; i++ {
		out = append(out, DomainDraft{
			Domain:       BusinessTestDomains[i%len(BusinessTestDomains)],
			DomainType:   "business",
			MXVerified:   true,
			DailySendCap: 5,
		})
	}

	// Gov
	for i := 0; i < targets[3]; i++ {
		out = append(out, DomainDraft{
			Domain:       GovTestDomains[i%len(GovTestDomains)],
			DomainType:   "gov",
			MXVerified:   true,
			DailySendCap: 2,
		})
	}

	// Edu
	for i := 0; i < targets[4]; i++ {
		out = append(out, DomainDraft{
			Domain:       EduTestDomains[i%len(EduTestDomains)],
			DomainType:   "edu",
			MXVerified:   true,
			DailySendCap: 2,
		})
	}

	// Freemail — these are always corporate-type emails in outreach_domains
	// per the schema, but we mark them freemail for ClassifyDomain coverage.
	for i := 0; i < targets[5]; i++ {
		f := FreemailTestDomains[i%len(FreemailTestDomains)]
		out = append(out, DomainDraft{
			Domain:       f.Domain,
			DomainType:   "freemail",
			MXVerified:   true,
			DailySendCap: 1,
		})
	}

	// Because integer rounding may leave us short or over by 1–2, trim
	// or pad to exactly n.
	if len(out) > n {
		out = out[:n]
	}
	for len(out) < n {
		// Fall back to more corporate domains with disambiguating suffix.
		extras := GenerateCorporateDomains(n - len(out) + 100)
		for _, d := range extras {
			if len(out) >= n {
				break
			}
			out = append(out, DomainDraft{
				Domain:       "ext-" + d,
				DomainType:   "corporate",
				MXVerified:   true,
				DailySendCap: 10,
			})
		}
	}
	// Final deduplication pass to guarantee UNIQUE(domain).
	seen := make(map[string]struct{}, len(out))
	dedup := out[:0]
	for _, d := range out {
		if _, ok := seen[d.Domain]; ok {
			continue
		}
		seen[d.Domain] = struct{}{}
		dedup = append(dedup, d)
	}
	out = dedup
	// One more pad pass if dedup removed entries.
	for len(out) < n {
		extras := GenerateCorporateDomains(n - len(out) + 100)
		for _, d := range extras {
			name := "pad-" + d
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			out = append(out, DomainDraft{
				Domain:       name,
				DomainType:   "corporate",
				MXVerified:   true,
				DailySendCap: 10,
			})
			if len(out) >= n {
				break
			}
		}
	}
	return out
}

// plannedDomainCounts computes integer per-type bucket counts that sum
// to exactly n. Rounding slack is absorbed into the corporate bucket
// (by far the largest).
//
// Any non-zero weight is rounded up to a floor of 1 whenever n is at
// least 1/weight. This guarantees the "coverage" buckets (gov, edu,
// freemail) are always represented in reasonably-sized datasets,
// avoiding the pathological case where a 0.05 % ratio at n=2000
// integer-floors to zero even though one row would be statistically
// justified.
func plannedDomainCounts(n int, r Ratios) [6]int {
	weights := domainTypeWeights(r)
	sum := 0.0
	for _, w := range weights {
		sum += w
	}
	var counts [6]int
	allocated := 0
	for i := 1; i < 6; i++ { // corporate absorbs rounding; computed last
		target := float64(n) * weights[i] / sum
		c := int(target)
		// Floor-at-1 promotion: if the weight justifies at least one
		// row (target >= 1 / n) we keep a representative sample even
		// when integer truncation would have zeroed it.
		if c == 0 && weights[i] > 0 && float64(n)*weights[i] >= 1.0 {
			c = 1
		}
		// Second rescue: at n >= 2000, any positive weight gets at least 1.
		if c == 0 && weights[i] > 0 && n >= 2000 {
			c = 1
		}
		counts[i] = c
		allocated += c
	}
	counts[0] = n - allocated
	if counts[0] < 0 {
		counts[0] = 0
	}
	return counts
}
