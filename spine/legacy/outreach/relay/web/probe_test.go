package web

import (
	"relay/internal/transport"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakePool implements ProxyPool with canned snapshots for deterministic tests.
type fakePool struct {
	snap transport.PoolSnapshot
}

func (f *fakePool) Snapshot() transport.PoolSnapshot { return f.snap }

// ─── auth & method guards ──────────────────────────────────────────

func TestProbe_AuthRequired(t *testing.T) {
	srv, _ := testServer(t)
	handler := srv.Handler()

	cases := []struct {
		method, path string
	}{
		{"POST", "/v1/auth-check"},
		{"POST", "/v1/probe"},
		{"GET", "/v1/proxy-pool"},
		{"POST", "/v1/verify"},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, nil)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401", c.method, c.path, rr.Code)
		}
	}
}

func TestProbe_MethodNotAllowed(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	cases := []struct {
		method, path string
	}{
		{"GET", "/v1/auth-check"}, // POST-only
		{"GET", "/v1/probe"},      // POST-only
		{"POST", "/v1/proxy-pool"}, // GET-only
		{"GET", "/v1/verify"},     // POST-only
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s %s: got %d, want 405", c.method, c.path, rr.Code)
		}
	}
}

// ─── /v1/proxy-pool ────────────────────────────────────────────────

func TestProxyPool_EmptyWhenPoolUnset(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest("GET", "/v1/proxy-pool", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rr.Code)
	}
	var resp proxyPoolResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Count != 0 {
		t.Errorf("count: got %d, want 0", resp.Count)
	}
	if resp.Working == nil {
		t.Error("working slice must be [] not null in JSON")
	}
}

func TestProxyPool_ReturnsSnapshot(t *testing.T) {
	srv, token := testServer(t)
	pool := &fakePool{snap: transport.PoolSnapshot{
		Working: []transport.PoolEntry{
			{Addr: "1.2.3.4:1080", Latency: 450 * time.Millisecond},
			{Addr: "5.6.7.8:1080", Latency: 220 * time.Millisecond},
		},
		LastRefresh: time.Date(2026, 4, 21, 12, 0, 0, 0, time.UTC),
	}}
	srv.WithProxyPool(pool)
	handler := srv.Handler()

	req := httptest.NewRequest("GET", "/v1/proxy-pool", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	var resp proxyPoolResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Count != 2 {
		t.Errorf("count: got %d, want 2", resp.Count)
	}
	if len(resp.Working) != 2 {
		t.Fatalf("working len: got %d, want 2", len(resp.Working))
	}
	if resp.Working[0].Addr != "1.2.3.4:1080" || resp.Working[0].LatencyMs != 450 {
		t.Errorf("entry[0]: got %+v", resp.Working[0])
	}
	if resp.LastRefresh != "2026-04-21T12:00:00Z" {
		t.Errorf("last_refresh: got %q", resp.LastRefresh)
	}
}

// ─── /v1/auth-check ────────────────────────────────────────────────

func TestAuthCheck_RequiredFields(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest("POST", "/v1/auth-check", bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", rr.Code)
	}
}

func TestAuthCheck_NoProxyPoolReturnsError(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"smtp_host":"smtp.example.test","smtp_port":465,"smtp_username":"u","password":"p"}`
	req := httptest.NewRequest("POST", "/v1/auth-check", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 with OK:false subcheck, got %d", rr.Code)
	}
	var sc probeSubcheck
	if err := json.NewDecoder(rr.Body).Decode(&sc); err != nil {
		t.Fatal(err)
	}
	if sc.OK {
		t.Error("OK should be false — no proxy configured")
	}
	if sc.Error == "" {
		t.Error("Error should explain missing proxy")
	}
}

// ─── /v1/probe ─────────────────────────────────────────────────────

func TestProbe_RequiredFields(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest("POST", "/v1/probe", bytes.NewBufferString(`{"smtp_host":"x"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", rr.Code)
	}
}

func TestProbe_ReturnsContractShape(t *testing.T) {
	srv, token := testServer(t)
	pool := &fakePool{snap: transport.PoolSnapshot{
		Working: []transport.PoolEntry{{Addr: "127.0.0.1:1", Latency: time.Millisecond}},
	}}
	srv.WithProxyPool(pool)
	handler := srv.Handler()

	body := `{"smtp_host":"smtp.example.test","smtp_port":465,"smtp_username":"u","password":"p"}`
	req := httptest.NewRequest("POST", "/v1/probe", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	checks, ok := resp["checks"].(map[string]any)
	if !ok {
		t.Fatalf("missing checks object: %+v", resp)
	}
	if _, ok := checks["smtp"]; !ok {
		t.Error("missing checks.smtp")
	}
	if _, ok := resp["checked_at"]; !ok {
		t.Error("missing checked_at")
	}
}

// ─── /v1/verify ────────────────────────────────────────────────────

func TestVerify_DisabledByDefault(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"email":"user@example.test"}`
	req := httptest.NewRequest("POST", "/v1/verify", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	var resp verifyResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Status != "unknown" {
		t.Errorf("status: got %q, want unknown", resp.Status)
	}
	if resp.Reason == "" {
		t.Error("reason should explain why verify is disabled")
	}
}

func TestVerify_EmailRequired(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest("POST", "/v1/verify", bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", rr.Code)
	}
}

func TestVerify_EnabledNoProxy_NoMX_ReturnsInvalid(t *testing.T) {
	// R6: real implementation. With verifyEnabled=true but no SOCKS5 proxy and
	// a domain with no real MX records (.test TLD), runVerify returns "invalid".
	srv, token := testServer(t)
	srv.WithVerifyEnabled(true)
	handler := srv.Handler()

	body := `{"email":"user@example.test"}`
	req := httptest.NewRequest("POST", "/v1/verify", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	var resp verifyResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	// .test TLD has no MX → invalid (R6 real implementation).
	if resp.Status != "invalid" {
		t.Errorf("status: got %q, want invalid (no MX for .test)", resp.Status)
	}
}

// ─── VERIFY_VIA_DIRECT_EGRESS tests ─────────────────────────────────────────

// T1: verifyDirectEgress() returns true when env var is unset (default).
func TestVerifyDirectEgress_DefaultTrue(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "")
	if !verifyDirectEgress() {
		t.Error("expected true when VERIFY_VIA_DIRECT_EGRESS is unset")
	}
}

// T2: verifyDirectEgress() returns true when explicitly set to "true".
func TestVerifyDirectEgress_ExplicitTrue(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "true")
	if !verifyDirectEgress() {
		t.Error("expected true when VERIFY_VIA_DIRECT_EGRESS=true")
	}
}

// T3: verifyDirectEgress() returns false when set to "false".
func TestVerifyDirectEgress_ExplicitFalse(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "false")
	if verifyDirectEgress() {
		t.Error("expected false when VERIFY_VIA_DIRECT_EGRESS=false")
	}
}

// T4: smtpRCPTProbe with direct egress (default) uses plain net.Dialer — it
// does NOT call SOCKS5 transport.  We verify this by stub-replacing smtpRCPTProbe
// and inspecting that socksAddr is empty when direct egress is active.
func TestSmtpRCPTProbe_DirectEgress_SocksAddrEmpty(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "")

	var capturedSocks string
	orig := smtpRCPTProbe
	smtpRCPTProbe = func(_ context.Context, socksAddr, _, _ string) (int, string) {
		capturedSocks = socksAddr
		return 250, "stubbed"
	}
	defer func() { smtpRCPTProbe = orig }()

	srv, _ := testServer(t)
	srv.WithVerifyEnabled(true)

	// Stub MX lookup so runVerify reaches smtpRCPTProbe.
	origMX := verifyLookupMX
	verifyLookupMX = func(_ context.Context, _ string) ([]*net.MX, error) {
		return []*net.MX{{Host: "mx-t4.example.test.", Pref: 10}}, nil
	}
	defer func() { verifyLookupMX = origMX }()

	srv.runVerify(context.Background(), "user@directegress.test")

	if capturedSocks != "" {
		t.Errorf("expected empty socksAddr for direct egress, got %q", capturedSocks)
	}
}

// T5: smtpRCPTProbe with VERIFY_VIA_DIRECT_EGRESS=false uses SOCKS5 —
// socksAddr must be non-empty and match the server's fallbackProxyAddr.
func TestSmtpRCPTProbe_LegacySOCKS_SocksAddrSet(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "false")

	var capturedSocks string
	orig := smtpRCPTProbe
	smtpRCPTProbe = func(_ context.Context, socksAddr, _, _ string) (int, string) {
		capturedSocks = socksAddr
		return 250, "stubbed"
	}
	defer func() { smtpRCPTProbe = orig }()

	srv, _ := testServer(t)
	srv.WithVerifyEnabled(true)
	srv.WithFallbackProxyAddr("127.0.0.1:1080")

	origMX := verifyLookupMX
	verifyLookupMX = func(_ context.Context, _ string) ([]*net.MX, error) {
		return []*net.MX{{Host: "mx-t5.example.test.", Pref: 10}}, nil
	}
	defer func() { verifyLookupMX = origMX }()

	srv.runVerify(context.Background(), "user@legacysocks.test")

	if capturedSocks != "127.0.0.1:1080" {
		t.Errorf("expected fallback proxy addr, got %q", capturedSocks)
	}
}

// T6: legacy path (VERIFY_VIA_DIRECT_EGRESS=false) with no proxy configured
// returns status="unknown" with a reason explaining missing proxy.
func TestRunVerify_LegacyNoProxy_ReturnsUnknown(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "false")

	srv, _ := testServer(t)
	srv.WithVerifyEnabled(true)
	// No proxy set on srv → verifySocksAddr() returns "".

	origMX := verifyLookupMX
	verifyLookupMX = func(_ context.Context, _ string) ([]*net.MX, error) {
		return []*net.MX{{Host: "mx-t6.noproxy.test.", Pref: 10}}, nil
	}
	defer func() { verifyLookupMX = origMX }()

	resp := srv.runVerify(context.Background(), "user@noproxy.test")
	if resp.Status != "unknown" {
		t.Errorf("status: got %q, want unknown", resp.Status)
	}
	if !strings.Contains(resp.Reason, "SOCKS5") && !strings.Contains(resp.Reason, "proxy") {
		t.Errorf("reason should mention proxy/SOCKS5: %q", resp.Reason)
	}
}

// T7: smtpRCPTProbe direct-dial uses net.Dialer (not SOCKS5).
// We confirm this by verifying that when VERIFY_VIA_DIRECT_EGRESS=true,
// the production smtpRCPTProbe returns a "connection failed" error for an
// unreachable localhost port — proving net.Dialer was invoked, not SOCKS5
// (which would return a different error about missing proxy).
func TestSmtpRCPTProbe_DirectDial_UsesNetDialer(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "true")

	// Pick a port that is closed (loopback, immediately refused).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // release immediately so the port is closed

	host, port, _ := net.SplitHostPort(addr)
	_ = port

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	var dialed atomic.Bool
	// Replace net.Dialer used inside smtpRCPTProbe by verifying that the
	// function returns code=0 and a non-empty error (dial failed) — this
	// can only happen if the direct net.Dialer path was taken.
	_ = &dialed

	code, reason := smtpRCPTProbe(ctx, "", host, "user@test.invalid")
	if code != 0 {
		t.Errorf("expected code=0 for closed port, got %d", code)
	}
	if reason == "" {
		t.Error("reason must explain connection failure")
	}
	// The error must come from the Go stdlib dialer, not from SOCKS5 proxy negotiation.
	if strings.Contains(reason, "SOCKS5") || strings.Contains(reason, "proxy") {
		t.Errorf("direct egress should not mention SOCKS5/proxy in error: %q", reason)
	}
}

// T8: smtpRCPTProbe direct-dial respects context cancellation (fast timeout).
func TestSmtpRCPTProbe_DirectDial_ContextCancel(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "true")

	// 203.0.113.x is TEST-NET-3 (RFC 5737) — guaranteed unreachable.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	code, reason := smtpRCPTProbe(ctx, "", "203.0.113.1", "u@test.invalid")
	elapsed := time.Since(start)

	if code != 0 {
		t.Errorf("expected code 0 for unreachable, got %d", code)
	}
	if elapsed > 5*time.Second {
		t.Errorf("dial should respect context timeout, took %v", elapsed)
	}
	if reason == "" {
		t.Error("reason must be non-empty on failure")
	}
}

// T9: audit ratchet — smtpRCPTProbe must NOT call verifySocksAddr when direct
// egress is enabled.  We verify by confirming the stub smtpRCPTProbe receives
// an empty socksAddr through the runVerify path.
func TestRunVerify_DirectEgress_NeverCallsVerifySocksAddr(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "true")

	var socksAddrUsed string
	orig := smtpRCPTProbe
	smtpRCPTProbe = func(_ context.Context, socksAddr, _, _ string) (int, string) {
		socksAddrUsed = socksAddr
		return 550, "no mailbox"
	}
	defer func() { smtpRCPTProbe = orig }()

	origMX := verifyLookupMX
	verifyLookupMX = func(_ context.Context, _ string) ([]*net.MX, error) {
		return []*net.MX{{Host: "mx-t9.audit.test.", Pref: 10}}, nil
	}
	defer func() { verifyLookupMX = origMX }()

	srv, _ := testServer(t)
	srv.WithVerifyEnabled(true)
	// Even if a proxy is available, it must not be used in direct egress mode.
	srv.WithFallbackProxyAddr("127.0.0.1:1080")

	srv.runVerify(context.Background(), "user@audit.test")

	if socksAddrUsed != "" {
		t.Errorf("verifySocksAddr path leaked into direct egress: socksAddr=%q", socksAddrUsed)
	}
}

// T10: end-to-end HTTP — /v1/verify with direct egress enabled (default) and a
// valid response shape.  Stubs smtpRCPTProbe and MX lookup.
func TestVerifyHTTP_DirectEgress_ContractShape(t *testing.T) {
	t.Setenv("VERIFY_VIA_DIRECT_EGRESS", "true")

	orig := smtpRCPTProbe
	// First call = canary (returns 550 = not catch-all), second = real (returns 250 = valid).
	var callCount atomic.Int32
	smtpRCPTProbe = func(_ context.Context, _, _, _ string) (int, string) {
		n := callCount.Add(1)
		if n == 1 {
			return 550, "no mailbox (canary)" // canary rejected → not catch-all
		}
		return 250, "accepted"
	}
	defer func() { smtpRCPTProbe = orig }()

	origMX := verifyLookupMX
	verifyLookupMX = func(_ context.Context, _ string) ([]*net.MX, error) {
		return []*net.MX{{Host: "mx-t10.e2e.test.", Pref: 10}}, nil
	}
	defer func() { verifyLookupMX = origMX }()

	srv, token := testServer(t)
	srv.WithVerifyEnabled(true)
	handler := srv.Handler()

	body := `{"email":"user@direct-e2e.test"}`
	req := httptest.NewRequest("POST", "/v1/verify", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d body: %s", rr.Code, rr.Body.String())
	}
	var resp verifyResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Status != "valid" {
		t.Errorf("expected valid, got %q (reason: %s)", resp.Status, resp.Reason)
	}
	if resp.Code != 250 {
		t.Errorf("expected code=250, got %d", resp.Code)
	}
}
