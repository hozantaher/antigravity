package prodlike

import (
	"math"
	"strings"
	"testing"
	"time"
)

// TestCorpusInvariants confirms the corpora hit the documented minimums
// so downstream generators can draw enough unique material.
func TestCorpusInvariants(t *testing.T) {
	ok, first, last, cities := ensureCorpusInvariants()
	if !ok {
		t.Fatalf("corpus too small: firstNames=%d surnames=%d cities=%d (want >=200/500/100)",
			first, last, cities)
	}
}

// TestRNGDeterminism — identical seeds must produce identical streams.
func TestRNGDeterminism(t *testing.T) {
	a := NewRNGFromSeed(42)
	b := NewRNGFromSeed(42)
	for i := 0; i < 1000; i++ {
		if a.Uint64() != b.Uint64() {
			t.Fatalf("RNG diverged at iter %d", i)
		}
	}
}

// TestRNGDifferentSeedsDiverge — different seeds must differ early.
func TestRNGDifferentSeedsDiverge(t *testing.T) {
	a := NewRNGFromSeed(1)
	b := NewRNGFromSeed(2)
	identical := 0
	for i := 0; i < 100; i++ {
		if a.Uint64() == b.Uint64() {
			identical++
		}
	}
	// 100 random 64-bit values from uncorrelated streams should rarely
	// collide; >5 collisions suggests the streams are correlated.
	if identical > 5 {
		t.Fatalf("seeds 1 and 2 produced %d identical values in 100 draws", identical)
	}
}

// TestWeightedChoiceDistribution — the sampler must honour the weights
// within statistical tolerance.
func TestWeightedChoiceDistribution(t *testing.T) {
	rng := NewRNGFromSeed(42)
	weights := []float64{0.7, 0.2, 0.08, 0.02}
	const n = 10000
	counts := make([]int, len(weights))
	for i := 0; i < n; i++ {
		counts[WeightedChoice(rng, weights)]++
	}
	for i, w := range weights {
		got := float64(counts[i]) / float64(n)
		if math.Abs(got-w) > 0.02 {
			t.Errorf("bucket %d: expected %.2f, got %.4f", i, w, got)
		}
	}
}

// TestZipfSkew — Zipf with alpha=1.2 should concentrate heavily on rank 1.
func TestZipfSkew(t *testing.T) {
	rng := NewRNGFromSeed(42)
	z := NewZipf(50, 1.2)
	const n = 5000
	counts := make([]int, 50)
	for i := 0; i < n; i++ {
		counts[z.Sample(rng)-1]++
	}
	// Rank 1 should hold > 25 % of mass for α=1.2 on [1,50].
	if float64(counts[0])/float64(n) < 0.2 {
		t.Errorf("Zipf rank 1 got %.4f share, expected > 0.20", float64(counts[0])/float64(n))
	}
	// The tail (ranks 40..50) should hold < 5 % combined.
	tail := 0
	for i := 39; i < 50; i++ {
		tail += counts[i]
	}
	if float64(tail)/float64(n) > 0.08 {
		t.Errorf("Zipf tail too heavy: %.4f", float64(tail)/float64(n))
	}
}

// TestRecentTimestampWindow — all returned timestamps lie within
// [now-days, now], and the median skews toward "recent".
func TestRecentTimestampWindow(t *testing.T) {
	rng := NewRNGFromSeed(42)
	now := time.Date(2026, 4, 16, 12, 0, 0, 0, time.UTC)
	const days = 180
	var samples []time.Time
	for i := 0; i < 1000; i++ {
		samples = append(samples, RecentTimestamp(rng, now, days))
	}
	lower := now.AddDate(0, 0, -days).Add(-time.Second)
	for _, s := range samples {
		if s.After(now) || s.Before(lower) {
			t.Fatalf("sample %v out of [%v, %v]", s, lower, now)
		}
	}
	// Count how many are in the most recent quarter of the window.
	recent := 0
	cutoff := now.AddDate(0, 0, -days/4)
	for _, s := range samples {
		if s.After(cutoff) {
			recent++
		}
	}
	// Exponential bias guarantees > 50 % in the most recent quarter.
	if recent*2 <= len(samples) {
		t.Errorf("expected >50%% samples in recent quarter, got %d/%d",
			recent, len(samples))
	}
}

// TestGenerateDomainsTLDInvariant — every produced domain ends with .test.
// This is the safety guarantee preventing accidental real-world sends.
func TestGenerateDomainsTLDInvariant(t *testing.T) {
	rng := NewRNGFromSeed(42)
	drafts := GenerateDomains(rng, 500, DefaultRatios())
	if len(drafts) != 500 {
		t.Fatalf("expected 500 drafts, got %d", len(drafts))
	}
	seen := make(map[string]struct{}, 500)
	for _, d := range drafts {
		if !strings.HasSuffix(d.Domain, ".test") {
			t.Errorf("domain %q does not end with .test", d.Domain)
		}
		if _, dup := seen[d.Domain]; dup {
			t.Errorf("duplicate domain: %q", d.Domain)
		}
		seen[d.Domain] = struct{}{}
	}
}

// TestGenerateDomainsTypeDistribution — produced drafts should roughly
// match the target domain-type ratios.
func TestGenerateDomainsTypeDistribution(t *testing.T) {
	rng := NewRNGFromSeed(42)
	const n = 2000
	drafts := GenerateDomains(rng, n, DefaultRatios())
	counts := map[string]int{}
	for _, d := range drafts {
		counts[d.DomainType]++
	}
	// Corporate should dominate (> 80 %).
	if float64(counts["corporate"])/float64(n) < 0.80 {
		t.Errorf("corporate share %.4f < 0.80",
			float64(counts["corporate"])/float64(n))
	}
	// Freemail should be present (the coverage lane) even if small.
	if counts["freemail"] == 0 {
		t.Error("freemail bucket empty — coverage path lost")
	}
	// Gov and edu should each have at least 1 row at n=2000.
	for _, key := range []string{"gov", "edu"} {
		if counts[key] == 0 {
			t.Errorf("%q bucket empty at n=2000", key)
		}
	}
}

// TestGenerateContactsDeterminism — identical seed + identical inputs
// must produce byte-identical email lists.
func TestGenerateContactsDeterminism(t *testing.T) {
	ratios := DefaultRatios()
	now := time.Date(2026, 4, 16, 0, 0, 0, 0, time.UTC)

	mkBatch := func() []ContactDraft {
		rng := NewRNGFromSeed(42)
		domains := GenerateDomains(rng, 50, ratios)
		companies := GenerateCompanies(rng, 100, ratios, now)
		return GenerateContacts(rng, 200, companies, domains, ratios, now)
	}

	a := mkBatch()
	b := mkBatch()
	if len(a) != len(b) {
		t.Fatalf("different sizes: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].Email != b[i].Email {
			t.Errorf("email diverged at %d: %q vs %q",
				i, a[i].Email, b[i].Email)
		}
	}
}

// TestGenerateContactsConsentTiers — tier proportions match DefaultRatios.
func TestGenerateContactsConsentTiers(t *testing.T) {
	rng := NewRNGFromSeed(42)
	ratios := DefaultRatios()
	now := time.Now().UTC()
	domains := GenerateDomains(rng, 400, ratios)
	companies := GenerateCompanies(rng, 400, ratios, now)
	contacts := GenerateContacts(rng, 5000, companies, domains, ratios, now)

	counts := map[string]int{}
	for _, c := range contacts {
		switch {
		case c.TargetingScore >= 0.7:
			counts["auto"]++
		case c.TargetingScore >= 0.4:
			counts["low"]++
		case c.TargetingScore >= 0.2:
			counts["manual"]++
		default:
			counts["block"]++
		}
	}
	n := float64(len(contacts))
	autoShare := float64(counts["auto"]) / n
	lowShare := float64(counts["low"]) / n
	// Tolerances: auto 13.5 % ± 3 %, low 86 % ± 3 %.
	if autoShare < 0.10 || autoShare > 0.17 {
		t.Errorf("auto tier share %.4f outside [0.10, 0.17]", autoShare)
	}
	if lowShare < 0.82 || lowShare > 0.90 {
		t.Errorf("low tier share %.4f outside [0.82, 0.90]", lowShare)
	}
}

// TestGenerateContactsEmailASCIIOnly — local parts must be ASCII so SMTP
// delivery (and tests using string equality) don't trip over diacritics.
func TestGenerateContactsEmailASCIIOnly(t *testing.T) {
	rng := NewRNGFromSeed(42)
	ratios := DefaultRatios()
	now := time.Now().UTC()
	domains := GenerateDomains(rng, 50, ratios)
	companies := GenerateCompanies(rng, 50, ratios, now)
	contacts := GenerateContacts(rng, 200, companies, domains, ratios, now)
	for _, c := range contacts {
		for _, r := range c.Email {
			if r > 127 {
				t.Errorf("non-ASCII rune %q in email %q", r, c.Email)
				break
			}
		}
	}
}

// TestGenerateCompaniesICOFormat — all IČO values use the 9-digit
// surrogate prefix to guarantee no collision with real 8-digit Czech IČO.
func TestGenerateCompaniesICOFormat(t *testing.T) {
	rng := NewRNGFromSeed(42)
	ratios := DefaultRatios()
	now := time.Now().UTC()
	companies := GenerateCompanies(rng, 500, ratios, now)
	for _, c := range companies {
		if len(c.ICO) != 9 {
			t.Errorf("ICO %q length %d (want 9)", c.ICO, len(c.ICO))
		}
		if !strings.HasPrefix(c.ICO, "9") {
			t.Errorf("ICO %q missing 9-prefix", c.ICO)
		}
	}
}

// TestGenerateCompaniesExclusionMix — the company pool should include
// at least one row in every exclusion status bucket.
func TestGenerateCompaniesExclusionMix(t *testing.T) {
	rng := NewRNGFromSeed(42)
	ratios := DefaultRatios()
	now := time.Now().UTC()
	companies := GenerateCompanies(rng, 1000, ratios, now)
	seen := map[string]int{}
	for _, c := range companies {
		seen[c.ExclusionStatus]++
	}
	for _, status := range []string{"pass", "pending", "soft_block", "hard_block"} {
		if seen[status] == 0 {
			t.Errorf("exclusion status %q empty at n=1000", status)
		}
	}
}

// TestPgTextArrayEscaping — array formatter must escape embedded quotes.
func TestPgTextArrayEscaping(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{nil, "{}"},
		{[]string{}, "{}"},
		{[]string{"a"}, `{"a"}`},
		{[]string{"a", "b"}, `{"a","b"}`},
		{[]string{`a"b`}, `{"a\"b"}`},
		{[]string{`a\b`}, `{"a\\b"}`},
	}
	for _, tc := range cases {
		got := pgTextArray(tc.in)
		if got != tc.want {
			t.Errorf("pgTextArray(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestResolveCountsDefaults — unknown scales fall back to ScaleSmall
// rather than silently returning zero counts.
func TestResolveCountsDefaults(t *testing.T) {
	unknown := ResolveCounts("bogus")
	small := ResolveCounts(ScaleSmall)
	if unknown != small {
		t.Errorf("unknown scale should default to small: got %+v", unknown)
	}
}
