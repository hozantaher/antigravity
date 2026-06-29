package imap

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"common/config"
)

// AW7-2 (issue #1179) — fail-fast SOCKS5 + relay-discovery test suite.
//
// memory feedback_extreme_testing: ≥10 cases per change site.
//
// Cases:
//  T-1  connect() with no SOCKS env + no ANTI_TRACE_RELAY_URL + ALLOW_IMAP_DIRECT unset
//        → returns ErrIMAPSOCKSUnavailable (HARD RULE)
//  T-2  connect() with ALLOW_IMAP_DIRECT=1 → direct dial proceeds (escape hatch)
//  T-3  connect() with ANTI_TRACE_RELAY_URL pointing to a stub that returns a
//        valid socks_addr → connect() attempts the SOCKS5 dial
//  T-4  connect() with ANTI_TRACE_RELAY_URL pointing to 503 → discovery returns
//        "" → fail-fast (no silent fallback)
//  T-5  connect() with ANTI_TRACE_RELAY_URL pointing to malformed JSON → "" → fail-fast
//  T-6  discoverImapSOCKSAddrFromRelay honours preferred_country query param
//  T-7  discoverImapSOCKSAddrFromRelay sends Bearer token when ANTI_TRACE_RELAY_TOKEN set
//  T-8  discoverImapSOCKSAddrFromRelay times out after 5s if relay hangs (bounded)
//  T-9  ErrIMAPSOCKSUnavailable error message includes mailbox + country for ops triage
//  T-10 connect() with IMAP_SOCKS_DEFAULT preserves operator pin (env beats relay)
//  T-11 discoverImapSOCKSAddrFromRelay handles empty ANTI_TRACE_RELAY_URL → ""
//  T-12 connect() refuses dial when relay returns empty socks_addr field

// ── T-1: HARD RULE refusal ────────────────────────────────────────────────────

func TestAW7_T1_RefusesDirectDialWithoutEscapeHatch(t *testing.T) {
	t.Setenv("IMAP_SOCKS_CZ", "")
	t.Setenv("IMAP_SOCKS_SK", "")
	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	t.Setenv("ALLOW_IMAP_DIRECT", "")

	mb := config.MailboxConfig{
		Address:          "no-socks@example.com",
		IMAPHost:         "127.0.0.2",
		IMAPPort:         143,
		PreferredCountry: "ZZ", // unknown → resolveImapSOCKSAddr returns ""
	}

	_, err := connect(context.Background(), mb)
	if err == nil {
		t.Fatal("expected error from fail-fast path")
	}
	if !errors.Is(err, ErrIMAPSOCKSUnavailable) {
		t.Errorf("expected ErrIMAPSOCKSUnavailable, got %v", err)
	}
}

// ── T-2: ALLOW_IMAP_DIRECT escape hatch ───────────────────────────────────────

func TestAW7_T2_AllowDirectEnvOpensEscapeHatch(t *testing.T) {
	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	t.Setenv("ALLOW_IMAP_DIRECT", "1")

	mb := config.MailboxConfig{
		Address:          "esc@example.com",
		IMAPHost:         "127.0.0.2", // unreachable but the dial WILL be attempted
		IMAPPort:         2,
		PreferredCountry: "ZZ",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	_, err := connect(ctx, mb)
	// Dial should be ATTEMPTED — error is "connection refused" or similar,
	// NOT ErrIMAPSOCKSUnavailable.
	if err == nil {
		t.Skip("port 2 happens to be open; can't assert dial-attempt-vs-refusal")
	}
	if errors.Is(err, ErrIMAPSOCKSUnavailable) {
		t.Errorf("ALLOW_IMAP_DIRECT=1 should bypass fail-fast; got HARD RULE error: %v", err)
	}
}

// ── T-3: relay discovery returns valid socks_addr ─────────────────────────────

func TestAW7_T3_RelayDiscoveryReturnsValidAddr(t *testing.T) {
	// Stub relay that returns a valid socks_addr.
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/imap-socks-addr" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"socks_addr": "127.0.0.1:65532", // unreachable port — connect will try SOCKS5 init
			"country":    "CZ",
			"label":      "stub",
		})
	}))
	defer stub.Close()

	t.Setenv("IMAP_SOCKS_CZ", "")
	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)
	t.Setenv("ALLOW_IMAP_DIRECT", "")

	mb := config.MailboxConfig{
		Address:          "stub@example.com",
		IMAPHost:         "imap.seznam.cz",
		IMAPPort:         993,
		PreferredCountry: "ZZ", // unknown → falls through to relay discovery
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	_, err := connect(ctx, mb)
	if err == nil {
		t.Fatal("expected dial error (SOCKS5 host port closed)")
	}
	// Must NOT be ErrIMAPSOCKSUnavailable — relay returned a valid addr.
	if errors.Is(err, ErrIMAPSOCKSUnavailable) {
		t.Errorf("relay returned valid addr; should not be HARD RULE error: %v", err)
	}
	// Must mention socks5 init / dial — confirms SOCKS5 path was taken.
	if !strings.Contains(err.Error(), "socks5") && !strings.Contains(err.Error(), "127.0.0.1:65532") {
		t.Errorf("expected SOCKS5 dial error, got: %v", err)
	}
}

// ── T-4: relay 503 → fail-fast ────────────────────────────────────────────────

func TestAW7_T4_Relay503FailsLoudNotSilent(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"no active wgpool endpoint"}`))
	}))
	defer stub.Close()

	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)
	t.Setenv("ALLOW_IMAP_DIRECT", "")

	mb := config.MailboxConfig{
		Address:          "down@example.com",
		IMAPHost:         "imap.seznam.cz",
		IMAPPort:         993,
		PreferredCountry: "ZZ",
	}

	_, err := connect(context.Background(), mb)
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrIMAPSOCKSUnavailable) {
		t.Errorf("relay 503 should fail loud with HARD RULE error, got: %v", err)
	}
}

// ── T-5: malformed JSON → fail-fast ───────────────────────────────────────────

func TestAW7_T5_MalformedJSONFailsLoud(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`not even close to json`))
	}))
	defer stub.Close()

	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)
	t.Setenv("ALLOW_IMAP_DIRECT", "")

	mb := config.MailboxConfig{
		Address:          "bad@example.com",
		IMAPHost:         "imap.seznam.cz",
		IMAPPort:         993,
		PreferredCountry: "ZZ",
	}

	_, err := connect(context.Background(), mb)
	if !errors.Is(err, ErrIMAPSOCKSUnavailable) {
		t.Errorf("malformed JSON should fail loud, got: %v", err)
	}
}

// ── T-6: preferred_country propagates to relay query ──────────────────────────

func TestAW7_T6_DiscoverySendsPreferredCountryQuery(t *testing.T) {
	var captured atomic.Value
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.Store(r.URL.RawQuery)
		_ = json.NewEncoder(w).Encode(map[string]string{"socks_addr": "127.0.0.1:1080"})
	}))
	defer stub.Close()

	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)
	got := discoverImapSOCKSAddrFromRelay(context.Background(), "CZ")
	if got != "127.0.0.1:1080" {
		t.Errorf("expected socks_addr 127.0.0.1:1080, got %q", got)
	}
	q, _ := captured.Load().(string)
	if !strings.Contains(q, "preferred_country=CZ") {
		t.Errorf("expected query to include preferred_country=CZ, got %q", q)
	}
}

// ── T-7: bearer token forwarded when ANTI_TRACE_RELAY_TOKEN set ───────────────

func TestAW7_T7_DiscoverySendsBearerToken(t *testing.T) {
	var capturedAuth atomic.Value
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth.Store(r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(map[string]string{"socks_addr": "127.0.0.1:1080"})
	}))
	defer stub.Close()

	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)
	t.Setenv("ANTI_TRACE_RELAY_TOKEN", "secret-token")

	_ = discoverImapSOCKSAddrFromRelay(context.Background(), "")
	auth, _ := capturedAuth.Load().(string)
	if auth != "Bearer secret-token" {
		t.Errorf("expected Bearer token in Authorization header, got %q", auth)
	}
}

// ── T-8: discovery times out instead of stalling poll cycle ───────────────────

func TestAW7_T8_DiscoveryTimesOutOnHangingRelay(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Hang far longer than the 5s discovery deadline.
		time.Sleep(20 * time.Second)
	}))
	defer stub.Close()

	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)

	// Deadline that exceeds the discovery's internal 5s — we want to confirm
	// discovery doesn't run away and stays within ~5–6s.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	start := time.Now()
	got := discoverImapSOCKSAddrFromRelay(ctx, "")
	elapsed := time.Since(start)
	if got != "" {
		t.Errorf("expected empty addr on timeout, got %q", got)
	}
	if elapsed > 7*time.Second {
		t.Errorf("discovery did not respect 5s timeout; took %v", elapsed)
	}
}

// ── T-9: error message names mailbox + country for ops triage ─────────────────

func TestAW7_T9_FailFastErrorIncludesMailboxAndCountry(t *testing.T) {
	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	t.Setenv("ALLOW_IMAP_DIRECT", "")

	mb := config.MailboxConfig{
		Address:          "specific-user@firma.cz",
		IMAPHost:         "imap.firma.cz",
		IMAPPort:         143,
		PreferredCountry: "ZZ",
	}

	_, err := connect(context.Background(), mb)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "specific-user@firma.cz") {
		t.Errorf("error must include mailbox address for ops triage, got: %v", err)
	}
	if !strings.Contains(err.Error(), "ZZ") {
		t.Errorf("error must include preferred_country, got: %v", err)
	}
}

// ── T-10: IMAP_SOCKS_DEFAULT env beats relay discovery ────────────────────────

func TestAW7_T10_EnvPinBeatsRelayDiscovery(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"socks_addr": "10.99.99.99:9999"})
	}))
	defer stub.Close()

	// IMAP_SOCKS_DEFAULT pin should win — relay never queried because env
	// already resolves a non-empty addr in the very first step.
	t.Setenv("IMAP_SOCKS_DEFAULT", "127.0.0.1:65530")
	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)

	mb := config.MailboxConfig{
		Address:          "pinned@example.com",
		IMAPHost:         "imap.seznam.cz",
		IMAPPort:         993,
		PreferredCountry: "ZZ",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	_, err := connect(ctx, mb)
	if err == nil {
		t.Fatal("expected dial error against unreachable SOCKS5 port")
	}
	// Error must mention the env-pinned addr, not the stub-returned addr.
	if !strings.Contains(err.Error(), "127.0.0.1:65530") {
		t.Errorf("expected env pin in error, got: %v", err)
	}
	if strings.Contains(err.Error(), "10.99.99.99") {
		t.Errorf("relay-discovered addr should NOT be used when env is pinned: %v", err)
	}
}

// ── T-11: empty ANTI_TRACE_RELAY_URL short-circuits without HTTP call ─────────

func TestAW7_T11_EmptyRelayURLSkipsDiscovery(t *testing.T) {
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	got := discoverImapSOCKSAddrFromRelay(context.Background(), "CZ")
	if got != "" {
		t.Errorf("empty ANTI_TRACE_RELAY_URL should yield empty addr, got %q", got)
	}
}

// ── T-12: empty socks_addr field in response → fail-fast ──────────────────────

func TestAW7_T12_EmptySocksAddrFieldFailsLoud(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"socks_addr": ""})
	}))
	defer stub.Close()

	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)
	t.Setenv("ALLOW_IMAP_DIRECT", "")

	mb := config.MailboxConfig{
		Address:          "empty-field@example.com",
		IMAPHost:         "imap.seznam.cz",
		IMAPPort:         993,
		PreferredCountry: "ZZ",
	}

	_, err := connect(context.Background(), mb)
	if !errors.Is(err, ErrIMAPSOCKSUnavailable) {
		t.Errorf("empty socks_addr field should fail loud, got: %v", err)
	}
}

// ── T-13: trailing slash in ANTI_TRACE_RELAY_URL is normalised ───────────────

func TestAW7_T13_TrailingSlashNormalised(t *testing.T) {
	var capturedPath atomic.Value
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath.Store(r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]string{"socks_addr": "127.0.0.1:1080"})
	}))
	defer stub.Close()

	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL+"/")
	got := discoverImapSOCKSAddrFromRelay(context.Background(), "")
	if got != "127.0.0.1:1080" {
		t.Errorf("expected addr, got %q", got)
	}
	p, _ := capturedPath.Load().(string)
	if p != "/v1/imap-socks-addr" {
		t.Errorf("expected /v1/imap-socks-addr, got %q (trailing-slash not normalised?)", p)
	}
}
