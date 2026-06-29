package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"privacy-gateway/internal/model"
)

// TestIntakeSubmissionByIDErrorPaths covers a number of error-path branches of
// handleIntakeSubmissionByID.
func TestIntakeSubmissionByIDErrorPaths(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "intake-user", TenantID: "tenant-1"})

	cases := []struct {
		name   string
		method string
		path   string
		want   int
	}{
		{"queue wrong method", http.MethodGet, "/v1/intake/submissions/sub_x/queue", http.StatusMethodNotAllowed},
		{"queue unknown id", http.MethodPost, "/v1/intake/submissions/sub_missing/queue", http.StatusNotFound},
		{"release wrong method", http.MethodGet, "/v1/intake/submissions/sub_x/release", http.StatusMethodNotAllowed},
		{"release unknown id", http.MethodPost, "/v1/intake/submissions/sub_missing/release", http.StatusNotFound},
		{"relay wrong method", http.MethodGet, "/v1/intake/submissions/sub_x/relay", http.StatusMethodNotAllowed},
		{"relay unknown id", http.MethodPost, "/v1/intake/submissions/sub_missing/relay", http.StatusNotFound},
		{"timeline wrong method", http.MethodPost, "/v1/intake/submissions/sub_x/timeline", http.StatusMethodNotAllowed},
		{"detail wrong method", http.MethodDelete, "/v1/intake/submissions/sub_x", http.StatusMethodNotAllowed},
		{"detail unknown id", http.MethodGet, "/v1/intake/submissions/sub_missing", http.StatusNotFound},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Header.Set("Authorization", "Bearer intake-token")
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("expected status %d for %s, got %d (body=%s)", tc.want, tc.path, rec.Code, rec.Body.String())
			}
		})
	}
}

// TestIntakeSubmissionsValidationErrors exercises validation error branches of
// handleIntakeSubmissions.
func TestIntakeSubmissionsValidationErrors(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "intake-user", TenantID: "tenant-1"})

	cases := []struct {
		name string
		body string
		want int
	}{
		{"missing channel_id", `{"subject":"Hi","text_body":"Body"}`, http.StatusBadRequest},
		{"html body rejected", `{"channel_id":"c1","subject":"Hi","html_body":"<p>x</p>"}`, http.StatusBadRequest},
		{"empty body rejected", `{"channel_id":"c1","subject":"Hi"}`, http.StatusBadRequest},
		{"invalid sanitizer profile", `{"channel_id":"c1","subject":"Hi","text_body":"Body","sanitizer_profile":"lax"}`, http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(tc.body))
			req.Header.Set("Authorization", "Bearer intake-token")
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("expected status %d, got %d for body %s: %s", tc.want, rec.Code, tc.body, rec.Body.String())
			}
		})
	}
}

// TestIntakeSubmissionsWrongMethod exercises the non-POST branch.
func TestIntakeSubmissionsWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "intake-user", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodGet, "/v1/intake/submissions", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestIntakeSubmissionsMissingAuth verifies 401 is returned without a token.
func TestIntakeSubmissionsMissingAuth(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "intake-user", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"c1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

// TestIntakeDashboardValidationErrors covers invalid limit parameters.
func TestIntakeDashboardValidationErrors(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "intake-user", TenantID: "tenant-1"})

	cases := []string{
		"/v1/intake/dashboard?problem_limit=0",
		"/v1/intake/dashboard?problem_limit=abc",
		"/v1/intake/dashboard?recent_limit=0",
		"/v1/intake/dashboard?recent_limit=abc",
	}

	for _, path := range cases {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Authorization", "Bearer intake-token")
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 for %s, got %d", path, rec.Code)
			}
		})
	}
}

// TestIntakeDashboardWrongMethod covers the non-GET branch.
func TestIntakeDashboardWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "intake-user", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/intake/dashboard", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestIntakeTimelineWrongMethod covers the non-GET branch.
func TestIntakeTimelineWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "intake-user", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/intake/timeline", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestIntakeQueueWrongMethod covers the non-GET branch of handleIntakeQueue.
func TestIntakeQueueWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "intake-user", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/intake/queue", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestHandleMessagesWrongMethod covers the non-POST branch of handleMessages.
func TestHandleMessagesWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodGet, "/v1/messages", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestHandleMessagesBadBody covers the decodeJSONBody error branch.
func TestHandleMessagesBadBody(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewBufferString("{not-json"))
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

// TestHandleMessagesPolicyRejection covers the policy-error branch of handleMessages.
func TestHandleMessagesPolicyRejection(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	// No recipients in body triggers policy.ErrNoRecipients.
	body := `{"alias_id":"al_missing","subject":"Hi","text_body":"Body"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	// Missing alias and missing recipients both produce 4xx; make sure we do not
	// get a 5xx.
	if rec.Code >= 500 {
		t.Fatalf("expected 4xx, got %d", rec.Code)
	}
}

// TestHandleOutboxWrongMethod covers the non-GET branch of handleOutbox.
func TestHandleOutboxWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/outbox", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestHandleInboxWrongMethod covers the non-GET branch of handleInbox.
func TestHandleInboxWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/inbox", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestHandleInboxSyncWrongMethodAndMissingSyncer covers method-not-allowed and
// not-implemented branches of handleInboxSync.
func TestHandleInboxSyncWrongMethodAndMissingSyncer(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	// GET should be rejected.
	req := httptest.NewRequest(http.MethodGet, "/v1/messages/inbox/sync", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}

	// POST should hit the not-implemented branch because inboxSyncer is nil.
	req = httptest.NewRequest(http.MethodPost, "/v1/messages/inbox/sync", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec = httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d", rec.Code)
	}
}

// TestHandleRelayAttemptsUnauthenticated exercises the auth-fail branch.
func TestHandleRelayAttemptsUnauthenticated(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodGet, "/v1/relay-attempts", nil)
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

// TestHandleDashboardWrongMethod covers the non-GET branch of handleDashboard.
func TestHandleDashboardWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/dashboard", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestHandleAliasesWrongMethod covers the unknown-method branch of handleAliases.
func TestHandleAliasesWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodDelete, "/v1/aliases", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestHandleChannelsInvalidBooleans covers the has_inbox/has_failures parse-error branches.
func TestHandleChannelsInvalidBooleans(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	cases := []string{
		"/v1/channels?has_inbox=not-a-bool",
		"/v1/channels?has_failures=not-a-bool",
	}
	for _, path := range cases {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Authorization", "Bearer token")
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 for %s, got %d", path, rec.Code)
			}
		})
	}
}

// TestHandleChannelsWrongMethod covers the non-GET branch of handleChannels.
func TestHandleChannelsWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/channels", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestHandleIdentityLinkByAliasIDWrongMethod exercises the non-GET/POST branch.
func TestHandleIdentityLinkByAliasIDWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodDelete, "/v1/identity-links/alias_x", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// TestHandleIdentityLinkByAliasIDUnknownAlias covers the repo-not-found branch.
func TestHandleIdentityLinkByAliasIDUnknownAlias(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodGet, "/v1/identity-links/alias_missing", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

// TestHandleRelayQueueWrongMethod covers the non-GET branch of handleRelayQueue.
func TestHandleRelayQueueWrongMethod(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/relay-queue", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}
