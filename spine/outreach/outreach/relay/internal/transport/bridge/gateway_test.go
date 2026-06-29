package bridge

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func init() {
	// Replace real sleep with a no-op so retry tests run instantly.
	retryWait = func(_ context.Context, _ time.Duration) bool { return true }
}

func TestForwardSubmissionSuccess(t *testing.T) {
	var gotPayload map[string]any
	var gotAuth string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/intake/submissions" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}
		gotAuth = r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&gotPayload)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"id": "sub_123"})
	}))
	defer server.Close()

	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "test-token",
	}, minlog.New("test"))

	env := model.Envelope{ID: "env_001"}
	result, err := b.ForwardSubmission(context.Background(), env, "person@example.com", "Help", "I need help")
	if err != nil {
		t.Fatalf("ForwardSubmission error: %v", err)
	}

	if gotAuth != "Bearer test-token" {
		t.Errorf("auth = %q, want Bearer test-token", gotAuth)
	}
	if gotPayload["channel_id"] != "anti-trace-relay" {
		t.Errorf("channel_id = %v, want anti-trace-relay", gotPayload["channel_id"])
	}
	to, ok := gotPayload["to"].([]any)
	if !ok || len(to) != 1 || to[0] != "person@example.com" {
		t.Errorf("to = %v, want [person@example.com]", gotPayload["to"])
	}
	if gotPayload["subject"] != "Help" {
		t.Errorf("subject = %v, want Help", gotPayload["subject"])
	}
	if result.EnvelopeID != "env_001" {
		t.Errorf("EnvelopeID = %s, want env_001", result.EnvelopeID)
	}
	if result.StatusCode != http.StatusCreated {
		t.Errorf("StatusCode = %d, want 201", result.StatusCode)
	}
}

func TestForwardSubmissionGatewayRejects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(map[string]string{"error": "policy violation"})
	}))
	defer server.Close()

	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "tok",
	}, minlog.New("test"))

	_, err := b.ForwardSubmission(context.Background(), model.Envelope{ID: "env_002"}, "a@b.com", "S", "B")
	if err == nil {
		t.Fatal("expected error for 422 response")
	}
}

func TestForwardSubmissionGatewayUnreachable(t *testing.T) {
	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: "http://127.0.0.1:1", // nothing listening
		Token:      "tok",
	}, minlog.New("test"))

	_, err := b.ForwardSubmission(context.Background(), model.Envelope{ID: "env_003"}, "a@b.com", "S", "B")
	if err == nil {
		t.Fatal("expected error for unreachable gateway")
	}
}

func TestHealthCheckSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))
	defer server.Close()

	b := NewPrivacyGatewayBridge(BridgeConfig{GatewayURL: server.URL}, minlog.New("test"))
	if err := b.HealthCheck(context.Background()); err != nil {
		t.Fatalf("HealthCheck error: %v", err)
	}
}

func TestHealthCheckFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	b := NewPrivacyGatewayBridge(BridgeConfig{GatewayURL: server.URL}, minlog.New("test"))
	if err := b.HealthCheck(context.Background()); err == nil {
		t.Fatal("expected error for 503 health check")
	}
}

func TestHealthCheckUnreachable(t *testing.T) {
	b := NewPrivacyGatewayBridge(BridgeConfig{GatewayURL: "http://127.0.0.1:1"}, minlog.New("test"))
	if err := b.HealthCheck(context.Background()); err == nil {
		t.Fatal("expected error for unreachable gateway")
	}
}

func TestCreateAliasSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/aliases" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["label"] != "whistleblower-channel" {
			t.Errorf("label = %s, want whistleblower-channel", body["label"])
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(AliasResult{
			ID:    "alias_1",
			Email: "wb@relay.example",
			Label: body["label"],
		})
	}))
	defer server.Close()

	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "tok",
	}, minlog.New("test"))

	result, err := b.CreateAlias(context.Background(), "whistleblower-channel")
	if err != nil {
		t.Fatalf("CreateAlias error: %v", err)
	}
	if result.ID != "alias_1" {
		t.Errorf("ID = %s, want alias_1", result.ID)
	}
	if result.Email != "wb@relay.example" {
		t.Errorf("Email = %s, want wb@relay.example", result.Email)
	}
	if result.StatusCode != http.StatusCreated {
		t.Errorf("StatusCode = %d, want 201", result.StatusCode)
	}
}

// --- Delivery Outcome Recording Tests (M1) ---

// stubAuditRecorder captures calls to RecordWithOutcome for test assertions.
type stubAuditRecorder struct {
	calls []auditCall
}

type auditCall struct {
	tenantID   string
	eventType  string
	envelopeID string
	outcome    string
	httpStatus int
}

func (s *stubAuditRecorder) RecordWithOutcome(_ context.Context, tenantID, eventType, envelopeID, outcome string, httpStatus int) error {
	s.calls = append(s.calls, auditCall{
		tenantID:   tenantID,
		eventType:  eventType,
		envelopeID: envelopeID,
		outcome:    outcome,
		httpStatus: httpStatus,
	})
	return nil
}

func TestForwardSubmissionRecordsSuccessOutcome(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"id": "sub_456"})
	}))
	defer server.Close()

	recorder := &stubAuditRecorder{}
	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "tok",
	}, minlog.New("test"))
	b.WithAudit(recorder)

	env := model.Envelope{ID: "env_out_001", TenantID: "tenant-x"}
	_, err := b.ForwardSubmission(context.Background(), env, "r@example.com", "Sub", "Body")
	if err != nil {
		t.Fatalf("ForwardSubmission error: %v", err)
	}

	if len(recorder.calls) != 1 {
		t.Fatalf("expected 1 audit call, got %d", len(recorder.calls))
	}
	call := recorder.calls[0]
	if call.eventType != model.EventBridgeDelivered {
		t.Errorf("eventType = %q, want %q", call.eventType, model.EventBridgeDelivered)
	}
	if call.outcome != model.OutcomeSuccess {
		t.Errorf("outcome = %q, want %q", call.outcome, model.OutcomeSuccess)
	}
	if call.httpStatus != http.StatusCreated {
		t.Errorf("httpStatus = %d, want 201", call.httpStatus)
	}
	if call.envelopeID != "env_out_001" {
		t.Errorf("envelopeID = %q, want env_out_001", call.envelopeID)
	}
	if call.tenantID != "tenant-x" {
		t.Errorf("tenantID = %q, want tenant-x", call.tenantID)
	}
}

func TestForwardSubmissionRecordsFailureOutcome_NonOK(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": "upstream error"})
	}))
	defer server.Close()

	recorder := &stubAuditRecorder{}
	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "tok",
	}, minlog.New("test"))
	b.WithAudit(recorder)

	env := model.Envelope{ID: "env_out_002", TenantID: "tenant-y"}
	_, err := b.ForwardSubmission(context.Background(), env, "r@example.com", "Sub", "Body")
	if err == nil {
		t.Fatal("expected error for non-2xx response")
	}

	if len(recorder.calls) != 1 {
		t.Fatalf("expected 1 audit call, got %d", len(recorder.calls))
	}
	call := recorder.calls[0]
	if call.eventType != model.EventBridgeFailed {
		t.Errorf("eventType = %q, want %q", call.eventType, model.EventBridgeFailed)
	}
	if call.outcome != "transient_failure_max_retries" {
		t.Errorf("outcome = %q, want %q", call.outcome, "transient_failure_max_retries")
	}
	if call.httpStatus != http.StatusBadGateway {
		t.Errorf("httpStatus = %d, want 502", call.httpStatus)
	}
}

func TestForwardSubmissionRecordsFailureOutcome_ConnectionError(t *testing.T) {
	recorder := &stubAuditRecorder{}
	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: "http://127.0.0.1:1", // nothing listening
		Token:      "tok",
	}, minlog.New("test"))
	b.WithAudit(recorder)

	env := model.Envelope{ID: "env_out_003", TenantID: "tenant-z"}
	_, err := b.ForwardSubmission(context.Background(), env, "r@example.com", "Sub", "Body")
	if err == nil {
		t.Fatal("expected error for connection failure")
	}

	if len(recorder.calls) != 1 {
		t.Fatalf("expected 1 audit call, got %d", len(recorder.calls))
	}
	call := recorder.calls[0]
	if call.eventType != model.EventBridgeFailed {
		t.Errorf("eventType = %q, want %q", call.eventType, model.EventBridgeFailed)
	}
	if call.outcome != "transient_failure_max_retries" {
		t.Errorf("outcome = %q, want %q", call.outcome, "transient_failure_max_retries")
	}
	// httpStatus should be 0 for connection errors (no HTTP response)
	if call.httpStatus != 0 {
		t.Errorf("httpStatus = %d, want 0 for connection error", call.httpStatus)
	}
}

func TestForwardSubmissionNoAuditNoError(t *testing.T) {
	// When no audit recorder is set, ForwardSubmission should still work without errors.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"id": "sub_789"})
	}))
	defer server.Close()

	b := NewPrivacyGatewayBridge(BridgeConfig{
		GatewayURL: server.URL,
		Token:      "tok",
	}, minlog.New("test"))
	// No b.WithAudit() call

	env := model.Envelope{ID: "env_no_audit", TenantID: "tenant-a"}
	_, err := b.ForwardSubmission(context.Background(), env, "r@example.com", "Sub", "Body")
	if err != nil {
		t.Fatalf("ForwardSubmission error without audit recorder: %v", err)
	}
}
