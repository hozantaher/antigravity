package web

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// ══════════════════════════════════════════
//  E2E: Full HTTP API Flow
// ══════════════════════════════════════════

// Uses the existing testServer() from server_test.go

func requireSocketE2E(t *testing.T) {
	t.Helper()
	if os.Getenv("HTTPAPI_SOCKET_E2E") != "1" {
		t.Skip("set HTTPAPI_SOCKET_E2E=1 to run socket-binding HTTP E2E tests")
	}
}

func TestE2E_HealthzReturnsOK(t *testing.T) {
	requireSocketE2E(t)
	server, _ := testServer(t)
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("healthz: %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.Contains(body, []byte("ok")) {
		t.Errorf("healthz body: %s", string(body))
	}
}

func TestE2E_SubmitUnauthorized(t *testing.T) {
	requireSocketE2E(t)
	server, _ := testServer(t)
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/v1/submit", "application/octet-stream", bytes.NewReader([]byte("data")))
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("expected 401 without auth, got %d", resp.StatusCode)
	}
}

func TestE2E_SubmitWithAuth(t *testing.T) {
	requireSocketE2E(t)
	server, token := testServer(t)
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	payload := []byte(`{"ciphertext":"dGVzdA==","ephemeral_pub":"AAAA","nonce":"BBBB","epoch":1}`)
	req, _ := http.NewRequest("POST", ts.URL+"/v1/submit", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	defer resp.Body.Close()

	// May be 200, 202, or 400 depending on envelope validation
	// Key point: auth succeeded (not 401)
	if resp.StatusCode == 401 {
		t.Error("auth should have succeeded")
	}
}

func TestE2E_StatusWithAuth(t *testing.T) {
	requireSocketE2E(t)
	server, token := testServer(t)
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	req, _ := http.NewRequest("GET", ts.URL+"/v1/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("status: %d %s", resp.StatusCode, string(body))
	}
}

func TestE2E_StatusUnauthorized(t *testing.T) {
	requireSocketE2E(t)
	server, _ := testServer(t)
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestE2E_NotFoundRoute(t *testing.T) {
	requireSocketE2E(t)
	server, token := testServer(t)
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	req, _ := http.NewRequest("GET", ts.URL+"/v1/nonexistent", nil)
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 && resp.StatusCode != 405 {
		t.Errorf("expected 404/405, got %d", resp.StatusCode)
	}
}

func TestE2E_SubmitThenStatus(t *testing.T) {
	requireSocketE2E(t)
	server, token := testServer(t)
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// Submit something
	payload := []byte(`{"test": "data"}`)
	req, _ := http.NewRequest("POST", ts.URL+"/v1/submit", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()

	// Check status
	req2, _ := http.NewRequest("GET", ts.URL+"/v1/status", nil)
	req2.Header.Set("Authorization", "Bearer "+token)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()

	if resp2.StatusCode != 200 {
		t.Errorf("status after submit: %d", resp2.StatusCode)
	}
}
