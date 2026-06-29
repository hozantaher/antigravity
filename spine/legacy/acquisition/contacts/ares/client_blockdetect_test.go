package ares

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"contacts/internal/blockdetect"
)

// TestFetchSubject_BlockDetection_RateLimit verifies that an upstream 429
// is classified as rate_limit and bubbles up as a block error after retries.
func TestFetchSubject_BlockDetection_RateLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`Too Many Requests`))
	}))
	defer srv.Close()

	var observed int32
	var seenType blockdetect.BlockType
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, bt blockdetect.BlockType, _ int, _ []byte) {
			atomic.AddInt32(&observed, 1)
			seenType = bt
		}),
	)

	_, err := client.FetchSubject(context.Background(), "12345678")
	if err == nil {
		t.Fatal("expected error from sustained 429, got nil")
	}
	if atomic.LoadInt32(&observed) == 0 {
		t.Errorf("BlockObserver was never invoked")
	}
	if seenType != blockdetect.BlockTypeRateLimit {
		t.Errorf("observed type = %s, want rate_limit", seenType)
	}
}

// TestFetchSubject_BlockDetection_Cloudflare verifies a Cloudflare challenge
// served as HTTP 200 is detected and surfaces as a block error rather than
// an empty SubjectData.
func TestFetchSubject_BlockDetection_Cloudflare(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Ray", "8a7e2b1d4c5e6f7g-PRG")
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser before accessing site.</body></html>`))
	}))
	defer srv.Close()

	var observed int32
	var seenType blockdetect.BlockType
	var seenStatus int
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, bt blockdetect.BlockType, status int, _ []byte) {
			atomic.AddInt32(&observed, 1)
			seenType = bt
			seenStatus = status
		}),
	)

	data, err := client.FetchSubject(context.Background(), "27082440")
	if err == nil {
		t.Fatalf("expected block error, got data: %+v", data)
	}
	if atomic.LoadInt32(&observed) == 0 {
		t.Errorf("BlockObserver should have fired on Cloudflare challenge")
	}
	if seenType != blockdetect.BlockTypeCloudflare {
		t.Errorf("observed type = %s, want cloudflare", seenType)
	}
	if seenStatus != http.StatusOK {
		t.Errorf("observed status = %d, want 200", seenStatus)
	}
}

// TestFetchSubject_BlockDetection_Captcha verifies a 200 with a reCAPTCHA
// widget body is detected.
func TestFetchSubject_BlockDetection_Captcha(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`<html><body><div class="g-recaptcha" data-sitekey="abc"></div></body></html>`))
	}))
	defer srv.Close()

	var seenType blockdetect.BlockType
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, bt blockdetect.BlockType, _ int, _ []byte) {
			seenType = bt
		}),
	)

	_, err := client.FetchSubject(context.Background(), "27082440")
	if err == nil {
		t.Fatal("expected block error")
	}
	if seenType != blockdetect.BlockTypeCaptcha {
		t.Errorf("observed type = %s, want captcha", seenType)
	}
	if !IsBlock(err) {
		t.Errorf("IsBlock(err) = false, want true")
	}
	if BlockType(err) != blockdetect.BlockTypeCaptcha {
		t.Errorf("BlockType(err) = %s, want captcha", BlockType(err))
	}
}

// TestFetchSubject_BlockDetection_Forbidden verifies a plain 403 surfaces
// as forbidden (no Cloudflare signature).
func TestFetchSubject_BlockDetection_Forbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", "nginx")
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`<h1>403 Forbidden</h1>`))
	}))
	defer srv.Close()

	var seenType blockdetect.BlockType
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, bt blockdetect.BlockType, _ int, _ []byte) {
			seenType = bt
		}),
	)
	_, err := client.FetchSubject(context.Background(), "27082440")
	if err == nil {
		t.Fatal("expected block error on 403")
	}
	if seenType != blockdetect.BlockTypeForbidden {
		t.Errorf("observed type = %s, want forbidden", seenType)
	}
}

// TestFetchSubject_BlockDetection_NoFalsePositiveOn200JSON verifies that a
// regular 200 OK ARES JSON response does NOT trigger the observer.
func TestFetchSubject_BlockDetection_NoFalsePositiveOn200JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ico":"27082440","obchodniJmeno":"Alza.cz a.s."}`))
	}))
	defer srv.Close()

	var observed int32
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, _ blockdetect.BlockType, _ int, _ []byte) {
			atomic.AddInt32(&observed, 1)
		}),
	)

	data, err := client.FetchSubject(context.Background(), "27082440")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data == nil || data.ICO != "27082440" {
		t.Fatalf("unexpected data: %+v", data)
	}
	if got := atomic.LoadInt32(&observed); got != 0 {
		t.Errorf("BlockObserver fired %d times on a clean response, want 0", got)
	}
}

// TestFetchSubject_BlockDetection_NoFalsePositiveOn404 verifies that a 404
// (legitimate "subject not found") is NOT treated as a block — it must
// still return (nil, nil) per existing contract.
func TestFetchSubject_BlockDetection_NoFalsePositiveOn404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	var observed int32
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, _ blockdetect.BlockType, _ int, _ []byte) {
			atomic.AddInt32(&observed, 1)
		}),
	)
	data, err := client.FetchSubject(context.Background(), "99999999")
	if err != nil {
		t.Fatalf("404 should not error: %v", err)
	}
	if data != nil {
		t.Fatal("404 should return nil data")
	}
	if got := atomic.LoadInt32(&observed); got != 0 {
		t.Errorf("BlockObserver fired %d times on 404, want 0", got)
	}
}

// TestFetchSubject_BlockDetection_BodySignaturePassedThrough verifies that
// the observer receives a non-empty body slice for forensic logging.
func TestFetchSubject_BlockDetection_BodySignaturePassedThrough(t *testing.T) {
	wantBody := `<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Ray", "abc-PRG")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(wantBody))
	}))
	defer srv.Close()

	var seenLen int
	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, _ blockdetect.BlockType, _ int, body []byte) {
			seenLen = len(body)
		}),
	)
	_, _ = client.FetchSubject(context.Background(), "27082440")

	if seenLen == 0 {
		t.Errorf("observer received empty body slice, want non-empty signature")
	}
}

// TestFetchSubject_BlockDetection_ObserverIsOptional verifies that a nil
// observer (default config) does not panic on a blocked response.
func TestFetchSubject_BlockDetection_ObserverIsOptional(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Ray", "abc-PRG")
		w.Write([]byte(`<title>Just a moment...</title>`))
	}))
	defer srv.Close()

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0), WithRetryBackoff(0))
	_, err := client.FetchSubject(context.Background(), "27082440")
	if err == nil {
		t.Fatal("expected block error")
	}
	if !IsBlock(err) {
		t.Errorf("expected block error, got %T", err)
	}
}

// TestFetchSubject_BlockDetection_RetriesExhaustedReturnsBlockError verifies
// that after maxRetries on a sustained block, the final wrapped error still
// satisfies IsBlock.
func TestFetchSubject_BlockDetection_RetriesExhaustedReturnsBlockError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", "cloudflare")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
		WithRetryBackoff(0),
	)
	_, err := client.FetchSubject(context.Background(), "27082440")
	if err == nil {
		t.Fatal("expected error after retries on sustained Cloudflare 403")
	}
	if !IsBlock(err) {
		t.Errorf("final error chain did not surface a block error: %v", err)
	}
	if BlockType(err) != blockdetect.BlockTypeCloudflare {
		t.Errorf("BlockType(err) = %s, want cloudflare", BlockType(err))
	}
}

// TestFetchSubject_BlockDetection_HighThroughputObserverNoRace verifies that
// concurrent fetches against a blocked server do not race on the observer.
// Run with -race.
func TestFetchSubject_BlockDetection_HighThroughputObserverNoRace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`Too Many Requests`))
	}))
	defer srv.Close()

	var observed atomic.Int64
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := NewClient(
		WithBaseURL(srv.URL),
		WithRate(ctx, 100),
		WithRetryBackoff(0),
		WithBlockObserver(func(_ string, _ blockdetect.BlockType, _ int, _ []byte) {
			observed.Add(1)
		}),
	)

	done := make(chan struct{}, 5)
	for i := 0; i < 5; i++ {
		go func() {
			_, _ = client.FetchSubject(ctx, "12345678")
			done <- struct{}{}
		}()
	}
	for i := 0; i < 5; i++ {
		<-done
	}
	if observed.Load() == 0 {
		t.Errorf("observer never invoked under concurrent fetches")
	}
}
