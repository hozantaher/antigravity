package wgpool

import (
	"testing"
	"time"
)

// mkMixedPool builds a pool with endpoints in multiple countries.
// Countries assigned round-robin from the given list.
func mkMixedPool(t *testing.T, countries []string, cfg Config) *Pool {
	t.Helper()
	eps := make([]Endpoint, len(countries))
	for i, c := range countries {
		eps[i] = Endpoint{
			Label:     "ep-" + string(rune('a'+i)),
			SocksAddr: "127.0.0.1:108" + string(rune('0'+i)),
			Country:   c,
		}
	}
	p, err := New(eps, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return p
}

// TestPick_PreferredCountry_ReturnsSKEndpoint verifies that Pick with "SK"
// always returns an SK endpoint when one is healthy.
func TestPick_PreferredCountry_ReturnsSKEndpoint(t *testing.T) {
	p := mkMixedPool(t, []string{"SK", "RO", "DE", "SK"}, Config{})

	for i := 0; i < 20; i++ {
		got, err := p.Pick("env-"+string(rune('0'+i)), "mb-goran", "SK")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		if got.Country != "SK" {
			t.Fatalf("pick %d: got country %q, want SK", i, got.Country)
		}
	}
}

// TestPick_PreferredCountry_ReturnsROEndpoint verifies RO pinning.
func TestPick_PreferredCountry_ReturnsROEndpoint(t *testing.T) {
	p := mkMixedPool(t, []string{"SK", "RO", "DE", "RO"}, Config{})

	for i := 0; i < 20; i++ {
		got, err := p.Pick("env-"+string(rune('0'+i)), "mb-nowak", "RO")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		if got.Country != "RO" {
			t.Fatalf("pick %d: got country %q, want RO", i, got.Country)
		}
	}
}

// TestPick_PreferredCountry_FallsBackWhenAllQuarantined verifies that when all
// SK endpoints are quarantined, Pick returns any healthy endpoint (fallback).
func TestPick_PreferredCountry_FallsBackWhenAllQuarantined(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkMixedPool(t, []string{"SK", "RO", "DE"}, Config{
		QuarantineThreshold: 1,
		QuarantineDuration:  5 * time.Minute,
		Now:                 func() time.Time { return now },
	})

	// Quarantine the only SK endpoint.
	p.RecordFailure("ep-a") // SK

	got, err := p.Pick("env-1", "mb-goran", "SK")
	if err != nil {
		t.Fatalf("pick after SK quarantine: %v", err)
	}
	// Must fall back to non-SK country (RO or DE).
	if got.Country == "SK" {
		t.Fatalf("expected fallback to non-SK endpoint, got SK (%s)", got.Label)
	}
}

// TestPick_PreferredCountry_EmptyUsesFullPool verifies no country filter applied
// when preferredCountry is "".
func TestPick_PreferredCountry_EmptyUsesFullPool(t *testing.T) {
	p := mkMixedPool(t, []string{"SK", "RO", "DE", "AT"}, Config{})

	seen := map[string]struct{}{}
	for i := 0; i < 200; i++ {
		got, err := p.Pick("env-"+string(rune(i%96+33)), "", "")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		seen[got.Country] = struct{}{}
	}
	if len(seen) < 3 {
		t.Fatalf("expected spread across countries, got only: %v", seen)
	}
}

// TestPick_PreferredCountry_NoCountryArgUsesFullPool ensures backward compat
// (no variadic arg = same as empty preferredCountry).
func TestPick_PreferredCountry_NoCountryArgUsesFullPool(t *testing.T) {
	p := mkMixedPool(t, []string{"SK", "RO", "DE", "AT"}, Config{})

	seen := map[string]struct{}{}
	for i := 0; i < 200; i++ {
		got, err := p.Pick("env-"+string(rune(i%96+33)), "")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		seen[got.Country] = struct{}{}
	}
	if len(seen) < 3 {
		t.Fatalf("expected spread across countries, got only: %v", seen)
	}
}

// TestPick_PreferredCountry_UnknownCountryFallsBack verifies that a country
// code with no matching endpoints falls back to full active pool.
func TestPick_PreferredCountry_UnknownCountryFallsBack(t *testing.T) {
	p := mkMixedPool(t, []string{"SK", "RO", "DE"}, Config{})

	got, err := p.Pick("env-1", "mb-x", "XX")
	if err != nil {
		t.Fatalf("pick with unknown country: %v", err)
	}
	// Any endpoint returned is fine — the key is no error, not nil endpoint.
	if got.Label == "" {
		t.Fatal("expected non-empty endpoint label")
	}
}

// TestPick_PreferredCountry_AllQuarantinedReturnsErrAllQuarantined verifies
// the existing ErrAllQuarantined behaviour is untouched when every endpoint
// is down (regardless of country filter).
func TestPick_PreferredCountry_AllQuarantinedReturnsErrAllQuarantined(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkMixedPool(t, []string{"SK", "RO"}, Config{
		QuarantineThreshold: 1,
		QuarantineDuration:  5 * time.Minute,
		Now:                 func() time.Time { return now },
	})

	p.RecordFailure("ep-a") // SK
	p.RecordFailure("ep-b") // RO

	_, err := p.Pick("env-1", "mb-x", "SK")
	if err == nil {
		t.Fatal("expected ErrAllQuarantined, got nil")
	}
}

// TestPick_Affinity_RespectsCountryPin verifies that affinity evicts a sticky
// endpoint that violates the preferred country and picks a new one.
func TestPick_Affinity_RespectsCountryPin(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkMixedPool(t, []string{"SK", "RO", "DE"}, Config{
		AffinityEnabled: true,
		AffinityWindow:  10,
		Now:             func() time.Time { return now },
	})

	// First pick with no country — sticks to some endpoint.
	first, err := p.Pick("env-first", "mb-1")
	if err != nil {
		t.Fatalf("first pick: %v", err)
	}
	_ = first

	// Now pick with "SK" preference — must return SK even if affinity
	// was established for a different endpoint.
	got, err := p.Pick("env-second", "mb-1", "SK")
	if err != nil {
		t.Fatalf("country pick: %v", err)
	}
	if got.Country != "SK" {
		t.Fatalf("expected SK endpoint, got country=%q label=%q", got.Country, got.Label)
	}
}

// TestPick_CaseInsensitiveCountry verifies that "sk" and "SK" match the same
// endpoints.
func TestPick_CaseInsensitiveCountry(t *testing.T) {
	p := mkMixedPool(t, []string{"SK", "RO"}, Config{})

	for _, c := range []string{"sk", "SK", "Sk"} {
		got, err := p.Pick("env-1", "mb-1", c)
		if err != nil {
			t.Fatalf("pick with %q: %v", c, err)
		}
		if got.Country != "SK" {
			t.Fatalf("pick with %q: got country %q, want SK", c, got.Country)
		}
	}
}

// TestFilterByCountry_BasicFiltering unit-tests the helper directly.
func TestFilterByCountry_BasicFiltering(t *testing.T) {
	eps := []Endpoint{
		{Label: "a", Country: "SK"},
		{Label: "b", Country: "RO"},
		{Label: "c", Country: "SK"},
		{Label: "d", Country: "DE"},
	}
	got := filterByCountry(eps, "SK")
	if len(got) != 2 {
		t.Fatalf("expected 2 SK endpoints, got %d: %v", len(got), got)
	}
	for _, ep := range got {
		if ep.Country != "SK" {
			t.Fatalf("unexpected country %q in filtered result", ep.Country)
		}
	}
}

// TestFilterByCountry_NoMatch returns nil (not empty slice) for unknown country.
func TestFilterByCountry_NoMatch(t *testing.T) {
	eps := []Endpoint{
		{Label: "a", Country: "SK"},
		{Label: "b", Country: "RO"},
	}
	got := filterByCountry(eps, "XX")
	if len(got) != 0 {
		t.Fatalf("expected empty result for unknown country, got %d", len(got))
	}
}

// TestPick_TwoDifferentMailboxes_NoCrossContamination verifies that two
// mailboxes with different country pins never get each other's country.
func TestPick_TwoDifferentMailboxes_NoCrossContamination(t *testing.T) {
	p := mkMixedPool(t, []string{"SK", "RO", "DE", "SK", "RO"}, Config{})

	for i := 0; i < 30; i++ {
		envID := "env-" + string(rune('a'+i))

		skEp, err := p.Pick(envID, "mb-nowak-gorak", "SK")
		if err != nil {
			t.Fatalf("SK pick %d: %v", i, err)
		}
		if skEp.Country != "SK" {
			t.Fatalf("SK pick %d: got %q, want SK", i, skEp.Country)
		}

		roEp, err := p.Pick(envID, "mb-goran-nowak", "RO")
		if err != nil {
			t.Fatalf("RO pick %d: %v", i, err)
		}
		if roEp.Country != "RO" {
			t.Fatalf("RO pick %d: got %q, want RO", i, roEp.Country)
		}
	}
}
