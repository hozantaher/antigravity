package web

import (
	"relay/internal/abuse"
	"relay/internal/audit"
	"relay/internal/intake/auth"
	"relay/internal/boundary"
	"relay/internal/delivery/contentenc"
	"relay/internal/filestore"
	"relay/internal/identity"
	"relay/internal/intake"
	"relay/internal/transport/metamin"
	"relay/internal/minlog"
	"relay/internal/model"
	"relay/internal/msgbus"
	"relay/internal/relay"
	"relay/internal/delivery/sanitizer"
	"relay/internal/vault"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()

	// Vault key
	vaultKey := make([]byte, 32)
	for i := range vaultKey {
		vaultKey[i] = byte(i + 1)
	}
	vaultKeyB64 := base64.StdEncoding.EncodeToString(vaultKey)

	// Data codec
	dataKey := make([]byte, 32)
	for i := range dataKey {
		dataKey[i] = byte(i + 100)
	}
	dataCodec, _ := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(dataKey))

	// Services
	vaultSvc, err := vault.NewFileVault(filepath.Join(dir, "vault.json"), vaultKeyB64, 0)
	if err != nil {
		t.Fatal(err)
	}
	identitySvc := identity.NewService(vaultSvc)
	sanitizerSvc := sanitizer.NewService()
	minimizer := metamin.NewMinimizer()
	sealer := contentenc.NewSealer()
	bus := msgbus.NewChannelBus(64)
	limiter := abuse.NewLimiter(5)
	logger := minlog.New("test")

	auditSvc, _ := audit.NewService(filepath.Join(dir, "audit.json"), dataCodec, 0)
	scheduler, _ := relay.NewScheduler(
		filepath.Join(dir, "relay.json"), dataCodec,
		time.Millisecond, 10*time.Millisecond, 0,
	)
	exitVerifier, _ := boundary.NewExitVerifier(filepath.Join(dir, "channels.json"), dataCodec)

	pipeline := intake.NewPipeline(sanitizerSvc, identitySvc, minimizer, sealer, bus, auditSvc, limiter, logger)

	token := "test-token-12345"
	authenticator := auth.NewStaticTokenAuthenticator(map[string]model.Actor{
		token: {ID: "user-1", TenantID: "tenant-1"},
	})

	server := NewServer(authenticator, pipeline, scheduler, auditSvc, vaultSvc, exitVerifier, limiter)
	return server, token
}

func TestHealthz(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["status"] != "ok" {
		t.Fatalf("expected ok, got %s", body["status"])
	}
}

func TestSubmitUnauthorized(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(`{"recipient":"a@b.com","body":"test"}`))
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestSubmitSuccess(t *testing.T) {
	server, token := testServer(t)
	body := `{"recipient":"person@example.com","subject":"Help","body":"I need help"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}

	var result map[string]any
	json.NewDecoder(w.Body).Decode(&result)
	if result["envelope_id"] == nil || result["envelope_id"] == "" {
		t.Fatal("expected envelope_id in response")
	}
	if result["status"] != model.StatusSealed {
		t.Fatalf("expected status=sealed, got %v", result["status"])
	}
}

func TestSubmitBlockedContent(t *testing.T) {
	server, token := testServer(t)
	body := `{"recipient":"person@example.com","subject":"Test","body":"<script>alert('xss')</script>"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSubmitInvalidRecipient(t *testing.T) {
	server, token := testServer(t)
	body := `{"recipient":"not-an-email","subject":"Test","body":"Hello"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSubmitRateLimited(t *testing.T) {
	server, token := testServer(t)

	// Exhaust rate limit (set to 5 per minute in testServer)
	for i := 0; i < 5; i++ {
		body := `{"recipient":"person@example.com","subject":"Test","body":"Hello"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, req)
	}

	// Next request should be rate limited
	body := `{"recipient":"person@example.com","subject":"Test","body":"Hello"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", w.Code)
	}
}

func TestAuditEventsAfterSubmit(t *testing.T) {
	server, token := testServer(t)

	// Submit one envelope
	body := `{"recipient":"person@example.com","subject":"Help","body":"I need help"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("submit failed: %d %s", w.Code, w.Body.String())
	}

	// Check audit events
	req2 := httptest.NewRequest(http.MethodGet, "/v1/audit-events", nil)
	req2.Header.Set("Authorization", "Bearer "+token)
	w2 := httptest.NewRecorder()
	server.Handler().ServeHTTP(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("audit events failed: %d", w2.Code)
	}

	var auditResp struct {
		Events []model.AuditEntry `json:"events"`
	}
	json.NewDecoder(w2.Body).Decode(&auditResp)

	if len(auditResp.Events) == 0 {
		t.Fatal("expected at least one audit event after submit")
	}

	// Verify audit entries have NO content, NO IP
	for _, e := range auditResp.Events {
		if e.EventType == "" {
			t.Fatal("audit event missing event_type")
		}
		if e.EnvelopeID == "" {
			t.Fatal("audit event missing envelope_id")
		}
		// Verify bucketed timestamp (should be truncated to 15-min)
		if e.BucketedAt.Minute()%15 != 0 {
			t.Fatalf("audit timestamp not bucketed: %v", e.BucketedAt)
		}
		if e.BucketedAt.Second() != 0 || e.BucketedAt.Nanosecond() != 0 {
			t.Fatalf("audit timestamp has sub-minute precision: %v", e.BucketedAt)
		}
	}
}

func TestStatusEndpoint(t *testing.T) {
	server, token := testServer(t)
	server = server.WithDeliveryMode("bridge")

	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["delivery_mode"] != "bridge" {
		t.Errorf("expected delivery_mode=bridge, got %v", resp["delivery_mode"])
	}
	if _, ok := resp["pending_envelopes"]; !ok {
		t.Error("missing pending_envelopes in status response")
	}
	if _, ok := resp["uptime_seconds"]; !ok {
		t.Error("missing uptime_seconds in status response")
	}
}

func TestStatusUnauthorized(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestSecurityHeaders(t *testing.T) {
	server, _ := testServer(t)
	handler := SecurityHeadersMiddleware(server.Handler())

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	headers := map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":          "DENY",
		"Cache-Control":            "no-store",
		"Content-Security-Policy":  "default-src 'none'",
		"Referrer-Policy":          "no-referrer",
	}
	for name, expected := range headers {
		if got := w.Header().Get(name); got != expected {
			t.Errorf("header %s: got %q, want %q", name, got, expected)
		}
	}
}

func TestCORSRejection(t *testing.T) {
	server, _ := testServer(t)
	handler := SecurityHeadersMiddleware(server.Handler())

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Origin", "https://evil.com")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-origin, got %d", w.Code)
	}
}

func TestIntakeChannelContext(t *testing.T) {
	server, token := testServer(t)

	// Wrap with onion channel
	handler := WithIntakeChannel(server.Handler(), "onion")

	body := `{"recipient":"person@example.com","subject":"Help","body":"via onion"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
}

func TestIdentitiesListEmpty(t *testing.T) {
	server, token := testServer(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/identities", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

// --- M1: Queue metrics in /v1/status ---

func TestStatusIncludesQueueMetrics(t *testing.T) {
	server, token := testServer(t)
	server = server.WithDeliveryMode("bridge")

	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	if _, ok := resp["queue_depth"]; !ok {
		t.Error("missing queue_depth in status response")
	}
	if _, ok := resp["oldest_pending_age_seconds"]; !ok {
		t.Error("missing oldest_pending_age_seconds in status response")
	}
}

// --- M1: /v1/health endpoint ---

type reachableBridgeChecker struct{}

func (r *reachableBridgeChecker) HealthCheck(_ context.Context) error { return nil }

type unreachableBridgeChecker struct{}

func (u *unreachableBridgeChecker) HealthCheck(_ context.Context) error {
	return fmt.Errorf("gateway unreachable")
}

func TestHealthEndpointReachable(t *testing.T) {
	server, _ := testServer(t)
	server = server.WithBridge(&reachableBridgeChecker{}, "bridge")

	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["status"] != "ok" {
		t.Errorf("expected status=ok, got %q", body["status"])
	}
}

func TestHealthEndpointUnreachable(t *testing.T) {
	server, _ := testServer(t)
	server = server.WithBridge(&unreachableBridgeChecker{}, "bridge")

	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", w.Code, w.Body.String())
	}

	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["status"] != "unreachable" {
		t.Errorf("expected status=unreachable, got %q", body["status"])
	}
}

func TestHealthEndpointNoBridgeConfigured(t *testing.T) {
	server, _ := testServer(t)
	// No bridge configured

	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	// With no bridge configured, health check should return 503
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when no bridge configured, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHealthEndpointMethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)
	server = server.WithBridge(&reachableBridgeChecker{}, "bridge")

	req := httptest.NewRequest(http.MethodPost, "/v1/health", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestExitChannelsRegisterAndList(t *testing.T) {
	server, token := testServer(t)

	// Register channel
	body := `{"name":"test-smtp","type":"smtp"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/exit-channels", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("register: expected 201, got %d: %s", w.Code, w.Body.String())
	}

	// List channels
	req2 := httptest.NewRequest(http.MethodGet, "/v1/exit-channels", nil)
	req2.Header.Set("Authorization", "Bearer "+token)
	w2 := httptest.NewRecorder()
	server.Handler().ServeHTTP(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", w2.Code)
	}

	var resp struct {
		Channels []model.ExitChannel `json:"channels"`
	}
	json.NewDecoder(w2.Body).Decode(&resp)
	if len(resp.Channels) != 1 {
		t.Fatalf("expected 1 channel, got %d", len(resp.Channels))
	}
	if resp.Channels[0].Name != "test-smtp" {
		t.Fatalf("expected channel name test-smtp, got %s", resp.Channels[0].Name)
	}
}
