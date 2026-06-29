package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// P2 FIX: Test rate limit on /v1/imap-socks-addr
func TestImapSocksAddrRateLimit(t *testing.T) {
	// Create fresh limiter for this test
	limiter := newIPRateLimiter(5, 60*time.Second) // 5 per minute

	// First 5 from same IP should pass
	for i := 0; i < 5; i++ {
		if !limiter.Allow("127.0.0.1") {
			t.Fatalf("request %d should have been allowed", i+1)
		}
	}

	// 6th should fail
	if limiter.Allow("127.0.0.1") {
		t.Fatalf("request 6 should have been rejected (rate limit)")
	}

	// Different IP should pass (separate bucket)
	if !limiter.Allow("127.0.0.2") {
		t.Fatalf("different IP should have separate limit")
	}
}

func TestImapSocksAddrRateLimitWindow(t *testing.T) {
	// Create limiter with very short window for testing
	limiter := newIPRateLimiter(2, 100*time.Millisecond)

	ip := "192.168.1.1"

	// First 2 should pass
	if !limiter.Allow(ip) || !limiter.Allow(ip) {
		t.Fatalf("first 2 requests should pass")
	}

	// 3rd should fail
	if limiter.Allow(ip) {
		t.Fatalf("3rd request should fail (at limit)")
	}

	// Wait for window to expire
	time.Sleep(150 * time.Millisecond)

	// Should pass again (window cleared)
	if !limiter.Allow(ip) {
		t.Fatalf("request after window expiry should pass")
	}
}

func TestImapSocksAddrEndpoint(t *testing.T) {
	server := &Server{
		fallbackProxyAddr: "127.0.0.1:1080",
	}

	// Reset global limiter for test
	imapSocksAddrLimiter = newIPRateLimiter(3, 60*time.Second)

	req := httptest.NewRequest("GET", "/v1/imap-socks-addr", nil)
	w := httptest.NewRecorder()

	// First 3 requests succeed
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "/v1/imap-socks-addr", nil)
		req.RemoteAddr = "10.0.0.1:54321"
		w := httptest.NewRecorder()
		server.handleImapSocksAddr(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("request %d should succeed, got %d", i+1, w.Code)
		}
	}

	// 4th request from same IP should be rate-limited
	req = httptest.NewRequest("GET", "/v1/imap-socks-addr", nil)
	req.RemoteAddr = "10.0.0.1:54321"
	w = httptest.NewRecorder()
	server.handleImapSocksAddr(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("4th request should be rate-limited, got %d", w.Code)
	}

	// Different IP should succeed
	req = httptest.NewRequest("GET", "/v1/imap-socks-addr", nil)
	req.RemoteAddr = "10.0.0.2:54321"
	w = httptest.NewRecorder()
	server.handleImapSocksAddr(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("different IP should succeed, got %d", w.Code)
	}
}
