package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"privacy-gateway/internal/alias"
	"privacy-gateway/internal/audit"
	"privacy-gateway/internal/auth"
	"privacy-gateway/internal/identityvault"
	"privacy-gateway/internal/inbox"
	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
	"privacy-gateway/internal/policy"
	"privacy-gateway/internal/sanitizer"
	"privacy-gateway/internal/submission"
)

// newNoRelayServer creates a server with relay=nil (relay service not configured).
func newNoRelayServer(t *testing.T, actor model.Actor) *Server {
	t.Helper()
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(t.TempDir() + "/inbox.json")
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	auditService := audit.NewService(audit.NewMemoryStore())
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), auditService)
	identityService := identityvault.NewService(identityvault.NewMemoryRepository())
	authenticator := auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor})
	// NO WithRelayService → s.relay = nil
	return NewServer(authenticator, aliasService, submissionPolicy, submissions, auditService, identityService, gateway, inboxStore, nil, 4096).
		WithIntakeAuthenticator(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"intake-token": actor}))
}

func authedGET(t *testing.T, path string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer token")
	return req
}

// ── handleRelayAttempts: relay == nil (line 113-116) ──

func TestHandleRelayAttempts_RelayNil(t *testing.T) {
	srv := newNoRelayServer(t, model.Actor{ID: "user-1"})
	req := authedGET(t, "/v1/relay-attempts")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("want 501, got %d", rec.Code)
	}
}

// ── handleRelayAttemptByID: relay == nil (line 169) ──

func TestHandleRelayAttemptByID_RelayNil(t *testing.T) {
	srv := newNoRelayServer(t, model.Actor{ID: "user-1"})
	req := authedGET(t, "/v1/relay-attempts/some-id")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("want 501, got %d", rec.Code)
	}
}

// ── handleRelayAttempts: method not allowed (line 117-120) ──

func TestHandleRelayAttempts_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/relay-attempts", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rec.Code)
	}
}

// ── handleRelayAttempts: bad status filter (line 129-131) ──

func TestHandleRelayAttempts_BadStatusFilter(t *testing.T) {
	srv := newTestServer(t, model.Actor{ID: "user-1"})
	req := authedGET(t, "/v1/relay-attempts?status=invalid")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

// ── NewServer: maxJSONBodyBytes <= 0 → default (line 50-52) ──

func TestNewServer_DefaultMaxJSONBody(t *testing.T) {
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	auditService := audit.NewService(audit.NewMemoryStore())
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), auditService)
	identityService := identityvault.NewService(identityvault.NewMemoryRepository())
	authenticator := auth.NewStaticTokenAuthenticator(map[string]model.Actor{})
	// maxJSONBodyBytes = 0 → should default to 256*1024
	srv := NewServer(authenticator, aliasService, submissionPolicy, submissions, auditService, identityService, gateway, nil, nil, 0)
	if srv.maxJSONBodyBytes != 256*1024 {
		t.Errorf("maxJSONBodyBytes = %d, want %d", srv.maxJSONBodyBytes, 256*1024)
	}
}
