package web

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"relay/internal/abuse"
	"relay/internal/audit"
	"relay/internal/boundary"
	"relay/internal/delivery/contentenc"
	"relay/internal/delivery/sanitizer"
	"relay/internal/filestore"
	"relay/internal/identity"
	"relay/internal/intake"
	"relay/internal/intake/auth"
	"relay/internal/minlog"
	"relay/internal/model"
	"relay/internal/msgbus"
	"relay/internal/relay"
	"relay/internal/transport/metamin"
	"relay/internal/vault"
)

// AW4-2 backpressure gate tests — followup to AW4 audit (PR #1189).
//
// Verifies /v1/submit returns 429 + Retry-After when scheduler.PendingCount()
// >= RELAY_MAX_QUEUE_DEPTH, with env-var override semantics + audit emit.

// backpressureServer wires a server whose scheduler exposes a controllable
// pending count. We use a long min/max delay so any envelope scheduled stays
// in StatusScheduled for the duration of the test.
//
// Returns the server, a token, and a "fill" helper that pushes N envelopes
// into the scheduler so PendingCount() == N.
func backpressureServer(t *testing.T) (*Server, string, func(n int)) {
	t.Helper()
	dir := t.TempDir()

	vaultKey := make([]byte, 32)
	for i := range vaultKey {
		vaultKey[i] = byte(i + 1)
	}
	vaultKeyB64 := base64.StdEncoding.EncodeToString(vaultKey)

	dataKey := make([]byte, 32)
	for i := range dataKey {
		dataKey[i] = byte(i + 100)
	}
	dataCodec, _ := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(dataKey))

	vaultSvc, err := vault.NewFileVault(filepath.Join(dir, "vault.json"), vaultKeyB64, 0)
	if err != nil {
		t.Fatal(err)
	}
	identitySvc := identity.NewService(vaultSvc)
	sanitizerSvc := sanitizer.NewService()
	minimizer := metamin.NewMinimizer()
	sealer := contentenc.NewSealer()
	bus := msgbus.NewChannelBus(64)
	limiter := abuse.NewLimiter(1000) // generous — backpressure must trip first
	logger := minlog.New("test")

	auditSvc, _ := audit.NewService(filepath.Join(dir, "audit.json"), dataCodec, 0)
	// Long delays so anything we Schedule() stays Pending for the whole test.
	scheduler, _ := relay.NewScheduler(
		filepath.Join(dir, "relay.json"), dataCodec,
		time.Hour, 2*time.Hour, 0,
	)
	exitVerifier, _ := boundary.NewExitVerifier(filepath.Join(dir, "channels.json"), dataCodec)

	pipeline := intake.NewPipeline(sanitizerSvc, identitySvc, minimizer, sealer, bus, auditSvc, limiter, logger)

	token := "test-token-12345"
	authenticator := auth.NewStaticTokenAuthenticator(map[string]model.Actor{
		token: {ID: "user-1", TenantID: "tenant-1"},
	})

	server := NewServer(authenticator, pipeline, scheduler, auditSvc, vaultSvc, exitVerifier, limiter)

	fill := func(n int) {
		t.Helper()
		ctx := context.Background()
		for i := 0; i < n; i++ {
			env := model.Envelope{
				ID:        "env_bp_" + strconv.Itoa(i),
				TenantID:  "tenant-1",
				Status:    model.StatusSealed,
				SizeClass: model.SizeClass512,
			}
			if _, err := scheduler.Schedule(ctx, env); err != nil {
				t.Fatalf("seed envelope %d: %v", i, err)
			}
		}
	}

	return server, token, fill
}

func submitOnce(server *Server, token string) *httptest.ResponseRecorder {
	body := `{"recipient":"person@example.com","subject":"Test","body":"Hello"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	return w
}

// 1. Queue depth below cap — accept (202).
func TestBackpressure_BelowCap_Accepts(t *testing.T) {
	server, token, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(5)
	fill(2) // 2 < 5

	w := submitOnce(server, token)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Retry-After"); got != "" {
		t.Errorf("Retry-After should be absent on accept, got %q", got)
	}
}

// 2. Queue depth exactly at cap — 429 + Retry-After.
func TestBackpressure_AtCap_Returns429(t *testing.T) {
	server, token, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(3)
	fill(3) // depth == cap

	w := submitOnce(server, token)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 at cap, got %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Retry-After"); got != strconv.Itoa(retryAfterSeconds) {
		t.Errorf("Retry-After: got %q want %q", got, strconv.Itoa(retryAfterSeconds))
	}

	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["error"] != "queue full" {
		t.Errorf("error body: got %q want %q", body["error"], "queue full")
	}
}

// 3. Queue depth far above cap — 429.
func TestBackpressure_FarAboveCap_Returns429(t *testing.T) {
	server, token, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(2)
	fill(10) // depth >> cap

	w := submitOnce(server, token)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 above cap, got %d", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got == "" {
		t.Errorf("Retry-After header missing")
	}
}

// 4. Cap of 0 disables the gate — accept regardless of depth.
func TestBackpressure_CapZero_Unlimited(t *testing.T) {
	server, token, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(0)
	fill(50) // arbitrary deep queue

	w := submitOnce(server, token)
	if w.Code != http.StatusAccepted {
		t.Fatalf("cap=0 should be unlimited, got %d: %s", w.Code, w.Body.String())
	}
}

// 5. Negative cap via builder treated as unlimited (defensive).
func TestBackpressure_NegativeCapViaBuilder_Unlimited(t *testing.T) {
	server, token, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(-7)
	fill(50)

	w := submitOnce(server, token)
	if w.Code != http.StatusAccepted {
		t.Fatalf("negative cap → unlimited expected, got %d", w.Code)
	}
}

// 6. parseMaxQueueDepth — empty string falls back to default.
func TestParseMaxQueueDepth_EmptyDefault(t *testing.T) {
	if got := parseMaxQueueDepth(""); got != defaultMaxQueueDepth {
		t.Errorf("empty: got %d want %d", got, defaultMaxQueueDepth)
	}
}

// 7. parseMaxQueueDepth — explicit 0 → unlimited (gate off).
func TestParseMaxQueueDepth_ZeroUnlimited(t *testing.T) {
	if got := parseMaxQueueDepth("0"); got != 0 {
		t.Errorf("zero: got %d want 0 (unlimited)", got)
	}
}

// 8. parseMaxQueueDepth — negative falls back to default (typo guard).
func TestParseMaxQueueDepth_NegativeFallback(t *testing.T) {
	if got := parseMaxQueueDepth("-5"); got != defaultMaxQueueDepth {
		t.Errorf("negative: got %d want %d", got, defaultMaxQueueDepth)
	}
}

// 9. parseMaxQueueDepth — unparseable falls back to default.
func TestParseMaxQueueDepth_UnparseableFallback(t *testing.T) {
	if got := parseMaxQueueDepth("not-a-number"); got != defaultMaxQueueDepth {
		t.Errorf("unparseable: got %d want %d", got, defaultMaxQueueDepth)
	}
}

// 10. parseMaxQueueDepth — positive integer respected.
func TestParseMaxQueueDepth_PositiveRespected(t *testing.T) {
	if got := parseMaxQueueDepth("250"); got != 250 {
		t.Errorf("positive: got %d want 250", got)
	}
}

// 11. parseMaxQueueDepth — whitespace trimmed.
func TestParseMaxQueueDepth_WhitespaceTrimmed(t *testing.T) {
	if got := parseMaxQueueDepth("  42  "); got != 42 {
		t.Errorf("whitespace: got %d want 42", got)
	}
}

// 12. Default cap from constructor (no env override) is 100.
func TestBackpressure_DefaultCapIs100(t *testing.T) {
	t.Setenv("RELAY_MAX_QUEUE_DEPTH", "")
	server, _, _ := backpressureServer(t)
	if server.maxQueueDepth != defaultMaxQueueDepth {
		t.Errorf("default cap: got %d want %d", server.maxQueueDepth, defaultMaxQueueDepth)
	}
}

// 13. Gate fires BEFORE actor auth (no Authorization header → still 429,
// not 401, when queue is full). This pins the "fail fast" intent so a future
// refactor can't accidentally move the check after requireActor.
func TestBackpressure_FiresBeforeAuth(t *testing.T) {
	server, _, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(1)
	fill(1) // at cap

	body := `{"recipient":"person@example.com","subject":"Test","body":"Hello"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
	// no Authorization header
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 (gate before auth), got %d: %s", w.Code, w.Body.String())
	}
}

// 14. Method gate still wins over backpressure (GET on /v1/submit returns 405,
// not 429, even when queue is full). Ordering check.
func TestBackpressure_MethodGateStillWins(t *testing.T) {
	server, _, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(1)
	fill(5) // way over cap

	req := httptest.NewRequest(http.MethodGet, "/v1/submit", nil)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET should be 405, got %d", w.Code)
	}
}

// 15. WithBackpressureAudit toggle wires through to the field.
func TestBackpressure_AuditFlagWiring(t *testing.T) {
	server, _, _ := backpressureServer(t)
	if server.backpressureAudit {
		t.Errorf("audit flag should default to false (BACKPRESSURE_AUDIT unset)")
	}
	server = server.WithBackpressureAudit(true)
	if !server.backpressureAudit {
		t.Errorf("audit flag should flip to true via builder")
	}
}
