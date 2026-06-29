// Package llmclient is a thin HTTP client used by the orchestrator to
// reach the llm-runner service (`services/llm-runner`). The orchestrator
// does not depend on the llm-runner Go package directly so that wire
// shape changes ratchet through ADR-006 §D2 contract reviews instead of
// silent compile-time coupling.
//
// This file owns the photo-parse contract (`POST /v1/parse-photo`) and
// the failure semantics expected by the inbound photo pipeline:
//   - llm-runner unavailable → ErrUnavailable (caller persists blob +
//     records `extracted=NULL` audit row + retry queue).
//   - llm-runner returns 501 (skeleton) → ErrNotImplemented (caller
//     persists blob with `extracted={}` so downstream retry job knows
//     to re-call once Ollama is wired).
//   - any other non-2xx → returned verbatim wrapped so operators see
//     the upstream status in slog.
package llmclient

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

// DefaultTimeout for `/v1/parse-photo` matches ADR-006 §D4 vision
// budget (30s vision + 30s margin). Single-shot, no streaming.
const DefaultTimeout = 60 * time.Second

// ErrUnavailable signals the caller that llm-runner could not be
// reached at all (DNS, connection refused, timeout). The caller's
// fail-open path uses errors.Is to switch into retry-queue mode.
var ErrUnavailable = errors.New("llmclient: llm-runner unavailable")

// ErrNotImplemented mirrors the 501 the skeleton handler returns
// today. We keep this distinct from ErrUnavailable so observability can
// tell "skeleton not yet wired" from "ollama box down".
var ErrNotImplemented = errors.New("llmclient: parse-photo not implemented")

// Config holds connect parameters. Empty BaseURL → caller wired the
// pipeline without configuring LLM_RUNNER_URL; the orchestrator skips
// llm calls and writes audit rows with `extracted=NULL` (per task spec
// fail-open semantic).
type Config struct {
	BaseURL string        // e.g. "http://llm-runner.railway.internal:8092"
	APIKey  string        // optional; empty → no X-LLM-Api-Key header
	Timeout time.Duration // default DefaultTimeout
}

// Client is a small wrapper around net/http. Reuse a single Client per
// orchestrator boot — net/http connection pooling matters even at low
// QPS because Railway internal DNS is DNS-load-balanced and we want
// keep-alive.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// NewClient constructs a Client. Empty BaseURL is allowed so the
// orchestrator can boot without llm-runner wired; ParsePhoto then
// returns ErrUnavailable on every call.
func NewClient(cfg Config) *Client {
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	return &Client{
		baseURL: strings.TrimSuffix(strings.TrimSpace(cfg.BaseURL), "/"),
		apiKey:  cfg.APIKey,
		http:    &http.Client{Timeout: timeout},
	}
}

// PhotoExtract is the structured output of `/v1/parse-photo`. Fields
// are pointers so we can distinguish "model returned 0" from "field
// absent". Callers typically marshal this back to JSON for the
// `photo_parse_audit.extracted` column without further translation.
//
// The shape is the contract documented in
// `services/llm-runner/cmd/llm-runner/main.go` parsePhotoHandler doc.
type PhotoExtract struct {
	Year        *int     `json:"year,omitempty"`
	Make        string   `json:"make,omitempty"`
	Model       string   `json:"model,omitempty"`
	Condition   string   `json:"condition,omitempty"`
	OdometerKM  *int     `json:"odometer_km,omitempty"`
	Confidence  *float64 `json:"confidence,omitempty"`
	RawResponse string   `json:"raw_response,omitempty"` // kept for audit
}

// ParsePhoto sends a base64-encoded image to llm-runner and decodes
// the structured response. The `context` argument is forwarded to the
// model as the prompt hint (ADR-006 §D2 contract).
//
// On any network failure or non-2xx response the function returns a
// wrapped error. Callers should branch on errors.Is(err,
// ErrUnavailable) / errors.Is(err, ErrNotImplemented) to drive
// retry-queue logic.
func (c *Client) ParsePhoto(ctx context.Context, imageB64, promptContext string) (*PhotoExtract, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("%w: empty base url", ErrUnavailable)
	}
	if strings.TrimSpace(imageB64) == "" {
		return nil, errors.New("llmclient: empty image_b64")
	}

	body, err := json.Marshal(map[string]string{
		"image_b64": imageB64,
		"context":   promptContext,
	})
	if err != nil {
		return nil, fmt.Errorf("llmclient: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.baseURL+"/v1/parse-photo", bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("llmclient: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("X-LLM-Api-Key", c.apiKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// net/http surfaces both context.DeadlineExceeded and
		// connection refused via Do; we treat both as Unavailable so
		// the caller can degrade gracefully (retry-queue path).
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()

	raw, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, fmt.Errorf("%w: read body: %v", ErrUnavailable, readErr)
	}

	switch {
	case resp.StatusCode == http.StatusOK:
		var out PhotoExtract
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("llmclient: decode response: %w", err)
		}
		out.RawResponse = string(raw)
		return &out, nil
	case resp.StatusCode == http.StatusNotImplemented:
		return nil, fmt.Errorf("%w: HTTP %d", ErrNotImplemented, resp.StatusCode)
	case resp.StatusCode >= 500:
		return nil, fmt.Errorf("%w: HTTP %d body=%s",
			ErrUnavailable, resp.StatusCode, truncate(string(raw), 200))
	default:
		return nil, fmt.Errorf("llmclient: HTTP %d body=%s",
			resp.StatusCode, truncate(string(raw), 200))
	}
}

// truncate keeps log lines bounded so we never dump a 10 MB response
// body into slog. 200 chars is enough for HTTP error JSON.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
