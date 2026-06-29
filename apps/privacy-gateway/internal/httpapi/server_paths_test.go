package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"privacy-gateway/internal/model"
)

// ── handleIntakeSubmissions: method not allowed (line 207-210) ──

func TestHandleIntakeSubmissions_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodGet, "/v1/intake/submissions", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleRelayAttemptByID: method not allowed (line ~178-181) ──

func TestHandleRelayAttemptByID_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/relay-attempts/some-id", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleIntakeDashboard: method not allowed (line ~268-270) ──

func TestHandleIntakeDashboard_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/intake/dashboard", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleAliases: method not allowed ──

func TestHandleAliases_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPut, "/v1/aliases", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// TestHandleAliasByID_MethodNotAllowed: skip since alias ID routing may not support POST.

// ── handleAliasTimeline: method not allowed ──

func TestHandleAliasTimeline_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/aliases/some-id/timeline", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleChannels: method not allowed ──

func TestHandleChannels_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/channels", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleMessages: method not allowed ──

func TestHandleMessages_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodDelete, "/v1/messages", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleSubmissions: method not allowed ──

func TestHandleSubmissions_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPut, "/v1/submissions", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleSubmissionByID: method not allowed ──

func TestHandleSubmissionByID_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/submissions/some-id", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleRelayQueue: method not allowed (uses token auth, not intake) ──

func TestHandleRelayQueue_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/relay-queue", nil)
	req.Header.Set("Authorization", "Bearer token") // regular auth, not intake
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleAuditEvents: method not allowed ──

func TestHandleAuditEvents_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/audit-events", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleIdentityLinks: method not allowed ──

func TestHandleIdentityLinks_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPut, "/v1/identity-links", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleSubmissionTimeline: method not allowed ──

func TestHandleSubmissionTimeline_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/submissions/some-id/timeline", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleIntakeSubmissionTimeline: method not allowed ──

func TestHandleIntakeSubmissionTimeline_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions/some-id/timeline", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleIdentityLinkByAliasID: method not allowed ──

func TestHandleIdentityLinkByAliasID_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/identity-links/some-alias", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}
