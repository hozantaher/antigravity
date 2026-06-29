package llmclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// helper builds a Client pointed at the test server.
func newTestClient(t *testing.T, srv *httptest.Server, opts ...func(*Config)) *Client {
	t.Helper()
	cfg := Config{BaseURL: srv.URL, Timeout: 2 * time.Second}
	for _, fn := range opts {
		fn(&cfg)
	}
	return NewClient(cfg)
}

// 1. Empty base URL → ErrUnavailable (boot without llm-runner wired).
func TestParsePhoto_EmptyBaseURLReturnsUnavailable(t *testing.T) {
	c := NewClient(Config{})
	_, err := c.ParsePhoto(context.Background(), "abc", "ctx")
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
}

// 2. Empty image → contract violation, plain error (no Unavailable).
func TestParsePhoto_EmptyImageReturnsError(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://localhost:1"})
	_, err := c.ParsePhoto(context.Background(), "", "ctx")
	if err == nil {
		t.Fatal("expected error for empty image")
	}
	if errors.Is(err, ErrUnavailable) {
		t.Errorf("must not classify empty image as Unavailable")
	}
}

// 3. Happy path: 200 OK with valid JSON → decoded extract.
func TestParsePhoto_HappyPathDecodes(t *testing.T) {
	year := 2018
	conf := 0.9
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.URL.Path != "/v1/parse-photo" {
			t.Errorf("path = %q, want /v1/parse-photo", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"year":       year,
			"make":       "Caterpillar",
			"model":      "320D",
			"condition":  "good",
			"confidence": conf,
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	out, err := c.ParsePhoto(context.Background(), "AAAA", "TP photo")
	if err != nil {
		t.Fatalf("ParsePhoto: %v", err)
	}
	if out.Make != "Caterpillar" || out.Model != "320D" {
		t.Errorf("decoded = %+v", out)
	}
	if out.Year == nil || *out.Year != 2018 {
		t.Errorf("year = %v", out.Year)
	}
	if out.Confidence == nil || *out.Confidence != 0.9 {
		t.Errorf("confidence = %v", out.Confidence)
	}
	if out.RawResponse == "" {
		t.Errorf("raw response not captured")
	}
}

// 4. 501 Not Implemented (skeleton) → ErrNotImplemented.
func TestParsePhoto_501ReturnsNotImplemented(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write([]byte(`{"error":"skeleton"}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.ParsePhoto(context.Background(), "AA", "ctx")
	if !errors.Is(err, ErrNotImplemented) {
		t.Errorf("err = %v, want ErrNotImplemented", err)
	}
	if errors.Is(err, ErrUnavailable) {
		t.Errorf("must not classify 501 as Unavailable")
	}
}

// 5. 500 server error → ErrUnavailable so retry-queue path triggers.
func TestParsePhoto_500ReturnsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream broken"))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.ParsePhoto(context.Background(), "AA", "ctx")
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
}

// 6. 400 Bad Request → plain error (caller logs and gives up).
func TestParsePhoto_400ReturnsPlainError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.ParsePhoto(context.Background(), "AA", "ctx")
	if err == nil {
		t.Fatal("expected error")
	}
	if errors.Is(err, ErrUnavailable) || errors.Is(err, ErrNotImplemented) {
		t.Errorf("must not classify 400 as Unavailable / NotImplemented")
	}
}

// 7. Malformed JSON on 200 → decode error (not Unavailable; the server
// is up but lying).
func TestParsePhoto_MalformedJSONReturnsDecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("not json"))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.ParsePhoto(context.Background(), "AA", "ctx")
	if err == nil {
		t.Fatal("expected decode error")
	}
	if errors.Is(err, ErrUnavailable) {
		t.Errorf("must not classify decode error as Unavailable")
	}
}

// 8. Connection refused → ErrUnavailable (the service is down).
func TestParsePhoto_ConnectionRefusedReturnsUnavailable(t *testing.T) {
	// 0.0.0.0:1 is reliably unreachable; net.Dial fails fast.
	c := NewClient(Config{BaseURL: "http://127.0.0.1:1", Timeout: 250 * time.Millisecond})
	_, err := c.ParsePhoto(context.Background(), "AA", "ctx")
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
}

// 9. Context cancellation → ErrUnavailable (network IO interrupted).
func TestParsePhoto_ContextCancelReturnsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hold the request open until context cancellation.
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()

	c := newTestClient(t, srv, func(c *Config) { c.Timeout = 5 * time.Second })
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := c.ParsePhoto(ctx, "AA", "ctx")
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
}

// 10. APIKey header is set when configured.
func TestParsePhoto_APIKeyHeaderForwarded(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-LLM-Api-Key")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv, func(c *Config) { c.APIKey = "secret-key" })
	_, err := c.ParsePhoto(context.Background(), "AA", "ctx")
	if err != nil {
		t.Fatalf("ParsePhoto: %v", err)
	}
	if gotKey != "secret-key" {
		t.Errorf("X-LLM-Api-Key = %q, want secret-key", gotKey)
	}
}

// 11. Default timeout applied when caller leaves Config.Timeout zero.
func TestNewClient_DefaultTimeoutApplied(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://x"})
	if c.http.Timeout != DefaultTimeout {
		t.Errorf("timeout = %v, want %v", c.http.Timeout, DefaultTimeout)
	}
}

// 12. Trailing slash in BaseURL is normalized.
func TestNewClient_BaseURLTrailingSlashTrimmed(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://x/"})
	if strings.HasSuffix(c.baseURL, "/") {
		t.Errorf("baseURL = %q, expected no trailing slash", c.baseURL)
	}
}

// 13. Request body shape matches contract: image_b64 + context fields.
func TestParsePhoto_RequestBodyShape(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.ParsePhoto(context.Background(), "AAAB", "TP foto")
	if err != nil {
		t.Fatalf("ParsePhoto: %v", err)
	}
	if got["image_b64"] != "AAAB" {
		t.Errorf("image_b64 = %q", got["image_b64"])
	}
	if got["context"] != "TP foto" {
		t.Errorf("context = %q", got["context"])
	}
}
