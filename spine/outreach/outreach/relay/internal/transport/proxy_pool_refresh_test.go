package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestRotatingProxyTransport_StaleReadNoRace exercises the concurrent read
// path (isStale) against refresh's write to lastRefresh. Race detector
// catches an unlocked read; guard: `go test -race`.
func TestRotatingProxyTransport_StaleReadNoRace(t *testing.T) {
	tr := &RotatingProxyTransport{
		working:     []proxyEntry{{addr: "1.2.3.4:1080"}},
		lastRefresh: time.Now(),
	}

	done := make(chan struct{})
	var wg sync.WaitGroup

	// Reader goroutines hammer isStale (the previously unlocked read).
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-done:
					return
				default:
					_ = tr.isStale()
				}
			}
		}()
	}

	// Writer mutates lastRefresh under lock.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			tr.mu.Lock()
			tr.lastRefresh = time.Now()
			tr.mu.Unlock()
		}
	}()

	time.Sleep(30 * time.Millisecond)
	close(done)
	wg.Wait()
}

// TestRotatingProxyTransport_TickerRefresh verifies the background ticker
// triggers refresh() independently of DialContext traffic, so a long quiet
// period doesn't leave the pool stale.
func TestRotatingProxyTransport_TickerRefresh(t *testing.T) {
	var fetchCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetchCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	}))
	defer srv.Close()

	// Override all sources — fetchProxyListMulti fans out to proxifly + geonode + proxyscrape,
	// test must mock all or the ticker hits real external API (data race + slowdown).
	proxifly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	defer proxifly.Close()

	origEndpoint := proxyListEndpoint
	origPS := proxyscrapeEndpoint
	origPF := proxiflyEndpoint
	origPFFB := proxiflyFallbackURL
	proxyListEndpoint = srv.URL
	proxyscrapeEndpoint = srv.URL
	proxiflyEndpoint = proxifly.URL
	proxiflyFallbackURL = proxifly.URL // prevent fallback from hitting real GitHub URL
	defer func() {
		proxyListEndpoint = origEndpoint
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
	}()

	origTicker := tickerInterval
	tickerInterval = 30 * time.Millisecond
	defer func() { tickerInterval = origTicker }()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tr, err := NewRotatingProxyTransport(ctx, NewDirectTransport())
	if err != nil {
		t.Fatalf("new transport: %v", err)
	}
	_ = tr

	// Initial refresh fires once from the constructor, then the ticker should
	// fire several times inside 300ms with a 30ms interval.
	time.Sleep(300 * time.Millisecond)
	cancel()

	// Ticker should have fired at least 3 times on top of the initial refresh.
	if got := fetchCount.Load(); got < 3 {
		t.Fatalf("expected ≥3 fetches from ticker + initial, got %d", got)
	}

	// After ctx cancel, no further fetches should accumulate.
	settled := fetchCount.Load()
	time.Sleep(100 * time.Millisecond)
	if got := fetchCount.Load(); got > settled+2 {
		// +2 tolerance: a tick may have been in flight when ctx was cancelled,
		// and fetchProxyListMulti fans out to two sources that share this mock.
		t.Fatalf("ticker leaked past ctx cancel: %d → %d", settled, got)
	}
}

// TestRotatingProxyTransport_InFlightRefreshGuard verifies a burst of stale
// DialContext calls fans out to exactly one refresh() instead of N.
// Without the guard, 50 parallel dials would fire 50 upstream fetches.
func TestRotatingProxyTransport_InFlightRefreshGuard(t *testing.T) {
	var fetchCount atomic.Int32
	// Hold the first request long enough that the burst of DialContext calls
	// all observe refreshing=true. The mock replies with an empty list so
	// refresh exits fast once released.
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fetchCount.Add(1) == 1 {
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	}))
	defer srv.Close()

	// Secondary source — responds immediately with empty list. Without this,
	// fetchProxyListMulti would hit real proxyscrape.com and stall the refresh
	// goroutine past the test's refreshing-drain wait.
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "")
	}))
	defer srv2.Close()

	// Tertiary proxifly mock — empty JSON array, responds immediately.
	srv3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	defer srv3.Close()

	origEndpoint := proxyListEndpoint
	origPS := proxyscrapeEndpoint
	origPF := proxiflyEndpoint
	origPFFB := proxiflyFallbackURL
	proxyListEndpoint = srv.URL
	proxyscrapeEndpoint = srv2.URL
	proxiflyEndpoint = srv3.URL
	proxiflyFallbackURL = srv3.URL // prevent fallback from hitting real GitHub URL
	defer func() {
		proxyListEndpoint = origEndpoint
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
	}()

	tr := &RotatingProxyTransport{
		fallback:    NewDirectTransport(),
		lastRefresh: time.Now().Add(-2 * refreshInterval), // stale
		ctx:         context.Background(),                 // refresh() derives from t.ctx; nil → "net/http: nil Context"
	}

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Target 127.0.0.1:1 — unreachable; we only care about refresh
			// side effects, not whether the dial itself succeeds.
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			defer cancel()
			_, _ = tr.DialContext(ctx, "tcp", "127.0.0.1:1")
		}()
	}
	wg.Wait()

	// Give the async refresh goroutine a moment to register as in-flight.
	time.Sleep(50 * time.Millisecond)
	close(release)

	// Deterministically join the in-flight refresh goroutine before reading
	// fetchCount or restoring the mocked endpoint globals — the previous
	// poll-with-timeout drain raced with deferred-restore writes against
	// fetchProxyListProxifly's still-active read of proxiflyEndpoint /
	// proxiflyFallbackURL when the 1s drain budget expired before refresh
	// completed. WaitRefresh is the strict join that the atomic guard alone
	// cannot provide.
	tr.WaitRefresh()

	if got := fetchCount.Load(); got != 1 {
		t.Fatalf("expected exactly 1 upstream fetch, got %d", got)
	}
	if tr.refreshing.Load() {
		t.Fatal("refreshing flag stuck true after refresh completed")
	}
}
