package transport

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net"
	"net/http"
	"net/smtp"

	"common/envconfig"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// buildGeonodeURL returns all socks5 proxies without country filter.
// Country-filtering datacenter IPs (CZ/SK) actually makes auth WORSE —
// seznam.cz blocks known CZ/SK datacenter ranges more aggressively than
// random EU/non-EU IPs. Let geonode return a wide pool and rely on the
// SOCKS5:465 probe to filter working ones.
func buildGeonodeURL() string {
	return "https://proxylist.geonode.com/api/proxy-list?protocols=socks5&limit=500&sort_by=lastChecked&sort_type=desc"
}

// buildProxyscrapeURL returns all socks5 proxies without country filter.
func buildProxyscrapeURL() string {
	return "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all"
}

// proxyListEndpoint is the URL used by fetchProxyListGeonode. Tests override
// this to point at a local httptest server without hitting the real API.
var proxyListEndpoint = buildGeonodeURL()

// proxyscrapeEndpoint mirrors proxyListEndpoint for the secondary source.
var proxyscrapeEndpoint = buildProxyscrapeURL()

// proxiflyURL is the tertiary source — github.com/proxifly/free-proxy-list
// The data.json format changed to a schema definition; use the plain-text
// socks5/data.txt which has one "socks5://host:port" per line and is stable.
const proxiflyURL = "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt"

// proxiflyFallbackURLDefault is the default fallback proxifly URL when the
// primary returns empty or an unexpected format.
const proxiflyFallbackURLDefault = "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt"

// proxiflyFallbackURL is the fallback URL (var so tests can override it).
var proxiflyFallbackURL = proxiflyFallbackURLDefault

// proxiflyEndpoint mirrors proxyListEndpoint for the tertiary source.
var proxiflyEndpoint = proxiflyURL

// allowedCountryCodes returns the set of ISO country codes to accept.
// Reads PROXY_COUNTRY_CODES env var (comma-separated, e.g. "CZ,SK,DE").
// Defaults to Central Europe (CZ,SK,DE,AT,PL,HU,SI) — wide enough to keep a
// healthy pool, narrow enough to reject Asia/Americas/Africa exits that
// recipient mail servers and abuse heuristics flag as suspicious.
func allowedCountryCodes() map[string]struct{} {
	raw := strings.TrimSpace(envconfig.GetOr("PROXY_COUNTRY_CODES", ""))
	if raw == "" {
		raw = "CZ,SK,DE,AT,PL,HU,SI"
	}
	m := make(map[string]struct{})
	for _, code := range strings.Split(raw, ",") {
		code = strings.TrimSpace(strings.ToUpper(code))
		if code != "" {
			m[code] = struct{}{}
		}
	}
	return m
}

// euCountryCodes is the EU-25 allow-set shared between geonode's URL filter
// and proxifly's in-process filter. Overridable via PROXY_COUNTRY_CODES env.
var euCountryCodes = allowedCountryCodes()

// probeVerify validates that a dialed conn actually reached the probe target.
// Default verifies via TLS handshake to the probe host. Tests override to
// skip verification when mocking SOCKS5 peers that don't speak TLS.
var probeVerify = verifyTLSHandshake

// probeDialFn is the function used by probeAll to dial through a SOCKS5 proxy.
// Tests override this to bypass the real SOCKS5 handshake when the candidate
// addresses are test listeners that don't speak SOCKS5.
// Default: nil means use NewSOCKS5Transport.DialContext.
var probeDialFn func(ctx context.Context, proxyAddr, target string) (net.Conn, error)

// probeTarget is the SMTP server address used for TLS-layer probing.
// Overrideable in tests to point at a local listener.
var probeTarget = "smtp.seznam.cz:465"

const (
	probeTimeout    = 10 * time.Second
	refreshInterval = 15 * time.Minute
	minWorkingPool  = 3
)

// tickerInterval drives the background periodic refresh. Shorter than
// refreshInterval so isStale() still returns false between ticks — the ticker
// is the primary refresh path, isStale is the lazy fallback. Var (not const)
// so tests can shorten it without sleeping for minutes.
var tickerInterval = 5 * time.Minute

// proxyEntry holds one SOCKS5 proxy candidate.
type proxyEntry struct {
	addr      string // host:port
	latency   time.Duration
	country   string // ISO country code, may be empty
	source    string // "geonode", "proxyscrape", "proxifly", "static"
	authValid bool   // true if SMTP AUTH succeeded during probe (only set when SMTP_PROBE_USERNAME is configured)
}

// smtpProbeCredentials holds the optional SMTP AUTH probe config.
type smtpProbeCredentials struct {
	host     string
	username string
	password string
}

// smtpProbeConfig reads optional SMTP AUTH probe credentials from env vars.
// If SMTP_PROBE_USERNAME is set, probeAll performs a full SMTP AUTH LOGIN
// check through the proxy in addition to the TLS-only layer-4 probe.
// A proxy that passes TLS but fails AUTH LOGIN is excluded from the pool.
//
// SMTP_PROBE_HOST defaults to "smtp.seznam.cz" when unset.
// SMTP_PROBE_USERNAME and SMTP_PROBE_PASSWORD must both be non-empty for AUTH
// probing to be enabled.
func smtpProbeConfig() (cfg smtpProbeCredentials, enabled bool) {
	cfg.host = envconfig.GetOr("SMTP_PROBE_HOST", "smtp.seznam.cz")
	cfg.username = envconfig.GetOr("SMTP_PROBE_USERNAME", "")
	cfg.password = envconfig.GetOr("SMTP_PROBE_PASSWORD", "")
	enabled = cfg.username != "" && cfg.password != ""
	return
}

// RotatingProxyTransport fetches a fresh SOCKS5 proxy list, probes each
// candidate, and rotates through working proxies on every dial.
// Falls back to direct if the pool is empty.
type RotatingProxyTransport struct {
	mu          sync.RWMutex
	working     []proxyEntry
	currentIdx  int
	lastRefresh time.Time
	fallback    AnonymousTransport
	guard       *DialGuard
	// refreshing guards against concurrent background refresh() calls. A burst
	// of DialContext calls while the pool is stale would otherwise each spawn
	// a goroutine that hits the upstream proxy list API.
	refreshing atomic.Bool
	// refreshWG counts in-flight background refresh goroutines (lazy-from-dial,
	// ticker, ForceRefresh). WaitRefresh() blocks until all reach zero — used
	// by tests to deterministically join the background refresh before
	// restoring mocked globals (eliminates a -race flake where deferred test
	// cleanup raced with an inner fetchProxyList* goroutine still reading
	// proxyListEndpoint / proxiflyEndpoint / proxyscrapeEndpoint after the
	// poll-with-timeout drain loop gave up).
	refreshWG sync.WaitGroup
	// consecutiveZeroRefreshes tracks how many successful refreshes in a row
	// returned an empty working set. 1-2 can happen on transient upstream flake;
	// ≥3 in a row means the pool is effectively broken (geonode/proxyscrape
	// down, country filter too tight, or abuse ban on the probe target) and
	// the operator must intervene — fallback=direct would start leaking real IP.
	consecutiveZeroRefreshes atomic.Int32
	// preferredCountry is an upper-cased ISO country code. When non-empty,
	// pick() rotates within the country-filtered sub-pool and falls back to the
	// full working pool only when no proxy in that country is available.
	preferredCountry string
	// countryIdx is the per-country round-robin counter. Separate from
	// currentIdx so the two sub-pools advance independently.
	countryIdx atomic.Int64

	// initialRefreshDone is closed by the initial background refresh goroutine
	// after refresh() returns (success or error). Tests wait on this channel to
	// detect when the goroutine has finished so they can safely restore globals.
	initialRefreshDone chan struct{}

	// tickerDone is closed when the runRefreshTicker goroutine exits. Tests that
	// modify package-level tickerInterval after cancelling ctx can wait on this
	// channel to ensure the ticker goroutine has fully exited and is no longer
	// reading tickerInterval, preventing data races.
	tickerDone chan struct{}

	// ctx is the parent context passed to NewRotatingProxyTransport. Background
	// goroutines (initial fetch, bgRefresh, ForceRefresh) derive from this
	// context so they are cancelled when the relay process shuts down rather
	// than running against context.Background() indefinitely.
	ctx context.Context
}

const emptyPoolCriticalThreshold int32 = 3

// NewRotatingProxyTransport creates the transport and asynchronously fetches+probes proxies.
// The pool starts empty and falls back to direct until proxies are ready.
// Pass a non-nil fallback to use when no proxies are available (e.g. DirectTransport).
// The passed ctx controls the lifetime of the background refresh ticker —
// cancel it to stop periodic refreshes (e.g. on server shutdown).
//
// The preferred country is read from PROXY_PREFERRED_COUNTRY (upper-cased,
// trimmed). Defaults to "CZ" when the env var is unset or empty. Override
// after construction with WithPreferredCountry if needed.
func NewRotatingProxyTransport(ctx context.Context, fallback AnonymousTransport) (*RotatingProxyTransport, error) {
	preferred := strings.ToUpper(strings.TrimSpace(envconfig.GetOr("PROXY_PREFERRED_COUNTRY", "")))
	if preferred == "" {
		preferred = "CZ"
	}
	t := &RotatingProxyTransport{
		fallback:           fallback,
		preferredCountry:   preferred,
		initialRefreshDone: make(chan struct{}),
		ctx:                ctx,
	}
	// Zero cold-start: seed the working pool from the last persisted snapshot
	// immediately so the first dial doesn't have to wait for a full fetch+probe cycle.
	if cached := loadPool(4); len(cached) > 0 {
		t.mu.Lock()
		t.working = cached
		t.lastRefresh = time.Now()
		t.mu.Unlock()
	}
	// Refresh in background so the caller (HTTP server) starts immediately.
	t.refreshWG.Add(1)
	go func() {
		defer t.refreshWG.Done()
		defer func() {
			if r := recover(); r != nil {
				slog.Error("proxy_pool: initial fetch panicked",
					"op", "transport.proxyPool/initialFetch/panic",
					"panic", fmt.Sprintf("%v", r))
			}
		}()
		if err := t.refresh(t.ctx); err != nil {
			slog.Warn("proxy_pool: initial fetch failed, will retry on next dial", "op", "transport.proxyPool/initialFetch", "error", err)
		}
		close(t.initialRefreshDone)
	}()
	// Periodic refresh ticker — keeps the pool fresh even with zero traffic,
	// so the first dial after a quiet period doesn't pay the fetch+probe
	// latency. isStale-based DialContext refresh stays as a safety net.
	t.tickerDone = make(chan struct{})
	go func() {
		defer close(t.tickerDone)
		t.runRefreshTicker(ctx)
	}()
	return t, nil
}

// WithPreferredCountry sets the preferred country for proxy selection. The
// value is normalised to upper-case and trimmed. An empty string disables
// country preference (plain round-robin over the full pool). Returns the
// receiver for chaining.
func (t *RotatingProxyTransport) WithPreferredCountry(country string) *RotatingProxyTransport {
	t.preferredCountry = strings.ToUpper(strings.TrimSpace(country))
	return t
}

// runRefreshTicker drives periodic pool refresh until ctx is cancelled. Skips
// a tick if another refresh is already in flight (covered by the refreshing
// atomic guard — mirrors the burst-of-dials path). Panics inside refresh are
// recovered so a single bad upstream response can't kill the ticker for the
// process lifetime.
func (t *RotatingProxyTransport) runRefreshTicker(ctx context.Context) {
	ticker := time.NewTicker(tickerInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !t.refreshing.CompareAndSwap(false, true) {
				continue
			}
			t.refreshWG.Add(1)
			func() {
				defer t.refreshWG.Done()
				defer t.refreshing.Store(false)
				defer func() {
					if r := recover(); r != nil {
						slog.Error("proxy_pool: ticker refresh panicked",
							"op", "transport.proxyPool/tickerRefresh/panic",
							"panic", fmt.Sprintf("%v", r))
					}
				}()
				if err := t.refresh(ctx); err != nil {
					slog.Warn("proxy_pool: ticker refresh failed", "op", "transport.proxyPool/tickerRefresh", "error", err)
				}
			}()
		}
	}
}

// DialContext picks the next working proxy and dials through it.
func (t *RotatingProxyTransport) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	// Refresh pool in background when stale. Skip if one already in flight —
	// burst of dials on a stale pool would otherwise fan out N refreshes.
	if t.isStale() && t.refreshing.CompareAndSwap(false, true) {
		t.refreshWG.Add(1)
		go func() {
			defer t.refreshWG.Done()
			defer t.refreshing.Store(false)
			defer func() {
				if r := recover(); r != nil {
					slog.Error("proxy_pool: bg refresh panicked",
						"op", "transport.proxyPool/bgRefresh/panic",
						"panic", fmt.Sprintf("%v", r))
				}
			}()
			if err := t.refresh(t.ctx); err != nil {
				slog.Warn("proxy_pool: background refresh failed", "op", "transport.proxyPool/bgRefresh", "error", err)
			}
		}()
	}

	proxy, ok := t.pick()
	if !ok {
		if t.fallback != nil {
			slog.Warn("proxy_pool: no working proxies, falling back to direct",
			"op", "transport.proxyPool/dialContext/noWorkingProxies")
			return t.fallback.DialContext(ctx, network, addr)
		}
		return nil, fmt.Errorf("proxy_pool: no working proxies and no fallback configured")
	}

	if t.guard != nil {
		if err := t.guard.Assert(proxy.addr); err != nil {
			// Picked proxy is no longer in the working set — drop it and retry.
			t.remove(proxy.addr)
			return t.DialContext(ctx, network, addr)
		}
	}

	start := time.Now()
	slog.Debug("proxy_pool: dialing via proxy", "proxy", proxy.addr, "target", addr)
	socks := NewSOCKS5Transport(proxy.addr, 30*time.Second)
	conn, err := socks.DialContext(ctx, network, addr)
	slog.Info("relay_audit",
		"event", "dial",
		"dest", proxy.addr,
		"target", addr,
		"ok", err == nil,
		"ms", time.Since(start).Milliseconds())
	if err != nil {
		// Remove dead proxy and retry with next.
		slog.Warn("proxy_pool: proxy failed, removing", "op", "transport.proxyPool/dialContext/proxyFailed", "proxy", proxy.addr, "error", err)
		t.remove(proxy.addr)
		return t.DialContext(ctx, network, addr)
	}
	return conn, nil
}

// WorkingCount returns the current number of verified working proxies.
func (t *RotatingProxyTransport) WorkingCount() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.working)
}

// isStale reports whether the pool should be refreshed. Safe for concurrent
// use: reads lastRefresh under RLock.
func (t *RotatingProxyTransport) isStale() bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return time.Since(t.lastRefresh) > refreshInterval
}

// IsWorkingAddr reports whether addr is currently in the working-proxy set.
// Used by DialGuard to decide if an outbound dial target is allowlisted.
func (t *RotatingProxyTransport) IsWorkingAddr(addr string) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	for _, e := range t.working {
		if e.addr == addr {
			return true
		}
	}
	return false
}

// AttachGuard wires a DialGuard into the pool so every proxy dial asserts
// the proxyAddr is still in the working set before the actual net.Dial.
func (t *RotatingProxyTransport) AttachGuard(g *DialGuard) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.guard = g
}

// PoolEntry is the exported shape of one working proxy — used by callers that
// need read-only access to the pool (e.g. probe handlers exposing state).
type PoolEntry struct {
	Addr      string        `json:"addr"`
	Latency   time.Duration `json:"-"`          // don't expose Duration directly
	Country   string        `json:"country,omitempty"`
	Source    string        `json:"source,omitempty"`
	LatencyMs int64         `json:"latency_ms"`
}

// PoolSnapshot is a copy of pool state at one moment. The slice is safe for
// concurrent read — it does not alias the internal `working` slice.
type PoolSnapshot struct {
	Working                  []PoolEntry               `json:"working"`
	LastRefresh              time.Time                 `json:"last_refresh"`
	ConsecutiveZeroRefreshes int32                     `json:"consecutive_zero_refreshes"`
	EmptyPoolCritical        bool                      `json:"empty_pool_critical"`
	// PreferredCountry is the ISO country code currently preferred for routing.
	PreferredCountry string `json:"preferred_country,omitempty"`
	// PreferredCountryCount is the number of working proxies in PreferredCountry.
	PreferredCountryCount int `json:"preferred_country_count,omitempty"`
	// AuthValidated is the count of working proxies whose SMTP AUTH LOGIN was
	// verified during the last probe cycle. Zero when SMTP_PROBE_USERNAME is
	// unset (AUTH probing disabled — all proxies are TLS-only validated).
	AuthValidated  int                            `json:"auth_validated"`
	SourceHealth   map[string]map[string]interface{} `json:"source_health,omitempty"`
}

// Snapshot returns a point-in-time copy of the working-proxy list plus the
// last-refresh timestamp. The returned slice is independent of internal state.
func (t *RotatingProxyTransport) Snapshot() PoolSnapshot {
	t.mu.RLock()
	defer t.mu.RUnlock()
	streak := t.consecutiveZeroRefreshes.Load()
	out := PoolSnapshot{
		Working:                  make([]PoolEntry, len(t.working)),
		LastRefresh:              t.lastRefresh,
		ConsecutiveZeroRefreshes: streak,
		EmptyPoolCritical:        streak >= emptyPoolCriticalThreshold,
		PreferredCountry:         t.preferredCountry,
		SourceHealth:             SourceHealthSnapshot(),
	}
	for i, e := range t.working {
		out.Working[i] = PoolEntry{
			Addr:      e.addr,
			Latency:   e.latency,
			Country:   e.country,
			Source:    e.source,
			LatencyMs: e.latency.Milliseconds(),
		}
		if t.preferredCountry != "" && strings.ToUpper(e.country) == t.preferredCountry {
			out.PreferredCountryCount++
		}
		if e.authValid {
			out.AuthValidated++
		}
	}
	return out
}

// scoreThreshold is the minimum ProxyScore a proxy must have to be eligible for
// pick(). Proxies below this value are consistently failing and are excluded.
// When every proxy in the pool falls below the threshold, pick() falls back to
// the full working set so delivery can continue (degraded but not dead).
const scoreThreshold = 0.2

func (t *RotatingProxyTransport) pick() (proxyEntry, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.working) == 0 {
		return proxyEntry{}, false
	}

	// Build a viable sub-pool: exclude proxies with a proven low success rate.
	viable := make([]proxyEntry, 0, len(t.working))
	for _, e := range t.working {
		if ProxyScore(e.addr) >= scoreThreshold {
			viable = append(viable, e)
		}
	}
	// Fallback: if every proxy is low-scoring, use the full pool rather than
	// returning nothing — degraded routing beats a total delivery blackout.
	if len(viable) == 0 {
		viable = t.working
	}

	if t.preferredCountry != "" {
		var pool []proxyEntry
		for _, e := range viable {
			if strings.ToUpper(e.country) == t.preferredCountry {
				pool = append(pool, e)
			}
		}
		if len(pool) > 0 {
			// countryIdx is atomic — safe to use under Lock or without lock.
			idx := int(t.countryIdx.Add(1)-1) % len(pool)
			return pool[idx], true
		}
		slog.Warn("proxy_pool: no proxies for preferred country, using full viable pool",
			"op", "transport.proxyPool/pick/noPreferredCountry",
			"country", t.preferredCountry, "total", len(viable))
	}
	idx := t.currentIdx % len(viable)
	t.currentIdx++
	return viable[idx], true
}

func (t *RotatingProxyTransport) remove(addr string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	filtered := t.working[:0]
	for _, e := range t.working {
		if e.addr != addr {
			filtered = append(filtered, e)
		}
	}
	t.working = filtered
}

// refresh fetches the proxy list and probes each candidate concurrently.
func (t *RotatingProxyTransport) refresh(ctx context.Context) error {
	candidates, err := fetchProxyListMulti(ctx)
	if err != nil {
		return err
	}
	slog.Info("proxy_pool: fetched candidates", "count", len(candidates))

	working := probeAll(ctx, candidates)
	// Shuffle so we don't always start with the same proxy.
	rand.Shuffle(len(working), func(i, j int) { working[i], working[j] = working[j], working[i] })

	t.mu.Lock()
	t.working = working
	t.lastRefresh = time.Now()
	t.mu.Unlock()

	// Persist the new working set so a cold restart can seed the pool instantly.
	savePool(working)

	// Track consecutive empty refreshes so a sustained pool outage escalates
	// from warn → critical in the snapshot/health output instead of just
	// producing a flat "working=0" line every refresh cycle.
	if len(working) == 0 {
		streak := t.consecutiveZeroRefreshes.Add(1)
		if streak >= emptyPoolCriticalThreshold {
			slog.Error("proxy_pool: empty-pool streak at critical threshold",
				"op", "transport.proxyPool/refresh/emptyCritical",
				"consecutive_zero", streak,
				"total_candidates", len(candidates))
		} else {
			slog.Warn("proxy_pool: refresh yielded zero working proxies",
				"op", "transport.proxyPool/refresh/zeroWorking",
				"consecutive_zero", streak,
				"total_candidates", len(candidates))
		}
	} else {
		t.consecutiveZeroRefreshes.Store(0)
	}

	slog.Info("proxy_pool: pool refreshed", "working", len(working), "total_candidates", len(candidates))
	return nil
}

// ForceRefresh triggers an immediate re-fetch+probe cycle in the calling
// goroutine, skipping the isStale() check. At most one refresh runs at a
// time — if a refresh is already in progress, ForceRefresh returns without
// starting a second one (atomic CAS guard, same as the ticker and DialContext
// lazy-refresh paths).
func (t *RotatingProxyTransport) ForceRefresh() {
	if t.refreshing.CompareAndSwap(false, true) {
		t.refreshWG.Add(1)
		defer t.refreshWG.Done()
		defer t.refreshing.Store(false)
		if err := t.refresh(t.ctx); err != nil {
			slog.Warn("proxy_pool: force-refresh failed", "op", "transport.proxyPool/forceRefresh", "error", err)
		}
	}
}

// WaitRefresh blocks until all in-flight background refresh goroutines (lazy
// from DialContext, ticker, ForceRefresh, initial fetch) have finished. Used
// by tests to deterministically join the refresh before tearing down mocked
// globals; production code does not need to call this.
func (t *RotatingProxyTransport) WaitRefresh() {
	t.refreshWG.Wait()
}

// ConsecutiveZeroRefreshes returns the number of successful refreshes in a row
// that returned an empty working set. Resets to 0 as soon as a refresh yields
// ≥1 proxy. Exported so health endpoints can surface the streak without
// re-deriving it from log scraping.
func (t *RotatingProxyTransport) ConsecutiveZeroRefreshes() int32 {
	return t.consecutiveZeroRefreshes.Load()
}

// EmptyPoolCritical reports whether the consecutive-zero streak has reached
// the critical threshold (≥3). At that point the operator must intervene:
// fallback to direct dials would leak the real relay IP.
func (t *RotatingProxyTransport) EmptyPoolCritical() bool {
	return t.consecutiveZeroRefreshes.Load() >= emptyPoolCriticalThreshold
}

// geonodeResponse is the JSON structure from proxylist.geonode.com.
type geonodeResponse struct {
	Data []struct {
		IP      string `json:"ip"`
		Port    string `json:"port"`
		Country string `json:"country"`
	} `json:"data"`
}

// fetchProxyListGeonode parses the geonode JSON feed and preserves the
// per-proxy country tag so downstream code can apply strict-geo filtering.
// Geonode is the only source that surfaces country data; proxifly + proxyscrape
// feeds carry no geo info, so candidates from those sources keep country == "".
func fetchProxyListGeonode(ctx context.Context) ([]proxyCandidate, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, proxyListEndpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch geonode list: %w", err)
	}
	defer resp.Body.Close()

	var result geonodeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode geonode list: %w", err)
	}

	cands := make([]proxyCandidate, 0, len(result.Data))
	for _, p := range result.Data {
		if p.IP != "" && p.Port != "" {
			cands = append(cands, proxyCandidate{
				addr:    net.JoinHostPort(p.IP, p.Port),
				country: strings.ToUpper(strings.TrimSpace(p.Country)),
				source:  "geonode",
			})
		}
	}
	return cands, nil
}

// fetchProxyListProxyscrape hits the plaintext proxyscrape.com feed. Format
// is one "ip:port" per line; anything that doesn't match host:port shape is
// dropped so premium-feature error bodies (e.g. "format are premium features.")
// return zero addrs rather than poisoning the pool.
func fetchProxyListProxyscrape(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, proxyscrapeEndpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch proxyscrape list: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read proxyscrape body: %w", err)
	}

	addrs := make([]string, 0, 64)
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		host, port, err := net.SplitHostPort(line)
		if err != nil || host == "" || port == "" {
			continue
		}
		addrs = append(addrs, net.JoinHostPort(host, port))
	}
	return addrs, nil
}

// fetchProxyListProxifly fetches the proxifly socks5/data.txt feed.
// Format: one "socks5://host:port" per line. No country data in this format;
// the data.json changed to a schema definition so we use the txt feed instead.
// If the primary endpoint returns empty, tries a fallback URL for format changes.
func fetchProxyListProxifly(ctx context.Context) ([]proxyCandidate, error) {
	cands, err := fetchProxyListProxiflyURL(ctx, proxiflyEndpoint)
	if err != nil {
		return nil, err
	}
	// If primary returned empty, try fallback in case format/URL changed.
	if len(cands) == 0 && proxiflyEndpoint != proxiflyFallbackURL {
		slog.Warn("proxy_pool: proxifly primary returned 0, trying fallback",
			"op", "transport.fetchProxyListProxifly/primaryEmpty")
		fallbackCands, fallbackErr := fetchProxyListProxiflyURL(ctx, proxiflyFallbackURL)
		if fallbackErr == nil && len(fallbackCands) > 0 {
			return fallbackCands, nil
		}
	}
	return cands, nil
}

// fetchProxyListProxiflyURL fetches from a specific proxifly URL and parses the response.
func fetchProxyListProxiflyURL(ctx context.Context, url string) ([]proxyCandidate, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch proxifly list: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("read proxifly body: %w", err)
	}

	cands := make([]proxyCandidate, 0, 400)
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Format: socks5://host:port
		addr := strings.TrimPrefix(line, "socks5://")
		if addr == line || addr == "" {
			continue
		}
		// Validate host:port
		if _, _, err := net.SplitHostPort(addr); err != nil {
			continue
		}
		cands = append(cands, proxyCandidate{
			addr:   addr,
			source: "proxifly",
		})
	}
	return cands, nil
}

// fetchProxyListMulti fans out to every configured proxy-list source in
// parallel and returns the union (deduped by host:port). A source that errors
// or returns zero addrs is logged and skipped — we only return an error if
// *all* sources fail, because a single live source is better than none.
// proxyCandidate is an alias for proxyEntry used by the multi-source fetch.
type proxyCandidate = proxyEntry

func fetchProxyListMulti(ctx context.Context) ([]proxyCandidate, error) {
	type strResult struct {
		name  string
		addrs []string
		err   error
	}
	type candResult struct {
		name  string
		cands []proxyCandidate
		err   error
	}

	// Fan-out all sources concurrently for speed, but merge in priority order:
	// proxifly (has country data) → geonode → proxyscrape (first-wins dedup).
	type anyResult struct {
		priority int
		name     string
		cands    []proxyCandidate
		err      error
	}
	allResults := make(chan anyResult, 3)

	go func() {
		cands, err := fetchProxyListProxifly(ctx)
		allResults <- anyResult{priority: 0, name: "proxifly", cands: cands, err: err}
	}()
	go func() {
		cands, err := fetchProxyListGeonode(ctx)
		allResults <- anyResult{priority: 1, name: "geonode", cands: cands, err: err}
	}()
	go func() {
		addrs, err := fetchProxyListProxyscrape(ctx)
		cands := make([]proxyCandidate, 0, len(addrs))
		for _, a := range addrs {
			cands = append(cands, proxyCandidate{addr: a, source: "proxyscrape"})
		}
		allResults <- anyResult{priority: 2, name: "proxyscrape", cands: cands, err: err}
	}()

	// Collect all 3 results then merge in priority order.
	collected := make([]anyResult, 0, 3)
	for i := 0; i < 3; i++ {
		collected = append(collected, <-allResults)
	}
	// Sort by priority (0=proxifly, 1=geonode, 2=proxyscrape).
	for i := 1; i < len(collected); i++ {
		for j := i; j > 0 && collected[j].priority < collected[j-1].priority; j-- {
			collected[j], collected[j-1] = collected[j-1], collected[j]
		}
	}

	seen := make(map[string]struct{})
	merged := make([]proxyCandidate, 0, 512)
	okCount := 0
	var lastErr error

	for _, r := range collected {
		if r.err != nil {
			slog.Warn("proxy_pool: source failed", "op", "transport.fetchProxyListMulti/sourceFailed", "source", r.name, "error", r.err)
			recordSourceResult(r.name, 0, r.err)
			lastErr = r.err
			continue
		}
		okCount++
		recordSourceResult(r.name, len(r.cands), nil)
		slog.Info("proxy_pool: source yielded", "source", r.name, "count", len(r.cands))
		for _, c := range r.cands {
			if _, dup := seen[c.addr]; dup {
				continue
			}
			seen[c.addr] = struct{}{}
			merged = append(merged, c)
		}
	}

	if okCount == 0 {
		return nil, fmt.Errorf("all proxy-list sources failed: %w", lastErr)
	}

	// Enrich missing country codes via ip-api.com /batch — proxifly + proxyscrape
	// feeds carry no geo info, so without enrichment strict-geo would drop them
	// all. Cached on disk so repeat refreshes don't re-hit the upstream API.
	EnrichCountries(ctx, merged)

	if strictGeoEnabled() {
		merged = filterByGeo(merged)
	}

	return merged, nil
}

// strictGeoEnabled reports whether the relay should hard-reject candidates
// whose ISO country code is missing or outside the PROXY_COUNTRY_CODES allow
// list. Toggled via PROXY_STRICT_GEO env (any non-empty value enables).
// Default off for backwards compatibility — historic deployments rely on the
// "let the probe decide" behaviour and this filter would shrink their pool.
func strictGeoEnabled() bool {
	return strings.TrimSpace(envconfig.GetOr("PROXY_STRICT_GEO", "")) != ""
}

// filterByGeo drops every candidate whose country tag is missing or not in
// the configured allow list. Only geonode candidates carry country tags;
// proxifly + proxyscrape feeds have no geo info, so they are rejected in
// strict mode as a conservative default. Operators who need wider coverage
// must either widen PROXY_COUNTRY_CODES or disable PROXY_STRICT_GEO.
func filterByGeo(cands []proxyCandidate) []proxyCandidate {
	allowed := allowedCountryCodes()
	out := make([]proxyCandidate, 0, len(cands))
	rejectedNonAllowed := 0
	rejectedNoCountry := 0
	for _, c := range cands {
		if c.country == "" {
			rejectedNoCountry++
			continue
		}
		if _, ok := allowed[c.country]; !ok {
			rejectedNonAllowed++
			continue
		}
		out = append(out, c)
	}
	if rejectedNonAllowed > 0 || rejectedNoCountry > 0 {
		slog.Info("proxy_pool: strict geo filter applied",
			"op", "transport.proxyPool/filterByGeo",
			"kept", len(out),
			"rejected_outside_allowlist", rejectedNonAllowed,
			"rejected_unknown_country", rejectedNoCountry)
	}
	return out
}

// smtpAuthProbeTimeout is the per-proxy deadline for the full SMTP AUTH probe
// (TLS handshake + EHLO + AUTH LOGIN exchange). Slightly longer than
// probeTimeout to allow for SMTP server greeting latency.
const smtpAuthProbeTimeout = 15 * time.Second

// probeAll tests all candidates concurrently (max 50 goroutines) and returns
// those that reach probeTarget *and* complete a TLS handshake with the
// expected ServerName. TCP-only probing lets through proxies that accept
// connects but silently drop / MITM the target — common for lying "SOCKS5"
// endpoints. TLS handshake to smtp.seznam.cz verifies we actually reached
// the real submission server.
//
// When SMTP_PROBE_USERNAME is set (smtpProbeConfig().enabled), each candidate
// that passes the TLS probe is additionally probed for SMTP AUTH LOGIN. Only
// proxies that pass AUTH are included in the returned working set. This catches
// the seznam.cz Layer-7 block pattern where a proxy routes TCP fine but the
// AUTH LOGIN receives a 535 from the SMTP server.
func probeAll(ctx context.Context, candidates []proxyCandidate) []proxyEntry {
	type result struct {
		entry proxyEntry
		ok    bool
	}

	smtpCfg, authEnabled := smtpProbeConfig()

	sem := make(chan struct{}, 50)
	results := make(chan result, len(candidates))

	targetHost := probeTarget
	if h, _, err := net.SplitHostPort(probeTarget); err == nil {
		targetHost = h
	}

	for _, cand := range candidates {
		cand := cand
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			start := time.Now()
			socks := NewSOCKS5Transport(cand.addr, probeTimeout)
			probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			var conn net.Conn
			var err error
			if probeDialFn != nil {
				conn, err = probeDialFn(probeCtx, cand.addr, probeTarget)
			} else {
				conn, err = socks.DialContext(probeCtx, "tcp", probeTarget)
			}
			if err != nil {
				results <- result{ok: false}
				return
			}
			verifyErr := probeVerify(probeCtx, conn, targetHost)
			_ = conn.Close()
			if verifyErr != nil {
				slog.Debug("proxy_pool: probe verify failed", "proxy", cand.addr, "err", verifyErr)
				results <- result{ok: false}
				return
			}

			entry := proxyEntry{addr: cand.addr, latency: time.Since(start), country: cand.country, source: cand.source}

			// Optional Layer-7 SMTP AUTH probe. Uses a separate SOCKS5 dial with
			// a longer timeout so the full SMTP greeting+AUTH exchange can complete.
			if authEnabled {
				authCtx, authCancel := context.WithTimeout(ctx, smtpAuthProbeTimeout)
				defer authCancel()
				authSocks := NewSOCKS5Transport(cand.addr, smtpAuthProbeTimeout)
				if !probeSmtpAuth(authCtx, authSocks, smtpCfg, cand.addr) {
					slog.Debug("proxy_pool: smtp auth probe failed", "proxy", cand.addr)
					results <- result{ok: false}
					return
				}
				entry.authValid = true
			}

			results <- result{entry: entry, ok: true}
		}()
	}

	// Drain sem
	for i := 0; i < cap(sem); i++ {
		sem <- struct{}{}
	}
	close(results)

	var working []proxyEntry
	for r := range results {
		if r.ok {
			working = append(working, r.entry)
		}
	}
	return working
}

// smtpAuthTLSConfigOverride, when non-nil, replaces the default TLS config
// used by probeSmtpAuth. Tests set this to &tls.Config{InsecureSkipVerify:true}
// to accept self-signed certs from mock SMTP servers.
var smtpAuthTLSConfigOverride *tls.Config

// smtpAuthDialOverride, when non-nil, replaces the SOCKS5 dial inside
// probeSmtpAuth. The function receives the proxy candidate addr so tests can
// route different candidates to different mock SMTP servers.
// Signature: func(ctx, proxyAddr string) (net.Conn, error)
var smtpAuthDialOverride func(ctx context.Context, proxyAddr string) (net.Conn, error)

// probeSmtpAuth performs a full SMTP AUTH LOGIN through the given SOCKS5
// transport. Returns true only if AUTH LOGIN succeeds (i.e. the SMTP server
// accepted the credentials). Any error — dial, TLS handshake, EHLO, or AUTH
// — returns false without panicking.
//
// proxyAddr is the SOCKS5 proxy address string (e.g. "1.2.3.4:1080"); it is
// passed to smtpAuthDialOverride so tests can dispatch per-candidate.
//
// The probe opens a fresh SOCKS5 connection (separate from the TLS-only probe
// connection) so TLS and AUTH are both verified end-to-end through the proxy.
func probeSmtpAuth(ctx context.Context, socks AnonymousTransport, cfg smtpProbeCredentials, proxyAddr string) bool {
	var conn net.Conn
	var err error
	if smtpAuthDialOverride != nil {
		conn, err = smtpAuthDialOverride(ctx, proxyAddr)
	} else {
		conn, err = socks.DialContext(ctx, "tcp", fmt.Sprintf("%s:465", cfg.host))
	}
	if err != nil {
		return false
	}
	defer conn.Close()

	// Apply context deadline to the underlying connection so all SMTP
	// operations (TLS handshake, EHLO, AUTH) time out with the caller's budget.
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	tlsCfg := SMTPParrotTLS(cfg.host)
	if smtpAuthTLSConfigOverride != nil {
		tlsCfg = smtpAuthTLSConfigOverride
	}
	tlsConn := tls.Client(conn, tlsCfg)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		return false
	}

	c, err := smtp.NewClient(tlsConn, cfg.host)
	if err != nil {
		return false
	}
	defer c.Close()

	// AUTH LOGIN — the mechanism required by seznam.cz and Czech providers.
	// smtpLoginAuth is a local shim so the transport package does not import
	// relay/internal/delivery (would create a circular dependency).
	auth := &smtpLoginAuth{username: cfg.username, password: cfg.password}
	if err := c.Auth(auth); err != nil {
		return false
	}
	return true
}

// smtpLoginAuth is a minimal SMTP AUTH LOGIN implementation local to the
// transport package. Mirrors delivery.loginAuthType without creating an
// import cycle.
type smtpLoginAuth struct{ username, password string }

func (a *smtpLoginAuth) Start(_ *smtp.ServerInfo) (string, []byte, error) {
	return "LOGIN", nil, nil
}

func (a *smtpLoginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	switch strings.ToLower(strings.TrimSpace(string(fromServer))) {
	case "username:":
		return []byte(a.username), nil
	case "password:":
		return []byte(a.password), nil
	default:
		return nil, fmt.Errorf("smtp auth login: unexpected challenge %q", fromServer)
	}
}

// verifyTLSConfig, when non-nil, replaces the default TLS client config used
// by verifyTLSHandshake. Tests set this to accept self-signed certs.
var verifyTLSConfig *tls.Config

// verifyTLSHandshake is the default probe verifier. After the SOCKS5 dial
// completes, run a TLS client handshake to the probe target: proxies that
// hijack DNS, MITM with a bad cert, or route to a dead host will fail here.
// A deadline on the underlying conn bounds the handshake to probeTimeout.
func verifyTLSHandshake(ctx context.Context, conn net.Conn, host string) error {
	_ = conn.SetDeadline(time.Now().Add(probeTimeout))
	tlsCfg := SMTPParrotTLS(host)
	if verifyTLSConfig != nil {
		tlsCfg = verifyTLSConfig
	}
	tlsConn := tls.Client(conn, tlsCfg)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		class := "handshake"
		if strings.Contains(err.Error(), "certificate") {
			class = "bad_cert"
		}
		return fmt.Errorf("tls %s: %w", class, err)
	}
	// Don't call tlsConn.Close() — probeAll closes the underlying conn.
	return nil
}
