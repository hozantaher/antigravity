package transport

import (
	"strings"
	"time"
)

// NewStaticRotatingProxy seeds a RotatingProxyTransport with a pre-probed
// list of SOCKS5 endpoints. Use this when the proxy list comes from a
// trusted source (e.g. the outreach-dashboard BFF's curated pool for
// CZ + neighboring countries that reach seznam.cz) instead of a public
// proxy aggregator.
//
// Addresses are `host:port`. The pool is marked as already refreshed so
// the background fetch cycle is skipped. An empty addrs slice falls back
// to the provided transport (typically DirectTransport) on every dial.
func NewStaticRotatingProxy(addrs []string, fallback AnonymousTransport) *RotatingProxyTransport {
	entries := make([]proxyEntry, 0, len(addrs))
	for _, raw := range addrs {
		addr := strings.TrimSpace(raw)
		if addr == "" {
			continue
		}
		entries = append(entries, proxyEntry{addr: addr, country: "ZZ", source: "static"})
	}
	return &RotatingProxyTransport{
		working:     entries,
		fallback:    fallback,
		lastRefresh: time.Now(),
	}
}

// Pool returns the current working addresses (copy). Intended for tests
// and operator diagnostics — do not mutate the caller's slice.
func (t *RotatingProxyTransport) Pool() []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make([]string, 0, len(t.working))
	for _, e := range t.working {
		out = append(out, e.addr)
	}
	return out
}
