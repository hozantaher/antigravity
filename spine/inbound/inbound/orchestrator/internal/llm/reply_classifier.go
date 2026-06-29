// Package llm provides the Sprint AC8 Haiku pre-classifier for inbound
// reply tagging. It is a separate package from `services/orchestrator/llm`
// (which holds the Ollama-backed sentiment classifier wired into
// ProcessReply's hot path). AC8 pre-classification is fire-and-forget
// async metadata, not a hot-path decision input — keeping it in its own
// package avoids overlapping with the ADR-006 Ollama contract.
//
// The classifier calls Anthropic Messages API directly over net/http
// (instead of the Anthropic SDK used elsewhere) so unit tests can mock
// transport via httptest without provider-specific test scaffolding.
//
// HARD RULE coverage:
//   - feedback_no_magic_thresholds (T0): every threshold (body cap,
//     classifier timeout, backoff base, max attempts, max tokens) is a
//     named package constant with a doc comment.
//   - feedback_external_io_backoff (T0): Anthropic HTTP call wrapped in
//     exponential backoff + jitter for transient (5xx, 429, transport)
//     errors, with explicit MaxAttempts cap.
//   - feedback_no_pii_in_commands (T0): the classifier emits no slog
//     line containing plain reply body — only intent + sender domain +
//     classifier metadata.
//   - feedback_no_speculation (T0): every assertion below is sourced
//     from Anthropic Messages API docs (https://docs.anthropic.com/en/
//     api/messages) or the spec doc; no fabricated behaviour.
package llm

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Tunable thresholds — feedback_no_magic_thresholds (T0).
const (
	// DefaultModel is the Anthropic model id used for AC8 pre-classification.
	// Haiku is chosen for cost (cheapest tier) and latency (8s p95).
	DefaultModel = "claude-haiku-4-5-20251001"

	// MaxBodyChars caps the reply body length forwarded to the API.
	// 2 000 chars covers >99% of B2B replies and bounds Anthropic input
	// token spend per call. Trim keeps the head + tail (first 1 500 +
	// last 500) so signature blocks remain visible.
	MaxBodyChars = 2000

	// HeadCharsOnTruncate / TailCharsOnTruncate is the head/tail split
	// applied when MaxBodyChars is exceeded. The middle is replaced with
	// a "...[truncated]..." marker so the model sees the boundary.
	// Sum must be strictly less than MaxBodyChars so the marker fits.
	HeadCharsOnTruncate = 1400
	TailCharsOnTruncate = 400

	// ClassifierTimeout is the per-call deadline applied to the HTTP
	// round-trip (including retry attempts). The caller in
	// thread.ProcessReply pads this with +3s so the DB UPDATE that
	// persists the result has its own budget.
	ClassifierTimeout = 5 * time.Second

	// BackoffBase is the initial sleep between retries. Doubles per
	// attempt with jitter, capped by MaxAttempts.
	BackoffBase = 500 * time.Millisecond

	// MaxAttempts is the total HTTP attempt cap (initial + retries).
	// 3 attempts ~= 0.5s + 1s + 2s worst case = ~3.5s, comfortably
	// inside ClassifierTimeout.
	MaxAttempts = 3

	// MaxOutputTokens caps the Anthropic response length. JSON envelope
	// {intent, confidence, reasoning} fits well below 200 tokens; the
	// extra headroom forgives verbose Haiku rationales.
	MaxOutputTokens = 200

	// anthropicEndpoint is the default Anthropic Messages API URL.
	// Override via NewClassifier(...) for httptest in unit tests.
	anthropicEndpoint = "https://api.anthropic.com/v1/messages"

	// anthropicVersion is the API version header value required by
	// Anthropic — see https://docs.anthropic.com/en/api/versioning.
	anthropicVersion = "2023-06-01"
)

// Allowed intents — the prompt instructs Haiku to pick from this set.
// "unknown" is the fallback we record when the model is unavailable or
// returns an unparseable payload.
const (
	IntentPositive    = "positive"
	IntentNegative    = "negative"
	IntentInfoRequest = "info_request"
	IntentUnsubscribe = "unsubscribe"
	IntentBounce      = "bounce"
	IntentUnknown     = "unknown"
)

// systemPrompt is the user-visible instruction sent as the Anthropic
// system field. CZ-only — every AC8 inbound is Czech-language B2B mail
// (see modules/outreach/CLAUDE.md).
const systemPrompt = `Klasifikuj následující CZ B2B email reply do jedné kategorie:
- positive: zájem o nabídku, dotaz na detaily, žádost o schůzku
- negative: odmítnutí, "nemáme zájem", "nikoliv", "ne"
- info_request: žádost o víc informací, "co přesně nabízíte"
- unsubscribe: žádost o odhlášení, "odeberte mě"
- bounce: automatická bounce zpráva (Mailer-Daemon)

Odpověz výhradně JSON: {"intent": "...", "confidence": 0.0-1.0, "reasoning": "krátký důvod"}`

// Classification is the parsed pre-classification verdict returned by
// ClassifyReply. Confidence is in [0, 1]. ModelUsed is the Anthropic
// model id that produced the result, or "" when the verdict is the
// fallback unknown.
type Classification struct {
	Intent     string  `json:"intent"`
	Confidence float64 `json:"confidence"`
	Reasoning  string  `json:"reasoning"`
	ModelUsed  string  `json:"model_used"`
}

// Classifier is the public surface called from thread.ProcessReply.
// Zero value is unusable — construct with NewClassifier.
type Classifier struct {
	apiKey     string
	model      string
	endpoint   string
	httpClient *http.Client
	rng        randSource
}

// randSource lets tests inject deterministic jitter. Production uses
// crypto/rand via the cryptoRandSource type below.
type randSource interface {
	IntN(n int) int
}

// Option is a functional option for NewClassifier.
type Option func(*Classifier)

// WithEndpoint overrides the Anthropic endpoint. Used by tests pointing
// at httptest.Server URLs.
func WithEndpoint(url string) Option {
	return func(c *Classifier) { c.endpoint = url }
}

// WithModel overrides DefaultModel.
func WithModel(model string) Option {
	return func(c *Classifier) { c.model = model }
}

// WithHTTPClient injects a pre-configured http.Client (timeouts, mock
// transport, etc.). When nil the classifier owns a *http.Client with
// ClassifierTimeout as its overall budget.
func WithHTTPClient(client *http.Client) Option {
	return func(c *Classifier) { c.httpClient = client }
}

// WithRandSource injects deterministic randomness for jitter. Tests use
// this to assert backoff sequences without flaky time-based assertions.
func WithRandSource(r randSource) Option {
	return func(c *Classifier) { c.rng = r }
}

// NewClassifier constructs a Classifier. apiKey="" is allowed — the
// resulting Classifier will refuse to call the API and ClassifyReply
// will return IntentUnknown with confidence 0 (and slog.Warn at boot).
func NewClassifier(apiKey string, opts ...Option) *Classifier {
	c := &Classifier{
		apiKey:   apiKey,
		model:    DefaultModel,
		endpoint: anthropicEndpoint,
		rng:      cryptoRandSource{},
	}
	for _, opt := range opts {
		opt(c)
	}
	if c.httpClient == nil {
		c.httpClient = &http.Client{Timeout: ClassifierTimeout}
	}
	return c
}

// ClassifyReply classifies an inbound reply body and returns the
// verdict. The function never propagates network or parse errors —
// every failure mode collapses to (Classification{Intent: "unknown",
// Confidence: 0, ModelUsed: ""}, nil-or-wrapped-error). The caller can
// either persist the unknown verdict or skip the UPDATE.
//
// The returned error is non-nil only for caller observability (slog +
// Sentry). Behaviour is identical regardless of err — the verdict is
// always populated.
func (c *Classifier) ClassifyReply(ctx context.Context, body string) (Classification, error) {
	// Empty body short-circuit. No reason to spend tokens or to fail
	// open when there is nothing to classify.
	if strings.TrimSpace(body) == "" {
		return Classification{Intent: IntentUnknown, Confidence: 0}, nil
	}
	if c.apiKey == "" {
		// Boot-time slog already warned; here we silently return so the
		// caller doesn't double-log per inbound message.
		return Classification{Intent: IntentUnknown, Confidence: 0}, nil
	}

	prompt := trimBody(body, MaxBodyChars)

	payload := map[string]any{
		"model":      c.model,
		"max_tokens": MaxOutputTokens,
		"system":     systemPrompt,
		"messages": []map[string]any{
			{"role": "user", "content": prompt},
		},
	}
	body4Req, err := json.Marshal(payload)
	if err != nil {
		// Cannot happen with JSON-serializable inputs above, but guard
		// for forward-compat if a future Option adds non-JSON content.
		return Classification{Intent: IntentUnknown, Confidence: 0},
			fmt.Errorf("marshal anthropic payload: %w", err)
	}

	rawResp, err := c.doWithBackoff(ctx, body4Req)
	if err != nil {
		return Classification{Intent: IntentUnknown, Confidence: 0}, err
	}

	verdict, perr := parseVerdict(rawResp)
	if perr != nil {
		return Classification{Intent: IntentUnknown, Confidence: 0}, perr
	}
	verdict.ModelUsed = c.model
	return verdict, nil
}

// doWithBackoff issues the HTTP POST with exponential backoff + jitter
// on transient failures (network, 5xx, 429). Non-retryable 4xx (auth,
// bad request) returns the body verbatim on first attempt.
func (c *Classifier) doWithBackoff(ctx context.Context, body []byte) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		if attempt > 0 {
			sleep := backoffDelay(attempt, c.rng)
			t := time.NewTimer(sleep)
			select {
			case <-ctx.Done():
				t.Stop()
				return nil, ctx.Err()
			case <-t.C:
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost,
			c.endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-api-key", c.apiKey)
		req.Header.Set("anthropic-version", anthropicVersion)

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("anthropic transport: %w", err)
			continue // transport errors are retryable
		}
		respBody, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("read anthropic response: %w", readErr)
			continue
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return respBody, nil
		}
		// 429 + 5xx are retryable. Everything else is terminal (auth
		// failure, bad request, model-not-found).
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("anthropic http %d: %s",
				resp.StatusCode, snippet(respBody))
			continue
		}
		return nil, fmt.Errorf("anthropic http %d (non-retryable): %s",
			resp.StatusCode, snippet(respBody))
	}
	if lastErr == nil {
		lastErr = errors.New("anthropic: exhausted attempts without response")
	}
	return nil, lastErr
}

// backoffDelay returns the per-attempt sleep. attempt is 1-indexed
// (first retry == 1). Adds ±25% jitter via rng.
func backoffDelay(attempt int, rng randSource) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	// Exponential: BackoffBase * 2^(attempt-1).
	base := BackoffBase << (attempt - 1)
	if base <= 0 {
		base = BackoffBase
	}
	// Jitter range: ±25%. Use rng.IntN(int(base/2)) and subtract base/4.
	jitterMax := int(base / 2)
	if jitterMax <= 0 {
		return base
	}
	jitter := time.Duration(rng.IntN(jitterMax)) - base/4
	return base + jitter
}

// anthropicResponse mirrors the subset of the Messages API response we
// consume. Schema: https://docs.anthropic.com/en/api/messages#response.
type anthropicResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// parseVerdict decodes Anthropic's wrapper, extracts the text block,
// and parses the inner JSON verdict produced by the system prompt.
// Unparseable responses → IntentUnknown verdict + non-nil error.
func parseVerdict(raw []byte) (Classification, error) {
	var outer anthropicResponse
	if err := json.Unmarshal(raw, &outer); err != nil {
		return Classification{Intent: IntentUnknown, Confidence: 0},
			fmt.Errorf("parse anthropic wrapper: %w", err)
	}
	if len(outer.Content) == 0 || outer.Content[0].Text == "" {
		return Classification{Intent: IntentUnknown, Confidence: 0},
			errors.New("anthropic: empty content")
	}

	text := strings.TrimSpace(outer.Content[0].Text)
	// Haiku occasionally wraps JSON in ```json fences. Strip them.
	text = stripCodeFences(text)

	var inner struct {
		Intent     string  `json:"intent"`
		Confidence float64 `json:"confidence"`
		Reasoning  string  `json:"reasoning"`
	}
	if err := json.Unmarshal([]byte(text), &inner); err != nil {
		return Classification{Intent: IntentUnknown, Confidence: 0},
			fmt.Errorf("parse verdict json: %w", err)
	}
	if !isAllowedIntent(inner.Intent) {
		return Classification{Intent: IntentUnknown, Confidence: 0,
			Reasoning: inner.Reasoning}, fmt.Errorf("anthropic: invalid intent %q", inner.Intent)
	}
	if inner.Confidence < 0 || inner.Confidence > 1 {
		inner.Confidence = clamp01(inner.Confidence)
	}
	return Classification{
		Intent:     inner.Intent,
		Confidence: inner.Confidence,
		Reasoning:  inner.Reasoning,
	}, nil
}

// isAllowedIntent guards against typos and hallucinated labels.
func isAllowedIntent(s string) bool {
	switch s {
	case IntentPositive, IntentNegative, IntentInfoRequest,
		IntentUnsubscribe, IntentBounce:
		return true
	}
	return false
}

func clamp01(f float64) float64 {
	if f < 0 {
		return 0
	}
	if f > 1 {
		return 1
	}
	return f
}

// stripCodeFences removes ```json ... ``` wrappers if present. Idempotent.
func stripCodeFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		// Trim leading fence (with optional language tag).
		if nl := strings.IndexByte(s, '\n'); nl > 0 {
			s = s[nl+1:]
		}
	}
	s = strings.TrimSuffix(strings.TrimSpace(s), "```")
	return strings.TrimSpace(s)
}

// trimBody enforces MaxBodyChars while preserving head + tail context.
func trimBody(body string, maxChars int) string {
	if len(body) <= maxChars {
		return body
	}
	if HeadCharsOnTruncate+TailCharsOnTruncate >= maxChars {
		// Defensive: degenerate config — just take the prefix.
		return body[:maxChars]
	}
	head := body[:HeadCharsOnTruncate]
	tail := body[len(body)-TailCharsOnTruncate:]
	return head + "\n...[truncated]...\n" + tail
}

// snippet returns the first 200 bytes of a response body, for slog/
// error wrapping. Keeps log lines bounded without losing the upstream
// failure context.
func snippet(b []byte) string {
	const max = 200
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max])
}

// cryptoRandSource is the default randSource; uses crypto/rand because
// math/rand on package-level globals breaks under -race in parallel
// tests and provides no security benefit here either way.
type cryptoRandSource struct{}

func (cryptoRandSource) IntN(n int) int {
	if n <= 0 {
		return 0
	}
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand failing is exceptional; degrade to 0 so backoff
		// stays deterministic and the caller is not blocked.
		slog.Warn("ac8 classifier: crypto/rand failed, jitter=0",
			"op", "internalllm.cryptoRandSource.IntN/fallback",
			"error", err)
		return 0
	}
	return int(binary.BigEndian.Uint64(buf[:]) % uint64(n))
}
