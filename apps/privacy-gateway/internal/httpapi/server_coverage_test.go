package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"privacy-gateway/internal/model"
)

// TestAuditEventMatchesAliasBranches exercises each branch of auditEventMatchesAlias.
func TestAuditEventMatchesAliasBranches(t *testing.T) {
	submissionIDs := map[string]struct{}{"sub_1": {}}

	cases := []struct {
		name  string
		event model.AuditEvent
		want  bool
	}{
		{
			name:  "resource id matches alias",
			event: model.AuditEvent{ResourceID: "alias_1"},
			want:  true,
		},
		{
			name:  "metadata alias_id match",
			event: model.AuditEvent{Metadata: map[string]string{"alias_id": "alias_1"}},
			want:  true,
		},
		{
			name:  "metadata channel_id match",
			event: model.AuditEvent{Metadata: map[string]string{"channel_id": "alias_1"}},
			want:  true,
		},
		{
			name:  "metadata submission_id in set",
			event: model.AuditEvent{Metadata: map[string]string{"submission_id": "sub_1"}},
			want:  true,
		},
		{
			name:  "metadata submission_id not in set",
			event: model.AuditEvent{Metadata: map[string]string{"submission_id": "sub_other"}},
			want:  false,
		},
		{
			name:  "resource id matches submission id in set",
			event: model.AuditEvent{ResourceID: "sub_1", Metadata: map[string]string{}},
			want:  true,
		},
		{
			name:  "nothing matches",
			event: model.AuditEvent{ResourceID: "other", Metadata: map[string]string{}},
			want:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := auditEventMatchesAlias(tc.event, "alias_1", submissionIDs); got != tc.want {
				t.Fatalf("auditEventMatchesAlias = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestCanRelaySubmissionBranches exercises each branch of canRelaySubmission.
func TestCanRelaySubmissionBranches(t *testing.T) {
	cases := []struct {
		name   string
		record model.Submission
		want   bool
	}{
		{"accepted", model.Submission{Status: model.SubmissionStatusAccepted}, true},
		{"sanitized", model.Submission{Status: model.SubmissionStatusSanitized}, true},
		{"queued", model.Submission{Status: model.SubmissionStatusQueued}, true},
		{"failed retryable", model.Submission{Status: model.SubmissionStatusFailed, RelayFailureDisposition: "retryable"}, true},
		{"failed terminal", model.Submission{Status: model.SubmissionStatusFailed, RelayFailureDisposition: "terminal"}, false},
		{"relayed", model.Submission{Status: model.SubmissionStatusRelayed}, false},
		{"blocked", model.Submission{Status: model.SubmissionStatusBlocked}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := canRelaySubmission(tc.record); got != tc.want {
				t.Fatalf("canRelaySubmission = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestIsValidSubmissionStatusFilterBranches exercises isValidSubmissionStatusFilter.
func TestIsValidSubmissionStatusFilterBranches(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{"accepted", "accepted", true},
		{"queued", "queued", true},
		{"sanitized", "sanitized", true},
		{"relayed", "relayed", true},
		{"failed", "failed", true},
		{"blocked", "blocked", true},
		{"unknown", "not_a_status", false},
		{"empty", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isValidSubmissionStatusFilter(tc.value); got != tc.want {
				t.Fatalf("isValidSubmissionStatusFilter(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

// TestIsValidSubmissionStatusBranches covers the model-typed version.
func TestIsValidSubmissionStatusBranches(t *testing.T) {
	valid := []model.SubmissionStatus{
		model.SubmissionStatusAccepted,
		model.SubmissionStatusQueued,
		model.SubmissionStatusSanitized,
		model.SubmissionStatusRelayed,
		model.SubmissionStatusFailed,
		model.SubmissionStatusBlocked,
	}
	for _, status := range valid {
		if !isValidSubmissionStatus(status) {
			t.Fatalf("expected %q to be valid", status)
		}
	}
	if isValidSubmissionStatus(model.SubmissionStatus("bogus")) {
		t.Fatal("expected bogus status to be invalid")
	}
}

// TestHandleAliasByIDErrorPaths covers the empty-path and wrong-method branches
// of handleAliasByID and the trailing-slash branch for nested sub-paths.
func TestHandleAliasByIDErrorPaths(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	cases := []struct {
		name   string
		method string
		path   string
		want   int
	}{
		{"unauthenticated list", http.MethodGet, "/v1/aliases/", http.StatusUnauthorized},
		{"unknown alias detail", http.MethodGet, "/v1/aliases/unknown", http.StatusNotFound},
		{"wrong method timeline", http.MethodDelete, "/v1/aliases/abc/timeline", http.StatusMethodNotAllowed},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.name != "unauthenticated list" {
				req.Header.Set("Authorization", "Bearer token")
			}
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("expected status %d, got %d (body=%s)", tc.want, rec.Code, rec.Body.String())
			}
		})
	}
}

// TestHandleInboxByIDErrorPaths covers the error paths of handleInboxByID.
func TestHandleInboxByIDErrorPaths(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	cases := []struct {
		name   string
		method string
		path   string
		want   int
	}{
		{"wrong method timeline", http.MethodPost, "/v1/messages/inbox/abc/timeline", http.StatusMethodNotAllowed},
		{"unknown sub path", http.MethodGet, "/v1/messages/inbox/abc/bogus", http.StatusNotFound},
		{"unknown message timeline", http.MethodGet, "/v1/messages/inbox/missing/timeline", http.StatusNotFound},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Header.Set("Authorization", "Bearer token")
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("expected status %d, got %d", tc.want, rec.Code)
			}
		})
	}
}

// TestHandleSubmissionByIDErrorPaths covers error branches of handleSubmissionByID.
func TestHandleSubmissionByIDErrorPaths(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	cases := []struct {
		name   string
		method string
		path   string
		want   int
	}{
		{"timeline wrong method", http.MethodPost, "/v1/submissions/abc/timeline", http.StatusMethodNotAllowed},
		{"queue wrong method", http.MethodGet, "/v1/submissions/abc/queue", http.StatusMethodNotAllowed},
		{"queue unknown id", http.MethodPost, "/v1/submissions/sub_missing/queue", http.StatusNotFound},
		{"release wrong method", http.MethodGet, "/v1/submissions/abc/release", http.StatusMethodNotAllowed},
		{"release unknown id", http.MethodPost, "/v1/submissions/sub_missing/release", http.StatusNotFound},
		{"relay wrong method", http.MethodGet, "/v1/submissions/abc/relay", http.StatusMethodNotAllowed},
		{"relay unknown id", http.MethodPost, "/v1/submissions/sub_missing/relay", http.StatusNotFound},
		{"detail wrong method", http.MethodDelete, "/v1/submissions/abc", http.StatusMethodNotAllowed},
		{"detail unknown id", http.MethodGet, "/v1/submissions/sub_missing", http.StatusNotFound},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Header.Set("Authorization", "Bearer token")
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("expected status %d, got %d (body=%s)", tc.want, rec.Code, rec.Body.String())
			}
		})
	}
}

// TestHandleRelayAttemptByIDErrorPaths exercises wrong method and missing id.
func TestHandleRelayAttemptByIDErrorPaths(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	cases := []struct {
		name   string
		method string
		path   string
		want   int
	}{
		{"wrong method", http.MethodPost, "/v1/relay-attempts/att_1", http.StatusMethodNotAllowed},
		{"unknown id", http.MethodGet, "/v1/relay-attempts/att_missing", http.StatusNotFound},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Header.Set("Authorization", "Bearer token")
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("expected status %d, got %d", tc.want, rec.Code)
			}
		})
	}
}

// TestHandleRelayAttemptsInvalidLimit exercises the limit validation branch.
func TestHandleRelayAttemptsInvalidLimit(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	cases := []string{
		"/v1/relay-attempts?limit=abc",
		"/v1/relay-attempts?limit=0",
		"/v1/relay-attempts?limit=-5",
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

// TestHandleRelayAttemptsLimitAndSubmissionFilter covers the positive filter paths.
func TestHandleRelayAttemptsLimitAndSubmissionFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createdAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "ops"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	for _, subID := range []string{"sub_a", "sub_b", "sub_c"} {
		if _, _, err := server.relay.Relay(context.Background(), subID, model.SanitizedMessage{
			Actor:    actor,
			Alias:    createdAlias,
			To:       []string{"dest@example.com"},
			Subject:  "hi",
			TextBody: "body",
		}); err != nil {
			t.Fatalf("Relay(%s) error = %v", subID, err)
		}
	}

	// limit=2 should cap the results at two items.
	req := httptest.NewRequest(http.MethodGet, "/v1/relay-attempts?limit=2", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "relay_attempts") {
		t.Fatalf("expected relay_attempts in body, got %s", rec.Body.String())
	}

	// submission_id filter should return exactly the one sub_b entry.
	req = httptest.NewRequest(http.MethodGet, "/v1/relay-attempts?submission_id=sub_b", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec = httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for submission filter, got %d", rec.Code)
	}
}

// TestDecodeOptionalJSONBodyTooLarge verifies the size-limit branch.
func TestDecodeOptionalJSONBodyTooLarge(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	// maxJSONBodyBytes = 4096 in tests; post a body that exceeds that.
	// identity-links/revoke is the optional-body consumer.
	big := bytes.Repeat([]byte{'A'}, 8192)
	req := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias_x/revoke", bytes.NewReader(big))
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized optional body, got %d", rec.Code)
	}
}

// TestDecodeOptionalJSONBodyInvalidJSON verifies the invalid-JSON branch.
func TestDecodeOptionalJSONBodyInvalidJSON(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias_x/revoke", bytes.NewBufferString("{not-json"))
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid JSON body, got %d", rec.Code)
	}
}

// TestDecodeOptionalJSONBodyTrailingContent verifies the trailing-content branch.
func TestDecodeOptionalJSONBodyTrailingContent(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias_x/revoke", bytes.NewBufferString(`{} "extra"`))
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for trailing content, got %d", rec.Code)
	}
}

// TestDecodeOptionalJSONBodyEmptyAccepted verifies the empty-body branch.
func TestDecodeOptionalJSONBodyEmptyAccepted(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	// empty body must be accepted by decodeOptionalJSONBody (returns true without
	// decoding). The subsequent RevokeByAliasID returns 404 for missing alias.
	req := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias_x/revoke", bytes.NewReader(nil))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 (empty body accepted, alias missing), got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleRelayAttemptsMethodNotAllowed exercises the non-GET branch.
func TestHandleRelayAttemptsMethodNotAllowed(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	req := httptest.NewRequest(http.MethodPost, "/v1/relay-attempts", bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}
