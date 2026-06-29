package prodlike

import (
	"math"
	"math/rand/v2"
	"sort"
	"time"
)

// WeightedChoice returns the index of the chosen bucket based on the
// provided non-negative weights. Panics if weights is empty or sums to
// zero.
//
// This is the workhorse sampler used throughout the generators for
// drawing categorical variables like consent tier, domain type,
// quality tier, or exclusion status.
//
// Complexity: O(n) per call, which is fine for the small (≤10) bucket
// lists we use. For high-frequency hot-paths with large n, a precomputed
// alias table would be preferable — not needed here.
func WeightedChoice(rng *rand.Rand, weights []float64) int {
	if len(weights) == 0 {
		panic("WeightedChoice: empty weights")
	}
	total := 0.0
	for _, w := range weights {
		if w < 0 {
			panic("WeightedChoice: negative weight")
		}
		total += w
	}
	if total <= 0 {
		panic("WeightedChoice: weights sum to zero")
	}
	r := rng.Float64() * total
	acc := 0.0
	for i, w := range weights {
		acc += w
		if r < acc {
			return i
		}
	}
	return len(weights) - 1 // floating-point tail case
}

// WeightedIndexer wraps a weighted-choice set to avoid redundant
// summation when the same weights are reused across many draws.
type WeightedIndexer struct {
	cum   []float64
	total float64
}

// NewWeightedIndexer precomputes the cumulative distribution function.
// Call Pick(rng) for each sample.
func NewWeightedIndexer(weights []float64) *WeightedIndexer {
	cum := make([]float64, len(weights))
	acc := 0.0
	for i, w := range weights {
		if w < 0 {
			panic("NewWeightedIndexer: negative weight")
		}
		acc += w
		cum[i] = acc
	}
	if acc <= 0 {
		panic("NewWeightedIndexer: weights sum to zero")
	}
	return &WeightedIndexer{cum: cum, total: acc}
}

// Pick returns the index chosen for a single RNG draw.
// O(log n) via binary search on the CDF.
func (w *WeightedIndexer) Pick(rng *rand.Rand) int {
	r := rng.Float64() * w.total
	i := sort.SearchFloat64s(w.cum, r)
	if i >= len(w.cum) {
		return len(w.cum) - 1
	}
	return i
}

// ZipfSample draws from a discrete Zipf-like distribution on the
// integers [1, n] with exponent alpha. Smaller alpha => flatter tail,
// larger alpha => more concentrated on small ranks.
//
// For domain→contacts count, alpha=1.2 on n=50 is close to the prod
// long-tail observed in outreach_domains (a handful of domains
// have hundreds of contacts; most have 1–3).
//
// Implementation: inverse CDF sampling against a precomputed table.
// For n up to a few hundred the overhead is negligible.
type Zipf struct {
	cdf []float64
	n   int
}

// NewZipf builds a distribution over [1, n] with the given exponent.
func NewZipf(n int, alpha float64) *Zipf {
	if n < 1 {
		n = 1
	}
	if alpha <= 0 {
		alpha = 1.0
	}
	cdf := make([]float64, n)
	acc := 0.0
	for i := 1; i <= n; i++ {
		acc += 1.0 / math.Pow(float64(i), alpha)
		cdf[i-1] = acc
	}
	// Normalise to 1.0 for numerical stability.
	for i := range cdf {
		cdf[i] /= acc
	}
	return &Zipf{cdf: cdf, n: n}
}

// Sample returns an integer in [1, n].
func (z *Zipf) Sample(rng *rand.Rand) int {
	r := rng.Float64()
	i := sort.SearchFloat64s(z.cdf, r)
	if i >= z.n {
		return z.n
	}
	return i + 1
}

// RecentTimestamp returns a timestamp in the window [now-days, now]
// with exponential bias toward "recent". Half the mass lies in the
// most recent days/4 slice, which matches production where ingestion
// is recent-heavy.
//
// The returned time is truncated to the second so tests comparing
// timestamps round-trip cleanly through PostgreSQL TIMESTAMPTZ.
func RecentTimestamp(rng *rand.Rand, now time.Time, days int) time.Time {
	if days <= 0 {
		return now
	}
	// Exponential decay: p(d) ∝ exp(-lambda * d). With lambda chosen so
	// that the median lies at days/4, ≈75 % of samples fall in the
	// second half of the window (newer).
	lambda := math.Ln2 / float64(days) * 4
	// Inverse CDF: d = -ln(1 - U) / lambda, truncated to [0, days].
	u := rng.Float64()
	d := -math.Log(1-u) / lambda
	if d < 0 {
		d = 0
	}
	if d > float64(days) {
		d = float64(days)
	}
	seconds := int64(d * 86400)
	return now.Add(-time.Duration(seconds) * time.Second).Truncate(time.Second)
}

// TargetingScoreForTier returns a score drawn uniformly from the tier's
// window. This lets the generator target a specific consent-tier ratio
// while still producing variability within each tier.
//
//	tier 0 → auto   [0.70, 1.00]
//	tier 1 → low    [0.40, 0.70)
//	tier 2 → manual [0.20, 0.40)
//	tier 3 → block  [0.00, 0.20)
func TargetingScoreForTier(rng *rand.Rand, tier int) float64 {
	switch tier {
	case 0:
		return 0.70 + rng.Float64()*0.30
	case 1:
		return 0.40 + rng.Float64()*0.30
	case 2:
		return 0.20 + rng.Float64()*0.20
	default:
		return rng.Float64() * 0.20
	}
}

// PickString picks a random element from a non-empty string slice.
// Panics if the slice is empty — the generators always pass curated
// corpora, so an empty slice indicates a programming error.
func PickString(rng *rand.Rand, xs []string) string {
	if len(xs) == 0 {
		panic("PickString: empty slice")
	}
	return xs[rng.IntN(len(xs))]
}

// CityByWeight draws a city name honouring the CzechCities weight
// table. Exposed for use by the generators and by tests that verify
// the Praha concentration.
func CityByWeight(rng *rand.Rand) string {
	weights := make([]float64, len(CzechCities))
	for i, c := range CzechCities {
		weights[i] = float64(c.Weight)
	}
	i := WeightedChoice(rng, weights)
	return CzechCities[i].Name
}

// CachedCityPicker returns a closure that reuses a WeightedIndexer so
// sampling N cities is O(N log K) rather than O(N K). Used when the
// generator draws thousands of city labels.
func CachedCityPicker() func(rng *rand.Rand) string {
	weights := make([]float64, len(CzechCities))
	for i, c := range CzechCities {
		weights[i] = float64(c.Weight)
	}
	idx := NewWeightedIndexer(weights)
	return func(rng *rand.Rand) string {
		return CzechCities[idx.Pick(rng)].Name
	}
}

// BernoulliCoverage returns true with probability p, false otherwise.
// Used for "58 % of rows have an email" style sampling.
func BernoulliCoverage(rng *rand.Rand, p float64) bool {
	if p <= 0 {
		return false
	}
	if p >= 1 {
		return true
	}
	return rng.Float64() < p
}
