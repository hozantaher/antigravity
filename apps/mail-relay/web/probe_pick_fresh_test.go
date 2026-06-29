package web

import (
	"testing"

	"relay/internal/transport"
)

// TestPickFreshProxy_EmptyPool returns empty string when no proxies.
func TestPickFreshProxy_EmptyPool(t *testing.T) {
	got := pickFreshProxy(nil)
	if got != "" {
		t.Fatalf("expected empty string for empty pool, got %q", got)
	}
}

// TestPickFreshProxy_SingleProxy returns it regardless of score.
func TestPickFreshProxy_SingleProxy(t *testing.T) {
	pool := []transport.PoolEntry{{Addr: "1.2.3.4:1080", LatencyMs: 100}}
	got := pickFreshProxy(pool)
	if got != "1.2.3.4:1080" {
		t.Fatalf("expected 1.2.3.4:1080, got %q", got)
	}
}

// TestPickFreshProxy_PrefersHigherScore picks proxy with better track record.
// Records simulate one healthy proxy and one with consistent failures.
func TestPickFreshProxy_PrefersHigherScore(t *testing.T) {
	t.Cleanup(transport.ResetGlobalProxyStatsForTest)

	// Healthy: record many successes
	for i := 0; i < 10; i++ {
		transport.RecordProxyResult("good:1080", true)
	}
	// Unhealthy: record many failures
	for i := 0; i < 10; i++ {
		transport.RecordProxyResult("bad:1080", false)
	}

	pool := []transport.PoolEntry{
		{Addr: "bad:1080", LatencyMs: 50},  // lower latency but bad score
		{Addr: "good:1080", LatencyMs: 200}, // higher latency but good score
	}
	got := pickFreshProxy(pool)
	if got != "good:1080" {
		t.Fatalf("expected good:1080 (higher score wins over latency), got %q", got)
	}
}

// TestPickFreshProxy_LatencyTiebreakWhenSameScore picks lower latency on tie.
func TestPickFreshProxy_LatencyTiebreakWhenSameScore(t *testing.T) {
	t.Cleanup(transport.ResetGlobalProxyStatsForTest)

	// Both unknown score (no records) → identical scores
	pool := []transport.PoolEntry{
		{Addr: "slow:1080", LatencyMs: 500},
		{Addr: "fast:1080", LatencyMs: 100},
	}
	got := pickFreshProxy(pool)
	if got != "fast:1080" {
		t.Fatalf("expected fast:1080 (lower latency tiebreak), got %q", got)
	}
}

// TestPickFreshProxy_AllLowScoreFallsBack returns something even when every
// proxy is below threshold (degraded routing beats blackout).
func TestPickFreshProxy_AllLowScoreFallsBack(t *testing.T) {
	t.Cleanup(transport.ResetGlobalProxyStatsForTest)

	for _, addr := range []string{"a:1080", "b:1080"} {
		for i := 0; i < 20; i++ {
			transport.RecordProxyResult(addr, false)
		}
	}

	pool := []transport.PoolEntry{
		{Addr: "a:1080", LatencyMs: 200},
		{Addr: "b:1080", LatencyMs: 100},
	}
	got := pickFreshProxy(pool)
	if got == "" {
		t.Fatalf("expected fallback pick, got empty")
	}
	// Lower latency wins in fallback when scores tie
	if got != "b:1080" {
		t.Fatalf("expected b:1080 in fallback (lower latency), got %q", got)
	}
}
