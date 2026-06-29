package web

// admin_refresh_pool_test.go — S9: POST /v1/admin/refresh-pool tests.
//
// Verifies:
//  - no token (disabled)  → 202
//  - valid token           → 202, body {"status":"refresh_triggered"}
//  - wrong token           → 401
//  - missing token         → 401 (when token required)
//  - GET method            → 405
//  - no proxy refresher    → 503
//  - ForceRefresh called   → exactly once when pool configured

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRefresher records how many times ForceRefresh was called.
type fakeRefresher struct {
	calls atomic.Int32
}

func (f *fakeRefresher) ForceRefresh() { f.calls.Add(1) }

// ── tests ────────────────────────────────────────────────────────────────────

func TestAdminRefreshPool_NoToken_WhenDisabled(t *testing.T) {
	server, _ := testServer(t)
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)
	// adminToken is empty (disabled) → anyone can call

	req := httptest.NewRequest(http.MethodPost, "/v1/admin/refresh-pool", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 when admin auth disabled, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminRefreshPool_ValidToken_Returns202(t *testing.T) {
	server, _ := testServer(t)
	server.adminToken = "admin-secret"
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)

	req := httptest.NewRequest(http.MethodPost, "/v1/admin/refresh-pool", nil)
	req.Header.Set("X-Admin-Token", "admin-secret")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 with valid token, got %d: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["status"] != "refresh_triggered" {
		t.Errorf(`expected status="refresh_triggered", got %q`, body["status"])
	}
}

func TestAdminRefreshPool_MissingToken_Returns401(t *testing.T) {
	server, _ := testServer(t)
	server.adminToken = "admin-secret"
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)

	req := httptest.NewRequest(http.MethodPost, "/v1/admin/refresh-pool", nil)
	// no X-Admin-Token header
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for missing token, got %d", w.Code)
	}
}

func TestAdminRefreshPool_WrongToken_Returns401(t *testing.T) {
	server, _ := testServer(t)
	server.adminToken = "correct-token"
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)

	req := httptest.NewRequest(http.MethodPost, "/v1/admin/refresh-pool", nil)
	req.Header.Set("X-Admin-Token", "wrong-token")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong token, got %d", w.Code)
	}
}

func TestAdminRefreshPool_GET_MethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)

	req := httptest.NewRequest(http.MethodGet, "/v1/admin/refresh-pool", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestAdminRefreshPool_NoProxyRefresher_Returns503(t *testing.T) {
	server, _ := testServer(t)
	// proxyRefresher NOT set

	req := httptest.NewRequest(http.MethodPost, "/v1/admin/refresh-pool", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when no proxy refresher configured, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminRefreshPool_ForceRefreshCalled_Async(t *testing.T) {
	server, _ := testServer(t)
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)

	req := httptest.NewRequest(http.MethodPost, "/v1/admin/refresh-pool", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
	// The refresh runs in a goroutine; wait up to 500ms for it to complete.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if fr.calls.Load() > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if got := fr.calls.Load(); got != 1 {
		t.Errorf("expected ForceRefresh called once, got %d", got)
	}
}

func TestAdminRefreshPool_ResponseContentType(t *testing.T) {
	server, _ := testServer(t)
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)

	req := httptest.NewRequest(http.MethodPost, "/v1/admin/refresh-pool", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	ct := w.Header().Get("Content-Type")
	if ct == "" {
		t.Error("expected Content-Type header in response")
	}
}

func TestAdminRefreshPool_DELETE_MethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)

	req := httptest.NewRequest(http.MethodDelete, "/v1/admin/refresh-pool", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for DELETE, got %d", w.Code)
	}
}

func TestAdminRefreshPool_PUT_MethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)
	fr := &fakeRefresher{}
	server.WithProxyRefresher(fr)

	req := httptest.NewRequest(http.MethodPut, "/v1/admin/refresh-pool", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for PUT, got %d", w.Code)
	}
}
