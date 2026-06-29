package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestIPLimiter_Allow_UnderLimit verifies requests are allowed below the max.
func TestIPLimiter_Allow_UnderLimit(t *testing.T) {
	l := newIPLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if !l.allow("1.2.3.4") {
			t.Fatalf("request %d should be allowed", i+1)
		}
	}
}

// TestIPLimiter_Allow_ExceedsLimit verifies the 4th request is blocked.
func TestIPLimiter_Allow_ExceedsLimit(t *testing.T) {
	l := newIPLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		l.allow("1.2.3.4")
	}
	if l.allow("1.2.3.4") {
		t.Error("4th request should be denied")
	}
}

// TestIPLimiter_Allow_DifferentIPs verifies IPs are tracked independently.
func TestIPLimiter_Allow_DifferentIPs(t *testing.T) {
	l := newIPLimiter(1, time.Minute)
	l.allow("10.0.0.1") // exhaust limit for 10.0.0.1
	if !l.allow("10.0.0.2") {
		t.Error("different IP should still be allowed")
	}
}

// TestIPLimiter_Evict_ClearsStaleEntries exercises the evict goroutine by
// using a very short window and verifying the IP entry is removed.
func TestIPLimiter_Evict_ClearsStaleEntries(t *testing.T) {
	window := 40 * time.Millisecond
	l := newIPLimiter(5, window)

	l.allow("9.9.9.9") // add an entry

	// Wait long enough for two evict ticks (evict runs on window ticker).
	time.Sleep(3 * window)

	l.mu.Lock()
	_, exists := l.requests["9.9.9.9"]
	l.mu.Unlock()

	if exists {
		t.Error("stale IP entry should have been evicted")
	}
}

// TestRateLimited_Allowed exercises the "permit" path in the middleware.
func TestRateLimited_Allowed(t *testing.T) {
	l := newIPLimiter(10, time.Minute)
	handler := rateLimited(l, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	handler(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("code = %d, want 200", rec.Code)
	}
}

// TestRateLimited_Blocked exercises the 429 path.
func TestRateLimited_Blocked(t *testing.T) {
	l := newIPLimiter(1, time.Minute)
	l.allow("10.0.0.2") // exhaust the single slot

	handler := rateLimited(l, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.2:1234"
	handler(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("code = %d, want 429", rec.Code)
	}
}
