package ares

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"contacts/internal/blockdetect"
)

const (
	defaultBaseURL   = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty"
	defaultRateLimit = time.Second // 1 request per second (conservative default)
	defaultTimeout   = 10 * time.Second
	maxRetries       = 3
	retryBackoffBase = 2 * time.Second
)

// tokenBucket is a thread-safe rate limiter backed by a buffered channel.
// A background goroutine refills the bucket at a fixed interval.
// The bucket is stopped when the context passed to newTokenBucket is cancelled.
type tokenBucket struct {
	tokens chan struct{}
	stop   chan struct{}
}

func newTokenBucket(ctx context.Context, ratePerSec int, burst int) *tokenBucket {
	if ratePerSec <= 0 {
		ratePerSec = 1
	}
	if burst < ratePerSec {
		burst = ratePerSec
	}
	tb := &tokenBucket{
		tokens: make(chan struct{}, burst),
		stop:   make(chan struct{}),
	}
	// Pre-fill the bucket up to burst capacity.
	for i := 0; i < burst; i++ {
		tb.tokens <- struct{}{}
	}
	ticker := time.NewTicker(time.Second / time.Duration(ratePerSec))
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				close(tb.stop)
				return
			case <-tb.stop:
				return
			case <-ticker.C:
				select {
				case tb.tokens <- struct{}{}: // refill one token
				default: // bucket is full
				}
			}
		}
	}()
	return tb
}

// Wait blocks until a token is available or ctx is cancelled.
func (tb *tokenBucket) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-tb.stop:
		return context.Canceled
	case <-tb.tokens:
		return nil
	}
}

// BlockObserver is a hook invoked whenever blockdetect classifies a fetch as
// a semantic block (rate_limit / captcha / cloudflare / forbidden). Callers
// (KT-A7 health monitor, healing_log writer, alt-source switcher) plug in
// here without the ARES client needing to know about them.
//
// targetURL is the full URL that was fetched (includes ICO).
// blockType is the classification.
// httpStatus is the upstream status as observed.
// bodyPrefix is a short signature slice (≤ 4 kB) for forensic logging.
type BlockObserver func(targetURL string, blockType blockdetect.BlockType, httpStatus int, bodyPrefix []byte)

// Client provides access to the ARES REST API with rate limiting.
type Client struct {
	baseURL       string
	client        *http.Client
	rateLimit     time.Duration // used when bucket is nil (legacy / tests)
	retryBackoff  time.Duration // base backoff between retries (default retryBackoffBase)
	mu            sync.Mutex
	lastReq       time.Time
	bucket        *tokenBucket // non-nil when WithRate is used
	blockObserver BlockObserver
}

// ClientOption configures the ARES client.
type ClientOption func(*Client)

// WithBaseURL overrides the ARES API base URL (for testing).
func WithBaseURL(url string) ClientOption {
	return func(c *Client) { c.baseURL = url }
}

// WithRateLimit sets the minimum interval between requests (simple sleep limiter).
// For concurrent use, prefer WithRate which provides a thread-safe token bucket.
func WithRateLimit(d time.Duration) ClientOption {
	return func(c *Client) { c.rateLimit = d }
}

// WithRate configures a token bucket rate limiter at ratePerSec requests/second
// with a burst capacity equal to ratePerSec. The bucket runs until ctx is cancelled.
// This is the recommended option for concurrent sync workers.
func WithRate(ctx context.Context, ratePerSec int) ClientOption {
	return func(c *Client) {
		c.bucket = newTokenBucket(ctx, ratePerSec, ratePerSec)
	}
}

// WithHTTPClient sets a custom HTTP client.
func WithHTTPClient(hc *http.Client) ClientOption {
	return func(c *Client) { c.client = hc }
}

// WithRetryBackoff overrides the base retry backoff duration.
// Set to 0 to disable backoff — useful in tests to avoid slow retry delays.
func WithRetryBackoff(d time.Duration) ClientOption {
	return func(c *Client) { c.retryBackoff = d }
}

// WithBlockObserver registers a callback invoked whenever a fetch trips
// blockdetect (KT-A8). The observer must be cheap and non-blocking — it
// runs on the request goroutine. Pass nil to disable.
//
// Multiple observers can be combined by wrapping them in a single function
// (the client itself only stores one observer reference). The KT-A8.1
// healing_log writer is registered via WithHealingLog(...) which is the
// preferred entry-point for production wiring.
func WithBlockObserver(o BlockObserver) ClientOption {
	return func(c *Client) { c.blockObserver = o }
}

// WithHealingLog wires the KT-A8.1 healing_log writer as a BlockObserver.
// This is the production entry-point — operators pass the *sql.DB the
// service already owns and audit rows land in healing_log on every block.
//
// Combines transparently with an existing observer: if WithBlockObserver
// has already been called, both callbacks fire (writer first, then the
// existing observer). This lets KT-A7 health-monitor + healing_log run
// in the same client without one displacing the other.
//
// Source name is fixed to "ares" for this client; the firmy.cz scraper
// passes "firmy_cz" via the same helper from its own wrapper.
func WithHealingLog(writer *blockdetect.LogWriter) ClientOption {
	return func(c *Client) {
		if writer == nil {
			return
		}
		auditObserver := writer.AsObserver("ares")
		existing := c.blockObserver
		if existing == nil {
			c.blockObserver = auditObserver
			return
		}
		// Chain: audit first (best-effort, swallows errors), then existing.
		c.blockObserver = func(url string, bt blockdetect.BlockType, status int, body []byte) {
			auditObserver(url, bt, status, body)
			existing(url, bt, status, body)
		}
	}
}

// NewClient creates a new ARES API client.
func NewClient(opts ...ClientOption) *Client {
	c := &Client{
		baseURL:      defaultBaseURL,
		client:       &http.Client{Timeout: defaultTimeout},
		rateLimit:    defaultRateLimit,
		retryBackoff: retryBackoffBase,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// FetchSubject fetches a single economic subject by ICO.
// Returns nil data and no error for 404 (subject not found in ARES).
func (c *Client) FetchSubject(ctx context.Context, ico string) (*SubjectData, error) {
	// Rate limiting: token bucket takes priority; fall back to simple sleep throttle.
	if c.bucket != nil {
		if err := c.bucket.Wait(ctx); err != nil {
			return nil, err
		}
	} else {
		if err := c.throttle(ctx); err != nil {
			return nil, err
		}
	}

	url := fmt.Sprintf("%s/%s", c.baseURL, ico)

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			backoff := c.retryBackoff * time.Duration(attempt)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		data, err := c.doFetch(ctx, url)
		if err == nil {
			return data, nil
		}

		// Don't retry on context cancellation or 404
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if isNotFound(err) {
			return nil, nil
		}

		lastErr = err
	}

	return nil, fmt.Errorf("ares fetch %s after %d retries: %w", ico, maxRetries, lastErr)
}

func (c *Client) doFetch(ctx context.Context, url string) (*SubjectData, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, &notFoundError{ico: url}
	}

	// Read up to 1 MB so blockdetect sees the meaningful prefix and the
	// JSON decoder can still decode the full ARES response without a second
	// network round-trip. ARES subject payloads are well under 200 kB.
	const maxBody = 1 << 20
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if readErr != nil {
		return nil, fmt.Errorf("read response body: %w", readErr)
	}

	// KT-A8 — semantic block detection. Runs on every response (including
	// 5xx and unexpected non-200) so that a Cloudflare 403, a 200 OK
	// challenge page and a 503 + Retry-After are all classified uniformly.
	if blockType := blockdetect.DetectBlock(resp.StatusCode, resp.Header, body); blockType != blockdetect.BlockTypeNone {
		c.notifyBlock(url, blockType, resp.StatusCode, body)
		return nil, &blockError{
			blockType: blockType,
			status:    resp.StatusCode,
			url:       url,
			snippet:   bodySnippet(body),
		}
	}

	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return nil, fmt.Errorf("ares status %d: %s", resp.StatusCode, string(snippetForLegacyError(body)))
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ares status %d: %s", resp.StatusCode, string(snippetForLegacyError(body)))
	}

	var subject SubjectResponse
	if err := json.Unmarshal(body, &subject); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	data := ParseSubject(subject)
	return &data, nil
}

// notifyBlock invokes the registered BlockObserver (if any) and emits a
// structured slog.Warn so operators see the event even before KT-A7 wiring.
// Czech-facing message text per CLAUDE.md UI conventions.
func (c *Client) notifyBlock(url string, blockType blockdetect.BlockType, status int, body []byte) {
	slog.Warn("ares: detekován blok upstream odpovědi",
		"op", "ares.detect_block",
		"block_type", blockType.String(),
		"http_status", status,
		"target_url", url,
		"body_signature", string(bodySnippet(body)),
	)
	if c.blockObserver != nil {
		c.blockObserver(url, blockType, status, body)
	}
}

// bodySnippet returns up to 200 bytes of the response body for forensic logs
// + healing_log audit. Trimmed to a single line so SQL inserts stay clean.
func bodySnippet(body []byte) []byte {
	const snippetCap = 200
	if len(body) > snippetCap {
		body = body[:snippetCap]
	}
	out := make([]byte, len(body))
	for i, b := range body {
		switch b {
		case '\n', '\r', '\t':
			out[i] = ' '
		default:
			out[i] = b
		}
	}
	return out
}

// snippetForLegacyError returns the same 512-byte prefix the previous
// implementation used in error messages, so existing callers (and tests)
// continue to see familiar context strings on 5xx / unexpected statuses.
func snippetForLegacyError(body []byte) []byte {
	const cap = 512
	if len(body) > cap {
		return body[:cap]
	}
	return body
}

func (c *Client) throttle(ctx context.Context) error {
	if c.rateLimit <= 0 {
		return nil
	}
	c.mu.Lock()
	elapsed := time.Since(c.lastReq)
	var sleep time.Duration
	if elapsed < c.rateLimit {
		sleep = c.rateLimit - elapsed
	}
	c.lastReq = time.Now().Add(sleep)
	c.mu.Unlock()
	if sleep > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(sleep):
		}
	}
	return nil
}

type notFoundError struct {
	ico string
}

func (e *notFoundError) Error() string {
	return fmt.Sprintf("ares: subject not found: %s", e.ico)
}

func isNotFound(err error) bool {
	_, ok := err.(*notFoundError)
	return ok
}

// blockError is returned from doFetch when blockdetect classified the
// response as a semantic block. The exported helper IsBlock + BlockType
// give callers (and tests) a typed way to react.
type blockError struct {
	blockType blockdetect.BlockType
	status    int
	url       string
	snippet   []byte
}

func (e *blockError) Error() string {
	return fmt.Sprintf("ares: block detected: type=%s status=%d url=%s body=%q",
		e.blockType.String(), e.status, e.url, string(e.snippet))
}

// IsBlock reports whether err originates from blockdetect classification.
// It walks the error chain so callers see through fmt.Errorf("%w") wraps.
func IsBlock(err error) bool {
	var be *blockError
	return errors.As(err, &be)
}

// BlockType returns the underlying block classification, or BlockTypeNone
// when err is not a block error. Walks the error chain via errors.As.
func BlockType(err error) blockdetect.BlockType {
	var be *blockError
	if errors.As(err, &be) {
		return be.blockType
	}
	return blockdetect.BlockTypeNone
}
