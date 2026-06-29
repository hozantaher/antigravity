package transport

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// makePool builds a RotatingProxyTransport seeded with the given entries
// and the given preferredCountry, without starting any background goroutines.
func makePool(entries []proxyEntry, preferred string) *RotatingProxyTransport {
	t := &RotatingProxyTransport{
		working:          entries,
		fallback:         nil,
		lastRefresh:      time.Now(),
		preferredCountry: strings.ToUpper(strings.TrimSpace(preferred)),
	}
	return t
}

// TestCountryPref_AllCZ — all proxies are CZ, pick must always return CZ.
func TestCountryPref_AllCZ(t *testing.T) {
	entries := []proxyEntry{
		{addr: "1.1.1.1:1080", country: "CZ"},
		{addr: "2.2.2.2:1080", country: "CZ"},
		{addr: "3.3.3.3:1080", country: "CZ"},
	}
	pool := makePool(entries, "CZ")
	for i := 0; i < 9; i++ {
		e, ok := pool.pick()
		if !ok {
			t.Fatalf("iteration %d: pick returned !ok", i)
		}
		if strings.ToUpper(e.country) != "CZ" {
			t.Errorf("iteration %d: got country %q, want CZ", i, e.country)
		}
	}
}

// TestCountryPref_MixedCZSK — CZ+SK pool, pick must return CZ only.
func TestCountryPref_MixedCZSK(t *testing.T) {
	entries := []proxyEntry{
		{addr: "1.1.1.1:1080", country: "CZ"},
		{addr: "2.2.2.2:1080", country: "SK"},
		{addr: "3.3.3.3:1080", country: "CZ"},
		{addr: "4.4.4.4:1080", country: "SK"},
	}
	pool := makePool(entries, "CZ")
	for i := 0; i < 10; i++ {
		e, ok := pool.pick()
		if !ok {
			t.Fatalf("iteration %d: pick returned !ok", i)
		}
		if strings.ToUpper(e.country) != "CZ" {
			t.Errorf("iteration %d: got country %q, want CZ", i, e.country)
		}
	}
}

// TestCountryPref_NoCZ_FallbackFull — no CZ proxies, fallback to full pool (SK entries).
func TestCountryPref_NoCZ_FallbackFull(t *testing.T) {
	entries := []proxyEntry{
		{addr: "1.1.1.1:1080", country: "SK"},
		{addr: "2.2.2.2:1080", country: "SK"},
	}
	pool := makePool(entries, "CZ")
	for i := 0; i < 4; i++ {
		e, ok := pool.pick()
		if !ok {
			t.Fatalf("iteration %d: pick returned !ok", i)
		}
		if strings.ToUpper(e.country) == "CZ" {
			t.Errorf("iteration %d: unexpectedly got CZ country", i)
		}
	}
}

// TestCountryPref_EmptyPool — empty pool must return ok=false.
func TestCountryPref_EmptyPool(t *testing.T) {
	pool := makePool(nil, "CZ")
	_, ok := pool.pick()
	if ok {
		t.Error("pick() on empty pool should return ok=false")
	}
}

// TestCountryPref_DefaultCZ — empty env value → defaultCZ applied (mirrors constructor logic).
func TestCountryPref_DefaultCZ(t *testing.T) {
	// Mimic the constructor default-resolution logic without starting goroutines.
	envVal := "" // simulate unset PROXY_PREFERRED_COUNTRY
	preferred := strings.ToUpper(strings.TrimSpace(envVal))
	if preferred == "" {
		preferred = "CZ"
	}
	if preferred != "CZ" {
		t.Errorf("default preferredCountry = %q, want CZ", preferred)
	}

	// Verify that using the default causes CZ picks.
	entries := []proxyEntry{
		{addr: "1.1.1.1:1080", country: "CZ"},
		{addr: "2.2.2.2:1080", country: "SK"},
	}
	pool := makePool(entries, preferred)
	e, ok := pool.pick()
	if !ok {
		t.Fatal("pick returned !ok")
	}
	if strings.ToUpper(e.country) != "CZ" {
		t.Errorf("default CZ pick: got %q, want CZ", e.country)
	}
}

// TestCountryPref_WithPreferredCountry_Normalizes — WithPreferredCountry("sk") normalises to "SK".
func TestCountryPref_WithPreferredCountry_Normalizes(t *testing.T) {
	pool := makePool(nil, "")
	pool.WithPreferredCountry("sk")
	if pool.preferredCountry != "SK" {
		t.Errorf("WithPreferredCountry(\"sk\") = %q, want SK", pool.preferredCountry)
	}

	pool.WithPreferredCountry("  Cz  ")
	if pool.preferredCountry != "CZ" {
		t.Errorf("WithPreferredCountry(\"  Cz  \") = %q, want CZ", pool.preferredCountry)
	}
}

// TestCountryPref_RoundRobinInCZPool — 3 CZ proxies, 3 consecutive picks must return 3 distinct addresses.
func TestCountryPref_RoundRobinInCZPool(t *testing.T) {
	entries := []proxyEntry{
		{addr: "a:1080", country: "CZ"},
		{addr: "b:1080", country: "CZ"},
		{addr: "c:1080", country: "CZ"},
	}
	pool := makePool(entries, "CZ")

	seen := make(map[string]bool)
	for i := 0; i < 3; i++ {
		e, ok := pool.pick()
		if !ok {
			t.Fatalf("pick %d returned !ok", i)
		}
		if seen[e.addr] {
			t.Errorf("pick %d: address %q already seen — not round-robin", i, e.addr)
		}
		seen[e.addr] = true
	}
	if len(seen) != 3 {
		t.Errorf("expected 3 distinct addresses, got %d", len(seen))
	}
}

// TestCountryPref_SnapshotPreferredCountryCount — Snapshot reports correct PreferredCountryCount.
func TestCountryPref_SnapshotPreferredCountryCount(t *testing.T) {
	entries := []proxyEntry{
		{addr: "1:1080", country: "CZ"},
		{addr: "2:1080", country: "CZ"},
		{addr: "3:1080", country: "SK"},
		{addr: "4:1080", country: "DE"},
	}
	pool := makePool(entries, "CZ")
	snap := pool.Snapshot()
	if snap.PreferredCountry != "CZ" {
		t.Errorf("Snapshot.PreferredCountry = %q, want CZ", snap.PreferredCountry)
	}
	if snap.PreferredCountryCount != 2 {
		t.Errorf("Snapshot.PreferredCountryCount = %d, want 2", snap.PreferredCountryCount)
	}
	if len(snap.Working) != 4 {
		t.Errorf("Snapshot.Working len = %d, want 4", len(snap.Working))
	}
}

// TestCountryPref_SnapshotPreferredCountryCount_Zero — no preferred country match → count 0.
func TestCountryPref_SnapshotPreferredCountryCount_Zero(t *testing.T) {
	entries := []proxyEntry{
		{addr: "1:1080", country: "SK"},
		{addr: "2:1080", country: "DE"},
	}
	pool := makePool(entries, "CZ")
	snap := pool.Snapshot()
	if snap.PreferredCountryCount != 0 {
		t.Errorf("Snapshot.PreferredCountryCount = %d, want 0", snap.PreferredCountryCount)
	}
}

// TestCountryPref_RaceSafe — 10 goroutines calling pick() concurrently; -race must find no issues.
func TestCountryPref_RaceSafe(t *testing.T) {
	entries := make([]proxyEntry, 0, 10)
	for i := 0; i < 5; i++ {
		entries = append(entries, proxyEntry{addr: "cz" + string(rune('0'+i)) + ":1080", country: "CZ"})
	}
	for i := 0; i < 5; i++ {
		entries = append(entries, proxyEntry{addr: "sk" + string(rune('0'+i)) + ":1080", country: "SK"})
	}
	pool := makePool(entries, "CZ")

	var wg sync.WaitGroup
	const goroutines = 10
	const picksPerGoroutine = 20
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < picksPerGoroutine; j++ {
				e, ok := pool.pick()
				if !ok {
					return
				}
				_ = e.addr
			}
		}()
	}
	wg.Wait()
}

// TestCountryPref_FallbackLogsWarning — fallback to full pool logs a warning with country and total.
func TestCountryPref_FallbackLogsWarning(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))
	orig := slog.Default()
	slog.SetDefault(logger)
	defer slog.SetDefault(orig)

	entries := []proxyEntry{
		{addr: "1:1080", country: "SK"},
		{addr: "2:1080", country: "DE"},
	}
	pool := makePool(entries, "CZ")
	_, ok := pool.pick()
	if !ok {
		t.Fatal("pick returned !ok — expected fallback to full pool")
	}

	got := buf.String()
	if !strings.Contains(got, "no proxies for preferred country") {
		t.Errorf("expected warning log, got: %q", got)
	}
	if !strings.Contains(got, "CZ") {
		t.Errorf("warning log should include the country, got: %q", got)
	}
}
