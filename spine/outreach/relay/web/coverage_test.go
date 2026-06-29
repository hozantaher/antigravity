package web

import (
	"relay/internal/deaddrop"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- handleHealthz method-not-allowed ---

func TestHealthzMethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)
	tests := []struct {
		name   string
		method string
	}{
		{"POST", http.MethodPost},
		{"PUT", http.MethodPut},
		{"DELETE", http.MethodDelete},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/healthz", nil)
			w := httptest.NewRecorder()
			server.Handler().ServeHTTP(w, req)
			if w.Code != http.StatusMethodNotAllowed {
				t.Fatalf("expected 405, got %d", w.Code)
			}
		})
	}
}

// --- handleMetrics tests ---

func TestMetricsSuccess(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("expected text/plain content type, got %q", ct)
	}
}

func TestMetricsMethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodPost, "/metrics", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

// --- Submit error branches ---

func TestSubmitMethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/submit", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestSubmitInvalidJSON(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(`{invalid json`))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSubmitMissingRecipient(t *testing.T) {
	server, token := testServer(t)
	body := `{"recipient":"","body":"hello"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSubmitMissingBody(t *testing.T) {
	server, token := testServer(t)
	body := `{"recipient":"person@example.com","body":""}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSubmitBodyTooLarge(t *testing.T) {
	server, token := testServer(t)
	// exceed 32KB body cap
	huge := strings.Repeat("x", 64*1024)
	body := fmt.Sprintf(`{"recipient":"person@example.com","body":%q}`, huge)
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized body, got %d", w.Code)
	}
}

// --- Status error branches ---

func TestStatusMethodNotAllowed(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestStatusWithReachableBridge(t *testing.T) {
	server, token := testServer(t)
	server = server.WithBridge(&reachableBridgeChecker{}, "bridge")

	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["bridge_status"] != "ok" {
		t.Errorf("expected bridge_status=ok, got %v", resp["bridge_status"])
	}
}

func TestStatusWithUnreachableBridge(t *testing.T) {
	server, token := testServer(t)
	server = server.WithBridge(&unreachableBridgeChecker{}, "bridge")

	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["bridge_status"] != "unreachable" {
		t.Errorf("expected bridge_status=unreachable, got %v", resp["bridge_status"])
	}
}

// --- Audit events error branches ---

func TestAuditEventsMethodNotAllowed(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/audit-events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestAuditEventsUnauthorized(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/audit-events", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestAuditEventsEmpty(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/audit-events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	events, ok := resp["events"].([]any)
	if !ok {
		t.Fatalf("expected events array, got %T", resp["events"])
	}
	if len(events) != 0 {
		t.Errorf("expected empty events, got %d", len(events))
	}
}

func TestAuditEventsWithTypeFilter(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/audit-events?event_type=intake_submitted", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

// --- Exit channels error branches ---

func TestExitChannelsUnauthorized(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/exit-channels", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestExitChannelsListEmpty(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/exit-channels", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	channels, ok := resp["channels"].([]any)
	if !ok {
		t.Fatalf("expected channels array, got %T", resp["channels"])
	}
	if len(channels) != 0 {
		t.Errorf("expected empty channels, got %d", len(channels))
	}
}

func TestExitChannelsPostInvalidJSON(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/exit-channels", strings.NewReader(`{bad}`))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestExitChannelsPostInvalidConfig(t *testing.T) {
	server, token := testServer(t)
	// Missing name and type → ErrInvalidChannel
	req := httptest.NewRequest(http.MethodPost, "/v1/exit-channels", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestExitChannelsMethodNotAllowed(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodDelete, "/v1/exit-channels", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

// --- Identities error branches ---

func TestIdentitiesUnauthorized(t *testing.T) {
	server, _ := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/identities", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestIdentitiesMethodNotAllowed(t *testing.T) {
	server, token := testServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/identities", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

// --- Dead drop tests ---

func TestDeadDropNotConfigured(t *testing.T) {
	server, _ := testServer(t)
	// server.deadDrop is nil by default
	slotHex := strings.Repeat("a", 64)
	req := httptest.NewRequest(http.MethodPost, "/v1/drop/"+slotHex, strings.NewReader(`{"data":"aa"}`))
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d", w.Code)
	}
}

func TestWithDeadDropAndPostPoll(t *testing.T) {
	server, _ := testServer(t)
	store := deaddrop.NewStore(deaddrop.Config{})
	server = server.WithDeadDrop(store)

	slotHex := strings.Repeat("b", 64)
	payload := "deadbeef"

	// Post
	body := fmt.Sprintf(`{"data":%q}`, payload)
	req := httptest.NewRequest(http.MethodPost, "/v1/drop/"+slotHex, strings.NewReader(body))
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("post: expected 202, got %d: %s", w.Code, w.Body.String())
	}

	// Poll
	req2 := httptest.NewRequest(http.MethodGet, "/v1/drop/"+slotHex, nil)
	w2 := httptest.NewRecorder()
	server.Handler().ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("poll: expected 200, got %d", w2.Code)
	}
	var resp struct {
		Messages []string `json:"messages"`
		Count    int      `json:"count"`
	}
	json.NewDecoder(w2.Body).Decode(&resp)
	if resp.Count != 1 {
		t.Fatalf("expected count=1, got %d", resp.Count)
	}
	if resp.Messages[0] != payload {
		t.Fatalf("expected %q, got %q", payload, resp.Messages[0])
	}
}

func TestDeadDropPollEmptySlot(t *testing.T) {
	server, _ := testServer(t)
	store := deaddrop.NewStore(deaddrop.Config{})
	server = server.WithDeadDrop(store)

	slotHex := strings.Repeat("c", 64)
	req := httptest.NewRequest(http.MethodGet, "/v1/drop/"+slotHex, nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp struct {
		Messages []string `json:"messages"`
		Count    int      `json:"count"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Count != 0 {
		t.Fatalf("expected count=0, got %d", resp.Count)
	}
}

func TestDeadDropInvalidSlotIDLength(t *testing.T) {
	server, _ := testServer(t)
	store := deaddrop.NewStore(deaddrop.Config{})
	server = server.WithDeadDrop(store)

	tests := []struct {
		name string
		path string
	}{
		{"empty", "/v1/drop/"},
		{"too short", "/v1/drop/abc"},
		{"too long", "/v1/drop/" + strings.Repeat("a", 65)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			w := httptest.NewRecorder()
			server.Handler().ServeHTTP(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d", w.Code)
			}
		})
	}
}

func TestDeadDropInvalidHexSlotID(t *testing.T) {
	server, _ := testServer(t)
	store := deaddrop.NewStore(deaddrop.Config{})
	server = server.WithDeadDrop(store)

	// 64 chars but not valid hex
	badSlot := strings.Repeat("z", 64)
	req := httptest.NewRequest(http.MethodGet, "/v1/drop/"+badSlot, nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeadDropPostInvalidJSON(t *testing.T) {
	server, _ := testServer(t)
	store := deaddrop.NewStore(deaddrop.Config{})
	server = server.WithDeadDrop(store)

	slotHex := strings.Repeat("d", 64)
	req := httptest.NewRequest(http.MethodPost, "/v1/drop/"+slotHex, strings.NewReader(`{bad}`))
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeadDropPostInvalidHexData(t *testing.T) {
	server, _ := testServer(t)
	store := deaddrop.NewStore(deaddrop.Config{})
	server = server.WithDeadDrop(store)

	slotHex := strings.Repeat("e", 64)
	req := httptest.NewRequest(http.MethodPost, "/v1/drop/"+slotHex, strings.NewReader(`{"data":"not-hex-ZZZ"}`))
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeadDropPostPayloadTooLarge(t *testing.T) {
	server, _ := testServer(t)
	// Very small max payload to trigger ErrPayloadSize easily
	store := deaddrop.NewStore(deaddrop.Config{MaxPayloadSize: 4})
	server = server.WithDeadDrop(store)

	slotHex := strings.Repeat("f", 64)
	// hex-decoded payload is > 4 bytes
	bigHex := hex.EncodeToString([]byte("this-is-too-large"))
	body := fmt.Sprintf(`{"data":%q}`, bigHex)
	req := httptest.NewRequest(http.MethodPost, "/v1/drop/"+slotHex, strings.NewReader(body))
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDeadDropPostSlotFull(t *testing.T) {
	server, _ := testServer(t)
	store := deaddrop.NewStore(deaddrop.Config{MaxSlotSize: 1})
	server = server.WithDeadDrop(store)

	slotHex := strings.Repeat("1", 64)
	body := `{"data":"aa"}`

	// First post succeeds
	req1 := httptest.NewRequest(http.MethodPost, "/v1/drop/"+slotHex, strings.NewReader(body))
	w1 := httptest.NewRecorder()
	server.Handler().ServeHTTP(w1, req1)
	if w1.Code != http.StatusAccepted {
		t.Fatalf("first post: expected 202, got %d", w1.Code)
	}

	// Second fills slot
	req2 := httptest.NewRequest(http.MethodPost, "/v1/drop/"+slotHex, strings.NewReader(body))
	w2 := httptest.NewRecorder()
	server.Handler().ServeHTTP(w2, req2)
	if w2.Code != http.StatusConflict {
		t.Fatalf("second post: expected 409, got %d: %s", w2.Code, w2.Body.String())
	}
}

func TestDeadDropMethodNotAllowed(t *testing.T) {
	server, _ := testServer(t)
	store := deaddrop.NewStore(deaddrop.Config{})
	server = server.WithDeadDrop(store)

	slotHex := strings.Repeat("2", 64)
	req := httptest.NewRequest(http.MethodDelete, "/v1/drop/"+slotHex, nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

// --- getIntakeChannel default branch ---

func TestIntakeChannelDefault(t *testing.T) {
	// No WithIntakeChannel wrap — channel should default to "api"
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if ch := getIntakeChannel(req); ch != "api" {
		t.Fatalf("expected api, got %q", ch)
	}
}

// --- NewServer with ADMIN_TOKEN env var set ---

func TestNewServerRespectsAdminTokenEnv(t *testing.T) {
	t.Setenv("ADMIN_TOKEN", "env-token-xyz")
	server, _ := testServer(t)
	if server.adminToken != "env-token-xyz" {
		t.Fatalf("expected env-token-xyz, got %q", server.adminToken)
	}
}

// --- Integration: SecurityHeaders + HTTP server via httptest.NewServer ---

func TestSecurityMiddlewareViaHTTPTestServer(t *testing.T) {
	server, _ := testServer(t)
	ts := httptest.NewServer(SecurityHeadersMiddleware(server.Handler()))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if resp.Header.Get("X-Frame-Options") != "DENY" {
		t.Errorf("missing security header")
	}
}

// --- bridge check timeout path using a slow checker ---

type slowBridgeChecker struct{}

func (s *slowBridgeChecker) HealthCheck(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestStatusBridgeTimeoutCtxDone(t *testing.T) {
	server, token := testServer(t)
	server = server.WithBridge(&slowBridgeChecker{}, "bridge")

	// Use a cancelled request context to force immediate ctx.Done
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["bridge_status"] != "unreachable" {
		t.Errorf("expected bridge_status=unreachable for cancelled ctx, got %v", resp["bridge_status"])
	}
}
