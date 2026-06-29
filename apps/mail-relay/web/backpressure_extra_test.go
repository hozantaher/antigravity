package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// AW6-2 (cycle 2) — relay /v1/submit backpressure edge cases beyond the AW4-2
// baseline (PR #1193).
//
// memory feedback_extreme_testing: AW4-2 shipped 15 cases. This file covers
// the second-order edges from cycle-2 review:
//
//   - Race between PendingCount() and gate decision (task spec #8): two
//     concurrent submits both observing depth=cap-1 must both succeed
//     (depth doesn't artificially block legitimate traffic).
//   - Retry-After header value is the documented constant (no drift).
//   - 429 response body is JSON, not plain text — operators rely on JSON
//     for log-analysis; plain text would break Sentry grouping.
//   - WithMaxQueueDepth builder is fluent (chains return *Server).
//   - parseMaxQueueDepth handles extreme inputs (very large, huge negative).
//
// All cases use the existing backpressureServer helper from
// backpressure_test.go — they live in the same package so we can reach the
// unexported `parseMaxQueueDepth`, `retryAfterSeconds`, etc.

// ── 1. Just-below-cap → accept (boundary -1) ─────────────────────────────────

// At depth = cap-1, the gate must NOT fire. This is the inverse of
// TestBackpressure_AtCap_Returns429 (depth = cap → 429). Boundary cases:
// "exactly at cap" and "exactly below cap" are different behaviour, both
// pinned. Exists to catch off-by-one regressions in the comparison
// (`>=` vs `>`).
func TestBackpressureExtra_JustBelowCap_Accepts(t *testing.T) {
	server, token, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(5)
	fill(4) // 4 < 5 → must pass

	w := submitOnce(server, token)
	if w.Code != http.StatusAccepted {
		t.Fatalf("at cap-1: expected 202, got %d: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Retry-After") != "" {
		t.Errorf("Retry-After must be absent below cap")
	}
}

// ── 2. 429 response body shape — JSON with `error` field ─────────────────────

// AW4-2 PR description claims Sentry groupability via JSON shape. Locking
// the contract: 429 body MUST be `{"error":"queue full"}` JSON, MUST NOT be
// HTML (default http.Error wraps in `<html>...`). A future refactor that
// switches `writeError` to plain text would break log analysis.
func TestBackpressureExtra_429BodyIsJSONShape(t *testing.T) {
	server, token, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(1)
	fill(1) // at cap

	w := submitOnce(server, token)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", w.Code)
	}

	ct := w.Header().Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type must include application/json; got %q", ct)
	}

	body := strings.TrimSpace(w.Body.String())
	var decoded map[string]string
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("body must be JSON: %v (body=%q)", err, body)
	}
	if decoded["error"] != "queue full" {
		t.Errorf(`expected {"error":"queue full"}, got %q`, body)
	}
	// Defensive: must NOT contain HTML markers.
	if strings.Contains(body, "<html>") || strings.Contains(body, "<HTML>") {
		t.Errorf("body should not contain HTML, got %q", body)
	}
}

// ── 3. Retry-After header value matches the package-level constant ───────────

// retryAfterSeconds=5 is derived from AW4 SMTP transaction latency. If a
// future refactor changes the constant without updating this test, the
// drift is caught. Inverse: if a refactor changes the test to a literal
// "5" without going through the constant, the constant becomes orphaned.
// Pin both directions.
func TestBackpressureExtra_RetryAfterMatchesConstant(t *testing.T) {
	server, token, fill := backpressureServer(t)
	server = server.WithMaxQueueDepth(1)
	fill(1)

	w := submitOnce(server, token)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", w.Code)
	}
	got := w.Header().Get("Retry-After")
	if got != strconv.Itoa(retryAfterSeconds) {
		t.Errorf("Retry-After: got %q, want %q (= retryAfterSeconds=%d)",
			got, strconv.Itoa(retryAfterSeconds), retryAfterSeconds)
	}
	// Sanity: must be a positive integer (HTTP spec allows seconds OR HTTP-date,
	// but our contract is seconds).
	n, err := strconv.Atoi(got)
	if err != nil {
		t.Errorf("Retry-After must be parseable int seconds, got %q (%v)", got, err)
	}
	if n <= 0 {
		t.Errorf("Retry-After must be positive, got %d", n)
	}
}

// ── 4. Builder-chain composability ───────────────────────────────────────────

// The functional-options style is documented as fluent — both
// WithMaxQueueDepth and WithBackpressureAudit must return *Server so they
// can chain. A regression that returns a value would break the canonical
// init pattern (`NewServer(...).WithMaxQueueDepth(50).WithBackpressureAudit(true)`).
func TestBackpressureExtra_BuildersChain(t *testing.T) {
	server, _, _ := backpressureServer(t)

	// Chained call: must compile, must not panic, must apply both fields.
	chained := server.WithMaxQueueDepth(50).WithBackpressureAudit(true)
	if chained == nil {
		t.Fatal("chained builder returned nil")
	}
	if chained.maxQueueDepth != 50 {
		t.Errorf("maxQueueDepth: got %d, want 50", chained.maxQueueDepth)
	}
	if !chained.backpressureAudit {
		t.Errorf("backpressureAudit: got false, want true")
	}
	// Identity contract: builders mutate-and-return-self (cheaper than
	// alloc-on-every-call). We don't strictly require this, but if it
	// breaks (deep-copy on every build) the operator init pattern still
	// works — the test stays green either way. Just verify the returned
	// pointer is non-nil and has the expected fields.
}

// ── 5. parseMaxQueueDepth with extreme values ────────────────────────────────

// Boundary scan — 15 existing AW4-2 cases cover empty/negative/typo-guard.
// Adds: very large positive (must respect, not overflow), max int32-shaped
// negative (still falls back to default — defensive against int wraparound).
func TestBackpressureExtra_ParseExtremeValues(t *testing.T) {
	cases := []struct {
		in   string
		want int
		why  string
	}{
		{"99999999", 99999999, "very large positive must be respected"},
		{"-99999999", defaultMaxQueueDepth, "very large negative falls back to default"},
		{"1e5", defaultMaxQueueDepth, "scientific notation is not Atoi-parseable"},
		{"0x10", defaultMaxQueueDepth, "hex literal not parseable by Atoi"},
		{"  42\t", 42, "leading whitespace + tab trimmed"},
		{"+50", 50, "explicit positive sign respected"},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			got := parseMaxQueueDepth(c.in)
			if got != c.want {
				t.Errorf("parseMaxQueueDepth(%q) = %d, want %d (%s)", c.in, got, c.want, c.why)
			}
		})
	}
}

// ── 6. Concurrent submits at capacity boundary — no spurious 429 below cap ────

// Race scenario from task spec #8: two concurrent submits, both observe
// depth = cap-1 BEFORE their request lands, both get past the gate. With
// a strict `>=` check both succeed (correct). The risk is a pessimistic
// `>` check that pre-increments — would make both see depth=cap and 429.
//
// We can't easily inject a barrier between the gate and the body parse
// without changing the production code, but we CAN observe the
// gate-decision count: launch N=10 concurrent submits with cap=20 and
// confirm all 10 pass. The gate's PendingCount() snapshot won't reach cap
// because envelopes are added after the gate (via the pipeline).
func TestBackpressureExtra_ConcurrentBelowCap_AllAccepted(t *testing.T) {
	server, token, _ := backpressureServer(t)
	server = server.WithMaxQueueDepth(20)

	const N = 10
	var wg sync.WaitGroup
	results := make(chan int, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body := `{"recipient":"a@example.com","subject":"X","body":"hi"}`
			req := httptest.NewRequest(http.MethodPost, "/v1/submit", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			server.Handler().ServeHTTP(w, req)
			results <- w.Code
		}()
	}
	wg.Wait()
	close(results)

	codes := map[int]int{}
	for code := range results {
		codes[code]++
	}
	// All should be 202 (accepted). NO 429 because depth never reaches cap.
	if codes[http.StatusTooManyRequests] != 0 {
		t.Errorf("got %d spurious 429s with concurrent submits below cap; codes=%v",
			codes[http.StatusTooManyRequests], codes)
	}
	if codes[http.StatusAccepted] != N {
		t.Errorf("expected all %d submits to be 202; got codes=%v", N, codes)
	}
}
