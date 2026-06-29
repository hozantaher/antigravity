package llm

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	anthropic "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// fakeAnthropicServer returns a test server that responds with a minimal
// Anthropic Messages API response. The response text is configurable.
func fakeAnthropicServer(text string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		// Minimal valid Messages response with one text block.
		resp := `{
			"id": "msg_test",
			"type": "message",
			"role": "assistant",
			"content": [{"type": "text", "text": "` + text + `"}],
			"model": "claude-haiku-4-5-20251001",
			"stop_reason": "end_turn",
			"stop_sequence": null,
			"usage": {"input_tokens": 1, "output_tokens": 1}
		}`
		_, _ = w.Write([]byte(resp))
	}))
}

func newTestAnthropicClient(srv *httptest.Server) *AnthropicClient {
	return &AnthropicClient{
		client: anthropic.NewClient(
			option.WithAPIKey("test-key"),
			option.WithBaseURL(srv.URL+"/"),
		),
		model: anthropic.ModelClaudeHaiku4_5_20251001,
	}
}

// ---- NewAnthropicClient ----

func TestNewAnthropicClient_DefaultModel(t *testing.T) {
	c := NewAnthropicClient(AnthropicConfig{APIKey: "key"})
	if c.model != anthropic.ModelClaudeHaiku4_5_20251001 {
		t.Fatalf("unexpected default model: %s", c.model)
	}
}

func TestNewAnthropicClient_CustomModel(t *testing.T) {
	c := NewAnthropicClient(AnthropicConfig{APIKey: "key", Model: anthropic.ModelClaudeSonnet4_5})
	if c.model != anthropic.ModelClaudeSonnet4_5 {
		t.Fatalf("unexpected model: %s", c.model)
	}
}

func TestNewAnthropicClient_NoAPIKey(t *testing.T) {
	c := NewAnthropicClient(AnthropicConfig{})
	if c == nil {
		t.Fatal("expected non-nil client")
	}
}

// ---- ClassifyIndustry ----

func TestAnthropicClient_ClassifyIndustry_EmptyDescription(t *testing.T) {
	// Empty description → early return, no HTTP call needed.
	srv := fakeAnthropicServer("stavebnictví")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	res, err := c.ClassifyIndustry(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tags) == 0 || res.Tags[0] != "other" {
		t.Fatalf("expected [other], got %v", res.Tags)
	}
}

func TestAnthropicClient_ClassifyIndustry_WithDescription(t *testing.T) {
	srv := fakeAnthropicServer("[stavebnictví]")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	res, err := c.ClassifyIndustry(context.Background(), "Firma se zabývá stavbou domů")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tags) == 0 {
		t.Fatal("expected non-empty tags")
	}
	if res.Confidence == 0 {
		t.Fatal("expected non-zero confidence")
	}
}

func TestAnthropicClient_ClassifyIndustry_LongDescription_Truncated(t *testing.T) {
	srv := fakeAnthropicServer("[other]")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	long := make([]byte, 600)
	for i := range long {
		long[i] = 'x'
	}
	res, err := c.ClassifyIndustry(context.Background(), string(long))
	if err != nil {
		t.Fatal(err)
	}
	if res == nil {
		t.Fatal("expected result")
	}
}

func TestAnthropicClient_ClassifyIndustry_NoTagsInResponse(t *testing.T) {
	srv := fakeAnthropicServer("nelze určit")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	res, err := c.ClassifyIndustry(context.Background(), "neznámá firma")
	if err != nil {
		t.Fatal(err)
	}
	// No extractable tags → fallback to "other"
	if len(res.Tags) == 0 || res.Tags[0] != "other" {
		t.Fatalf("expected fallback [other], got %v", res.Tags)
	}
}

// ---- SummarizeDescription ----

func TestAnthropicClient_SummarizeDescription_Empty(t *testing.T) {
	srv := fakeAnthropicServer("irrelevant")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	s, err := c.SummarizeDescription(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if s != "" {
		t.Fatalf("expected empty string, got %q", s)
	}
}

func TestAnthropicClient_SummarizeDescription_OK(t *testing.T) {
	srv := fakeAnthropicServer("Firma prodává stavební stroje.")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	s, err := c.SummarizeDescription(context.Background(), "Velký dealer těžkých strojů v Brně.")
	if err != nil {
		t.Fatal(err)
	}
	if s == "" {
		t.Fatal("expected non-empty summary")
	}
}

// ---- ClassifySentiment ----

func TestAnthropicClient_ClassifySentiment_Interested(t *testing.T) {
	srv := fakeAnthropicServer("interested")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	cat, err := c.ClassifySentiment(context.Background(), "Ano, máme zájem.")
	if err != nil {
		t.Fatal(err)
	}
	if cat != "interested" {
		t.Fatalf("expected interested, got %s", cat)
	}
}

func TestAnthropicClient_ClassifySentiment_NegativeMatch(t *testing.T) {
	srv := fakeAnthropicServer("negative")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	cat, err := c.ClassifySentiment(context.Background(), "Nemáme zájem.")
	if err != nil {
		t.Fatal(err)
	}
	if cat != "negative" {
		t.Fatalf("expected negative, got %s", cat)
	}
}

func TestAnthropicClient_ClassifySentiment_DefaultFallback(t *testing.T) {
	// "nic" doesn't match any category → extractCategory returns default "interested"
	srv := fakeAnthropicServer("nic")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	cat, err := c.ClassifySentiment(context.Background(), "ok")
	if err != nil {
		t.Fatal(err)
	}
	if cat == "" {
		t.Fatal("expected non-empty category")
	}
}

// ---- Ping ----

func TestAnthropicClient_Ping_OK(t *testing.T) {
	srv := fakeAnthropicServer("pong")
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	if err := c.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestAnthropicClient_Ping_Err(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"error":{"type":"api_error","message":"server error"}}`))
	}))
	defer srv.Close()
	c := newTestAnthropicClient(srv)

	if err := c.Ping(context.Background()); err == nil {
		t.Fatal("expected error on 500")
	}
}
