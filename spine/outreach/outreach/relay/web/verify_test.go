package web

// verify_test.go — comprehensive tests for the /v1/verify SMTP RCPT-TO probe (R6).
//
// All network I/O is stubbed via injectable package-level vars:
//   - verifyLookupMX  — controls MX lookup results
//   - smtpRCPTProbe   — controls SMTP probe results
//   - verifyMXGate    — replaced per test to bypass rate limiting
//
// Tests are isolated: each restores the original var via t.Cleanup.

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"relay/internal/transport"
)

// ─── helpers ──────────────────────────────────────────────────────────────

// stubMX returns a verifyLookupMX stub that always gives the supplied MX records.
func stubMX(records []*net.MX) func(ctx context.Context, domain string) ([]*net.MX, error) {
	return func(_ context.Context, _ string) ([]*net.MX, error) {
		return records, nil
	}
}

// noMX returns a verifyLookupMX stub that always returns empty records.
func noMX() func(ctx context.Context, domain string) ([]*net.MX, error) {
	return stubMX(nil)
}

// singleMX is a shortcut for one MX entry.
func singleMX(host string) []*net.MX {
	return []*net.MX{{Host: host, Pref: 10}}
}

// stubProbe returns a smtpRCPTProbe stub that returns canned (code, reason) per call.
// probeResults[0] = canary probe, probeResults[1] = real probe.
func stubProbe(probeResults ...struct{ code int; reason string }) func(ctx context.Context, socksAddr, mxHost, recipient string) (int, string) {
	i := 0
	return func(_ context.Context, _, _, _ string) (int, string) {
		if i >= len(probeResults) {
			return 0, "no more stub results"
		}
		r := probeResults[i]
		i++
		return r.code, r.reason
	}
}

// passRateGate replaces verifyMXGate with one that always allows (spacing=0).
func passRateGate() *mxRateLimiter { return newMXRateLimiter(0) }

// verifyPOST fires POST /v1/verify with the given email via the test server.
func verifyPOST(t *testing.T, srv *Server, token, email string) verifyResponse {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email})
	req := httptest.NewRequest("POST", "/v1/verify", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("HTTP %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp verifyResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

// ─── test 1: syntax invalid → 400 ────────────────────────────────────────

func TestVerify_SyntaxInvalid_400(t *testing.T) {
	srv, token := testServer(t)
	srv.WithVerifyEnabled(true)
	handler := srv.Handler()

	cases := []string{"notanemail", "@nodomain", "local@", ""}
	for _, email := range cases {
		body := `{"email":"` + email + `"}`
		if email == "" {
			body = `{}` // trigger missing-email path
		}
		req := httptest.NewRequest("POST", "/v1/verify", bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		if email == "" {
			if rr.Code != http.StatusBadRequest {
				t.Errorf("empty email: got %d want 400", rr.Code)
			}
			continue
		}
		// Non-empty but syntactically bad → 200 with status=invalid
		if rr.Code != http.StatusOK {
			t.Errorf("email=%q: got %d want 200", email, rr.Code)
			continue
		}
		var resp verifyResponse
		if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
			t.Fatal(err)
		}
		if resp.Status != "invalid" {
			t.Errorf("email=%q: got status=%q want invalid", email, resp.Status)
		}
	}
}

// ─── test 2: VERIFY_EMAIL_ENABLED=false → unknown stub ───────────────────

func TestVerify_DisabledReturnsUnknown(t *testing.T) {
	srv, token := testServer(t)
	// verifyEnabled defaults to false in testServer
	resp := verifyPOST(t, srv, token, "user@example.com")
	if resp.Status != "unknown" {
		t.Errorf("got %q want unknown", resp.Status)
	}
	if resp.Reason == "" {
		t.Error("reason must explain disabled state")
	}
}

// ─── test 3: domain has no MX → invalid ──────────────────────────────────

func TestVerify_NoMX_ReturnsInvalid(t *testing.T) {
	orig := verifyLookupMX
	verifyLookupMX = noMX()
	t.Cleanup(func() { verifyLookupMX = orig })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true).WithFallbackProxyAddr("127.0.0.1:1080")

	resp := verifyPOST(t, srv, token, "user@nodomain.invalid")
	if resp.Status != "invalid" {
		t.Errorf("got %q want invalid", resp.Status)
	}
}

// ─── test 4: happy path 250 → valid ──────────────────────────────────────

func TestVerify_HappyPath_250_Valid(t *testing.T) {
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	// canary → 550 (not catch-all), real → 250 (exists)
	smtpRCPTProbe = stubProbe(
		struct{ code int; reason string }{550, "550 5.1.1 user unknown"},
		struct{ code int; reason string }{250, "accepted"},
	)
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true).WithFallbackProxyAddr("127.0.0.1:1080")

	resp := verifyPOST(t, srv, token, "user@example.com")
	if resp.Status != "valid" {
		t.Errorf("got %q want valid", resp.Status)
	}
	if resp.Code != 250 {
		t.Errorf("code: got %d want 250", resp.Code)
	}
}

// ─── test 5: 550 mailbox unknown → invalid ───────────────────────────────

func TestVerify_550_MailboxUnknown_Invalid(t *testing.T) {
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	smtpRCPTProbe = stubProbe(
		struct{ code int; reason string }{550, "550 5.1.1 user unknown"},
		struct{ code int; reason string }{550, "550 5.1.1 user unknown"},
	)
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true).WithFallbackProxyAddr("127.0.0.1:1080")

	resp := verifyPOST(t, srv, token, "nobody@example.com")
	if resp.Status != "invalid" {
		t.Errorf("got %q want invalid", resp.Status)
	}
	if resp.Code != 550 {
		t.Errorf("code: got %d want 550", resp.Code)
	}
}

// ─── test 6: 4xx greylist → unknown ──────────────────────────────────────

func TestVerify_4xx_Greylisted_Unknown(t *testing.T) {
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	smtpRCPTProbe = stubProbe(
		struct{ code int; reason string }{452, "452 too many recipients"},
		struct{ code int; reason string }{452, "452 try again"},
	)
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true).WithFallbackProxyAddr("127.0.0.1:1080")

	resp := verifyPOST(t, srv, token, "user@example.com")
	if resp.Status != "unknown" {
		t.Errorf("got %q want unknown", resp.Status)
	}
	if resp.Code != 452 {
		t.Errorf("code: got %d want 452", resp.Code)
	}
}

// ─── test 7: catch-all detection ─────────────────────────────────────────

func TestVerify_CatchAll_Detection(t *testing.T) {
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	// canary gets 250 → catch-all; second probe would be skipped
	smtpRCPTProbe = stubProbe(
		struct{ code int; reason string }{250, "accepted"},
	)
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true).WithFallbackProxyAddr("127.0.0.1:1080")

	resp := verifyPOST(t, srv, token, "real@catchall.example.com")
	if resp.Status != "catch_all" {
		t.Errorf("got %q want catch_all", resp.Status)
	}
	if resp.Code != 250 {
		t.Errorf("code: got %d want 250", resp.Code)
	}
}

// ─── test 8: TCP connection failure → unknown ─────────────────────────────

func TestVerify_TCPFail_Unknown(t *testing.T) {
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	smtpRCPTProbe = stubProbe(
		struct{ code int; reason string }{0, "connection failed: connection refused"},
		struct{ code int; reason string }{0, "connection failed: connection refused"},
	)
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true).WithFallbackProxyAddr("127.0.0.1:1080")

	resp := verifyPOST(t, srv, token, "user@example.com")
	if resp.Status != "unknown" {
		t.Errorf("got %q want unknown", resp.Status)
	}
}

// ─── test 9: no SOCKS5 proxy configured → unknown ────────────────────────

func TestVerify_NoProxy_Unknown(t *testing.T) {
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true)
	// No proxy pool, no fallback → verifySocksAddr returns ""

	resp := verifyPOST(t, srv, token, "user@example.com")
	if resp.Status != "unknown" {
		t.Errorf("got %q want unknown (no proxy)", resp.Status)
	}
}

// ─── test 10: rate limit (second probe same MX rapid) → unknown ──────────

func TestVerify_RateLimit_SecondProbeBlocked(t *testing.T) {
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx.ratelimit.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	smtpRCPTProbe = stubProbe(
		struct{ code int; reason string }{550, "canary rejected"},
		struct{ code int; reason string }{250, "accepted"},
		struct{ code int; reason string }{550, "canary rejected"},
		struct{ code int; reason string }{250, "accepted"},
	)
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	// Use real rate gate with a very long spacing so second probe is blocked.
	origGate := verifyMXGate
	verifyMXGate = newMXRateLimiter(24 * time.Hour)
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true).WithFallbackProxyAddr("127.0.0.1:1080")

	// First probe: allowed (consumes the gate slot).
	resp1 := verifyPOST(t, srv, token, "user@ratelimit.example.com")
	if resp1.Status != "valid" {
		t.Errorf("first probe: got %q want valid", resp1.Status)
	}

	// Second probe immediately: rate-limited → unknown.
	resp2 := verifyPOST(t, srv, token, "other@ratelimit.example.com")
	if resp2.Status != "unknown" {
		t.Errorf("second probe: got %q want unknown (rate limited)", resp2.Status)
	}
}

// ─── test 11: MX sorted by priority — lowest pref wins ───────────────────

func TestVerify_MXSortedByPriority(t *testing.T) {
	var dialedMX string
	origMX := verifyLookupMX
	verifyLookupMX = func(_ context.Context, _ string) ([]*net.MX, error) {
		// Higher pref = lower priority; return in reverse order to verify sorting.
		return []*net.MX{
			{Host: "mx10.example.com.", Pref: 10},
			{Host: "mx5.example.com.", Pref: 5},  // ← should win
			{Host: "mx20.example.com.", Pref: 20},
		}, nil
	}
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	smtpRCPTProbe = func(_ context.Context, _, mxHost, _ string) (int, string) {
		dialedMX = mxHost
		return 550, "user unknown"
	}
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true).WithFallbackProxyAddr("127.0.0.1:1080")

	verifyPOST(t, srv, token, "user@example.com")

	// The first MX dialed should be the one with lowest Pref (5), with trailing dot stripped.
	if dialedMX != "mx5.example.com" {
		t.Errorf("dialed MX=%q want mx5.example.com", dialedMX)
	}
}

// ─── test 12: extractSMTPCode ─────────────────────────────────────────────

func TestExtractSMTPCode(t *testing.T) {
	cases := []struct {
		msg  string
		want int
	}{
		{"550 5.1.1 user unknown", 550},
		{"250 OK", 250},
		{"452 too many", 452},
		{"221 bye", 221},
		{"", 0},
		{"abc", 0},
		{"99 short", 0},   // 2 digits only
		{"1000 too long", 100}, // 4-char string: first 3 digits = "100", valid range 100-599
		{"xyz bad", 0},
	}
	for _, c := range cases {
		got := extractSMTPCode(c.msg)
		if got != c.want {
			t.Errorf("extractSMTPCode(%q) = %d, want %d", c.msg, got, c.want)
		}
	}
}

// ─── test 13: direct egress — proxy pool is NOT used (VERIFY_VIA_DIRECT_EGRESS=true, default) ──

func TestVerify_UsesProxyPool_WhenNoFallback(t *testing.T) {
	// When VERIFY_VIA_DIRECT_EGRESS=true (default), the verify probe bypasses
	// the SOCKS5/wgsocks pool entirely and uses Railway native egress.
	// smtpRCPTProbe must receive an empty socksAddr regardless of pool state.
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "true")

	var dialedProxy string
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	smtpRCPTProbe = func(_ context.Context, socksAddr, _, _ string) (int, string) {
		dialedProxy = socksAddr
		return 550, "user unknown"
	}
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true)
	// Pool is wired but must NOT be consulted when direct egress is on.
	srv.WithProxyPool(&fakePool{
		snap: transport.PoolSnapshot{
			Working: []transport.PoolEntry{{Addr: "127.0.0.1:9999", Latency: time.Millisecond}},
		},
	})

	verifyPOST(t, srv, token, "user@example.com")
	if dialedProxy != "" {
		t.Errorf("direct egress: socksAddr must be empty, got %q", dialedProxy)
	}
}

// ─── test 13b: legacy SOCKS path — pool IS used when direct egress disabled ──

func TestVerify_UsesProxyPool_WhenDirectEgressDisabled(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "false")

	var dialedProxy string
	origMX := verifyLookupMX
	verifyLookupMX = stubMX(singleMX("mx-13b.example.com"))
	t.Cleanup(func() { verifyLookupMX = origMX })

	origProbe := smtpRCPTProbe
	smtpRCPTProbe = func(_ context.Context, socksAddr, _, _ string) (int, string) {
		dialedProxy = socksAddr
		return 550, "user unknown"
	}
	t.Cleanup(func() { smtpRCPTProbe = origProbe })

	origGate := verifyMXGate
	verifyMXGate = passRateGate()
	t.Cleanup(func() { verifyMXGate = origGate })

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true)
	srv.WithProxyPool(&fakePool{
		snap: transport.PoolSnapshot{
			Working: []transport.PoolEntry{{Addr: "127.0.0.1:9999", Latency: time.Millisecond}},
		},
	})

	verifyPOST(t, srv, token, "user@legacy-socks.com")
	if dialedProxy != "127.0.0.1:9999" {
		t.Errorf("legacy SOCKS: proxy addr got %q want 127.0.0.1:9999", dialedProxy)
	}
}

// ─── test 14: method guard ────────────────────────────────────────────────

func TestVerify_GetMethodNotAllowed(t *testing.T) {
	srv, token := testServer(t)
	req := httptest.NewRequest("GET", "/v1/verify", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("got %d want 405", rr.Code)
	}
}

// ─── test 15: mxRateLimiter Allow / block ────────────────────────────────

func TestMXRateLimiter_AllowAndBlock(t *testing.T) {
	rl := newMXRateLimiter(100 * time.Millisecond)

	if !rl.Allow("mx.example.com") {
		t.Fatal("first allow should succeed")
	}
	if rl.Allow("mx.example.com") {
		t.Fatal("second allow within spacing should be blocked")
	}

	// Different host should be independent.
	if !rl.Allow("mx.other.com") {
		t.Fatal("different host should not be rate-limited")
	}
}
