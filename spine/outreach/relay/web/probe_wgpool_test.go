package web

// Sprint AO3 tests (probe_wgpool_test.go): smtpAuthProbe / imapAuthProbe must
// use wgPool when mailbox_id is provided — same egress path as drain.
//
// Test matrix (AO3):
//  T1.  smtpAuthProbe picks wgpool CZ endpoint when mailbox_id + wgPool wired
//  T2.  smtpAuthProbe picks wgpool SK endpoint
//  T3.  smtpAuthProbe with mailbox_id but wgPool nil → proxyPool fallback (backward compat)
//  T4.  smtpAuthProbe without mailbox_id → proxyPool (backward compat)
//  T5.  smtpAuthProbe wgPool.Pick error (all quarantined) → error, no silent fallback
//  T6.  imapAuthProbe picks wgpool endpoint when mailbox_id + wgPool wired
//  T7.  imapAuthProbe without mailbox_id → proxyPool fallback
//  T8.  imapAuthProbe wgPool.Pick error → error, no silent fallback
//  T9.  handleAuthCheck passes mailbox_id + preferred_country to smtpAuthProbe
//  T10. handleProbe passes mailbox_id + preferred_country to smtp + imap
//  T11. smtpAuthProbe mailbox_id, no pools → returns error (no crash)
//  T12. audit ratchet: wgPool path entered, no bare net.Dialer

import (
	"relay/internal/transport"
	"relay/internal/transport/wgpool"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestBuildWGPoolResponse_ExposesRealPoolState — guards against
// regression of synthetic-data fabrication. /v1/proxy-pool must reflect
// Pool.Snapshot verbatim with no inventions.
func TestBuildWGPoolResponse_ExposesRealPoolState(t *testing.T) {
	p, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz5", SocksAddr: "127.0.0.1:1080", Country: "CZ", City: "Prague"},
		{Label: "de4", SocksAddr: "127.0.0.1:1081", Country: "DE"},
		{Label: "at1", SocksAddr: "127.0.0.1:1082", Country: "AT"},
	}, wgpool.Config{})
	if err != nil {
		t.Fatal(err)
	}

	resp := buildWGPoolResponse(p)

	if resp.Mode != "wg-pool" {
		t.Fatalf("mode = %q, want wg-pool", resp.Mode)
	}
	if resp.PoolSize != 3 {
		t.Fatalf("pool_size = %d, want 3", resp.PoolSize)
	}
	if resp.ActiveEndpoints != 3 {
		t.Fatalf("active = %d, want 3", resp.ActiveEndpoints)
	}
	if resp.QuarantinedEndpoints != 0 {
		t.Fatalf("quarantined = %d, want 0", resp.QuarantinedEndpoints)
	}
	if len(resp.Endpoints) != 3 {
		t.Fatalf("endpoints len = %d, want 3", len(resp.Endpoints))
	}
	if resp.Endpoints[0].Label != "at1" || resp.Endpoints[1].Label != "cz5" || resp.Endpoints[2].Label != "de4" {
		t.Fatalf("not sorted: %+v", resp.Endpoints)
	}
}

func TestBuildWGPoolResponse_QuarantineSurfaced(t *testing.T) {
	p, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz5", SocksAddr: "127.0.0.1:1080", Country: "CZ"},
		{Label: "de4", SocksAddr: "127.0.0.1:1081", Country: "DE"},
	}, wgpool.Config{QuarantineThreshold: 1, QuarantineDuration: 5 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	p.RecordFailure("cz5")
	resp := buildWGPoolResponse(p)
	if resp.QuarantinedEndpoints != 1 {
		t.Fatalf("quarantined = %d, want 1", resp.QuarantinedEndpoints)
	}
	if resp.ActiveEndpoints != 1 {
		t.Fatalf("active = %d, want 1", resp.ActiveEndpoints)
	}
	if len(resp.Working) != 1 || resp.Working[0].Addr != "127.0.0.1:1081" {
		t.Fatalf("working = %+v, want only de4", resp.Working)
	}
}

func TestBuildWGPoolResponse_JSONShape(t *testing.T) {
	p, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz5", SocksAddr: "127.0.0.1:1080", Country: "CZ", PeerHost: "cz5.mullvad.net:51820"},
	}, wgpool.Config{})
	if err != nil {
		t.Fatal(err)
	}
	resp := buildWGPoolResponse(p)
	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	checks := []string{
		`"mode":"wg-pool"`,
		`"pool_size":1`,
		`"active_endpoints":1`,
		`"endpoints":`,
		`"label":"cz5"`,
		`"peer_host":"cz5.mullvad.net:51820"`,
	}
	got := string(out)
	for _, sub := range checks {
		if !strings.Contains(got, sub) {
			t.Fatalf("missing field %q in: %s", sub, got)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprint AO3 — probe wgPool routing tests
// closedPortAddr is a loopback:1 address that immediately refuses connections.
// It lets us verify which pool path was entered without completing SMTP/IMAP.
const ao3ClosedAddr = "127.0.0.1:1"

func ao3Pool(t *testing.T, endpoints []wgpool.Endpoint) *wgpool.Pool {
	t.Helper()
	pool, err := wgpool.New(endpoints, wgpool.Config{})
	if err != nil {
		t.Fatalf("ao3Pool: %v", err)
	}
	return pool
}

// T1 — smtpAuthProbe uses wgpool CZ endpoint when mailbox_id + wgPool wired.
func TestAO3_SmtpAuthProbe_WGPool_CZ(t *testing.T) {
	srv, _ := testServer(t)
	srv.WithWGPool(ao3Pool(t, []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: ao3ClosedAddr, Country: "CZ"},
	}))

	req := authCheckRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		MailboxID:        "mbx-cz",
		PreferredCountry: "CZ",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	if strings.HasPrefix(result.Error, "wgpool pick:") {
		t.Fatalf("wgPool.Pick failed unexpectedly: %s", result.Error)
	}
	// Connection refused at socks_dial confirms wgpool path was taken.
	found := false
	for _, s := range result.Steps {
		if s.Name == "socks_dial" {
			found = true
		}
	}
	if !found {
		t.Errorf("socks_dial step missing; steps=%+v error=%s", result.Steps, result.Error)
	}
}

// T2 — smtpAuthProbe uses wgpool SK endpoint.
func TestAO3_SmtpAuthProbe_WGPool_SK(t *testing.T) {
	srv, _ := testServer(t)
	srv.WithWGPool(ao3Pool(t, []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: ao3ClosedAddr, Country: "CZ"},
		{Label: "sk1", SocksAddr: ao3ClosedAddr, Country: "SK"},
	}))

	req := authCheckRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		MailboxID:        "mbx-sk",
		PreferredCountry: "SK",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	if strings.HasPrefix(result.Error, "wgpool pick:") {
		t.Fatalf("wgPool.Pick failed: %s", result.Error)
	}
	found := false
	for _, s := range result.Steps {
		if s.Name == "socks_dial" {
			found = true
		}
	}
	if !found {
		t.Errorf("socks_dial step missing; steps=%+v error=%s", result.Steps, result.Error)
	}
}

// T3 — smtpAuthProbe: wgPool nil + mailboxID set → ErrWgPoolUnavailableForMailbox (P0 fix).
// Previously this silently fell back to the free rotating (multi-country) pool,
// producing the fraud-lock pattern. Now it must refuse and return a hard error.
func TestAO3_SmtpAuthProbe_MailboxID_WGPoolNil_ReturnsError(t *testing.T) {
	srv, _ := testServer(t)
	// Wire proxyPool but NOT wgPool — the bug was: wgPool nil + mailboxID → proxyPool fallback.
	srv.WithProxyPool(&fakePool{snap: transport.PoolSnapshot{
		Working: []transport.PoolEntry{{Addr: ao3ClosedAddr, Latency: time.Millisecond}},
	}})

	req := authCheckRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		MailboxID:        "mbx-001",
		PreferredCountry: "CZ",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	// Must NOT succeed — wgPool is required for mailboxID routing.
	if result.OK {
		t.Error("expected OK=false when wgPool is nil but mailboxID is set")
	}
	// Error must contain wgpool_required sentinel.
	if !strings.Contains(result.Error, "wgpool_required") {
		t.Errorf("expected wgpool_required error, got: %q", result.Error)
	}
	// Must NOT have reached socks_dial — free pool must not be used.
	for _, s := range result.Steps {
		if s.Name == "socks_dial" {
			t.Error("socks_dial must NOT fire — free pool fallback is forbidden for mailbox_id")
		}
	}
}

// T3b — smtpAuthProbe: wgPool nil + mailboxID empty → proxyPool OK (backward compat).
func TestAO3_SmtpAuthProbe_NoMailboxID_WGPoolNil_ProxyPoolOK(t *testing.T) {
	srv, _ := testServer(t)
	srv.WithProxyPool(&fakePool{snap: transport.PoolSnapshot{
		Working: []transport.PoolEntry{{Addr: ao3ClosedAddr, Latency: time.Millisecond}},
	}})

	req := authCheckRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		// No MailboxID — legacy path should still use proxyPool.
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	// Should reach socks_dial (proxyPool used), even though it will fail at conn refused.
	if strings.Contains(result.Error, "wgpool_required") {
		t.Errorf("legacy path (no mailboxID) must not trigger wgpool_required: %q", result.Error)
	}
	if result.Error == "no proxy pool configured and no proxy_addr provided" {
		t.Error("proxyPool should have been used for request without mailbox_id")
	}
}

// T3c — imapAuthProbe: wgPool nil + mailboxID set → ErrWgPoolUnavailableForMailbox.
func TestAO3_ImapAuthProbe_MailboxID_WGPoolNil_ReturnsError(t *testing.T) {
	srv, _ := testServer(t)
	srv.WithProxyPool(&fakePool{snap: transport.PoolSnapshot{
		Working: []transport.PoolEntry{{Addr: ao3ClosedAddr, Latency: time.Millisecond}},
	}})

	req := probeRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		IMAPHost: "imap.seznam.cz", IMAPPort: 993,
		MailboxID:        "mbx-001",
		PreferredCountry: "CZ",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.imapAuthProbe(ctx, req, "")
	if result.OK {
		t.Error("expected OK=false when wgPool nil but mailboxID set")
	}
	if !strings.Contains(result.Error, "wgpool_required") {
		t.Errorf("expected wgpool_required error, got: %q", result.Error)
	}
	for _, s := range result.Steps {
		if s.Name == "socks_dial" {
			t.Error("socks_dial must NOT fire — free pool fallback is forbidden for mailbox_id")
		}
	}
}

// T4 — smtpAuthProbe without mailbox_id uses proxyPool (backward compat).
func TestAO3_SmtpAuthProbe_NoMailboxID_ProxyPool(t *testing.T) {
	srv, _ := testServer(t)
	srv.WithProxyPool(&fakePool{snap: transport.PoolSnapshot{
		Working: []transport.PoolEntry{{Addr: ao3ClosedAddr, Latency: time.Millisecond}},
	}})

	req := authCheckRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		// No MailboxID
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	if result.Error == "no proxy pool configured and no proxy_addr provided" {
		t.Error("proxyPool should have been used for request without mailbox_id")
	}
}

// T5 — smtpAuthProbe: wgPool all-quarantined → error, no silent fallback.
func TestAO3_SmtpAuthProbe_AllQuarantined_ErrorNoFallback(t *testing.T) {
	srv, _ := testServer(t)
	pool := ao3Pool(t, []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: ao3ClosedAddr, Country: "CZ"},
	})
	for i := 0; i < 5; i++ {
		pool.RecordFailure("cz1")
	}
	srv.WithWGPool(pool)

	req := authCheckRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		MailboxID: "mbx-001", PreferredCountry: "CZ",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	if !strings.HasPrefix(result.Error, "wgpool pick:") {
		t.Errorf("expected wgpool pick error, got: %q", result.Error)
	}
	if result.OK {
		t.Error("result.OK should be false")
	}
	for _, s := range result.Steps {
		if s.Name == "socks_dial" {
			t.Error("must NOT reach socks_dial when wgPool.Pick fails with mailbox_id set")
		}
	}
}

// T6 — imapAuthProbe uses wgpool endpoint when mailbox_id set.
func TestAO3_ImapAuthProbe_WGPool(t *testing.T) {
	srv, _ := testServer(t)
	srv.WithWGPool(ao3Pool(t, []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: ao3ClosedAddr, Country: "CZ"},
	}))

	req := probeRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		IMAPHost: "imap.seznam.cz", IMAPPort: 993,
		MailboxID: "mbx-001", PreferredCountry: "CZ",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.imapAuthProbe(ctx, req, "")
	if strings.HasPrefix(result.Error, "wgpool pick:") {
		t.Fatalf("wgPool.Pick failed: %s", result.Error)
	}
	found := false
	for _, s := range result.Steps {
		if s.Name == "socks_dial" {
			found = true
		}
	}
	if !found {
		t.Errorf("socks_dial step missing; steps=%+v error=%s", result.Steps, result.Error)
	}
}

// T7 — imapAuthProbe without mailbox_id → proxyPool.
func TestAO3_ImapAuthProbe_NoMailboxID_ProxyPool(t *testing.T) {
	srv, _ := testServer(t)
	srv.WithProxyPool(&fakePool{snap: transport.PoolSnapshot{
		Working: []transport.PoolEntry{{Addr: ao3ClosedAddr, Latency: time.Millisecond}},
	}})

	req := probeRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		IMAPHost: "imap.seznam.cz", IMAPPort: 993,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.imapAuthProbe(ctx, req, "")
	if result.Error == "no proxy pool" {
		t.Error("proxyPool should have been used for IMAP probe without mailbox_id")
	}
}

// T8 — imapAuthProbe: wgPool all-quarantined → error, no silent fallback.
func TestAO3_ImapAuthProbe_AllQuarantined_ErrorNoFallback(t *testing.T) {
	srv, _ := testServer(t)
	pool := ao3Pool(t, []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: ao3ClosedAddr, Country: "CZ"},
	})
	for i := 0; i < 5; i++ {
		pool.RecordFailure("cz1")
	}
	srv.WithWGPool(pool)

	req := probeRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		IMAPHost: "imap.seznam.cz", IMAPPort: 993,
		MailboxID: "mbx-001", PreferredCountry: "CZ",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.imapAuthProbe(ctx, req, "")
	if !strings.HasPrefix(result.Error, "wgpool pick:") {
		t.Errorf("expected wgpool pick error, got: %q", result.Error)
	}
	if result.OK {
		t.Error("result.OK should be false")
	}
}

// T9 — handleAuthCheck passes mailbox_id + preferred_country.
func TestAO3_HandleAuthCheck_PassesMailboxIDCountry(t *testing.T) {
	srv, token := testServer(t)
	srv.WithWGPool(ao3Pool(t, []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: ao3ClosedAddr, Country: "CZ"},
	}))

	body := `{"smtp_host":"smtp.seznam.cz","smtp_port":465,"smtp_username":"mb@garaaage.cz","password":"secret","mailbox_id":"mbx-001","preferred_country":"CZ"}`
	req := httptest.NewRequest("POST", "/v1/auth-check", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d body: %s", rr.Code, rr.Body.String())
	}
	var sc probeSubcheck
	if err := json.NewDecoder(rr.Body).Decode(&sc); err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(sc.Error, "wgpool pick:") {
		t.Errorf("wgPool.Pick failed unexpectedly: %s", sc.Error)
	}
	if strings.Contains(sc.Error, "no proxy pool") {
		t.Errorf("fell back to proxyPool — expected wgpool path: %s", sc.Error)
	}
}

// T10 — handleProbe passes mailbox_id + preferred_country to smtp and imap.
func TestAO3_HandleProbe_PassesMailboxIDCountry(t *testing.T) {
	srv, token := testServer(t)
	srv.WithWGPool(ao3Pool(t, []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: ao3ClosedAddr, Country: "CZ"},
	}))

	body := `{"smtp_host":"smtp.seznam.cz","smtp_port":465,"smtp_username":"mb@garaaage.cz","password":"secret","imap_host":"imap.seznam.cz","imap_port":993,"mailbox_id":"mbx-001","preferred_country":"CZ"}`
	req := httptest.NewRequest("POST", "/v1/probe", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d body: %s", rr.Code, rr.Body.String())
	}
	var resp probeResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(resp.Checks.SMTP.Error, "wgpool pick:") {
		t.Errorf("SMTP: wgPool.Pick failed: %s", resp.Checks.SMTP.Error)
	}
	if resp.Checks.IMAP == nil {
		t.Error("IMAP subcheck must be present (imap_host/port provided)")
	} else if strings.HasPrefix(resp.Checks.IMAP.Error, "wgpool pick:") {
		t.Errorf("IMAP: wgPool.Pick failed: %s", resp.Checks.IMAP.Error)
	}
	if resp.CheckedAt == "" {
		t.Error("checked_at missing")
	}
}

// T11 — smtpAuthProbe with mailbox_id, no pools at all → returns error.
func TestAO3_SmtpAuthProbe_MailboxID_NoPools_ReturnsError(t *testing.T) {
	srv, _ := testServer(t)
	// No wgPool, no proxyPool wired.

	req := authCheckRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		MailboxID: "mbx-001", PreferredCountry: "CZ",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	if result.OK {
		t.Error("must not succeed with no pools configured")
	}
	if result.Error == "" {
		t.Error("must return non-empty error")
	}
}

// T12 — audit ratchet: wgPool path entered, no bare net.Dialer fallback.
func TestAO3_SmtpAuthProbe_NoBareNetDialer_WhenWGPoolWired(t *testing.T) {
	srv, _ := testServer(t)
	srv.WithWGPool(ao3Pool(t, []wgpool.Endpoint{
		{Label: "at1", SocksAddr: ao3ClosedAddr, Country: "AT"},
	}))

	req := authCheckRequest{
		SMTPHost: "smtp.seznam.cz", SMTPPort: 465,
		SMTPUsername: "mb@garaaage.cz", Password: "secret",
		MailboxID: "mbx-at-01", PreferredCountry: "AT",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	// Bare net.Dialer path would produce "no proxy pool configured and no proxy_addr provided".
	if result.Error == "no proxy pool configured and no proxy_addr provided" {
		t.Error("bare net.Dialer path was taken — wgPool.Pick was not called")
	}
	// wgPool.Pick should have succeeded for AT (not quarantined).
	if strings.HasPrefix(result.Error, "wgpool pick:") {
		t.Errorf("wgPool.Pick failed unexpectedly: %s", result.Error)
	}
}
