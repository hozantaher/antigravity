package prodlike

import (
	"math/rand/v2"
	"strconv"

	"common/envconfig"
)

// DefaultSeed is used when SEED_RNG is unset or invalid. Matches the
// canonical "answer to everything" so CI logs stay recognisable.
const DefaultSeed int64 = 42

// NewRNG returns a deterministic PCG source wrapped in *rand.Rand.
//
// The seed is taken from the SEED_RNG env variable if set, otherwise
// DefaultSeed. The same seed always produces the same byte-for-byte
// dataset, which is essential for drift tests and reproducible bug
// reports.
//
// We use math/rand/v2 (Go 1.22+) with PCG because:
//   - it's statistically stronger than math/rand v1's default,
//   - it seeds from two uint64 values, giving 2^128 distinct streams,
//   - its outputs are stable across Go versions (v1 changed in 1.20).
func NewRNG() *rand.Rand {
	return NewRNGFromSeed(seedFromEnv())
}

// NewRNGFromSeed builds a deterministic RNG from an explicit int64.
// Exposed for tests that want to vary the seed without touching env.
func NewRNGFromSeed(seed int64) *rand.Rand {
	// Derive two uint64 halves from a single int64 so callers can pass
	// one human-friendly number. The second half is XOR-shifted so
	// seed=0 and seed=1 don't produce correlated streams.
	hi := uint64(seed)
	lo := uint64(seed) ^ 0x9E3779B97F4A7C15 // golden-ratio constant
	return rand.New(rand.NewPCG(hi, lo))
}

// seedFromEnv parses SEED_RNG. Any parse failure falls back to
// DefaultSeed silently — deterministic behaviour matters more than
// surfacing a typo here.
func seedFromEnv() int64 {
	raw := envconfig.GetOr("SEED_RNG", "")
	if raw == "" {
		return DefaultSeed
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return DefaultSeed
	}
	return n
}
