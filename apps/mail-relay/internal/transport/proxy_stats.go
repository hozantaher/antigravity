package transport

import (
	"sync"
	"sync/atomic"
	"time"
)

type proxyStatEntry struct {
	success atomic.Uint64
	fail    atomic.Uint64
	lastOk  time.Time
	mu      sync.Mutex // guards lastOk only
}

type proxyStats struct {
	mu      sync.RWMutex
	entries map[string]*proxyStatEntry
}

// globalProxyStats is the process-wide success/fail tracker for all SOCKS5 proxies.
var globalProxyStats = &proxyStats{entries: make(map[string]*proxyStatEntry)}

// RecordProxyResult records a delivery success (ok=true) or failure (ok=false)
// for the given proxy address. Thread-safe; safe to call from concurrent goroutines.
func RecordProxyResult(addr string, ok bool) {
	globalProxyStats.mu.RLock()
	e := globalProxyStats.entries[addr]
	globalProxyStats.mu.RUnlock()

	if e == nil {
		globalProxyStats.mu.Lock()
		// double-check under write lock
		if e = globalProxyStats.entries[addr]; e == nil {
			e = &proxyStatEntry{}
			globalProxyStats.entries[addr] = e
		}
		globalProxyStats.mu.Unlock()
	}

	if ok {
		e.success.Add(1)
		e.mu.Lock()
		e.lastOk = time.Now()
		e.mu.Unlock()
	} else {
		e.fail.Add(1)
	}
}

// ProxyScore returns the success rate 0.0–1.0 for the given address.
// Returns 0.5 (neutral) for unknown proxies with no recorded results.
func ProxyScore(addr string) float64 {
	globalProxyStats.mu.RLock()
	e := globalProxyStats.entries[addr]
	globalProxyStats.mu.RUnlock()
	if e == nil {
		return 0.5
	}
	s := e.success.Load()
	f := e.fail.Load()
	total := s + f
	if total == 0 {
		return 0.5
	}
	return float64(s) / float64(total)
}

// resetGlobalProxyStats clears the global stats — used only in tests to
// prevent cross-test contamination. Not exported from the package outside tests.
func resetGlobalProxyStats() {
	globalProxyStats.mu.Lock()
	globalProxyStats.entries = make(map[string]*proxyStatEntry)
	globalProxyStats.mu.Unlock()
}

// ResetGlobalProxyStatsForTest is the exported test hook for cross-package tests
// (e.g. relay/web probe selection). Not for production use.
func ResetGlobalProxyStatsForTest() { resetGlobalProxyStats() }
