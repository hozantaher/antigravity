package bridge

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ---------------------------------------------------------------------------
// ForwardSubmission — non-JSON response body (covers line 108-110)
// ---------------------------------------------------------------------------

// TestForwardSubmission_NonJSONResponseBody verifies that when the gateway
// returns 2xx with a non-JSON body, ForwardSubmission stores the raw body
// instead of panicking or returning an error.
func TestForwardSubmission_NonJSONResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte("not json at all {{"))
	}))
	defer server.Close()

	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "tok",
	}, minlog.New("test"))

	env := model.Envelope{ID: "env_raw_body"}
	result, err := b.ForwardSubmission(context.Background(), env, "a@b.com", "S", "B")
	if err != nil {
		t.Fatalf("expected success for non-JSON 2xx body, got error: %v", err)
	}
	if result.Raw == "" {
		t.Error("expected Raw to be populated when JSON unmarshal fails")
	}
	if result.StatusCode != http.StatusCreated {
		t.Errorf("expected StatusCode=201, got %d", result.StatusCode)
	}
}

// ---------------------------------------------------------------------------
// CreateAlias — error paths (covers lines 175-177 and 181-183)
// ---------------------------------------------------------------------------

// TestCreateAlias_Unreachable verifies CreateAlias returns an error when the
// gateway is unreachable (covers the client.Do error path, line 175-177).
func TestCreateAlias_Unreachable(t *testing.T) {
	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: "http://127.0.0.1:1",
		Token:      "tok",
	}, minlog.New("test"))

	_, err := b.CreateAlias(context.Background(), "test-label")
	if err == nil {
		t.Fatal("expected error for unreachable gateway")
	}
}

// TestCreateAlias_NonJSONResponse verifies CreateAlias returns an error when
// the gateway returns a non-JSON response body (covers line 181-183).
func TestCreateAlias_NonJSONResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte("not json {{{{"))
	}))
	defer server.Close()

	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "tok",
	}, minlog.New("test"))

	_, err := b.CreateAlias(context.Background(), "test-label")
	if err == nil {
		t.Fatal("expected error for non-JSON alias response")
	}
}

// ---------------------------------------------------------------------------
// HealthCheck — invalid URL (covers line 192-194)
// ---------------------------------------------------------------------------

// TestHealthCheck_InvalidURL verifies HealthCheck returns an error when the
// gateway URL is malformed and NewRequestWithContext fails (line 192-194).
func TestHealthCheck_InvalidURL(t *testing.T) {
	b := NewPrivacyGatewayBridge(BridgeConfig{
		// URL with a null byte makes http.NewRequestWithContext return an error.
		GatewayURL: "http://\x00invalid",
		Token:      "tok",
	}, minlog.New("test"))

	err := b.HealthCheck(context.Background())
	if err == nil {
		t.Fatal("expected error for invalid gateway URL")
	}
}

// ---------------------------------------------------------------------------
// CreateAlias — invalid URL (covers line 168-170)
// ---------------------------------------------------------------------------

// TestCreateAlias_InvalidURL verifies CreateAlias returns an error when the
// gateway URL is malformed and NewRequestWithContext fails (line 168-170).
func TestCreateAlias_InvalidURL(t *testing.T) {
	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: "http://\x00invalid",
		Token:      "tok",
	}, minlog.New("test"))

	_, err := b.CreateAlias(context.Background(), "test-label")
	if err == nil {
		t.Fatal("expected error for invalid gateway URL")
	}
}

// ---------------------------------------------------------------------------
// ForwardSubmission — invalid URL (covers lines 93-95 in retry func)
// ---------------------------------------------------------------------------

// TestForwardSubmission_InvalidURL verifies ForwardSubmission returns an error
// when the gateway URL is malformed (covers NewRequestWithContext error, line 93-95).
func TestForwardSubmission_InvalidURL(t *testing.T) {
	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: "http://\x00invalid",
		Token:      "tok",
	}, minlog.New("test"))

	_, err := b.ForwardSubmission(context.Background(), model.Envelope{ID: "env_bad"}, "a@b.com", "S", "B")
	if err == nil {
		t.Fatal("expected error for invalid gateway URL in ForwardSubmission")
	}
}

// ---------------------------------------------------------------------------
// Audit: permanent failure classification (covers ForwardSubmission line 130-135)
// ---------------------------------------------------------------------------

// TestForwardSubmission_PermanentFailure_AuditOutcome verifies that 422/4xx
// responses produce a "permanent_failure" audit outcome.
func TestForwardSubmission_PermanentFailure_AuditOutcome(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity) // 422 = permanent
		json.NewEncoder(w).Encode(map[string]string{"error": "policy violation"})
	}))
	defer server.Close()

	recorder := &stubAuditRecorder{}
	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "tok",
	}, minlog.New("test"))
	b.WithAudit(recorder)

	env := model.Envelope{ID: "env_perm_fail", TenantID: "tenant-perm"}
	_, err := b.ForwardSubmission(context.Background(), env, "r@example.com", "Sub", "Body")
	if err == nil {
		t.Fatal("expected error for 422 permanent failure")
	}

	if len(recorder.calls) != 1 {
		t.Fatalf("expected 1 audit call, got %d", len(recorder.calls))
	}
	call := recorder.calls[0]
	if call.outcome != "permanent_failure" {
		t.Errorf("outcome = %q, want permanent_failure", call.outcome)
	}
	if call.eventType != model.EventBridgeFailed {
		t.Errorf("eventType = %q, want %q", call.eventType, model.EventBridgeFailed)
	}
}
