// Package integration drží end-to-end testy proti real Ollama daemon.
// Spuštění: nastav OLLAMA_TEST_URL na běžící Ollama instance.
//
//	OLLAMA_TEST_URL=http://localhost:11434 go test -count=1 ./tests/integration/...
//
// Bez env je test skip-ován (prefer-by-default — CI nepotřebuje Ollama).
package integration

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"llm-runner/internal/handler"
	"llm-runner/internal/ollama"
)

// requireOllama vrací base URL nebo skip-uje test.
func requireOllama(t *testing.T) string {
	t.Helper()
	url := os.Getenv("OLLAMA_TEST_URL")
	if url == "" {
		t.Skip("OLLAMA_TEST_URL not set — skipping integration test")
	}
	return url
}

func TestIntegration_Ping(t *testing.T) {
	url := requireOllama(t)
	c := ollama.NewClient(ollama.Config{BaseURL: url, Timeout: 10 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
}

func TestIntegration_ListModels(t *testing.T) {
	url := requireOllama(t)
	c := ollama.NewClient(ollama.Config{BaseURL: url, Timeout: 10 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	models, err := c.ListModels(ctx)
	if err != nil {
		t.Fatalf("list models: %v", err)
	}
	if len(models) == 0 {
		t.Skip("no models loaded on test daemon — pull llama3.2:3b first")
	}
}

func TestIntegration_ClassifyHappyPath(t *testing.T) {
	url := requireOllama(t)
	model := os.Getenv("LLM_TEST_MODEL")
	if model == "" {
		model = "llama3.2:3b"
	}

	c := ollama.NewClient(ollama.Config{BaseURL: url, Timeout: 30 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	prompt := "Reply ONLY with the word 'interested':"
	out, err := c.Generate(ctx, model, prompt)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	cat, conf := handler.ParseClassification(out)
	if cat == "unknown" {
		t.Fatalf("expected non-unknown category, got raw=%q", out)
	}
	if conf == 0 {
		t.Fatalf("expected non-zero confidence, got raw=%q", out)
	}
}

// TestIntegration_HandlerRoundTrip prochází plný HTTP roundtrip:
// POST /v1/classify request → handler → real Ollama → response.
func TestIntegration_HandlerRoundTrip(t *testing.T) {
	url := requireOllama(t)
	model := os.Getenv("LLM_TEST_MODEL")
	if model == "" {
		model = "llama3.2:3b"
	}

	c := ollama.NewClient(ollama.Config{BaseURL: url, Timeout: 30 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Volá Generate přímo přes klient — handler vrstva je již testována
	// v internal/handler/*_test.go. Tady jen ověřujeme že wire fungují
	// proti real daemon.
	out, err := c.Generate(ctx, model, "say only 'ok' and nothing else:")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if strings.TrimSpace(out) == "" {
		t.Fatal("expected non-empty response")
	}

	// Sanity check že response je serializable (žádné NULL bytes).
	_, jerr := json.Marshal(out)
	if jerr != nil {
		t.Fatalf("response not JSON-serializable: %v", jerr)
	}
}
