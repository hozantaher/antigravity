package ollama

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// --- NewClient + Ping + ListModels (lifted z původního skeletonu) ---

func TestNewClient_Defaults(t *testing.T) {
	c := NewClient(Config{})
	if c.BaseURL() == "" {
		t.Fatal("expected default baseURL, got empty")
	}
	if !strings.HasPrefix(c.BaseURL(), "http://") {
		t.Fatalf("expected default baseURL to be HTTP, got %q", c.BaseURL())
	}
}

func TestNewClient_TrimsTrailingSlash(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://example/", Timeout: time.Second})
	if c.BaseURL() != "http://example" {
		t.Fatalf("expected trailing slash trimmed, got %q", c.BaseURL())
	}
}

func TestPing_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("expected nil err, got %v", err)
	}
}

func TestPing_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	err := c.Ping(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("expected HTTP 500 in error, got %q", err.Error())
	}
}

func TestListModels_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tags" {
			t.Fatalf("expected /api/tags, got %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]string{
				{"name": "llama3.2:3b"},
				{"name": "llama3.2-vision:11b"},
			},
		})
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	names, err := c.ListModels(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(names) != 2 || names[0] != "llama3.2:3b" {
		t.Fatalf("unexpected names: %v", names)
	}
}

func TestListModels_HTTP500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	_, err := c.ListModels(context.Background())
	if err == nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("expected HTTP 500 error, got %v", err)
	}
}

// --- Generate happy path ---

func TestGenerate_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/generate" {
			t.Fatalf("expected /api/generate, got %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		ct := r.Header.Get("Content-Type")
		if ct != "application/json" {
			t.Fatalf("expected JSON content-type, got %q", ct)
		}
		body, _ := io.ReadAll(r.Body)
		var req generateRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Stream {
			t.Fatal("expected stream=false (non-streaming)")
		}
		if req.Model != "llama3.2:3b" {
			t.Fatalf("unexpected model: %q", req.Model)
		}
		if req.Prompt != "ahoj" {
			t.Fatalf("unexpected prompt: %q", req.Prompt)
		}
		_ = json.NewEncoder(w).Encode(generateResponse{
			Model:    "llama3.2:3b",
			Response: "  hello back  ",
			Done:     true,
		})
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: 2 * time.Second})
	out, err := c.Generate(context.Background(), "llama3.2:3b", "ahoj")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if out != "hello back" {
		t.Fatalf("expected trimmed response, got %q", out)
	}
}

// --- Generate validation ---

func TestGenerate_EmptyModel(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://localhost:0", Timeout: time.Millisecond})
	_, err := c.Generate(context.Background(), "", "ahoj")
	if err == nil || !strings.Contains(err.Error(), "model is required") {
		t.Fatalf("expected 'model is required', got %v", err)
	}
}

func TestGenerate_EmptyPrompt(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://localhost:0", Timeout: time.Millisecond})
	_, err := c.Generate(context.Background(), "llama3.2:3b", "")
	if err == nil || !strings.Contains(err.Error(), "prompt is required") {
		t.Fatalf("expected 'prompt is required', got %v", err)
	}
}

// --- Generate retry on 5xx ---

func TestGenerate_RetryOn5xx_RecoversOnSecond(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("transient"))
			return
		}
		_ = json.NewEncoder(w).Encode(generateResponse{Response: "ok", Done: true})
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: 2 * time.Second})
	out, err := c.Generate(context.Background(), "llama3.2:3b", "x")
	if err != nil {
		t.Fatalf("expected recovery, got %v", err)
	}
	if out != "ok" {
		t.Fatalf("expected 'ok', got %q", out)
	}
	if atomic.LoadInt32(&calls) != 2 {
		t.Fatalf("expected 2 calls, got %d", calls)
	}
}

// --- Generate no-retry on 4xx ---

func TestGenerate_NoRetryOn4xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("bad input"))
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: 2 * time.Second})
	_, err := c.Generate(context.Background(), "m", "p")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("expected HTTP 400 in error, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected 1 call (no retry on 4xx), got %d", got)
	}
}

// --- Generate retry exhaustion (both attempts fail) ---

func TestGenerate_RetryExhausted(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: 2 * time.Second})
	_, err := c.Generate(context.Background(), "m", "p")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "max retries") {
		t.Fatalf("expected 'max retries', got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("expected 2 calls, got %d", got)
	}
}

// --- Generate malformed JSON ---

func TestGenerate_MalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{not-json"))
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	_, err := c.Generate(context.Background(), "m", "p")
	if err == nil || !strings.Contains(err.Error(), "decode") {
		t.Fatalf("expected decode error, got %v", err)
	}
}

// --- Generate ctx cancellation ---

func TestGenerate_CtxCanceled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: 5 * time.Second})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := c.Generate(ctx, "m", "p")
	if err == nil {
		t.Fatal("expected ctx error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) && !strings.Contains(err.Error(), "context") {
		t.Fatalf("expected ctx-related error, got %v", err)
	}
}

// --- GenerateOpts s system prompt + options ---

func TestGenerateOpts_PassesSystemAndOptions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req generateRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if req.System != "you are tester" {
			t.Fatalf("system mismatch: %q", req.System)
		}
		if req.Options == nil || req.Options.Temperature == nil || *req.Options.Temperature != 0.1 {
			t.Fatalf("options mismatch: %+v", req.Options)
		}
		_ = json.NewEncoder(w).Encode(generateResponse{Response: "ok", Done: true})
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	temp := 0.1
	out, err := c.GenerateOpts(context.Background(), "m", "p", &GenerateOptions{
		System:  "you are tester",
		Options: &Options{Temperature: &temp},
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if out != "ok" {
		t.Fatalf("expected ok, got %q", out)
	}
}

// --- GenerateWithImage ---

func TestGenerateWithImage_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req generateRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(req.Images) != 1 || req.Images[0] != "Zm9v" {
			t.Fatalf("expected 1 image 'Zm9v', got %v", req.Images)
		}
		_ = json.NewEncoder(w).Encode(generateResponse{Response: "year=2018", Done: true})
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	out, err := c.GenerateWithImage(context.Background(), "vision", "describe", "Zm9v")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if out != "year=2018" {
		t.Fatalf("got %q", out)
	}
}

func TestGenerateWithImage_EmptyImage(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://localhost:0", Timeout: time.Millisecond})
	_, err := c.GenerateWithImage(context.Background(), "v", "p", "")
	if err == nil || !strings.Contains(err.Error(), "image is required") {
		t.Fatalf("expected 'image is required', got %v", err)
	}
}

// --- Chat happy path ---

func TestChat_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Fatalf("expected /api/chat, got %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		var req chatRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(req.Messages) != 2 {
			t.Fatalf("expected 2 messages, got %d", len(req.Messages))
		}
		if req.Messages[0].Role != "system" || req.Messages[1].Role != "user" {
			t.Fatalf("unexpected roles: %+v", req.Messages)
		}
		_ = json.NewEncoder(w).Encode(chatResponse{
			Message: Message{Role: "assistant", Content: "  hi  "},
			Done:    true,
		})
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	out, err := c.Chat(context.Background(), "m", []Message{
		{Role: "system", Content: "be brief"},
		{Role: "user", Content: "hello"},
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if out != "hi" {
		t.Fatalf("expected trimmed 'hi', got %q", out)
	}
}

// --- Chat validation ---

func TestChat_EmptyModel(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://localhost:0", Timeout: time.Millisecond})
	_, err := c.Chat(context.Background(), "", []Message{{Role: "user", Content: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "model is required") {
		t.Fatalf("expected 'model is required', got %v", err)
	}
}

func TestChat_EmptyMessages(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://localhost:0", Timeout: time.Millisecond})
	_, err := c.Chat(context.Background(), "m", nil)
	if err == nil || !strings.Contains(err.Error(), "messages is required") {
		t.Fatalf("expected 'messages is required', got %v", err)
	}
}

// --- Chat malformed JSON response ---

func TestChat_MalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("###"))
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, Timeout: time.Second})
	_, err := c.Chat(context.Background(), "m", []Message{{Role: "user", Content: "x"}})
	if err == nil || !strings.Contains(err.Error(), "decode") {
		t.Fatalf("expected decode error, got %v", err)
	}
}
