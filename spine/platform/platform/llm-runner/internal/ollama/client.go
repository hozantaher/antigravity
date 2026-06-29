// Package ollama poskytuje thin HTTP klient pro Ollama REST API.
//
// Per ADR-006 §D1 je `services/llm-runner` jediný consumer Ollama daemon
// v M+3. Klient drží všechen retry/timeout logic; handler vrstva nad
// ním přidává prompt template injection + response parsing.
//
// Endpoints:
//   - POST /api/generate     → text completion (prompt-based)
//   - POST /api/chat         → chat completion (messages-based)
//   - GET  /api/tags         → list of installed models
//   - GET  /                 → liveness probe
//
// Reference: https://github.com/ollama/ollama/blob/main/docs/api.md
package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Config drží connect parametry pro Ollama daemon.
type Config struct {
	BaseURL string        // např. "http://ollama.railway.internal:11434"
	Timeout time.Duration // default 60s; pro vision přepíše per-call ctx deadline
}

// Client je thin HTTP wrapper. Per-call retry je 1× pro transient errors
// (network/5xx); 4xx se nikdy neretry-uje. Wrapper handler vrstva může
// retry vypnout zcela volbou krátkého ctx deadline.
type Client struct {
	baseURL string
	http    *http.Client
}

// Message reprezentuje jeden turn v chat conversation.
// Role je "system" / "user" / "assistant".
// Images obsahuje base64-encoded image bytes (bez "data:" prefix).
type Message struct {
	Role    string   `json:"role"`
	Content string   `json:"content"`
	Images  []string `json:"images,omitempty"`
}

// Options jsou Ollama generation parameters (volitelné).
// Nil hodnoty znamenají "použij model default".
type Options struct {
	Temperature *float64 `json:"temperature,omitempty"`
	TopP        *float64 `json:"top_p,omitempty"`
	NumPredict  *int     `json:"num_predict,omitempty"` // max tokens
	Seed        *int     `json:"seed,omitempty"`
}

// NewClient vytváří nový Ollama klient.
// BaseURL je trim-ován pro trailing slash; Timeout default 60s.
// Pokud BaseURL == "", použije se "http://localhost:11434" (dev fallback).
func NewClient(cfg Config) *Client {
	base := strings.TrimSuffix(cfg.BaseURL, "/")
	if base == "" {
		base = "http://localhost:11434"
	}
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	return &Client{
		baseURL: base,
		http:    &http.Client{Timeout: timeout},
	}
}

// BaseURL vrací bázovou URL klienta (pro logging/debugging).
func (c *Client) BaseURL() string {
	return c.baseURL
}

// Ping ověří dostupnost Ollama daemon přes root endpoint.
// Vrací nil pokud HTTP 200; jinak chybu s HTTP status.
func (c *Client) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/", nil)
	if err != nil {
		return fmt.Errorf("ollama ping: build request: %w", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("ollama ping: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ollama ping: HTTP %d", resp.StatusCode)
	}
	return nil
}

// ListModels vrací jména stažených modelů na Ollama daemon.
// Voláno z `/healthz` handler — pokud DEFAULT_MODEL chybí v list,
// service je degraded (ne crash).
func (c *Client) ListModels(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/tags", nil)
	if err != nil {
		return nil, fmt.Errorf("ollama list models: build request: %w", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama list models: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama list models: HTTP %d: %s", resp.StatusCode, string(body))
	}

	var payload struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("ollama list models: decode: %w", err)
	}
	names := make([]string, 0, len(payload.Models))
	for _, m := range payload.Models {
		names = append(names, m.Name)
	}
	return names, nil
}

// generateRequest je payload pro POST /api/generate.
// Stream=false vrací single JSON response místo NDJSON streamu — wrapper
// API neexponuje streaming (per ADR-006 §D4).
type generateRequest struct {
	Model   string   `json:"model"`
	Prompt  string   `json:"prompt"`
	System  string   `json:"system,omitempty"`
	Images  []string `json:"images,omitempty"`
	Stream  bool     `json:"stream"`
	Options *Options `json:"options,omitempty"`
}

// generateResponse je single (non-stream) response z /api/generate.
type generateResponse struct {
	Model         string `json:"model"`
	Response      string `json:"response"`
	Done          bool   `json:"done"`
	TotalDuration int64  `json:"total_duration"` // nanoseconds
	EvalCount     int    `json:"eval_count"`     // tokens generated
}

// chatRequest je payload pro POST /api/chat.
type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Stream   bool      `json:"stream"`
	Options  *Options  `json:"options,omitempty"`
}

// chatResponse je single (non-stream) response z /api/chat.
type chatResponse struct {
	Model         string  `json:"model"`
	Message       Message `json:"message"`
	Done          bool    `json:"done"`
	TotalDuration int64   `json:"total_duration"`
	EvalCount     int     `json:"eval_count"`
}

// GenerateOptions je volitelný argument pro Generate / GenerateWithImage.
// Nil → defaults (žádné options pole se neposílá).
type GenerateOptions struct {
	System  string   // optional system prompt
	Images  []string // base64-encoded images (vision models only)
	Options *Options // sampling parameters
}

// Generate odešle text prompt na Ollama POST /api/generate a vrátí
// completion text. Retry 1× při transient (network / 5xx). Při ctx
// deadline retry odpadá.
//
// Pro multimodal (vision) volání použij GenerateWithImage nebo přímo
// GenerateOpts s opts.Images set.
func (c *Client) Generate(ctx context.Context, model, prompt string) (string, error) {
	return c.GenerateOpts(ctx, model, prompt, nil)
}

// GenerateOpts je rozšířená varianta Generate s system prompt + images +
// sampling options. Vrací parsed response text (strip whitespace).
func (c *Client) GenerateOpts(ctx context.Context, model, prompt string, opts *GenerateOptions) (string, error) {
	if model == "" {
		return "", errors.New("ollama generate: model is required")
	}
	if prompt == "" {
		return "", errors.New("ollama generate: prompt is required")
	}

	req := generateRequest{
		Model:  model,
		Prompt: prompt,
		Stream: false,
	}
	if opts != nil {
		req.System = opts.System
		req.Images = opts.Images
		req.Options = opts.Options
	}

	body, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("ollama generate: marshal: %w", err)
	}

	respBody, err := c.postWithRetry(ctx, "/api/generate", body)
	if err != nil {
		return "", err
	}

	var resp generateResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return "", fmt.Errorf("ollama generate: decode: %w", err)
	}
	return strings.TrimSpace(resp.Response), nil
}

// Chat odešle chat conversation na Ollama POST /api/chat a vrátí
// assistant message content. Použij pro multi-turn / system-prompted
// flows kde Generate prompt-string není dostatečný.
func (c *Client) Chat(ctx context.Context, model string, messages []Message) (string, error) {
	return c.ChatOpts(ctx, model, messages, nil)
}

// ChatOpts je rozšířená varianta Chat se sampling options.
func (c *Client) ChatOpts(ctx context.Context, model string, messages []Message, opts *Options) (string, error) {
	if model == "" {
		return "", errors.New("ollama chat: model is required")
	}
	if len(messages) == 0 {
		return "", errors.New("ollama chat: messages is required")
	}

	req := chatRequest{
		Model:    model,
		Messages: messages,
		Stream:   false,
		Options:  opts,
	}
	body, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("ollama chat: marshal: %w", err)
	}

	respBody, err := c.postWithRetry(ctx, "/api/chat", body)
	if err != nil {
		return "", err
	}

	var resp chatResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return "", fmt.Errorf("ollama chat: decode: %w", err)
	}
	return strings.TrimSpace(resp.Message.Content), nil
}

// GenerateWithImage odešle multimodal prompt (text + base64 image) na
// /api/generate s `images` polem. Voláno z `/v1/parse-photo` handler.
//
// imageB64 musí být čistý base64 string (bez "data:image/..." prefix).
// Validace prefix-stripping je odpovědnost handler vrstvy.
func (c *Client) GenerateWithImage(ctx context.Context, model, prompt, imageB64 string) (string, error) {
	if imageB64 == "" {
		return "", errors.New("ollama generate-with-image: image is required")
	}
	return c.GenerateOpts(ctx, model, prompt, &GenerateOptions{
		Images: []string{imageB64},
	})
}

// postWithRetry odešle POST request s 1 retry při transient error.
// Transient = network error (resp.Body unread) nebo HTTP 5xx.
// HTTP 4xx se nikdy nereetry-uje.
//
// Pokud ctx je už done, retry odpadá.
func (c *Client) postWithRetry(ctx context.Context, path string, body []byte) ([]byte, error) {
	const maxAttempts = 2 // 1 původní + 1 retry

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		// Při retry kontrola ctx — pokud expired, skoč ven s lastErr.
		if attempt > 0 {
			if ctx.Err() != nil {
				return nil, fmt.Errorf("ollama %s: ctx canceled before retry: %w", path, ctx.Err())
			}
		}

		respBody, transient, err := c.postOnce(ctx, path, body)
		if err == nil {
			return respBody, nil
		}
		lastErr = err
		if !transient {
			return nil, err
		}
	}
	return nil, fmt.Errorf("ollama %s: max retries exceeded: %w", path, lastErr)
}

// postOnce provede single POST. Vrací (body, isTransient, error).
// isTransient=true pro network err / 5xx; pro 4xx je false.
func (c *Client) postOnce(ctx context.Context, path string, body []byte) ([]byte, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("ollama %s: build request: %w", path, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// Network error → transient.
		return nil, true, fmt.Errorf("ollama %s: %w", path, err)
	}
	defer resp.Body.Close()

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, true, fmt.Errorf("ollama %s: read body: %w", path, readErr)
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return respBody, false, nil
	}

	transient := resp.StatusCode >= 500
	return nil, transient, fmt.Errorf("ollama %s: HTTP %d: %s", path, resp.StatusCode, string(respBody))
}
