package transport

// AD5 — proxy_pool goroutines must derive from the parent context passed to
// NewRotatingProxyTransport, not context.Background(). Tests verify:
//
//   1. ctx field on struct is non-nil after construction
//   2. ctx field is the parent ctx (cancels when parent cancels)
//   3. runRefreshTicker exits on ctx cancel within 2 s
//   4. ForceRefresh returns quickly when parent ctx already cancelled
//   5. NewRotatingProxyTransport accepts context.Context as first arg
//   6. bgRefresh from DialContext uses parent ctx and completes
//   7. Hanging server: refresh exits early when ctx cancelled
//   8. WaitRefresh unblocks after ctx cancel + ticker stops
//   9. Audit ratchet: t.refresh(context.Background()) not in source
//  10. Concurrent cancel + ForceRefresh does not race
//  11. Ticker goroutine stops after cancel

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// setAD5TestEndpoints overrides all proxy-list endpoints to srv.URL and also
// overrides the proxifly fallback URL so no test leaks to the real internet.
// Returns a restore func that waits for tr.initialRefreshDone before
// restoring globals (prevents data races on package-level vars).
func setAD5TestEndpoints(t *testing.T, handler http.Handler) (srvURL string, restore func(tr *RotatingProxyTransport)) {
	t.Helper()
	srv := httptest.NewServer(handler)
	origGeo, origPS, origPF, origPFFB := proxyListEndpoint, proxyscrapeEndpoint, proxiflyEndpoint, proxiflyFallbackURL
	proxyListEndpoint = srv.URL
	proxyscrapeEndpoint = srv.URL
	proxiflyEndpoint = srv.URL
	proxiflyFallbackURL = srv.URL
	return srv.URL, func(tr *RotatingProxyTransport) {
		if tr != nil && tr.initialRefreshDone != nil {
			select {
			case <-tr.initialRefreshDone:
			case <-time.After(5 * time.Second):
			}
		}
		srv.Close()
		proxyListEndpoint = origGeo
		proxyscrapeEndpoint = origPS
		proxiflyEndpoint = origPF
		proxiflyFallbackURL = origPFFB
	}
}

// badJSONHandler returns invalid JSON so fetchProxyListGeonode returns an error
// immediately — no candidates, no probe goroutines, refresh completes fast.
func badJSONHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	}
}

// AD5-1: ctx field on struct must be non-nil after NewRotatingProxyTransport.
func TestAD5_CtxFieldNotNilAfterConstruct(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}
	restore(tp)

	if tp.ctx == nil {
		t.Fatal("RotatingProxyTransport.ctx is nil after construction")
	}
}

// AD5-2: Parent ctx stored on struct is derived from (or is) the parent ctx:
// cancelling parent also cancels tp.ctx.
func TestAD5_CtxFieldIsParentCtx(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}
	restore(tp)

	cancel()
	select {
	case <-tp.ctx.Done():
		// Pass: tp.ctx cancelled when parent cancelled.
	case <-time.After(100 * time.Millisecond):
		t.Fatal("tp.ctx was not cancelled when parent ctx was cancelled")
	}
}

// AD5-3: Cancelling parent ctx stops runRefreshTicker within 2 s.
// Uses tickerDone channel to verify the ticker goroutine fully exits,
// not just that its refresh work drains.
func TestAD5_TickerExitsOnCtxCancel(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())

	ctx, cancel := context.WithCancel(context.Background())

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		cancel()
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}

	cancel()
	restore(tp) // waits for initialRefreshDone

	// tickerDone is closed when runRefreshTicker goroutine exits.
	select {
	case <-tp.tickerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("ticker goroutine did not exit within 2s after ctx cancel")
	}
}

// AD5-4: ForceRefresh uses t.ctx: when ctx is already cancelled, it returns quickly.
func TestAD5_ForceRefreshRespectsCtxCancel(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())

	ctx, cancel := context.WithCancel(context.Background())

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}
	restore(tp)
	cancel() // cancel before ForceRefresh

	done := make(chan struct{})
	go func() {
		tp.ForceRefresh()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ForceRefresh did not return within 2s when parent ctx cancelled")
	}
}

// AD5-5: NewRotatingProxyTransport accepts context.Context as first arg (compile + runtime check).
func TestAD5_ConstructorAcceptsParentCtx(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())

	tp, err := NewRotatingProxyTransport(context.Background(), nil)
	if err != nil {
		restore(nil)
		t.Fatalf("unexpected error: %v", err)
	}
	restore(tp)
}

// AD5-6: bgRefresh goroutine from DialContext completes without deadlock.
// Keep the test endpoints live during the bgRefresh-triggered-by-DialContext
// so that the goroutine can make its (failed) HTTP request and return.
func TestAD5_BgRefreshFromDialContextCompletes(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())
	// Note: do NOT call restore before bgRefresh finishes — restore closes the
	// httptest server and waits for initialRefreshDone only, not for goroutines
	// spawned later. We call restore at the end after WaitRefresh.

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}
	// Wait for initial refresh via initialRefreshDone before forcing stale.
	select {
	case <-tp.initialRefreshDone:
	case <-time.After(5 * time.Second):
		restore(nil)
		t.Fatal("initial refresh did not complete within 5s")
	}

	// Force stale state so DialContext triggers a bgRefresh.
	tp.mu.Lock()
	tp.lastRefresh = time.Now().Add(-refreshInterval - time.Second)
	tp.mu.Unlock()

	_, _ = tp.DialContext(ctx, "tcp", "127.0.0.1:9")

	done := make(chan struct{})
	go func() {
		tp.WaitRefresh()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		restore(nil)
		t.Fatal("bgRefresh from DialContext did not complete within 5s")
	}
	restore(nil) // endpoints still valid; just close srv and restore globals
}

// AD5-7: Hanging server + cancelled ctx: refresh exits early, not after 15s timeout.
// If goroutines used context.Background(), they'd block for 15s HTTP timeout.
// With t.ctx, they abort as soon as ctx is cancelled.
func TestAD5_RefreshExitsEarlyOnCtxCancel(t *testing.T) {
	blockCh := make(chan struct{})
	_, restore := setAD5TestEndpoints(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-blockCh:
		case <-r.Context().Done():
		}
	}))

	ctx, cancel := context.WithCancel(context.Background())

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		close(blockCh)
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}

	// Cancel immediately: in-flight refresh should abort.
	cancel()
	close(blockCh) // unblock any pending server handlers

	done := make(chan struct{})
	go func() {
		restore(tp)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("initial refresh blocked >3s; goroutines may be using context.Background()")
	}
}

// AD5-8: WaitRefresh unblocks after ctx cancel (ticker stops, no new work added).
// Does NOT modify tickerInterval to avoid data races with other tests' goroutines.
func TestAD5_WaitRefreshUnblocksAfterCancel(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())

	ctx, cancel := context.WithCancel(context.Background())

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}
	restore(tp) // wait for initial refresh
	cancel()

	done := make(chan struct{})
	go func() {
		tp.WaitRefresh()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("WaitRefresh did not unblock within 2s after ctx cancel")
	}
}

// AD5-9: Audit ratchet — t.refresh(context.Background()) must not appear in proxy_pool.go.
// This is the static safety net: if someone reintroduces the banned pattern, this test fails immediately.
func TestAD5_NoContextBackgroundInRefreshCalls(t *testing.T) {
	data, err := os.ReadFile("proxy_pool.go")
	if err != nil {
		t.Skipf("cannot read proxy_pool.go for audit: %v", err)
		return
	}
	banned := "t.refresh(context.Background())"
	if strings.Contains(string(data), banned) {
		t.Errorf("proxy_pool.go still contains banned pattern %q — AD5 ctx propagation fix was reverted", banned)
	}
}

// AD5-10: Concurrent cancel + ForceRefresh does not race (requires -race flag).
func TestAD5_ConcurrentCancelAndForceRefreshNoRace(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())

	ctx, cancel := context.WithCancel(context.Background())

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}
	restore(tp)

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tp.ForceRefresh()
		}()
	}
	cancel() // concurrent cancel while ForceRefresh goroutines run
	wg.Wait()
}

// AD5-11: tickerDone channel is closed when the ticker goroutine exits.
// Uses NewRotatingProxyTransport so the full lifecycle (constructor →
// cancel → tickerDone closed) is exercised end-to-end.
func TestAD5_TickerGoroutineStopsAfterCancel(t *testing.T) {
	_, restore := setAD5TestEndpoints(t, badJSONHandler())

	ctx, cancel := context.WithCancel(context.Background())

	tp, err := NewRotatingProxyTransport(ctx, nil)
	if err != nil {
		cancel()
		restore(nil)
		t.Fatalf("NewRotatingProxyTransport: %v", err)
	}

	cancel()
	restore(tp) // waits for initialRefreshDone

	select {
	case <-tp.tickerDone:
		// Ticker goroutine fully exited — no goroutine leak.
	case <-time.After(2 * time.Second):
		t.Fatal("ticker goroutine did not exit within 2s after ctx cancel (tickerDone not closed)")
	}
}
