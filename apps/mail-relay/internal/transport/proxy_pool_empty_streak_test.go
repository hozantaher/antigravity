package transport

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestEmptyPoolStreak_IncrementsOnZeroRefresh drives refresh() with both
// sources returning zero proxies. Each refresh should increment the counter;
// after the critical threshold Snapshot.EmptyPoolCritical must be true.
func TestEmptyPoolStreak_IncrementsOnZeroRefresh(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	}))
	defer srv.Close()

	emptyProxifly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	defer emptyProxifly.Close()

	origGN, origPS, origPF, origPFFB := proxyListEndpoint, proxyscrapeEndpoint, proxiflyEndpoint, proxiflyFallbackURL
	proxyListEndpoint = srv.URL
	proxyscrapeEndpoint = srv.URL
	proxiflyEndpoint = emptyProxifly.URL
	proxiflyFallbackURL = emptyProxifly.URL // prevent fallback from hitting real GitHub URL
	defer func() {
		proxyListEndpoint = origGN
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
	}()

	tr := &RotatingProxyTransport{}

	for i := 1; i <= 3; i++ {
		if err := tr.refresh(context.Background()); err != nil {
			t.Fatalf("refresh #%d: %v", i, err)
		}
		if got := tr.ConsecutiveZeroRefreshes(); got != int32(i) {
			t.Errorf("after refresh #%d: streak=%d, want %d", i, got, i)
		}
	}

	if !tr.EmptyPoolCritical() {
		t.Errorf("EmptyPoolCritical should be true after 3 zero refreshes")
	}

	snap := tr.Snapshot()
	if !snap.EmptyPoolCritical {
		t.Errorf("snapshot.EmptyPoolCritical = false, want true")
	}
	if snap.ConsecutiveZeroRefreshes != 3 {
		t.Errorf("snapshot.ConsecutiveZeroRefreshes = %d, want 3", snap.ConsecutiveZeroRefreshes)
	}
}

// TestEmptyPoolStreak_ResetsOnNonEmptyRefresh verifies the counter resets to
// 0 as soon as a refresh yields at least one working proxy.
func TestEmptyPoolStreak_ResetsOnNonEmptyRefresh(t *testing.T) {
	// Phase 1: both sources empty → streak rises.
	emptySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	}))
	defer emptySrv.Close()

	// Phase 2: geonode returns one candidate that the probe will accept.
	socks := newMockSOCKS5Server(t)
	socks.start()
	host, port, err := net.SplitHostPort(socks.addr)
	if err != nil {
		t.Fatalf("split addr: %v", err)
	}

	liveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{{"ip": host, "port": port}},
		})
	}))
	defer liveSrv.Close()

	emptyProxyscrape := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(""))
	}))
	defer emptyProxyscrape.Close()

	emptyProxifly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	defer emptyProxifly.Close()

	origGN, origPS, origPF, origPFFB, origVerify := proxyListEndpoint, proxyscrapeEndpoint, proxiflyEndpoint, proxiflyFallbackURL, probeVerify
	probeVerify = func(context.Context, net.Conn, string) error { return nil }
	proxiflyEndpoint = emptyProxifly.URL
	proxiflyFallbackURL = emptyProxifly.URL // prevent fallback from hitting real GitHub URL
	defer func() {
		proxyListEndpoint = origGN
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
		probeVerify = origVerify
	}()

	tr := &RotatingProxyTransport{}

	// Two empty refreshes → streak = 2.
	proxyListEndpoint = emptySrv.URL
	proxyscrapeEndpoint = emptyProxyscrape.URL
	for i := 0; i < 2; i++ {
		if err := tr.refresh(context.Background()); err != nil {
			t.Fatalf("empty refresh: %v", err)
		}
	}
	if got := tr.ConsecutiveZeroRefreshes(); got != 2 {
		t.Fatalf("before reset: streak=%d, want 2", got)
	}

	// One non-empty refresh → streak resets to 0.
	proxyListEndpoint = liveSrv.URL
	if err := tr.refresh(context.Background()); err != nil {
		t.Fatalf("live refresh: %v", err)
	}
	if got := tr.ConsecutiveZeroRefreshes(); got != 0 {
		t.Errorf("after non-empty refresh: streak=%d, want 0", got)
	}
	if tr.EmptyPoolCritical() {
		t.Errorf("EmptyPoolCritical should be false after streak reset")
	}
}
