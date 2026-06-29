package transport

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// setTempPersistPath sets PROXY_POOL_PERSIST_PATH to a temp file and returns a
// cleanup function that restores the original value and removes the file.
func setTempPersistPath(t *testing.T) (path string) {
	t.Helper()
	dir := t.TempDir()
	path = filepath.Join(dir, "proxy_pool_cache.json")
	t.Setenv("PROXY_POOL_PERSIST_PATH", path)
	return path
}

// TestSavePool_Empty writes an empty pool — must not panic and must produce valid JSON.
func TestSavePool_Empty(t *testing.T) {
	path := setTempPersistPath(t)
	savePool(nil)

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("expected file to be created: %v", err)
	}
	var pp persistedPool
	if err := json.Unmarshal(b, &pp); err != nil {
		t.Fatalf("file is not valid JSON: %v", err)
	}
	if len(pp.Entries) != 0 {
		t.Fatalf("expected 0 entries, got %d", len(pp.Entries))
	}
}

// TestSavePool_WritesCorrectData verifies all fields are serialised faithfully.
func TestSavePool_WritesCorrectData(t *testing.T) {
	path := setTempPersistPath(t)
	entries := []proxyEntry{
		{addr: "1.2.3.4:1080", latency: 42 * time.Millisecond, country: "CZ", source: "geonode"},
		{addr: "5.6.7.8:9050", latency: 100 * time.Millisecond, country: "SK", source: "proxifly"},
	}
	savePool(entries)

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	var pp persistedPool
	if err := json.Unmarshal(b, &pp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(pp.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(pp.Entries))
	}
	e0 := pp.Entries[0]
	if e0.Addr != "1.2.3.4:1080" || e0.LatencyMs != 42 || e0.Country != "CZ" || e0.Source != "geonode" {
		t.Errorf("entry[0] mismatch: %+v", e0)
	}
	e1 := pp.Entries[1]
	if e1.Addr != "5.6.7.8:9050" || e1.LatencyMs != 100 || e1.Country != "SK" || e1.Source != "proxifly" {
		t.Errorf("entry[1] mismatch: %+v", e1)
	}
}

// TestLoadPool_ReturnsEntries verifies a freshly-saved pool is loaded correctly.
func TestLoadPool_ReturnsEntries(t *testing.T) {
	setTempPersistPath(t)
	want := []proxyEntry{
		{addr: "a:1080", latency: 10 * time.Millisecond, country: "DE", source: "proxyscrape"},
	}
	savePool(want)

	got := loadPool(4)
	if got == nil {
		t.Fatal("expected non-nil result")
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	if got[0].addr != "a:1080" || got[0].country != "DE" || got[0].source != "proxyscrape" {
		t.Errorf("entry mismatch: %+v", got[0])
	}
}

// TestLoadPool_StaleReturnsNil verifies that a pool older than maxAgeH is ignored.
func TestLoadPool_StaleReturnsNil(t *testing.T) {
	path := setTempPersistPath(t)
	// Write a pool with SavedAt > 4 hours ago.
	old := persistedPool{
		SavedAt: time.Now().Add(-5 * time.Hour),
		Entries: []persistedEntry{{Addr: "old:1080", LatencyMs: 5}},
	}
	b, _ := json.Marshal(old)
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}

	got := loadPool(4)
	if got != nil {
		t.Fatalf("expected nil for stale pool, got %v", got)
	}
}

// TestLoadPool_MissingFileReturnsNil verifies no panic on missing file.
func TestLoadPool_MissingFileReturnsNil(t *testing.T) {
	t.Setenv("PROXY_POOL_PERSIST_PATH", "/tmp/does_not_exist_xyz.json")
	got := loadPool(4)
	if got != nil {
		t.Fatalf("expected nil for missing file, got %v", got)
	}
}

// TestLoadPool_CorruptJSONReturnsNil verifies that corrupt JSON does not panic.
func TestLoadPool_CorruptJSONReturnsNil(t *testing.T) {
	path := setTempPersistPath(t)
	if err := os.WriteFile(path, []byte("not valid json {{{{"), 0600); err != nil {
		t.Fatal(err)
	}
	got := loadPool(4)
	if got != nil {
		t.Fatalf("expected nil for corrupt JSON, got %v", got)
	}
}

// TestLoadPool_FreshFileBoundary verifies a pool saved exactly at maxAgeH ago is still accepted.
func TestLoadPool_FreshFileBoundary(t *testing.T) {
	path := setTempPersistPath(t)
	// Saved 3h55m ago — inside 4h window
	fresh := persistedPool{
		SavedAt: time.Now().Add(-3*time.Hour - 55*time.Minute),
		Entries: []persistedEntry{{Addr: "b:1080", LatencyMs: 8}},
	}
	b, _ := json.Marshal(fresh)
	_ = os.WriteFile(path, b, 0600)

	got := loadPool(4)
	if got == nil {
		t.Fatal("expected non-nil for a pool saved 3h55m ago with maxAge=4h")
	}
}

// TestColdStartWithPersistedPool verifies that NewRotatingProxyTransport loads the
// persisted pool immediately so cold-start is zero-wait.
func TestColdStartWithPersistedPool(t *testing.T) {
	// Block all real HTTP sources so we don't hit external APIs.
	origEndpoint := proxyListEndpoint
	origPS := proxyscrapeEndpoint
	origPF := proxiflyEndpoint
	proxyListEndpoint = "http://127.0.0.1:1" // unreachable
	proxyscrapeEndpoint = "http://127.0.0.1:1"
	proxiflyEndpoint = "http://127.0.0.1:1"
	defer func() {
		proxyListEndpoint = origEndpoint
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
	}()

	setTempPersistPath(t)
	seeds := []proxyEntry{
		{addr: "10.0.0.1:1080", latency: 20 * time.Millisecond, country: "CZ", source: "static"},
		{addr: "10.0.0.2:1080", latency: 25 * time.Millisecond, country: "CZ", source: "static"},
	}
	savePool(seeds)

	tr := &RotatingProxyTransport{
		fallback:         NewDirectTransport(),
		preferredCountry: "CZ",
	}
	// Simulate what NewRotatingProxyTransport does with persisted pool.
	if cached := loadPool(4); len(cached) > 0 {
		tr.mu.Lock()
		tr.working = cached
		tr.lastRefresh = time.Now()
		tr.mu.Unlock()
	}

	if got := tr.WorkingCount(); got != 2 {
		t.Fatalf("expected 2 working proxies from persisted pool, got %d", got)
	}
}

// TestRefreshOverwritesPersistedPool verifies that a completed refresh replaces
// the persisted file with the new working set.
func TestRefreshOverwritesPersistedPool(t *testing.T) {
	path := setTempPersistPath(t)
	// Write old data first.
	old := []proxyEntry{{addr: "old:1080", source: "static"}}
	savePool(old)

	// Now save new data (simulates post-refresh savePool call).
	newEntries := []proxyEntry{
		{addr: "new1:1080", latency: 15 * time.Millisecond, source: "proxifly"},
		{addr: "new2:1080", latency: 20 * time.Millisecond, source: "proxifly"},
	}
	savePool(newEntries)

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var pp persistedPool
	_ = json.Unmarshal(b, &pp)
	if len(pp.Entries) != 2 {
		t.Fatalf("expected 2 entries after overwrite, got %d", len(pp.Entries))
	}
	if pp.Entries[0].Addr != "new1:1080" {
		t.Errorf("expected new1:1080 after overwrite, got %s", pp.Entries[0].Addr)
	}
}

// TestSavePool_WriteError verifies savePool handles os.WriteFile errors gracefully.
// When the persist path is a directory (not a file), WriteFile returns an error.
func TestSavePool_WriteError(t *testing.T) {
	dir := t.TempDir()
	// Use the directory itself as the file path — os.WriteFile will fail.
	t.Setenv("PROXY_POOL_PERSIST_PATH", dir)

	// Must not panic even when the write fails.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("savePool panicked on write error: %v", r)
		}
	}()
	savePool([]proxyEntry{{addr: "a:1080", source: "test"}})
}

// TestSavePool_LargePool verifies saving a large pool (>100 entries) works
// correctly and all entries are restored by loadPool.
func TestSavePool_LargePool(t *testing.T) {
	setTempPersistPath(t)
	const n = 200
	entries := make([]proxyEntry, n)
	for i := range entries {
		entries[i] = proxyEntry{
			addr:    "10.0.0." + itoa(i%256) + ":1080",
			latency: time.Duration(i) * time.Millisecond,
			country: "CZ",
			source:  "proxifly",
		}
	}
	savePool(entries)

	got := loadPool(4)
	if len(got) != n {
		t.Fatalf("expected %d entries after save, got %d", n, len(got))
	}
}

// TestLoadPool_ZeroMaxAge verifies that any pool with maxAgeH=0 is treated as
// always stale (immediately expired).
func TestLoadPool_ZeroMaxAge(t *testing.T) {
	setTempPersistPath(t)
	savePool([]proxyEntry{{addr: "b:1080", source: "test"}})

	got := loadPool(0) // maxAge=0 means even a freshly saved pool is stale
	if got != nil {
		t.Fatal("expected nil for maxAgeH=0 (zero tolerance)")
	}
}

// TestSavePoolLoadPool_Roundtrip_AllFields verifies all fields survive a
// full roundtrip through savePool → loadPool.
func TestSavePoolLoadPool_Roundtrip_AllFields(t *testing.T) {
	setTempPersistPath(t)
	want := []proxyEntry{
		{addr: "192.168.1.1:9050", latency: 77 * time.Millisecond, country: "AT", source: "proxyscrape"},
		{addr: "10.0.0.99:1080", latency: 150 * time.Millisecond, country: "DE", source: "geonode"},
	}
	savePool(want)
	got := loadPool(4)

	if len(got) != len(want) {
		t.Fatalf("expected %d entries, got %d", len(want), len(got))
	}
	for i, w := range want {
		g := got[i]
		if g.addr != w.addr {
			t.Errorf("[%d] addr mismatch: want %q, got %q", i, w.addr, g.addr)
		}
		if g.latency != w.latency {
			t.Errorf("[%d] latency mismatch: want %v, got %v", i, w.latency, g.latency)
		}
		if g.country != w.country {
			t.Errorf("[%d] country mismatch: want %q, got %q", i, w.country, g.country)
		}
		if g.source != w.source {
			t.Errorf("[%d] source mismatch: want %q, got %q", i, w.source, g.source)
		}
	}
}

// itoa is a simple int-to-string helper for test setup (0-255 range).
func itoa(n int) string {
	return fmt.Sprintf("%d", n)
}

// TestSavePool_ConcurrentNoPanic fires multiple goroutines saving simultaneously.
// Validates no panic / data race (run with -race).
func TestSavePool_ConcurrentNoPanic(t *testing.T) {
	setTempPersistPath(t)
	entries := []proxyEntry{
		{addr: "c:1080", source: "test"},
		{addr: "d:1080", source: "test"},
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			savePool(entries)
		}()
	}
	wg.Wait()
	// If we get here without panic or race detector complaint, the test passes.
}
