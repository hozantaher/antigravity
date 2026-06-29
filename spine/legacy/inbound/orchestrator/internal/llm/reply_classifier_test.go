package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fixedRand is a deterministic randSource for backoff tests.
type fixedRand struct{ v int }

func (f fixedRand) IntN(int) int { return f.v }

// successResponse builds an Anthropic Messages API JSON response with
// the given inner verdict.
func successResponse(t *testing.T, intent string, confidence float64, reasoning string) string {
	t.Helper()
	inner := map[string]any{
		"intent":     intent,
		"confidence": confidence,
		"reasoning":  reasoning,
	}
	innerJSON, err := json.Marshal(inner)
	if err != nil {
		t.Fatalf("marshal inner: %v", err)
	}
	outer := map[string]any{
		"content": []map[string]string{
			{"type": "text", "text": string(innerJSON)},
		},
	}
	outerJSON, err := json.Marshal(outer)
	if err != nil {
		t.Fatalf("marshal outer: %v", err)
	}
	return string(outerJSON)
}

func newTestClassifier(t *testing.T, srvURL string) *Classifier {
	t.Helper()
	return NewClassifier(
		"sk-test-key",
		WithEndpoint(srvURL),
		WithHTTPClient(&http.Client{Timeout: 2 * time.Second}),
		WithRandSource(fixedRand{v: 0}), // zero jitter
	)
}

// 1. Happy path positive ────────────────────────────────────────────────
func TestClassifyReply_PositiveHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify headers.
		if got := r.Header.Get("x-api-key"); got != "sk-test-key" {
			t.Errorf("x-api-key header = %q, want sk-test-key", got)
		}
		if got := r.Header.Get("anthropic-version"); got != anthropicVersion {
			t.Errorf("anthropic-version header = %q, want %s", got, anthropicVersion)
		}
		_, _ = io.WriteString(w, successResponse(t, IntentPositive, 0.92, "asks for meeting"))
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(),
		"Dobrý den, rád bych si domluvil schůzku. S pozdravem, Jan")
	if err != nil {
		t.Fatalf("ClassifyReply err = %v", err)
	}
	if v.Intent != IntentPositive {
		t.Errorf("Intent = %q, want %q", v.Intent, IntentPositive)
	}
	if v.Confidence != 0.92 {
		t.Errorf("Confidence = %v, want 0.92", v.Confidence)
	}
	if v.ModelUsed != DefaultModel {
		t.Errorf("ModelUsed = %q, want %q", v.ModelUsed, DefaultModel)
	}
}

// 2. Happy path negative ────────────────────────────────────────────────
func TestClassifyReply_NegativeHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, successResponse(t, IntentNegative, 0.88, "refusal"))
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(), "Nemáme zájem, děkuji.")
	if err != nil {
		t.Fatalf("ClassifyReply err = %v", err)
	}
	if v.Intent != IntentNegative {
		t.Errorf("Intent = %q, want %q", v.Intent, IntentNegative)
	}
}

// 3. Happy path bounce ─────────────────────────────────────────────────
func TestClassifyReply_BounceHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, successResponse(t, IntentBounce, 0.99, "mailer daemon"))
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(),
		"This is the mail system at host mx.seznam.cz. Delivery failed.")
	if err != nil {
		t.Fatalf("ClassifyReply err = %v", err)
	}
	if v.Intent != IntentBounce {
		t.Errorf("Intent = %q, want %q", v.Intent, IntentBounce)
	}
}

// 4. Malformed JSON in inner text → unknown verdict + err ──────────────
func TestClassifyReply_MalformedJSONResponse_ReturnsUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		outer := map[string]any{
			"content": []map[string]string{
				{"type": "text", "text": "this is not json {{{"},
			},
		}
		_ = json.NewEncoder(w).Encode(outer)
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(), "Ahoj")
	if err == nil {
		t.Errorf("want non-nil err for malformed JSON, got nil")
	}
	if v.Intent != IntentUnknown {
		t.Errorf("Intent = %q, want unknown on malformed JSON", v.Intent)
	}
	if v.Confidence != 0 {
		t.Errorf("Confidence = %v, want 0 on malformed JSON", v.Confidence)
	}
}

// 5. HTTP 5xx → retry then give up with unknown ────────────────────────
func TestClassifyReply_HTTP5xx_RetriesAndReturnsUnknown(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, "upstream down", http.StatusBadGateway)
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(), "Ahoj")
	if err == nil {
		t.Errorf("want non-nil err on persistent 5xx, got nil")
	}
	if v.Intent != IntentUnknown {
		t.Errorf("Intent = %q, want unknown on 5xx", v.Intent)
	}
	got := atomic.LoadInt32(&calls)
	if got != int32(MaxAttempts) {
		t.Errorf("call count = %d, want %d (full retry exhaustion)", got, MaxAttempts)
	}
}

// 6. Context cancellation (simulates timeout) → returns ctx.Err ───────
func TestClassifyReply_ContextCancelled_ReturnsErr(t *testing.T) {
	// A server that stalls long enough for the client-side context to
	// fire. We do NOT block on r.Context().Done() because Go's
	// httptest.Server.Close blocks waiting for in-flight handlers — a
	// stalled handler then prevents the test from cleaning up.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Server stalls 500ms — client ctx (50ms) fires first.
		select {
		case <-time.After(500 * time.Millisecond):
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(ctx, "Ahoj, jak se máte?")
	if err == nil {
		t.Errorf("want err on context cancel, got nil")
	}
	if v.Intent != IntentUnknown {
		t.Errorf("Intent = %q, want unknown on ctx cancel", v.Intent)
	}
}

// 7. Missing API key → unknown without HTTP call ──────────────────────
func TestClassifyReply_MissingAPIKey_ReturnsUnknown(t *testing.T) {
	called := int32(0)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&called, 1)
		_, _ = io.WriteString(w, successResponse(t, IntentPositive, 1, "should not be reached"))
	}))
	defer srv.Close()

	c := NewClassifier("", WithEndpoint(srv.URL))
	v, err := c.ClassifyReply(context.Background(), "Ahoj")
	if err != nil {
		t.Errorf("want nil err for missing API key, got %v", err)
	}
	if v.Intent != IntentUnknown {
		t.Errorf("Intent = %q, want unknown when API key missing", v.Intent)
	}
	if atomic.LoadInt32(&called) != 0 {
		t.Errorf("HTTP server hit %d times — must not call API without key", called)
	}
}

// 8. Body trim respects MaxBodyChars ──────────────────────────────────
func TestClassifyReply_BodyTrimRespectsMaxBodyChars(t *testing.T) {
	var capturedBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		capturedBody = b
		_, _ = io.WriteString(w, successResponse(t, IntentInfoRequest, 0.7, "asks for spec"))
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	huge := strings.Repeat("x", MaxBodyChars*3)
	_, err := c.ClassifyReply(context.Background(), huge)
	if err != nil {
		t.Fatalf("ClassifyReply err = %v", err)
	}

	// Decode payload.
	var payload struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(capturedBody, &payload); err != nil {
		t.Fatalf("decode captured payload: %v", err)
	}
	if len(payload.Messages) != 1 {
		t.Fatalf("messages len = %d, want 1", len(payload.Messages))
	}
	got := payload.Messages[0].Content
	if len(got) > MaxBodyChars+len("\n...[truncated]...\n") {
		t.Errorf("trimmed body len = %d, want <= MaxBodyChars+marker", len(got))
	}
	if !strings.Contains(got, "[truncated]") {
		t.Errorf("trimmed body missing truncation marker: %q...", got[:min(80, len(got))])
	}
	if !strings.HasPrefix(got, "x") {
		t.Errorf("trimmed body should start with head text")
	}
	if !strings.HasSuffix(got, "x") {
		t.Errorf("trimmed body should end with tail text")
	}
}

// 9. Empty body short-circuits ────────────────────────────────────────
func TestClassifyReply_EmptyBody_NoAPICall(t *testing.T) {
	called := int32(0)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&called, 1)
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(), "   \n\t ")
	if err != nil {
		t.Errorf("want nil err on empty body, got %v", err)
	}
	if v.Intent != IntentUnknown {
		t.Errorf("Intent = %q, want unknown on empty body", v.Intent)
	}
	if atomic.LoadInt32(&called) != 0 {
		t.Errorf("HTTP hit %d times — empty body must short-circuit", called)
	}
}

// 10. Invalid intent label from model → unknown + err ────────────────
func TestClassifyReply_InvalidIntentLabel_ReturnsUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Model hallucinates an unallowed label.
		_, _ = io.WriteString(w, successResponse(t, "maybe", 0.5, "uncertain"))
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(), "Možná, uvidíme.")
	if err == nil {
		t.Errorf("want non-nil err for invalid intent, got nil")
	}
	if v.Intent != IntentUnknown {
		t.Errorf("Intent = %q, want unknown on invalid intent", v.Intent)
	}
}

// 11. Code-fence stripping ────────────────────────────────────────────
func TestClassifyReply_CodeFenceStripping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inner := `{"intent":"unsubscribe","confidence":0.95,"reasoning":"explicit unsubscribe"}`
		wrapped := "```json\n" + inner + "\n```"
		outer := map[string]any{
			"content": []map[string]string{{"type": "text", "text": wrapped}},
		}
		_ = json.NewEncoder(w).Encode(outer)
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(), "Odhlaste mě prosím.")
	if err != nil {
		t.Fatalf("ClassifyReply err = %v", err)
	}
	if v.Intent != IntentUnsubscribe {
		t.Errorf("Intent = %q, want %q", v.Intent, IntentUnsubscribe)
	}
}

// 12. 4xx non-retryable returns immediately ──────────────────────────
func TestClassifyReply_4xxNonRetryable_NoRetries(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, `{"type":"error","error":{"type":"invalid_request_error"}}`, http.StatusBadRequest)
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(), "Ahoj")
	if err == nil {
		t.Errorf("want non-nil err on 400, got nil")
	}
	if v.Intent != IntentUnknown {
		t.Errorf("Intent = %q, want unknown on 400", v.Intent)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("call count = %d, want 1 (no retry on 4xx)", got)
	}
}

// 13. 429 retries until success (transient rate-limit) ───────────────
func TestClassifyReply_429RetriesUntilSuccess(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n < 2 {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		_, _ = io.WriteString(w, successResponse(t, IntentPositive, 0.81, "asks for catalog"))
	}))
	defer srv.Close()

	c := newTestClassifier(t, srv.URL)
	v, err := c.ClassifyReply(context.Background(), "Pošlete mi ceník prosím.")
	if err != nil {
		t.Fatalf("ClassifyReply err = %v", err)
	}
	if v.Intent != IntentPositive {
		t.Errorf("Intent = %q, want positive after 429 retry", v.Intent)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("call count = %d, want 2 (429 then 200)", got)
	}
}

// ── helper for Go < 1.21 compat (we are on 1.25 but keep it explicit) ──
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
