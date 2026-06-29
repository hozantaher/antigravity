package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"common/envconfig"
)

// GeoIP cache: persistent map of IP → ISO country code, refreshed via
// ip-api.com /batch. Used by probeAll to populate proxy country tags so
// PROXY_STRICT_GEO can filter out non-allowlisted regions.
//
// ip-api.com /batch:
//   - up to 100 IPs per call
//   - 15 calls/min unauthenticated (HTTP only — no HTTPS in free tier)
//   - response: [{query, countryCode, status}, ...]
//
// Cache TTL is 7 days (countries don't change). On boot the persisted file
// is loaded; failed lookups are NOT cached (so transient API outages don't
// stick). geoCachePath is overrideable via PROXY_GEO_CACHE_PATH env.

const (
	geoBatchSize    = 100
	geoBatchTimeout = 12 * time.Second
	geoEntryTTL     = 7 * 24 * time.Hour
	// W2-F (2026-04-29): default endpoint is HTTP because ip-api.com's
	// free tier requires no key but is HTTP-only (HTTPS is paid pro).
	// Operators concerned about leaking the proxy IP list to the
	// network path between relay and ip-api.com can override via env
	// PROXY_GEOIP_BATCH_URL — pointing at:
	//   - https://pro.ip-api.com/batch?key=... (paid)
	//   - a self-hosted GeoLite2 MaxMind frontend
	//   - a custom internal endpoint
	// The current default trades privacy of the proxy-IP list against
	// not requiring a paid-tier dependency. Documented in the relay
	// CLAUDE.md and the W2-F PR body.
	defaultGeoBatchEndpoint = "http://ip-api.com/batch?fields=status,countryCode,query"
)

// geoBatchEndpoint reads the runtime endpoint, allowing PROXY_GEOIP_BATCH_URL
// override.
func geoBatchEndpointURL() string {
	if v := envconfig.GetOr("PROXY_GEOIP_BATCH_URL", ""); v != "" {
		return v
	}
	return defaultGeoBatchEndpoint
}

type geoCacheEntry struct {
	Country string    `json:"c"`
	At      time.Time `json:"t"`
}

type geoCache struct {
	mu      sync.RWMutex
	entries map[string]geoCacheEntry
	path    string
}

var globalGeoCache = newGeoCache()

func newGeoCache() *geoCache {
	c := &geoCache{
		entries: map[string]geoCacheEntry{},
		path:    geoCachePath(),
	}
	c.loadFromDisk()
	return c
}

func geoCachePath() string {
	if p := envconfig.GetOr("PROXY_GEO_CACHE_PATH", ""); p != "" {
		return p
	}
	return "/tmp/relay-geoip-cache.json"
}

func (c *geoCache) loadFromDisk() {
	if c.path == "" {
		return
	}
	data, err := os.ReadFile(c.path)
	if err != nil {
		return
	}
	var raw map[string]geoCacheEntry
	if err := json.Unmarshal(data, &raw); err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for ip, e := range raw {
		if now.Sub(e.At) < geoEntryTTL && e.Country != "" {
			c.entries[ip] = e
		}
	}
}

func (c *geoCache) saveToDisk() {
	if c.path == "" {
		return
	}
	c.mu.RLock()
	snapshot := make(map[string]geoCacheEntry, len(c.entries))
	for k, v := range c.entries {
		snapshot[k] = v
	}
	c.mu.RUnlock()
	data, err := json.Marshal(snapshot)
	if err != nil {
		return
	}
	tmp := c.path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return
	}
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, c.path)
}

func (c *geoCache) get(ip string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[ip]
	if !ok {
		return "", false
	}
	if time.Since(e.At) > geoEntryTTL {
		return "", false
	}
	return e.Country, true
}

func (c *geoCache) put(ip, country string) {
	if country == "" {
		return
	}
	c.mu.Lock()
	c.entries[ip] = geoCacheEntry{Country: country, At: time.Now()}
	c.mu.Unlock()
}

// EnrichCountries fills missing country codes on the candidate slice in place.
// Already-tagged candidates are left alone. Lookups are batched against
// ip-api.com /batch; on API failure, candidates remain untagged (caller
// decides what to do — strict-geo will drop them).
func EnrichCountries(ctx context.Context, cands []proxyCandidate) {
	if len(cands) == 0 {
		return
	}

	missingIdx := make([]int, 0, len(cands))
	missingIPs := make([]string, 0, len(cands))
	for i := range cands {
		if cands[i].country != "" {
			continue
		}
		host, _, err := net.SplitHostPort(cands[i].addr)
		if err != nil {
			continue
		}
		if c, ok := globalGeoCache.get(host); ok {
			cands[i].country = c
			continue
		}
		missingIdx = append(missingIdx, i)
		missingIPs = append(missingIPs, host)
	}

	if len(missingIPs) == 0 {
		return
	}

	resolved := batchLookup(ctx, missingIPs)
	for j, idx := range missingIdx {
		ip := missingIPs[j]
		if c, ok := resolved[ip]; ok && c != "" {
			cands[idx].country = c
			globalGeoCache.put(ip, c)
		}
	}
	globalGeoCache.saveToDisk()
}

type batchReqEntry struct {
	Query string `json:"query"`
}

type batchRespEntry struct {
	Status      string `json:"status"`
	CountryCode string `json:"countryCode"`
	Query       string `json:"query"`
}

// batchLookup calls ip-api.com /batch in chunks of 100. Returns ip→country
// for successful entries. Errors are logged and result in missing entries —
// caller treats missing as "unknown country."
func batchLookup(ctx context.Context, ips []string) map[string]string {
	out := make(map[string]string, len(ips))

	for start := 0; start < len(ips); start += geoBatchSize {
		end := start + geoBatchSize
		if end > len(ips) {
			end = len(ips)
		}
		chunk := ips[start:end]

		body := make([]batchReqEntry, 0, len(chunk))
		for _, ip := range chunk {
			body = append(body, batchReqEntry{Query: ip})
		}
		payload, err := json.Marshal(body)
		if err != nil {
			continue
		}

		reqCtx, cancel := context.WithTimeout(ctx, geoBatchTimeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, geoBatchEndpointURL(), bytes.NewReader(payload))
		if err != nil {
			cancel()
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "anti-trace-relay/1")

		geoHTTPClient := &http.Client{Timeout: 10 * time.Second}
		resp, err := geoHTTPClient.Do(req)
		if err != nil {
			cancel()
			slog.Warn("geoip: batch fetch failed", "op", "transport.geoip/batchLookup", "error", err, "chunk_size", len(chunk))
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		cancel()

		if resp.StatusCode != http.StatusOK {
			n := len(raw)
			if n > 200 {
				n = 200
			}
			slog.Warn("geoip: batch non-200", "op", "transport.geoip/batchLookup/non200", "status", resp.StatusCode, "body", string(raw[:n]))
			continue
		}

		var entries []batchRespEntry
		if err := json.Unmarshal(raw, &entries); err != nil {
			slog.Warn("geoip: batch decode failed", "op", "transport.geoip/batchLookup/decode", "error", err)
			continue
		}
		for _, e := range entries {
			if e.Status == "success" && e.CountryCode != "" {
				out[e.Query] = e.CountryCode
			}
		}
	}

	return out
}

