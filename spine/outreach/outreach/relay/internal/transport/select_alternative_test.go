// KT-A8.1 — SelectAlternative source-failover unit tests.
//
// These tests exercise the registry-level alt-source selector consumed by
// the contacts service's recovery loop. The registry is reset between
// tests to keep cross-test pollution out of the global map.

package transport

import (
	"sync"
	"testing"
)

// T-1: empty exclude list, no health data → any seeded source is returned
// (the registry seeds geonode/proxyscrape/proxifly with zero-value health,
// all three count as healthy).
func TestSelectAlternative_EmptyExcludeReturnsHealthy(t *testing.T) {
	resetGlobalSourceHealth()
	got := SelectAlternative("", nil)
	if got == "" {
		t.Fatalf("expected a healthy source, got empty string")
	}
	if got != "geonode" && got != "proxyscrape" && got != "proxifly" {
		t.Errorf("unexpected source name %q", got)
	}
}

// T-2: every source excluded → returns "".
func TestSelectAlternative_AllExcluded(t *testing.T) {
	resetGlobalSourceHealth()
	got := SelectAlternative("geonode", []string{"proxyscrape", "proxifly"})
	if got != "" {
		t.Errorf("expected empty when all excluded, got %q", got)
	}
}

// T-3: currentSource is excluded automatically (the caller doesn't have to
// repeat it in `exclude`).
func TestSelectAlternative_CurrentSourceExcluded(t *testing.T) {
	resetGlobalSourceHealth()
	// Two of three are excluded; the only remaining one is "proxifly".
	got := SelectAlternative("geonode", []string{"proxyscrape"})
	if got != "proxifly" {
		t.Errorf("expected proxifly, got %q", got)
	}
}

// T-4: degraded sources are skipped — only healthy ones are returned.
func TestSelectAlternative_SkipsDegradedSources(t *testing.T) {
	resetGlobalSourceHealth()
	// Push geonode + proxyscrape over the threshold so only proxifly stays
	// healthy.
	for i := 0; i < sourceZeroAlertThreshold; i++ {
		recordSourceResult("geonode", 0, nil)
		recordSourceResult("proxyscrape", 0, nil)
	}
	got := SelectAlternative("", nil)
	if got != "proxifly" {
		t.Errorf("expected proxifly (only healthy), got %q", got)
	}
}

// T-5: when every source is degraded the function returns "".
func TestSelectAlternative_AllDegraded(t *testing.T) {
	resetGlobalSourceHealth()
	for i := 0; i < sourceZeroAlertThreshold; i++ {
		recordSourceResult("geonode", 0, nil)
		recordSourceResult("proxyscrape", 0, nil)
		recordSourceResult("proxifly", 0, nil)
	}
	got := SelectAlternative("", nil)
	if got != "" {
		t.Errorf("expected empty when all degraded, got %q", got)
	}
}

// T-6: ties break lexicographically — with all three equally healthy
// (zero failures) the selector returns "geonode" deterministically.
func TestSelectAlternative_LexicographicTieBreak(t *testing.T) {
	resetGlobalSourceHealth()
	got := SelectAlternative("", nil)
	// geonode < proxifly < proxyscrape lexicographically.
	if got != "geonode" {
		t.Errorf("expected geonode (lex smallest), got %q", got)
	}
}

// T-7: lowest-consecutiveZero wins over the lex tiebreaker. Proxifly has 1
// failure, geonode has 2, proxyscrape has 0 → returns proxyscrape.
func TestSelectAlternative_LowestConsecutiveZero(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("proxifly", 0, nil)
	// proxyscrape stays at 0 failures.
	got := SelectAlternative("", nil)
	if got != "proxyscrape" {
		t.Errorf("expected proxyscrape (cleanest), got %q", got)
	}
}

// T-8: empty currentSource + empty exclude doesn't mis-handle the seed
// "" → returns one of the three.
func TestSelectAlternative_EmptyCurrentDoesNotExcludeAll(t *testing.T) {
	resetGlobalSourceHealth()
	got := SelectAlternative("", []string{})
	if got == "" {
		t.Fatalf("expected non-empty result with no exclusions")
	}
}

// T-9: empty strings inside exclude slice are ignored (they would otherwise
// "exclude all unnamed sources" — defensive contract).
func TestSelectAlternative_EmptyStringsInExclude(t *testing.T) {
	resetGlobalSourceHealth()
	got := SelectAlternative("", []string{"", "geonode"})
	if got == "" {
		t.Fatalf("expected non-empty result, empty strings should be ignored")
	}
	if got == "geonode" {
		t.Errorf("geonode should be excluded, got %q", got)
	}
}

// T-10: concurrent SelectAlternative + recordSourceResult calls don't race.
func TestSelectAlternative_ConcurrentSafe(t *testing.T) {
	resetGlobalSourceHealth()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			recordSourceResult("geonode", 100, nil)
		}()
		go func() {
			defer wg.Done()
			_ = SelectAlternative("proxyscrape", nil)
		}()
	}
	wg.Wait()
}

// T-11: only one source seeded as healthy after others get degraded → it
// is returned even when currentSource matches it (the function still returns
// "" because excluding currentSource removes the only candidate).
func TestSelectAlternative_OnlyHealthyIsCurrent(t *testing.T) {
	resetGlobalSourceHealth()
	for i := 0; i < sourceZeroAlertThreshold; i++ {
		recordSourceResult("proxyscrape", 0, nil)
		recordSourceResult("proxifly", 0, nil)
	}
	// geonode is the only healthy one, but it is also `currentSource`.
	got := SelectAlternative("geonode", nil)
	if got != "" {
		t.Errorf("expected empty when only healthy source is current, got %q", got)
	}
}
