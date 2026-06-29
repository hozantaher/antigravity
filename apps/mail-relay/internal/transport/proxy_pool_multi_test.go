package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

// TestFetchProxyListMulti_UnionDedup confirms the multi-source fetcher merges
// geonode + proxyscrape results and de-dupes by host:port.
func TestFetchProxyListMulti_UnionDedup(t *testing.T) {
	geonode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{
				{"ip": "1.1.1.1", "port": "1080"},
				{"ip": "2.2.2.2", "port": "1080"}, // overlap with proxyscrape
				{"ip": "3.3.3.3", "port": "1080"},
			},
		})
	}))
	defer geonode.Close()

	proxyscrape := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "2.2.2.2:1080\n4.4.4.4:1080\n\n   \nnot-a-proxy\n5.5.5.5:1080\n")
	}))
	defer proxyscrape.Close()

	proxifly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, "[]")
	}))
	defer proxifly.Close()

	origGeo, origPS, origPF, origPFFB := proxyListEndpoint, proxyscrapeEndpoint, proxiflyEndpoint, proxiflyFallbackURL
	proxyListEndpoint = geonode.URL
	proxyscrapeEndpoint = proxyscrape.URL
	proxiflyEndpoint = proxifly.URL
	proxiflyFallbackURL = proxifly.URL // prevent fallback from hitting real GitHub URL
	defer func() {
		proxyListEndpoint = origGeo
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
	}()

	cands, err := fetchProxyListMulti(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	addrs := candAddrs(cands)
	sort.Strings(addrs)
	want := []string{"1.1.1.1:1080", "2.2.2.2:1080", "3.3.3.3:1080", "4.4.4.4:1080", "5.5.5.5:1080"}
	if len(addrs) != len(want) {
		t.Fatalf("expected %d addrs, got %d: %v", len(want), len(addrs), addrs)
	}
	for i, w := range want {
		if addrs[i] != w {
			t.Errorf("addr[%d]: want %q got %q", i, w, addrs[i])
		}
	}
	// Verify first-wins dedup on 2.2.2.2: declared order puts proxifly before
	// geonode before proxyscrape. Geonode supplied 2.2.2.2, proxyscrape also
	// supplied it; geonode should win and the source tag should reflect that.
	for _, c := range cands {
		if c.addr == "2.2.2.2:1080" && c.source != "geonode" {
			t.Errorf("2.2.2.2 should carry source=geonode (first-wins), got %q", c.source)
		}
	}
}

// candAddrs extracts just the host:port strings from a candidate slice so
// existing string-oriented test assertions keep working after the shift to
// proxyCandidate.
func candAddrs(cands []proxyCandidate) []string {
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		out = append(out, c.addr)
	}
	return out
}

// TestFetchProxyListMulti_OneSourceFails verifies one failing source doesn't
// block the other — we still get proxyscrape's addrs when geonode 500s.
func TestFetchProxyListMulti_OneSourceFails(t *testing.T) {
	geonode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer geonode.Close()

	proxyscrape := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "7.7.7.7:1080\n8.8.8.8:1080\n")
	}))
	defer proxyscrape.Close()

	proxifly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer proxifly.Close()

	origGeo, origPS, origPF, origPFFB := proxyListEndpoint, proxyscrapeEndpoint, proxiflyEndpoint, proxiflyFallbackURL
	proxyListEndpoint = geonode.URL
	proxyscrapeEndpoint = proxyscrape.URL
	proxiflyEndpoint = proxifly.URL
	proxiflyFallbackURL = proxifly.URL // prevent fallback from hitting real GitHub URL
	defer func() {
		proxyListEndpoint = origGeo
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
	}()

	cands, err := fetchProxyListMulti(context.Background())
	if err != nil {
		t.Fatalf("expected ok (one source live), got err: %v", err)
	}
	if len(cands) != 2 {
		t.Fatalf("expected 2 addrs from surviving source, got %d: %v", len(cands), candAddrs(cands))
	}
}

// TestFetchProxyListMulti_AllSourcesFail only surfaces an error when
// zero sources returned anything.
func TestFetchProxyListMulti_AllSourcesFail(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer down.Close()

	origGeo, origPS, origPF, origPFFB := proxyListEndpoint, proxyscrapeEndpoint, proxiflyEndpoint, proxiflyFallbackURL
	proxyListEndpoint = down.URL
	// proxyscrape bodies decode as text; a 500 status still reads without
	// decode error but yields zero addrs. Point it at an invalid URL so the
	// HTTP round-trip itself errors.
	proxyscrapeEndpoint = "http://127.0.0.1:1/dead"
	proxiflyEndpoint = "http://127.0.0.1:1/dead"
	proxiflyFallbackURL = "http://127.0.0.1:1/dead" // prevent fallback from hitting real GitHub URL
	defer func() {
		proxyListEndpoint = origGeo
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
	}()

	// Geonode JSON decode on an error body fails too — all three sources error.
	if _, err := fetchProxyListMulti(context.Background()); err == nil {
		t.Fatal("expected error when all sources fail")
	}
}
