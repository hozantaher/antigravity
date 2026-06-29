package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client communicates with an Ollama-compatible API.
type Client struct {
	baseURL    string
	model      string
	httpClient *http.Client
}

// Config for creating an LLM client.
type Config struct {
	BaseURL string // e.g. "http://localhost:11434" or Railway URL
	Model   string // e.g. "gemma2:2b"
	Timeout time.Duration
}

// NewClient creates an Ollama API client.
func NewClient(cfg Config) *Client {
	baseURL := cfg.BaseURL
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	model := cfg.Model
	if model == "" {
		model = "gemma2:2b"
	}
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}

	return &Client{
		baseURL: strings.TrimSuffix(baseURL, "/"),
		model:   model,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// generateRequest is the Ollama API request.
type generateRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
}

// generateResponse is the Ollama API response.
type generateResponse struct {
	Response      string `json:"response"`
	TotalDuration int64  `json:"total_duration"` // nanoseconds
	Done          bool   `json:"done"`
}

// Generate sends a prompt and returns the response text.
func (c *Client) Generate(ctx context.Context, prompt string) (string, time.Duration, error) {
	body, err := json.Marshal(generateRequest{
		Model:  c.model,
		Prompt: prompt,
		Stream: false,
	})
	if err != nil {
		return "", 0, fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return "", 0, fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", 0, fmt.Errorf("ollama HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var result generateResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", 0, fmt.Errorf("decode: %w", err)
	}

	duration := time.Duration(result.TotalDuration)
	return strings.TrimSpace(result.Response), duration, nil
}

// Ping checks if the Ollama server is reachable.
func (c *Client) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/", nil)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("ollama unreachable: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ollama HTTP %d", resp.StatusCode)
	}
	return nil
}

// ModelLoaded checks if the specified model is available.
func (c *Client) ModelLoaded(ctx context.Context) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/api/tags", nil)
	if err != nil {
		return false, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	var result struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false, err
	}

	for _, m := range result.Models {
		if m.Name == c.model || strings.HasPrefix(m.Name, c.model+":") {
			return true, nil
		}
	}
	return false, nil
}
