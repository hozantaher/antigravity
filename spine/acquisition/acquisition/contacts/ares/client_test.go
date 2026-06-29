package ares

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestFetchSubject_Success(t *testing.T) {
	resp := SubjectResponse{
		ICO:           "27082440",
		ObchodniJmeno: "Alza.cz a.s.",
		PravniForma:   "121",
		DatumVzniku:   "2003-08-26",
		CzNace:        []string{"47910", "46510", "26110"},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0))
	data, err := client.FetchSubject(context.Background(), "27082440")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data == nil {
		t.Fatal("expected data, got nil")
	}
	if data.ICO != "27082440" {
		t.Errorf("ICO = %s, want 27082440", data.ICO)
	}
	if data.NACEPrimary != "47910" {
		t.Errorf("NACEPrimary = %s, want 47910", data.NACEPrimary)
	}
	if len(data.NACECodes) != 3 {
		t.Errorf("NACECodes len = %d, want 3", len(data.NACECodes))
	}
	if data.DatumVzniku != "2003-08-26" {
		t.Errorf("DatumVzniku = %s, want 2003-08-26", data.DatumVzniku)
	}
	if data.PravniForma != "121" {
		t.Errorf("PravniForma = %s, want 121", data.PravniForma)
	}
}

func TestFetchSubject_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0))
	data, err := client.FetchSubject(context.Background(), "99999999")
	if err != nil {
		t.Fatalf("404 should not return error: %v", err)
	}
	if data != nil {
		t.Fatal("404 should return nil data")
	}
}

func TestFetchSubject_RetryOn500(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n <= 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		resp := SubjectResponse{ICO: "12345678", CzNace: []string{"28990"}}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(0),
	)
	data, err := client.FetchSubject(context.Background(), "12345678")
	if err != nil {
		t.Fatalf("should succeed after retries: %v", err)
	}
	if data == nil || data.ICO != "12345678" {
		t.Fatalf("unexpected data: %v", data)
	}
	if atomic.LoadInt32(&attempts) < 3 {
		t.Errorf("expected at least 3 attempts, got %d", atomic.LoadInt32(&attempts))
	}
}

func TestFetchSubject_ContextCancelled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Second)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	client := NewClient(WithBaseURL(srv.URL), WithRateLimit(0))
	_, err := client.FetchSubject(ctx, "12345678")
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
}

func TestParseSubject_EmptyNACE(t *testing.T) {
	resp := SubjectResponse{
		ICO:         "00000001",
		CzNace:      nil,
		DatumVzniku: "",
	}
	data := ParseSubject(resp)
	if data.NACEPrimary != "" {
		t.Errorf("NACEPrimary should be empty, got %s", data.NACEPrimary)
	}
	if len(data.NACECodes) != 0 {
		t.Errorf("NACECodes should be empty, got %v", data.NACECodes)
	}
}

func TestRateLimit(t *testing.T) {
	var reqTimes []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqTimes = append(reqTimes, time.Now())
		resp := SubjectResponse{ICO: "12345678"}
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient(
		WithBaseURL(srv.URL),
		WithRateLimit(50*time.Millisecond),
	)

	for i := 0; i < 3; i++ {
		client.FetchSubject(context.Background(), "12345678")
	}

	if len(reqTimes) < 3 {
		t.Fatalf("expected 3 requests, got %d", len(reqTimes))
	}
	for i := 1; i < len(reqTimes); i++ {
		gap := reqTimes[i].Sub(reqTimes[i-1])
		if gap < 40*time.Millisecond {
			t.Errorf("request %d gap too short: %v", i, gap)
		}
	}
}

// ── tokenBucket ───────────────────────────────────────────────────────────

func TestTokenBucket_AllowsUpToBurst(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tb := newTokenBucket(ctx, 100, 5) // 100 req/s, burst 5

	// Should be able to consume 5 tokens immediately (pre-filled burst).
	for i := 0; i < 5; i++ {
		if err := tb.Wait(ctx); err != nil {
			t.Fatalf("token %d: unexpected error: %v", i, err)
		}
	}
}

func TestTokenBucket_BlocksWhenEmpty(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	tb := newTokenBucket(ctx, 1, 1) // 1 req/s, burst 1

	// Consume the single pre-filled token.
	if err := tb.Wait(ctx); err != nil {
		t.Fatal("first wait failed:", err)
	}

	// Next wait must block and eventually return ctx.Err() when deadline hits.
	err := tb.Wait(ctx)
	if err == nil {
		t.Error("expected error from empty bucket with short timeout")
	}
}

func TestTokenBucket_RespectsContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tb := newTokenBucket(ctx, 1, 1)

	// Drain the single token.
	tb.Wait(ctx) //nolint:errcheck

	cancel() // cancel context

	err := tb.Wait(ctx)
	if err == nil {
		t.Error("expected error from cancelled context")
	}
}

func TestWithRate_ConcurrentFetches(t *testing.T) {
	// Verify that concurrent callers don't race or deadlock when using WithRate.
	var callCount atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ico":"12345678","obchodniJmeno":"Test s.r.o."}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := NewClient(WithBaseURL(srv.URL), WithRate(ctx, 50)) // 50 req/s

	// Fire 5 concurrent fetches — should all complete without race.
	done := make(chan error, 5)
	for i := 0; i < 5; i++ {
		go func() {
			_, err := client.FetchSubject(ctx, "12345678")
			done <- err
		}()
	}
	for i := 0; i < 5; i++ {
		if err := <-done; err != nil {
			t.Errorf("fetch %d error: %v", i, err)
		}
	}
}
