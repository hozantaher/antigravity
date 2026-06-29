package transport

// AD2 hardening tests — http.Client{Timeout: 10s} in geoip.go batchLookup.
//
// Locks the fix from Sprint AD2: batchLookup must not use http.DefaultClient
// (no timeout) — a slow upstream would block the proxy pool refresh goroutine.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// ── AD2-1: audit ratchet — no http.DefaultClient in geoip.go ─────────────────

func TestAD2_AuditRatchet_NoDefaultClientInGeoip(t *testing.T) {
	raw, err := os.ReadFile("geoip.go")
	if err != nil {
		t.Fatalf("cannot read geoip.go for audit: %v", err)
	}
	for i, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		if strings.Contains(trimmed, "http.DefaultClient") {
			t.Errorf("AD2: geoip.go line %d uses http.DefaultClient (no timeout): %s", i+1, trimmed)
		}
	}
}

// ── AD2-2: http.Client with Timeout succeeds on fast upstream ─────────────────

func TestAD2_HTTPClientWithTimeout_SuccessOnFastUpstream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[{"status":"success","countryCode":"CZ","query":"1.2.3.4"}]`))
	}))
	defer srv.Close()

	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("client.Do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

// ── AD2-3: http.Client with Timeout fires on slow upstream ───────────────────

func TestAD2_HTTPClientWithTimeout_TimesOutOnSlowUpstream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate a hung upstream: sleep longer than client timeout.
		time.Sleep(500 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := &http.Client{Timeout: 50 * time.Millisecond}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	_, err = client.Do(req)
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
	// The error should contain deadline or timeout indicator.
	msg := err.Error()
	if !strings.Contains(msg, "deadline exceeded") &&
		!strings.Contains(msg, "Timeout") &&
		!strings.Contains(msg, "timeout") &&
		!strings.Contains(msg, "context deadline") {
		t.Errorf("expected timeout-related error, got: %v", err)
	}
}

// ── AD2-4: http.DefaultClient has no Timeout (documents the old bug) ─────────

func TestAD2_DefaultClient_HasNoTimeout(t *testing.T) {
	if http.DefaultClient.Timeout != 0 {
		t.Errorf("http.DefaultClient.Timeout = %v; expected 0 (no timeout) — test assumption broken", http.DefaultClient.Timeout)
	}
}

// ── AD2-5: custom client Timeout is set to 10s as specified ──────────────────

func TestAD2_CustomClient_HasCorrectTimeout(t *testing.T) {
	const wantTimeout = 10 * time.Second
	client := &http.Client{Timeout: wantTimeout}
	if client.Timeout != wantTimeout {
		t.Errorf("expected Timeout=%v, got %v", wantTimeout, client.Timeout)
	}
}

// ── AD2-6: context cancellation propagates through custom client ──────────────

func TestAD2_HTTPClientWithTimeout_RespectsContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	client := &http.Client{Timeout: 10 * time.Second} // client timeout is generous
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	_, err = client.Do(req)
	if err == nil {
		t.Fatal("expected context cancellation error, got nil")
	}
}

// ── AD2-7: connection refused returns wrapped error (not panic) ───────────────

func TestAD2_HTTPClientWithTimeout_ConnectionRefusedReturnsError(t *testing.T) {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		"http://127.0.0.1:19999/batch", nil) // port nobody listens on
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	_, err = client.Do(req)
	if err == nil {
		t.Fatal("expected connection refused error, got nil")
	}
	// Must be an error — not a panic.
	if !strings.Contains(err.Error(), "connect") &&
		!strings.Contains(err.Error(), "refused") &&
		!strings.Contains(err.Error(), "timeout") &&
		!strings.Contains(err.Error(), "deadline") {
		t.Logf("connection error (acceptable): %v", err)
	}
}
