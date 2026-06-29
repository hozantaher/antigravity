package web

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// passThrough is a noop handler that records each invocation count.
func passThrough(counter *int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(counter, 1)
		w.WriteHeader(http.StatusOK)
	}
}

// makeReq builds an httptest request with RemoteAddr set.
func makeReq(method, ip string) *http.Request {
	req := httptest.NewRequest(method, "/api/campaigns", nil)
	req.RemoteAddr = ip + ":12345"
	return req
}

// 1. Basic burst exhaustion: with rate=10/s, burst=30, 31st request
//    inside one second is rejected with 429.
func TestStateLimiter_BurstExhaustion(t *testing.T) {
	l := newStateLimiter(10, 30, 1000, time.Hour)
	t.Cleanup(l.stop)

	for i := 0; i < 30; i++ {
		if !l.allow("198.51.100.1") {
			t.Fatalf("burst slot %d should be allowed", i+1)
		}
	}
	if l.allow("198.51.100.1") {
		t.Errorf("31st request inside one second should be denied")
	}
}

// 2. Retry-After header is set on rejection.
func TestRateLimitState_SetsRetryAfter(t *testing.T) {
	l := newStateLimiter(10, 1, 100, time.Hour)
	t.Cleanup(l.stop)

	var hits int64
	h := RateLimitState(l, passThrough(&hits))

	// First fills the bucket.
	rec1 := httptest.NewRecorder()
	h(rec1, makeReq(http.MethodPost, "203.0.113.10"))
	if rec1.Code != http.StatusOK {
		t.Fatalf("first request status = %d, want 200", rec1.Code)
	}

	rec2 := httptest.NewRecorder()
	h(rec2, makeReq(http.MethodPost, "203.0.113.10"))
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("second request status = %d, want 429", rec2.Code)
	}
	if got := rec2.Header().Get("Retry-After"); got != "1" {
		t.Errorf("Retry-After = %q, want %q", got, "1")
	}
	if ct := rec2.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if body := rec2.Body.String(); body != `{"error":"rate_limited"}` {
		t.Errorf("body = %q, want JSON rate_limited", body)
	}
}

// 3. Per-IP isolation: exhausting IP1 must not affect IP2.
func TestStateLimiter_PerIPIsolation(t *testing.T) {
	l := newStateLimiter(1, 5, 100, time.Hour)
	t.Cleanup(l.stop)

	for i := 0; i < 5; i++ {
		l.allow("10.0.0.1")
	}
	if l.allow("10.0.0.1") {
		t.Error("10.0.0.1 should be exhausted")
	}
	if !l.allow("10.0.0.2") {
		t.Error("10.0.0.2 should still be allowed (separate bucket)")
	}
}

// 4. Burst window: exactly burst requests pass, the next one fails.
//    Tests the inclusive boundary at b.tokens >= 1.
func TestStateLimiter_BoundaryBurst(t *testing.T) {
	l := newStateLimiter(10, 30, 100, time.Hour)
	t.Cleanup(l.stop)

	allowed := 0
	for i := 0; i < 31; i++ {
		if l.allow("192.0.2.50") {
			allowed++
		}
	}
	if allowed != 30 {
		t.Errorf("allowed = %d in 31 immediate calls, want 30", allowed)
	}
}

// 5. X-Forwarded-For header is respected (Railway proxy provides it).
func TestRateLimitState_XForwardedForRespected(t *testing.T) {
	l := newStateLimiter(10, 1, 100, time.Hour)
	t.Cleanup(l.stop)

	var hits int64
	h := RateLimitState(l, passThrough(&hits))

	// Two distinct XFFs should both be allowed once even when
	// RemoteAddr is identical (i.e., same upstream proxy).
	rec1 := httptest.NewRecorder()
	r1 := httptest.NewRequest(http.MethodPost, "/api/campaigns", nil)
	r1.RemoteAddr = "127.0.0.1:0"
	r1.Header.Set("X-Forwarded-For", "198.51.100.10")
	h(rec1, r1)

	rec2 := httptest.NewRecorder()
	r2 := httptest.NewRequest(http.MethodPost, "/api/campaigns", nil)
	r2.RemoteAddr = "127.0.0.1:0"
	r2.Header.Set("X-Forwarded-For", "198.51.100.20")
	h(rec2, r2)

	if rec1.Code != http.StatusOK || rec2.Code != http.StatusOK {
		t.Errorf("two distinct XFF IPs should both be allowed; got %d, %d", rec1.Code, rec2.Code)
	}
	if got := atomic.LoadInt64(&hits); got != 2 {
		t.Errorf("handler hits = %d, want 2", got)
	}

	// Repeat with the same XFF — bucket=1 → second is rejected.
	rec3 := httptest.NewRecorder()
	r3 := httptest.NewRequest(http.MethodPost, "/api/campaigns", nil)
	r3.RemoteAddr = "127.0.0.1:0"
	r3.Header.Set("X-Forwarded-For", "198.51.100.10")
	h(rec3, r3)
	if rec3.Code != http.StatusTooManyRequests {
		t.Errorf("second request from same XFF should be 429, got %d", rec3.Code)
	}
}

// 6. methodGuardedRateLimit lets GET requests bypass the limiter
//    even when the bucket is exhausted.
func TestMethodGuardedRateLimit_GetBypasses(t *testing.T) {
	l := newStateLimiter(10, 1, 100, time.Hour)
	t.Cleanup(l.stop)

	// Exhaust the bucket via a POST first.
	if !l.allow("203.0.113.42") {
		t.Fatal("setup: first allow must succeed")
	}
	if l.allow("203.0.113.42") {
		t.Fatal("setup: bucket should be exhausted")
	}

	var hits int64
	h := methodGuardedRateLimit(l, passThrough(&hits))

	// 100 GETs should all pass — bucket is bypassed for GET.
	for i := 0; i < 100; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/campaigns", nil)
		req.RemoteAddr = "203.0.113.42:9999"
		h(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET #%d should bypass rate limit, got %d", i+1, rec.Code)
		}
	}
	if got := atomic.LoadInt64(&hits); got != 100 {
		t.Errorf("GET hits = %d, want 100", got)
	}

	// But POST is still gated and should now hit 429.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", nil)
	req.RemoteAddr = "203.0.113.42:9999"
	h(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("POST after exhaustion should be 429, got %d", rec.Code)
	}
}

// 7. Concurrent allow() calls under -race must produce a consistent
//    permitted-count equal to burst.
func TestStateLimiter_ConcurrentAllow(t *testing.T) {
	l := newStateLimiter(0.001, 100, 1000, time.Hour) // refill ~0 over test
	t.Cleanup(l.stop)

	var wg sync.WaitGroup
	var allowed int64
	const goroutines = 64
	const perGoroutine = 50 // total 3200 attempts vs burst=100

	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < perGoroutine; j++ {
				if l.allow("100.64.0.1") {
					atomic.AddInt64(&allowed, 1)
				}
			}
		}()
	}
	wg.Wait()

	// With burst=100 and ~0 refill, exactly 100 requests should pass.
	if got := atomic.LoadInt64(&allowed); got != 100 {
		t.Errorf("concurrent allowed = %d, want 100 (burst)", got)
	}
}

// 8. LRU eviction: when more than maxIPs unique IPs request, the
//    oldest bucket is dropped to keep the cap.
func TestStateLimiter_LRUEvictionAtCap(t *testing.T) {
	const cap_ = 5
	l := newStateLimiter(10, 30, cap_, time.Hour)
	t.Cleanup(l.stop)

	// Insert cap+3 distinct IPs.
	for i := 0; i < cap_+3; i++ {
		ip := "198.51.100." + itoa(i)
		if !l.allow(ip) {
			t.Fatalf("first allow for %s should succeed", ip)
		}
	}

	l.mu.Lock()
	got := len(l.buckets)
	l.mu.Unlock()
	if got != cap_ {
		t.Errorf("buckets after %d inserts = %d, want %d (capped)", cap_+3, got, cap_)
	}
}

// 9. Zero-port / no-port RemoteAddr edge: remoteIP must not panic and
//    the bucket must still be accessible.
func TestRateLimitState_ZeroIPEdge(t *testing.T) {
	l := newStateLimiter(10, 5, 100, time.Hour)
	t.Cleanup(l.stop)

	var hits int64
	h := RateLimitState(l, passThrough(&hits))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", nil)
	req.RemoteAddr = "" // edge: no remote address at all
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("empty RemoteAddr should not panic and should be allowed; got %d", rec.Code)
	}
}

// 10. Recovery after cooldown: an exhausted bucket admits new
//     requests once enough wall-clock time has passed for the
//     refill to credit at least one token.
func TestStateLimiter_RecoveryAfterCooldown(t *testing.T) {
	// rate=200/s → 1 token credited every 5ms. burst=2.
	l := newStateLimiter(200, 2, 100, time.Hour)
	t.Cleanup(l.stop)

	// Exhaust.
	if !l.allow("192.0.2.99") {
		t.Fatal("token 1")
	}
	if !l.allow("192.0.2.99") {
		t.Fatal("token 2")
	}
	if l.allow("192.0.2.99") {
		t.Fatal("third must be denied (bucket empty)")
	}

	// Wait for refill (~10ms credits 2 tokens).
	time.Sleep(20 * time.Millisecond)
	if !l.allow("192.0.2.99") {
		t.Error("after cooldown, request should be admitted")
	}
}

// 11. Default-limiter sustained rate: at 10 req/s after a fresh
//     bucket is exhausted, a request after 110 ms gets refilled.
func TestStateLimiter_SustainedRefillRate(t *testing.T) {
	l := newStateLimiter(10, 5, 100, time.Hour)
	t.Cleanup(l.stop)

	for i := 0; i < 5; i++ {
		l.allow("198.51.100.200")
	}
	if l.allow("198.51.100.200") {
		t.Fatal("bucket should be empty after 5 burst")
	}

	// 10 req/s = 1 token / 100ms. 110ms is enough for 1 token.
	time.Sleep(110 * time.Millisecond)
	if !l.allow("198.51.100.200") {
		t.Error("after 110ms at 10/s rate, expected refill of >= 1 token")
	}
}

// 12. envFloat / envInt fallback paths cover the override surface
//     without setting OS env. Ensures default constants survive.
func TestStateLimiterFromEnv_DefaultsApply(t *testing.T) {
	// No env vars set in test → defaults must apply (10/s, burst 30,
	// maxIPs 10000, ttl 1h).
	l := stateLimiterFromEnv()
	t.Cleanup(l.stop)

	if l.rate != 10 {
		t.Errorf("default rate = %v, want 10", l.rate)
	}
	if l.burst != 30 {
		t.Errorf("default burst = %v, want 30", l.burst)
	}
	if l.maxIPs != 10000 {
		t.Errorf("default maxIPs = %d, want 10000", l.maxIPs)
	}
	if l.ttl != time.Hour {
		t.Errorf("default ttl = %v, want 1h", l.ttl)
	}
}

// itoa is a tiny strconv-free integer formatter used to keep this
// test file's imports minimal.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
