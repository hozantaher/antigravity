package transport

import (
	"sync"
	"testing"
)

// TestRecordProxyResult_SuccessRaisesScore verifies a single success pushes score above 0.5.
func TestRecordProxyResult_SuccessRaisesScore(t *testing.T) {
	resetGlobalProxyStats()
	RecordProxyResult("1.2.3.4:1080", true)
	score := ProxyScore("1.2.3.4:1080")
	if score <= 0.5 {
		t.Fatalf("expected score > 0.5 after 1 success, got %f", score)
	}
}

// TestRecordProxyResult_FailureLowersScore verifies a single failure yields score < 0.5.
func TestRecordProxyResult_FailureLowersScore(t *testing.T) {
	resetGlobalProxyStats()
	RecordProxyResult("2.3.4.5:1080", false)
	score := ProxyScore("2.3.4.5:1080")
	if score >= 0.5 {
		t.Fatalf("expected score < 0.5 after 1 failure, got %f", score)
	}
}

// TestProxyScore_UnknownProxyNeutral verifies unknown proxies return 0.5.
func TestProxyScore_UnknownProxyNeutral(t *testing.T) {
	resetGlobalProxyStats()
	score := ProxyScore("99.99.99.99:1080")
	if score != 0.5 {
		t.Fatalf("expected 0.5 for unknown proxy, got %f", score)
	}
}

// TestProxyScore_ConsistentlyFailing verifies 9 fails + 1 ok → score < 0.2.
func TestProxyScore_ConsistentlyFailing(t *testing.T) {
	resetGlobalProxyStats()
	addr := "3.4.5.6:1080"
	for i := 0; i < 9; i++ {
		RecordProxyResult(addr, false)
	}
	RecordProxyResult(addr, true)
	score := ProxyScore(addr)
	if score >= 0.2 {
		t.Fatalf("expected score < 0.2 for 9 fails + 1 ok, got %f", score)
	}
}

// TestProxyScore_AllSuccesses verifies 100% success rate returns 1.0.
func TestProxyScore_AllSuccesses(t *testing.T) {
	resetGlobalProxyStats()
	addr := "4.5.6.7:1080"
	for i := 0; i < 5; i++ {
		RecordProxyResult(addr, true)
	}
	score := ProxyScore(addr)
	if score != 1.0 {
		t.Fatalf("expected 1.0 for 5 successes, got %f", score)
	}
}

// TestProxyScore_ExactNeutralMix verifies equal success and failure = 0.5.
func TestProxyScore_ExactNeutralMix(t *testing.T) {
	resetGlobalProxyStats()
	addr := "5.6.7.8:1080"
	RecordProxyResult(addr, true)
	RecordProxyResult(addr, false)
	score := ProxyScore(addr)
	if score != 0.5 {
		t.Fatalf("expected 0.5 for 1 success + 1 fail, got %f", score)
	}
}

// TestPickExcludesLowScoreProxies verifies pick() skips proxies scoring < 0.2.
func TestPickExcludesLowScoreProxies(t *testing.T) {
	resetGlobalProxyStats()
	badAddr := "bad:1080"
	goodAddr := "good:1080"

	// Drive bad proxy below 0.2 score.
	for i := 0; i < 9; i++ {
		RecordProxyResult(badAddr, false)
	}
	RecordProxyResult(badAddr, true)
	// Confirm score is actually below threshold.
	if ProxyScore(badAddr) >= 0.2 {
		t.Fatalf("test setup broken: bad proxy score should be < 0.2")
	}

	// Good proxy has neutral score (default).
	tr := &RotatingProxyTransport{
		working: []proxyEntry{
			{addr: badAddr},
			{addr: goodAddr},
		},
	}

	// Run pick many times — should only return goodAddr.
	for i := 0; i < 20; i++ {
		p, ok := tr.pick()
		if !ok {
			t.Fatal("pick() returned !ok unexpectedly")
		}
		if p.addr == badAddr {
			t.Errorf("pick() returned bad proxy with score < 0.2 on iteration %d", i)
		}
	}
}

// TestPickFallsBackToAllWhenAllScoreLow verifies fallback to full pool when every
// proxy is below the 0.2 threshold (better than returning no proxy at all).
func TestPickFallsBackToAllWhenAllScoreLow(t *testing.T) {
	resetGlobalProxyStats()
	addr1 := "low1:1080"
	addr2 := "low2:1080"

	for _, a := range []string{addr1, addr2} {
		for i := 0; i < 9; i++ {
			RecordProxyResult(a, false)
		}
		RecordProxyResult(a, true)
	}

	tr := &RotatingProxyTransport{
		working: []proxyEntry{
			{addr: addr1},
			{addr: addr2},
		},
	}

	// Should still return *a* proxy (not !ok) even though both are low.
	p, ok := tr.pick()
	if !ok {
		t.Fatal("pick() returned !ok even with fallback to full pool")
	}
	if p.addr != addr1 && p.addr != addr2 {
		t.Errorf("unexpected proxy addr from fallback: %s", p.addr)
	}
}

// TestPickEmptyPoolReturnsFalse verifies pick() returns !ok on empty pool.
func TestPickEmptyPoolReturnsFalse(t *testing.T) {
	resetGlobalProxyStats()
	tr := &RotatingProxyTransport{}
	_, ok := tr.pick()
	if ok {
		t.Fatal("expected !ok on empty pool")
	}
}

// TestRecordProxyResult_ConcurrentNoRace fires many goroutines recording results
// for the same and different addresses. Run with -race flag.
func TestRecordProxyResult_ConcurrentNoRace(t *testing.T) {
	resetGlobalProxyStats()
	addrs := []string{"r1:1080", "r2:1080", "r3:1080"}

	var wg sync.WaitGroup
	for _, a := range addrs {
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func(addr string, ok bool) {
				defer wg.Done()
				RecordProxyResult(addr, ok)
			}(a, i%2 == 0)
		}
	}
	wg.Wait()

	for _, a := range addrs {
		score := ProxyScore(a)
		if score < 0 || score > 1 {
			t.Errorf("addr %s: score %f out of range", a, score)
		}
	}
}

// TestProxyScore_ZeroTotalWithExistingEntry covers the total==0 branch in ProxyScore.
// This can happen if an entry was pre-inserted with no recorded results.
func TestProxyScore_ZeroTotalWithExistingEntry(t *testing.T) {
	resetGlobalProxyStats()
	addr := "zero-total:1080"

	// Directly inject an empty entry to simulate the zero-total state.
	// This is the only way to reach total==0 branch after entry creation.
	globalProxyStats.mu.Lock()
	globalProxyStats.entries[addr] = &proxyStatEntry{}
	globalProxyStats.mu.Unlock()

	score := ProxyScore(addr)
	if score != 0.5 {
		t.Fatalf("expected 0.5 for entry with total==0, got %f", score)
	}
}

// TestProxyScore_MonkeyHighCounters verifies score calculation stays in [0,1]
// with very large counter values (overflow protection check).
func TestProxyScore_MonkeyHighCounters(t *testing.T) {
	resetGlobalProxyStats()
	addr := "overflow-check:1080"

	// Record a large number of successes and failures.
	for i := 0; i < 1000; i++ {
		RecordProxyResult(addr, i%3 != 0) // 2/3 successes, 1/3 failures
	}

	score := ProxyScore(addr)
	if score < 0.0 || score > 1.0 {
		t.Fatalf("ProxyScore out of range [0,1]: %f", score)
	}
	// With 2/3 success rate score should be close to 0.667.
	if score < 0.6 || score > 0.75 {
		t.Errorf("expected score near 0.667, got %f", score)
	}
}

// TestProxyScore_AllFailures verifies 100% failure rate returns 0.0.
func TestProxyScore_AllFailures(t *testing.T) {
	resetGlobalProxyStats()
	addr := "all-fail:1080"
	for i := 0; i < 10; i++ {
		RecordProxyResult(addr, false)
	}
	score := ProxyScore(addr)
	if score != 0.0 {
		t.Fatalf("expected 0.0 for 10 failures, got %f", score)
	}
}

// TestRecordProxyResult_MonkeyDifferentAddrs verifies no panic with varied addr strings.
func TestRecordProxyResult_MonkeyDifferentAddrs(t *testing.T) {
	resetGlobalProxyStats()
	weird := []string{
		"",
		"noport",
		"::1:9050",
		"a-very-long-hostname-that-should-still-work.example.com:65535",
		"256.256.256.256:1234",
	}
	for _, addr := range weird {
		// Must not panic.
		RecordProxyResult(addr, true)
		RecordProxyResult(addr, false)
		_ = ProxyScore(addr)
	}
}
