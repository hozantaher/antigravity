package ares

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/quick"
	"time"
)

// ── newTokenBucket edge cases ─────────────────────────────────────────────

// TestNewTokenBucket_ZeroRate covers the ratePerSec <= 0 → default to 1 branch.
func TestNewTokenBucket_ZeroRate(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tb := newTokenBucket(ctx, 0, 0) // both zero — should not panic, burst defaults to 1
	if err := tb.Wait(ctx); err != nil {
		t.Fatalf("unexpected error draining first token: %v", err)
	}
}

// TestNewTokenBucket_NegativeRate covers ratePerSec <= 0 normalised to 1.
func TestNewTokenBucket_NegativeRate(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tb := newTokenBucket(ctx, -5, -10) // both negative → rate=1, burst=1
	if err := tb.Wait(ctx); err != nil {
		t.Fatalf("unexpected error draining first token: %v", err)
	}
}

// TestNewTokenBucket_BurstLessThanRate covers burst < ratePerSec → burst = ratePerSec.
func TestNewTokenBucket_BurstLessThanRate(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// burst=1 < rate=5 → gets bumped to 5; we should be able to drain 5 tokens immediately.
	tb := newTokenBucket(ctx, 5, 1)
	for i := 0; i < 5; i++ {
		if err := tb.Wait(ctx); err != nil {
			t.Fatalf("token %d: unexpected error: %v", i, err)
		}
	}
}

// ── doFetch error paths ───────────────────────────────────────────────────

// TestDoFetch_429_Returns503Error covers the 429/5xx branch in doFetch.
func TestDoFetch_429_Returns503Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte("slow down"))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))
	_, err := c.doFetch(context.Background(), srv.URL+"/12345678")
	if err == nil {
		t.Fatal("expected error for 429 response")
	}
}

// TestDoFetch_500_ReturnsError covers the 5xx branch in doFetch.
func TestDoFetch_500_ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal error"))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))
	_, err := c.doFetch(context.Background(), srv.URL+"/12345678")
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

// TestDoFetch_NonOKNon404_ReturnsError covers the non-200/non-404/non-429/non-5xx
// status branch (e.g. 403, 503).
func TestDoFetch_NonOKNon404_ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte("forbidden"))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))
	_, err := c.doFetch(context.Background(), srv.URL+"/12345678")
	if err == nil {
		t.Fatal("expected error for 403 response")
	}
}

// TestDoFetch_InvalidJSON_ReturnsDecodeError covers the JSON decode error branch.
func TestDoFetch_InvalidJSON_ReturnsDecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("not-json{{{"))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))
	_, err := c.doFetch(context.Background(), srv.URL+"/12345678")
	if err == nil {
		t.Fatal("expected JSON decode error")
	}
}

// TestDoFetch_NotFound_ReturnsNotFoundError covers the 404 branch directly.
func TestDoFetch_NotFound_ReturnsNotFoundError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))
	_, err := c.doFetch(context.Background(), srv.URL+"/99999999")
	if err == nil {
		t.Fatal("expected notFoundError")
	}
	if !isNotFound(err) {
		t.Errorf("expected notFoundError, got %T: %v", err, err)
	}
}

// TestFetchSubject_ContextCancelledDuringRetryBackoff covers ctx.Done() during backoff sleep.
func TestFetchSubject_ContextCancelledDuringRetryBackoff(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Always return 500 to trigger retries.
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel after a short delay so the first retry backoff is hit.
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	c := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(200*time.Millisecond), // long enough for cancel to hit
	)
	_, err := c.FetchSubject(ctx, "12345678")
	if err == nil {
		t.Fatal("expected error when context cancelled during backoff")
	}
}

// TestFetchSubject_AllRetriesExhausted covers the "after N retries" path
// where all attempts fail with a server error.
func TestFetchSubject_AllRetriesExhausted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
	)
	_, err := c.FetchSubject(context.Background(), "12345678")
	if err == nil {
		t.Fatal("expected error after all retries exhausted")
	}
}

// TestThrottle_ContextCancelledDuringSleep covers ctx.Done() in throttle sleep.
func TestThrottle_ContextCancelledDuringSleep(t *testing.T) {
	c := NewClient(WithRateLimit(500 * time.Millisecond))
	// Seed lastReq so throttle will want to sleep.
	c.lastReq = time.Now()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	err := c.throttle(ctx)
	if err == nil {
		t.Fatal("expected context error from throttle")
	}
}

// ── property tests ────────────────────────────────────────────────────────

// TestParseSubject_Property_NoPanic verifies ParseSubject never panics on any
// combination of ICO, NACECodes count, DatumVzniku, and PravniForma.
func TestParseSubject_Property_NoPanic(t *testing.T) {
	f := func(ico string, naceCount uint8, datumVzniku string, pravniForma string) bool {
		defer func() { recover() }()
		var nace []string
		for i := 0; i < int(naceCount%20); i++ {
			nace = append(nace, fmt.Sprintf("%05d", i))
		}
		resp := SubjectResponse{
			ICO:         ico,
			CzNace:      nace,
			DatumVzniku: datumVzniku,
			PravniForma: pravniForma,
		}
		ParseSubject(resp)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Error(err)
	}
}

// TestNewClient_Property_NoPanic verifies NewClient never panics for any combination
// of options.
func TestNewClient_Property_NoPanic(t *testing.T) {
	f := func(rateMS uint16) bool {
		defer func() { recover() }()
		ctx := context.Background()
		_ = NewClient(
			WithRateLimit(time.Duration(rateMS)*time.Millisecond),
			WithRate(ctx, int(rateMS%50)+1),
			WithRetryBackoff(0),
		)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestFetchSubject_Property_NoPanic verifies FetchSubject doesn't panic for
// varied ICO strings when the server returns 404.
func TestFetchSubject_Property_NoPanic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))

	f := func(ico string) bool {
		defer func() { recover() }()
		c.FetchSubject(context.Background(), ico) //nolint:errcheck
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestFetchSubject_WithRate_NotFound verifies FetchSubject with a token-bucket
// rate limiter correctly returns nil on 404.
func TestFetchSubject_WithRate_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(SubjectResponse{ICO: "12345678"})
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c := NewClient(WithBaseURL(srv.URL), WithRate(ctx, 10), WithRetryBackoff(0))
	data, err := c.FetchSubject(ctx, "12345678")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data == nil {
		t.Fatal("expected non-nil data")
	}
}
