package imap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"common/config"
)

// AW6-2 (cycle 2) — SOCKS5 fail-fast edge cases beyond the AW7-2 baseline
// (PR #1191).
//
// memory feedback_extreme_testing: the AW7-2 suite (aw7_socks_failfast_test.go)
// covered T-1..T-13. This file adds the second-order edges that surfaced in
// cycle-2 review:
//
//   T-14 connect() with both ANTI_TRACE_RELAY_URL empty and IMAP_SOCKS_DEFAULT
//        empty must fail loud (sentinel error) — confirms task spec case #5
//        ("fail loud při connect, ne tichý fallback").
//   T-15 ALLOW_IMAP_DIRECT escape hatch logs a WARN, not silent — task spec
//        case #7. We exercise the path and assert error shape (NOT the
//        sentinel) which proves the warn-branch was taken instead of the
//        fail-fast branch.
//   T-16 Relay returning 429 (rate-limited) is treated the same as 503 —
//        discovery returns "" and connect() fail-fasts. Pins the contract
//        that NO non-200 response is silently retried at the dial layer
//        (the relay's own backoff is the right place for that).
//   T-17 ALLOW_IMAP_DIRECT=anything-else (e.g. "true", "yes", "0") does NOT
//        open the escape hatch. Only the literal "1" passes. Boundary test
//        for the env-var contract.

// ── T-14: BOTH discovery sources empty → ErrIMAPSOCKSUnavailable ──────────────

func TestAW6_2_T14_NoRelay_NoEnv_FailsLoud(t *testing.T) {
	t.Setenv("IMAP_SOCKS_CZ", "")
	t.Setenv("IMAP_SOCKS_SK", "")
	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	t.Setenv("ALLOW_IMAP_DIRECT", "")

	mb := config.MailboxConfig{
		Address:          "fully-unconfigured@example.com",
		IMAPHost:         "imap.unreachable.test",
		IMAPPort:         993,
		PreferredCountry: "ZZ", // unknown country — IMAP_SOCKS_DEFAULT path
	}

	_, err := connect(context.Background(), mb)
	if err == nil {
		t.Fatal("expected error when no SOCKS5 source is configured")
	}
	// Must be the HARD-RULE sentinel (not a plain dial error).
	if !strings.Contains(err.Error(), "imap: SOCKS5 endpoint unavailable") {
		t.Errorf("expected HARD-RULE sentinel, got %v", err)
	}
}

// ── T-15: ALLOW_IMAP_DIRECT=1 takes the warn-branch (NOT the sentinel) ────────

// The escape hatch must not fail-fast — instead it should attempt the dial
// and emit a WARN-level log. We can't assert the slog directly without
// hooking the global handler, but we CAN assert the error shape: a
// connection-refused / unreachable error instead of ErrIMAPSOCKSUnavailable.
// That delta proves the warn-branch was taken.
func TestAW6_2_T15_AllowDirect_TakesWarnBranch_NotSentinel(t *testing.T) {
	t.Setenv("IMAP_SOCKS_CZ", "")
	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	t.Setenv("ALLOW_IMAP_DIRECT", "1")

	mb := config.MailboxConfig{
		Address:          "escape-hatch@example.com",
		IMAPHost:         "127.0.0.99", // unreachable
		IMAPPort:         12,           // privileged port; unlikely to be open
		PreferredCountry: "ZZ",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	_, err := connect(ctx, mb)
	if err == nil {
		t.Skip("port 12 happens to be reachable; skipping warn-branch assertion")
		return
	}
	// Must NOT be the HARD-RULE sentinel — that would mean fail-fast won.
	if strings.Contains(err.Error(), "imap: SOCKS5 endpoint unavailable") {
		t.Errorf("ALLOW_IMAP_DIRECT=1 should bypass fail-fast; got HARD-RULE error: %v", err)
	}
	// The error should be a plain dial / TLS / handshake error.
	hasDialShape := strings.Contains(err.Error(), "dial") ||
		strings.Contains(err.Error(), "tls") ||
		strings.Contains(err.Error(), "connection") ||
		strings.Contains(err.Error(), "deadline")
	if !hasDialShape {
		t.Errorf("expected plain dial/TLS error, got: %v", err)
	}
}

// ── T-16: relay 429 → discovery "", fail-fast (no silent retry) ───────────────

// Mirrors T-4 (which used 503) but locks the contract for ALL non-200 codes:
// 429 (rate-limited), 4xx (client error), 5xx (server error) all flow into
// fail-fast. The relay's own backoff is responsible for retrying internally;
// connect() must not loop or fall through silently.
func TestAW6_2_T16_Relay429_FailsLoud(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate limited"}`))
	}))
	defer stub.Close()

	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)
	t.Setenv("ALLOW_IMAP_DIRECT", "")

	got := discoverImapSOCKSAddrFromRelay(context.Background(), "CZ")
	if got != "" {
		t.Errorf("relay 429 should yield empty addr, got %q", got)
	}

	// Now the full connect path: must fail loud with sentinel.
	mb := config.MailboxConfig{
		Address:          "rate-limited@example.com",
		IMAPHost:         "imap.seznam.cz",
		IMAPPort:         993,
		PreferredCountry: "ZZ",
	}
	_, err := connect(context.Background(), mb)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "imap: SOCKS5 endpoint unavailable") {
		t.Errorf("relay 429 should still fail loud at connect(); got: %v", err)
	}
}

// ── T-17: ALLOW_IMAP_DIRECT only opens the gate when value is exactly "1" ─────

// Defensive contract: env-var truthy parsing is famously inconsistent across
// languages. The relay/orchestrator standard is the literal "1" string.
// This test proves "true", "yes", "TRUE", "0", "" — none open the gate.
// (Prevents drift if a future maintainer "fixes" the parsing to be
// "more flexible" and accidentally weakens HARD-RULE enforcement.)
func TestAW6_2_T17_AllowDirect_OnlyLiteralOneOpensGate(t *testing.T) {
	mb := config.MailboxConfig{
		Address:          "boundary@example.com",
		IMAPHost:         "imap.unreachable.test",
		IMAPPort:         993,
		PreferredCountry: "ZZ",
	}

	t.Setenv("IMAP_SOCKS_DEFAULT", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")

	// All these values must NOT open the gate — fail-fast must win.
	for _, val := range []string{"true", "yes", "TRUE", "True", "0", "", "01", " 1", "1 "} {
		t.Run("val="+val, func(t *testing.T) {
			t.Setenv("ALLOW_IMAP_DIRECT", val)
			_, err := connect(context.Background(), mb)
			if err == nil {
				t.Fatalf("expected fail-fast error for ALLOW_IMAP_DIRECT=%q", val)
			}
			if !strings.Contains(err.Error(), "imap: SOCKS5 endpoint unavailable") {
				t.Errorf("ALLOW_IMAP_DIRECT=%q should NOT open the gate; got: %v", val, err)
			}
		})
	}
}

// ── T-18: discoverImapSOCKSAddrFromRelay handles socks_addr=null in JSON ──────

// The relay protocol returns `{"socks_addr":"127.0.0.1:1080"}` on success.
// Defensive: a malformed relay that returns `{"socks_addr":null}` (Go nil
// JSON) decodes into the empty string field. discovery returns "" and
// connect() fail-fasts. Without this guard, a refactor that uses
// `json.Number` or `interface{}` could panic on the nil.
func TestAW6_2_T18_RelayReturnsNullSocksAddr_FailsLoud(t *testing.T) {
	var hits atomic.Int32
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		// Explicit null in the field — JSON decodes to "" for string field.
		_, _ = w.Write([]byte(`{"socks_addr":null,"country":"CZ"}`))
	}))
	defer stub.Close()

	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)
	got := discoverImapSOCKSAddrFromRelay(context.Background(), "CZ")
	if got != "" {
		t.Errorf("null socks_addr field should yield empty addr, got %q", got)
	}
	if hits.Load() != 1 {
		t.Errorf("relay should have been called exactly once, got %d", hits.Load())
	}
}

// ── T-19: discovery preserves preferred_country URL-escaping ──────────────────

// Ensures non-ASCII / unusual country codes are URL-escaped instead of
// pasted raw into the query string (would break URL parsing on the relay).
// Practical: test plumbing only ever sends "CZ" / "SK", but the contract
// must hold for any string the dashboard might pass.
func TestAW6_2_T19_PreferredCountryURLEscaped(t *testing.T) {
	var capturedURL atomic.Value
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedURL.Store(r.URL.RawQuery)
		_ = json.NewEncoder(w).Encode(map[string]string{"socks_addr": "127.0.0.1:1080"})
	}))
	defer stub.Close()

	t.Setenv("ANTI_TRACE_RELAY_URL", stub.URL)

	// Country with characters that NEED escaping (defensive: any caller that
	// passes a raw bare string with spaces or & must not break the relay URL).
	got := discoverImapSOCKSAddrFromRelay(context.Background(), "CZ&injected=1")
	if got != "127.0.0.1:1080" {
		t.Errorf("expected addr, got %q", got)
	}

	q, _ := capturedURL.Load().(string)
	// QueryEscape replaces "&" with "%26".
	if !strings.Contains(q, "preferred_country=CZ%26injected%3D1") {
		t.Errorf("preferred_country must be URL-escaped; got query %q", q)
	}
	// Sanity: NOT a raw injection.
	if strings.Contains(q, "preferred_country=CZ&injected=1") {
		t.Errorf("query string contains un-escaped injection: %q", q)
	}
}
