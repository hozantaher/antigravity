package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// --- /admin/circuits tests ---

func TestAdminCircuits_NoToken_WhenDisabled(t *testing.T) {
	// When ADMIN_TOKEN env var is empty the endpoint must allow unauthenticated access.
	server, _ := testServer(t)
	// testServer does not set ADMIN_TOKEN, so adminToken == "" → disabled

	req := httptest.NewRequest(http.MethodGet, "/admin/circuits", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 when admin auth disabled, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Circuits []circuitEntry `json:"circuits"`
		Total    int            `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Circuits == nil {
		t.Error("expected non-nil circuits slice")
	}
}

func TestAdminCircuits_ValidToken(t *testing.T) {
	server, _ := testServer(t)
	server.adminToken = "secret-operator-token"

	req := httptest.NewRequest(http.MethodGet, "/admin/circuits", nil)
	req.Header.Set("X-Admin-Token", "secret-operator-token")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 with valid token, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminCircuits_MissingToken_Returns401(t *testing.T) {
	server, _ := testServer(t)
	server.adminToken = "secret-operator-token"

	req := httptest.NewRequest(http.MethodGet, "/admin/circuits", nil)
	// no X-Admin-Token header
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for missing token, got %d", w.Code)
	}
}

func TestAdminCircuits_WrongToken_Returns401(t *testing.T) {
	server, _ := testServer(t)
	server.adminToken = "correct-token"

	req := httptest.NewRequest(http.MethodGet, "/admin/circuits", nil)
	req.Header.Set("X-Admin-Token", "wrong-token")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong token, got %d", w.Code)
	}
}

func TestAdminCircuits_MethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)

	req := httptest.NewRequest(http.MethodPost, "/admin/circuits", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestAdminCircuits_ResponseShape(t *testing.T) {
	server, _ := testServer(t)

	req := httptest.NewRequest(http.MethodGet, "/admin/circuits", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp struct {
		Circuits []circuitEntry `json:"circuits"`
		Total    int            `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != len(resp.Circuits) {
		t.Errorf("total=%d does not match len(circuits)=%d", resp.Total, len(resp.Circuits))
	}
}

// --- /admin/stats tests ---

func TestAdminStats_NoToken_WhenDisabled(t *testing.T) {
	server, _ := testServer(t)

	req := httptest.NewRequest(http.MethodGet, "/admin/stats", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 when admin auth disabled, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminStats_ValidToken(t *testing.T) {
	server, _ := testServer(t)
	server.adminToken = "op-token"

	req := httptest.NewRequest(http.MethodGet, "/admin/stats", nil)
	req.Header.Set("X-Admin-Token", "op-token")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminStats_MissingToken_Returns401(t *testing.T) {
	server, _ := testServer(t)
	server.adminToken = "op-token"

	req := httptest.NewRequest(http.MethodGet, "/admin/stats", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestAdminStats_ResponseShape(t *testing.T) {
	server, _ := testServer(t)

	req := httptest.NewRequest(http.MethodGet, "/admin/stats", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var snap struct {
		RequestsTotal  int64 `json:"requests_total"`
		BytesForwarded int64 `json:"bytes_forwarded"`
		LatencyP50Ms   int64 `json:"latency_p50_ms"`
		LatencyP95Ms   int64 `json:"latency_p95_ms"`
		LatencyP99Ms   int64 `json:"latency_p99_ms"`
		UptimeSeconds  int64 `json:"uptime_seconds"`
	}
	if err := json.NewDecoder(w.Body).Decode(&snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if snap.UptimeSeconds < 0 {
		t.Errorf("uptime_seconds = %d, want >= 0", snap.UptimeSeconds)
	}
}

func TestAdminStats_MethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)

	req := httptest.NewRequest(http.MethodPost, "/admin/stats", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestAdminStats_WithPopulatedData(t *testing.T) {
	server, _ := testServer(t)

	// Record some observations via the AdminStats accessor
	stats := server.AdminStats()
	stats.IncRequests()
	stats.IncRequests()
	stats.AddBytes(2048)
	for _, ms := range []time.Duration{10, 50, 100, 200, 500} {
		stats.ObserveLatency(ms * time.Millisecond)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/stats", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var snap struct {
		RequestsTotal  int64 `json:"requests_total"`
		BytesForwarded int64 `json:"bytes_forwarded"`
		LatencyP50Ms   int64 `json:"latency_p50_ms"`
		LatencyP95Ms   int64 `json:"latency_p95_ms"`
		LatencyP99Ms   int64 `json:"latency_p99_ms"`
		UptimeSeconds  int64 `json:"uptime_seconds"`
	}
	if err := json.NewDecoder(w.Body).Decode(&snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if snap.RequestsTotal != 2 {
		t.Errorf("requests_total = %d, want 2", snap.RequestsTotal)
	}
	if snap.BytesForwarded != 2048 {
		t.Errorf("bytes_forwarded = %d, want 2048", snap.BytesForwarded)
	}
	if snap.LatencyP50Ms <= 0 {
		t.Errorf("latency_p50_ms = %d, want > 0", snap.LatencyP50Ms)
	}
	if snap.LatencyP99Ms <= 0 {
		t.Errorf("latency_p99_ms = %d, want > 0", snap.LatencyP99Ms)
	}
}

func TestAdminCircuits_WithPendingEnvelopes(t *testing.T) {
	server, _ := testServer(t)

	// The scheduler starts empty; circuits response should still be valid
	req := httptest.NewRequest(http.MethodGet, "/admin/circuits", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Circuits []circuitEntry `json:"circuits"`
		Total    int            `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != 0 {
		t.Errorf("expected total=0 for empty scheduler, got %d", resp.Total)
	}
	if len(resp.Circuits) != resp.Total {
		t.Errorf("circuits length %d does not match total %d", len(resp.Circuits), resp.Total)
	}
}
