package web

// proxy_pool_isnotfound_test.go — covers handleProxyPool (relay pass-through)
// and isNotFound which were at 0% coverage.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ── handleProxyPool — no relay configured ────────────────────────────────────
//
// When ANTI_TRACE_RELAY_URL is unset the handler must NOT fabricate a
// healthy pool. It must return mode=unknown + error=relay_not_configured
// (HARD RULE memory: feedback_no_fabricated_test_data).

func TestHandleProxyPool_NoRelay_Returns200JSON(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/proxy-pool", nil)
	w := httptest.NewRecorder()
	s.handleProxyPool(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestHandleProxyPool_NoRelay_ReturnsUnknownModeAndError(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/proxy-pool", nil)
	w := httptest.NewRecorder()
	s.handleProxyPool(w, req)

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if body["mode"] != "unknown" {
		t.Errorf("mode = %v, want unknown", body["mode"])
	}
	if body["error"] != "relay_not_configured" {
		t.Errorf("error = %v, want relay_not_configured", body["error"])
	}
	working, _ := body["working"].([]any)
	if len(working) != 0 {
		t.Errorf("working has %d entries; must be empty when relay unset (no fabrication)", len(working))
	}
	// `total` and `count` must both be present and zero.
	if total, _ := body["total"].(float64); int(total) != 0 {
		t.Errorf("total = %v, want 0", total)
	}
	if count, _ := body["count"].(float64); int(count) != 0 {
		t.Errorf("count = %v, want 0", count)
	}
}

// ── handleProxyPool — proxies to relay /v1/proxy-pool ────────────────────────

func TestHandleProxyPool_ProxiesToRelay_MullvadEmpty(t *testing.T) {
	// Real-world relay payload when TRANSPORT_MODE=socks5+wireproxy:
	// mode=mullvad, working=[], count=0.
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/proxy-pool" {
			t.Errorf("relay got unexpected path %q", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("relay got method %q, want GET", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q, want Bearer test-token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"mode":"mullvad","working":[],"count":0,"consecutive_zero_refreshes":0,"empty_pool_critical":false}`)
	}))
	defer relay.Close()

	s := newTestServer(t).WithRelay(relay.URL, "test-token", relay.Client())
	req := httptest.NewRequest(http.MethodGet, "/api/proxy-pool", nil)
	w := httptest.NewRecorder()
	s.handleProxyPool(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("not JSON: %v body=%s", err, w.Body.String())
	}
	if body["mode"] != "mullvad" {
		t.Errorf("mode = %v, want mullvad", body["mode"])
	}
	working, _ := body["working"].([]any)
	if len(working) != 0 {
		t.Errorf("working len = %d, want 0 (mullvad mode reports empty by design)", len(working))
	}
	if c, _ := body["count"].(float64); int(c) != 0 {
		t.Errorf("count = %v, want 0", c)
	}
	// `total` is filled by the handler from `count` for legacy callers.
	if total, _ := body["total"].(float64); int(total) != 0 {
		t.Errorf("total = %v, want 0", total)
	}
}

func TestHandleProxyPool_ProxiesToRelay_RotatingPoolWorking(t *testing.T) {
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"mode":"rotating-pool","working":[`+
			`{"addr":"1.2.3.4:1080","latency_ms":200,"country":"CZ","source":"proxifly"},`+
			`{"addr":"5.6.7.8:1080","latency_ms":350,"country":"DE","source":"geonode"}`+
			`],"count":2,"last_refresh":"2026-05-01T12:00:00Z","consecutive_zero_refreshes":0,"empty_pool_critical":false}`)
	}))
	defer relay.Close()

	s := newTestServer(t).WithRelay(relay.URL, "tok", relay.Client())
	req := httptest.NewRequest(http.MethodGet, "/api/proxy-pool", nil)
	w := httptest.NewRecorder()
	s.handleProxyPool(w, req)

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if body["mode"] != "rotating-pool" {
		t.Errorf("mode = %v", body["mode"])
	}
	working, _ := body["working"].([]any)
	if len(working) != 2 {
		t.Fatalf("working len = %d, want 2", len(working))
	}
	first, _ := working[0].(map[string]any)
	if first["addr"] != "1.2.3.4:1080" {
		t.Errorf("working[0].addr = %v", first["addr"])
	}
	if c, _ := body["count"].(float64); int(c) != 2 {
		t.Errorf("count = %v, want 2", c)
	}
	if total, _ := body["total"].(float64); int(total) != 2 {
		t.Errorf("total = %v, want 2 (filled from count)", total)
	}
}

func TestHandleProxyPool_RelayHTTP500_ReturnsErrorEnvelope(t *testing.T) {
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer relay.Close()

	s := newTestServer(t).WithRelay(relay.URL, "tok", relay.Client())
	req := httptest.NewRequest(http.MethodGet, "/api/proxy-pool", nil)
	w := httptest.NewRecorder()
	s.handleProxyPool(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (envelope), got %d", w.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["mode"] != "unknown" {
		t.Errorf("mode = %v, want unknown on relay 5xx", body["mode"])
	}
	if errStr, _ := body["error"].(string); !strings.HasPrefix(errStr, "relay_status_") {
		t.Errorf("error = %v, want relay_status_*", errStr)
	}
}

func TestHandleProxyPool_RelayMalformedJSON_ReturnsParseError(t *testing.T) {
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{not json`)
	}))
	defer relay.Close()

	s := newTestServer(t).WithRelay(relay.URL, "tok", relay.Client())
	req := httptest.NewRequest(http.MethodGet, "/api/proxy-pool", nil)
	w := httptest.NewRecorder()
	s.handleProxyPool(w, req)

	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["error"] != "relay_parse_failed" {
		t.Errorf("error = %v, want relay_parse_failed", body["error"])
	}
	if body["mode"] != "unknown" {
		t.Errorf("mode = %v, want unknown on parse failure", body["mode"])
	}
}

func TestHandleProxyPool_RelayUnreachable_ReturnsErrorEnvelope(t *testing.T) {
	// Point at a closed port — no listener, immediate connect refused.
	s := newTestServer(t).WithRelay("http://127.0.0.1:1", "tok", &http.Client{})
	req := httptest.NewRequest(http.MethodGet, "/api/proxy-pool", nil)
	w := httptest.NewRecorder()
	s.handleProxyPool(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 envelope, got %d", w.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["mode"] != "unknown" {
		t.Errorf("mode = %v, want unknown when relay unreachable", body["mode"])
	}
	working, _ := body["working"].([]any)
	if len(working) != 0 {
		t.Errorf("working has %d entries; must be empty on relay error (no fabrication)", len(working))
	}
}

func TestHandleProxyPool_NoFabricatedPoolNEntries(t *testing.T) {
	// Regression: the legacy handler returned synthetic pool-1..pool-4 IDs
	// regardless of relay state. Ensure no such IDs ever leak through.
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/proxy-pool", nil)
	w := httptest.NewRecorder()
	s.handleProxyPool(w, req)
	bodyStr := w.Body.String()
	for _, banned := range []string{"pool-1", "pool-2", "pool-3", "pool-4"} {
		if strings.Contains(bodyStr, banned) {
			t.Errorf("response contains synthetic id %q (forbidden); body=%s", banned, bodyStr)
		}
	}
}

// ── isNotFound ────────────────────────────────────────────────────────────────

func TestIsNotFound_Nil(t *testing.T) {
	if isNotFound(nil) {
		t.Error("nil error should not be 'not found'")
	}
}

func TestIsNotFound_ErrNoRows(t *testing.T) {
	if !isNotFound(sql.ErrNoRows) {
		t.Error("sql.ErrNoRows should be classified as not found")
	}
}

func TestIsNotFound_WrappedErrNoRows(t *testing.T) {
	wrapped := errors.Join(errors.New("outer"), sql.ErrNoRows)
	if !isNotFound(wrapped) {
		t.Error("wrapped sql.ErrNoRows should be classified as not found")
	}
}

func TestIsNotFound_MessageContainsNotFound(t *testing.T) {
	err := errors.New("record not found")
	if !isNotFound(err) {
		t.Error("error with 'not found' in message should be classified as not found")
	}
}

func TestIsNotFound_GenericError(t *testing.T) {
	if isNotFound(errors.New("connection refused")) {
		t.Error("generic error should not be classified as not found")
	}
}

func TestIsNotFound_CaseExact_NotFound(t *testing.T) {
	// "not found" must appear (case-sensitive in strings.Contains)
	// Verify boundary: only "not found" substring triggers it, not "Not Found"
	err := errors.New("segment Not Found in DB")
	// strings.Contains is case-sensitive — "Not Found" ≠ "not found"
	if isNotFound(err) {
		// This tests current behaviour: "Not Found" (capital) does NOT match.
		// If behaviour changes, update this test.
		t.Error("uppercase 'Not Found' matches — implementation may have changed")
	}
}

func TestIsNotFound_ExactSubstring(t *testing.T) {
	for _, msg := range []string{
		"segment not found",
		"item not found in cache",
		"key not found",
	} {
		if !isNotFound(errors.New(msg)) {
			t.Errorf("isNotFound(%q) = false, want true", msg)
		}
	}
}
