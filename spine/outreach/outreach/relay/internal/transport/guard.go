package transport

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Alert is emitted by the guard when something tries to dial a destination
// that is neither in the working proxy pool nor in the allowed-bridge list.
type Alert struct {
	Type      string
	Dest      string
	Timestamp time.Time
}

// DialGuard is a belt-and-suspenders check that refuses any outbound dial to
// addresses outside the working SOCKS5 proxy pool and the privacy-gateway
// bridge allowlist. It is the R7 runtime assertion layer for
// SMTP-EGRESS-LOCKDOWN — even if a code path tries to bypass the pool, the
// guard refuses and emits an alert.
//
// The guard is intentionally cheap to call (an RWMutex-read + slice scan on
// a small working set) so every net.Dial/socks.Dial in the relay can Assert.
type DialGuard struct {
	pool    *RotatingProxyTransport
	bridges []string
	alerts  chan<- Alert

	mu         sync.RWMutex
	lastAlerts []Alert // bounded ring for observability when no sink is wired
	maxRing    int
}

// NewDialGuard builds a guard over the proxy pool and an optional list of
// static bridge addresses (e.g. privacy-gateway egress). If alerts is nil,
// rejected destinations are stored in a bounded in-memory ring for
// introspection via RecentAlerts.
func NewDialGuard(pool *RotatingProxyTransport, bridges []string, alerts chan<- Alert) *DialGuard {
	return &DialGuard{
		pool:    pool,
		bridges: append([]string(nil), bridges...),
		alerts:  alerts,
		maxRing: 32,
	}
}

// Assert verifies dest is allowed. Returns nil when dest is in the working
// proxy pool or the bridge allowlist; otherwise returns an error and emits
// an alert so the operator can trace the bypass attempt.
func (g *DialGuard) Assert(dest string) error {
	if g == nil {
		return nil
	}
	if g.pool != nil && g.pool.IsWorkingAddr(dest) {
		return nil
	}
	for _, b := range g.bridges {
		if b == dest {
			return nil
		}
	}
	alert := Alert{
		Type:      "DIRECT_EGRESS_ATTEMPT",
		Dest:      dest,
		Timestamp: time.Now(),
	}
	g.record(alert)
	slog.Warn("relay_audit: direct egress refused",
		"op", "transport.dialGuard/assert",
		"event", "DIRECT_EGRESS_ATTEMPT",
		"dest", dest)
	return fmt.Errorf("dial_guard: refused direct egress to %s", dest)
}

// AddBridge appends an address to the allowlist. Call during startup after
// the guard is constructed to register privacy-gateway addresses.
func (g *DialGuard) AddBridge(addr string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, b := range g.bridges {
		if b == addr {
			return
		}
	}
	g.bridges = append(g.bridges, addr)
}

// Bridges returns a defensive copy of the current bridge allowlist.
func (g *DialGuard) Bridges() []string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return append([]string(nil), g.bridges...)
}

// RecentAlerts returns the bounded ring of refused destinations.
func (g *DialGuard) RecentAlerts() []Alert {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return append([]Alert(nil), g.lastAlerts...)
}

func (g *DialGuard) record(a Alert) {
	g.mu.Lock()
	if len(g.lastAlerts) >= g.maxRing {
		g.lastAlerts = g.lastAlerts[1:]
	}
	g.lastAlerts = append(g.lastAlerts, a)
	g.mu.Unlock()
	if g.alerts != nil {
		select {
		case g.alerts <- a:
		default:
			// Alert sink saturated — don't block the dial path.
		}
	}
}
