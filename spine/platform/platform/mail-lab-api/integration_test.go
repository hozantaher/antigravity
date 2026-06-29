//go:build integration

// Integration test suite for mail-lab-api (ML1.5, issue #217).
//
// Tests that require a running Mail Lab stack (docker compose up)
// are gated behind env MAIL_LAB_RUNNING=true. All others (auth checks,
// JSON validation, race safety) run standalone with no external deps.
//
// Run all tests:
//
//	MAIL_LAB_API_URL=http://localhost:8090 LAB_API_KEY=dev-only \
//	  MAIL_LAB_RUNNING=true \
//	  go test -tags=integration -race -v ./...
//
// Run standalone-only (no docker required):
//
//	LAB_API_KEY=dev-only go test -tags=integration -race -v ./...
//
// Assertions (≥12 per #217 acceptance):
//  1. POST mailbox without API key → 401
//  2. POST mailbox with correct key → 201 + Location header
//  3. POST duplicate mailbox → 409
//  4. GET non-existent mailbox → 404
//  5. GET created mailbox → 200 + correct address field
//  6. GET messages on empty mailbox → [] (not null)
//  7. DELETE mailbox → 204; subsequent GET → 404
//  8. POST malformed JSON → 400 + error field present
//  9. POST missing required fields → 400
// 10. Health endpoint → 200 {status:"ok"} + uptime_seconds ≥ 0
// 11. Slog audit: required op tags present in handler source
// 12. Race: 100 concurrent POSTs for distinct addresses → all 100 created
// 13. GET /v1/mailbox/:address/messages is registered (404 not 405)

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mail-lab-api/internal/exec"
	"mail-lab-api/internal/handler"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fake runner
// ─────────────────────────────────────────────────────────────────────────────

// integFakeRunner satisfies exec.Runner using an in-memory mailbox map.
type integFakeRunner struct {
	mu        sync.Mutex
	mailboxes map[string]bool
}

func newIntegFakeRunner() *integFakeRunner {
	return &integFakeRunner{mailboxes: map[string]bool{}}
}

func (f *integFakeRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	// setup email <action>
	if len(args) >= 5 && args[0] == "exec" && args[2] == "setup" && args[3] == "email" {
		switch args[4] {
		case "list":
			var sb strings.Builder
			for addr := range f.mailboxes {
				sb.WriteString("* " + addr + " ( 0 / ~ ) [0 messages]\n")
			}
			return sb.String(), nil
		case "add":
			if len(args) < 7 {
				return "", fmt.Errorf("add: missing args")
			}
			addr := args[5]
			if f.mailboxes[addr] {
				return "", fmt.Errorf("already exists")
			}
			f.mailboxes[addr] = true
			return "User '" + addr + "' added\n", nil
		case "del":
			if len(args) < 7 {
				return "", fmt.Errorf("del: missing args")
			}
			addr := args[6]
			delete(f.mailboxes, addr)
			return "User '" + addr + "' deleted\n", nil
		}
	}
	// doveadm fetch → empty output (no messages in ML1 unit path)
	if len(args) >= 4 && args[0] == "exec" && args[2] == "doveadm" {
		return "", nil
	}
	return "", nil
}

func (f *integFakeRunner) RunWithStdin(_ context.Context, _ []byte, _ string, _ ...string) (string, error) {
	return "", nil
}

// Compile-time interface check.
var _ exec.Runner = (*integFakeRunner)(nil)

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const testAPIKey = "integration-test-key"

// requireMailLab skips the test if MAIL_LAB_RUNNING != "true".
func requireMailLab(t *testing.T) {
	t.Helper()
	if os.Getenv("MAIL_LAB_RUNNING") != "true" {
		t.Skip("requires running mail-lab stack — set MAIL_LAB_RUNNING=true")
	}
}

// liveURL returns the base URL for the live mail-lab-api instance.
func liveURL() string {
	if u := os.Getenv("MAIL_LAB_API_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return "http://localhost:8090"
}

// liveAPIKey returns the API key for the live instance.
func liveAPIKey() string {
	if k := os.Getenv("LAB_API_KEY"); k != "" {
		return k
	}
	return "dev-only"
}

// newStandaloneServer starts a real HTTP server on a free loopback port using
// the production handler code with a fake runner. Returns base URL and cleanup.
func newStandaloneServer(t *testing.T) (baseURL string, apiKey string, cleanup func()) {
	t.Helper()

	fr := newIntegFakeRunner()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	srv := handler.NewServer(testAPIKey, fr, logger)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	hs := &http.Server{
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go hs.Serve(ln) //nolint:errcheck
	base := "http://" + ln.Addr().String()
	return base, testAPIKey, func() { hs.Close() }
}

// request performs an HTTP request; returns the response (caller must close body).
func request(t *testing.T, method, url, apiKey string, body []byte) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatalf("http.NewRequest: %v", err)
	}
	if apiKey != "" {
		req.Header.Set("X-Lab-Api-Key", apiKey)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("http.Do: %v", err)
	}
	return resp
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 1 — POST without key → 401
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_01_POST_NoKey_Unauthorized(t *testing.T) {
	base, _, cleanup := newStandaloneServer(t)
	defer cleanup()

	resp := request(t, "POST", base+"/v1/mailbox", "", []byte(`{"address":"a@seznam.lab","password":"pw"}`))
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status=%d want 401", resp.StatusCode)
	}
	var body map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&body) //nolint:errcheck
	if body["error"] == nil {
		t.Error("response missing 'error' field on 401")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 2 — POST with key → 201 + Location header
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_02_POST_WithKey_Created(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	resp := request(t, "POST", base+"/v1/mailbox", key, []byte(`{"address":"alice@seznam.lab","password":"hunter2"}`))
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d want 201 body=%s", resp.StatusCode, body)
	}
	loc := resp.Header.Get("Location")
	if loc == "" {
		t.Error("Location header missing")
	}
	if !strings.Contains(loc, "alice@seznam.lab") {
		t.Errorf("Location %q does not contain address", loc)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 3 — POST duplicate → 409
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_03_POST_Duplicate_Conflict(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	payload := []byte(`{"address":"bob@seznam.lab","password":"pw"}`)
	resp1 := request(t, "POST", base+"/v1/mailbox", key, payload)
	resp1.Body.Close()
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST status=%d", resp1.StatusCode)
	}

	resp2 := request(t, "POST", base+"/v1/mailbox", key, payload)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusConflict {
		t.Errorf("duplicate POST status=%d want 409", resp2.StatusCode)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 4 — GET non-existent → 404
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_04_GET_NonExistent_NotFound(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	resp := request(t, "GET", base+"/v1/mailbox/nobody@seznam.lab", key, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status=%d want 404", resp.StatusCode)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 5 — GET created mailbox → 200 + correct address + domain
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_05_GET_Created_OK(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	request(t, "POST", base+"/v1/mailbox", key, []byte(`{"address":"carol@seznam.lab","password":"pw"}`)).Body.Close()

	resp := request(t, "GET", base+"/v1/mailbox/carol@seznam.lab", key, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d want 200 body=%s", resp.StatusCode, body)
	}
	var got map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["address"] != "carol@seznam.lab" {
		t.Errorf("address=%v", got["address"])
	}
	if got["domain"] != "seznam.lab" {
		t.Errorf("domain=%v", got["domain"])
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 6 — GET messages on empty mailbox → [] not null
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_06_GET_Messages_EmptyIsArray(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	request(t, "POST", base+"/v1/mailbox", key, []byte(`{"address":"empty@seznam.lab","password":"pw"}`)).Body.Close()

	resp := request(t, "GET", base+"/v1/mailbox/empty@seznam.lab/messages", key, nil)
	rawBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%s", resp.StatusCode, rawBody)
	}
	if strings.TrimSpace(string(rawBody)) == "null" {
		t.Fatal("GET messages returned null — must be []")
	}
	var msgs []interface{}
	if err := json.Unmarshal(rawBody, &msgs); err != nil {
		t.Fatalf("unmarshal: %v — body: %s", err, rawBody)
	}
	// Empty but not nil.
	if len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 7 — DELETE → 204; GET after → 404
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_07_DELETE_Then_GET_NotFound(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	request(t, "POST", base+"/v1/mailbox", key, []byte(`{"address":"dan@seznam.lab","password":"pw"}`)).Body.Close()

	resp1 := request(t, "DELETE", base+"/v1/mailbox/dan@seznam.lab", key, nil)
	resp1.Body.Close()
	if resp1.StatusCode != http.StatusNoContent {
		t.Errorf("DELETE status=%d want 204", resp1.StatusCode)
	}

	resp2 := request(t, "GET", base+"/v1/mailbox/dan@seznam.lab", key, nil)
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Errorf("GET after DELETE status=%d want 404", resp2.StatusCode)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 8 — POST malformed JSON → 400 + error field
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_08_MalformedJSON_BadRequest(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	resp := request(t, "POST", base+"/v1/mailbox", key, []byte(`{not-json`))
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status=%d want 400", resp.StatusCode)
	}
	var body map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&body) //nolint:errcheck
	if body["error"] == nil {
		t.Error("response missing 'error' field on 400")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 9 — POST missing required fields → 400
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_09_MissingFields_BadRequest(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	cases := []string{
		`{"address":"","password":"pw"}`,           // empty address
		`{"address":"x@seznam.lab","password":""}`,  // empty password
		`{}`, // both absent
	}
	for _, c := range cases {
		resp := request(t, "POST", base+"/v1/mailbox", key, []byte(c))
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("payload=%s status=%d want 400", c, resp.StatusCode)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 10 — /healthz no auth → 200 {status:"ok", uptime_seconds ≥ 0}
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_10_Healthz_NoAuth(t *testing.T) {
	base, _, cleanup := newStandaloneServer(t)
	defer cleanup()

	resp := request(t, "GET", base+"/healthz", "" /* no key */, nil)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d want 200 body=%s", resp.StatusCode, body)
	}
	var got struct {
		Status        string `json:"status"`
		UptimeSeconds int64  `json:"uptime_seconds"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Status != "ok" {
		t.Errorf("status=%q want ok", got.Status)
	}
	if got.UptimeSeconds < 0 {
		t.Errorf("uptime_seconds=%d want ≥ 0", got.UptimeSeconds)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 11 — Slog audit: op tags present in handler source
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_11_SlogOpAudit(t *testing.T) {
	src, err := os.ReadFile("internal/handler/handler.go")
	if err != nil {
		t.Fatalf("read handler.go: %v", err)
	}
	content := string(src)

	required := []string{
		`"op", "mail-lab-api.handleCreate"`,
		`"op", "mail-lab-api.handleCreate/exec"`,
		`"op", "mail-lab-api.handleDelete"`,
		`"op", "mail-lab-api.handleMessages"`,
	}
	for _, want := range required {
		if !strings.Contains(content, want) {
			t.Errorf("handler.go missing slog op tag: %q", want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 12 — Race: 100 concurrent POSTs → all 100 succeed
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_12_Race_100ConcurrentPOSTs(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	const N = 100
	var wg sync.WaitGroup
	var ok int64

	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			addr := fmt.Sprintf("race%d@seznam.lab", i)
			payload := fmt.Appendf(nil, `{"address":%q,"password":"pw"}`, addr)
			resp := request(t, "POST", base+"/v1/mailbox", key, payload)
			resp.Body.Close()
			if resp.StatusCode == http.StatusCreated {
				atomic.AddInt64(&ok, 1)
			}
		}(i)
	}
	wg.Wait()

	if ok != N {
		t.Errorf("only %d/%d concurrent POSTs succeeded", ok, N)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 13 — GET /messages endpoint is registered (not 405)
// ─────────────────────────────────────────────────────────────────────────────

func TestInteg_13_MessagesEndpoint_Registered(t *testing.T) {
	base, key, cleanup := newStandaloneServer(t)
	defer cleanup()

	resp := request(t, "GET", base+"/v1/mailbox/nope@seznam.lab/messages", key, nil)
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusMethodNotAllowed {
		t.Fatal("GET /v1/mailbox/:address/messages returned 405 — route not registered")
	}
	// 404 is expected because the mailbox doesn't exist.
	if resp.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("status=%d want 404 body=%s", resp.StatusCode, body)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Live stack tests (require MAIL_LAB_RUNNING=true)
// ─────────────────────────────────────────────────────────────────────────────

func TestLive_FullRoundTrip(t *testing.T) {
	requireMailLab(t)

	base := liveURL()
	key := liveAPIKey()
	addr := fmt.Sprintf("integ_%d@seznam.lab", time.Now().UnixMilli())

	// POST.
	resp1 := request(t, "POST", base+"/v1/mailbox", key, fmt.Appendf(nil, `{"address":%q,"password":"SecurePass1!"}`, addr))
	resp1.Body.Close()
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("live POST status=%d", resp1.StatusCode)
	}

	// GET.
	resp2 := request(t, "GET", base+"/v1/mailbox/"+addr, key, nil)
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("live GET status=%d", resp2.StatusCode)
	}

	// GET messages → [] not null.
	resp3 := request(t, "GET", base+"/v1/mailbox/"+addr+"/messages", key, nil)
	raw3, _ := io.ReadAll(resp3.Body)
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusOK {
		t.Errorf("live GET messages status=%d", resp3.StatusCode)
	}
	if strings.TrimSpace(string(raw3)) == "null" {
		t.Error("live GET messages returned null")
	}

	// DELETE.
	resp4 := request(t, "DELETE", base+"/v1/mailbox/"+addr, key, nil)
	resp4.Body.Close()
	if resp4.StatusCode != http.StatusNoContent {
		t.Errorf("live DELETE status=%d", resp4.StatusCode)
	}
}
