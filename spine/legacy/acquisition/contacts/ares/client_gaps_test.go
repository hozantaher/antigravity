package ares

import (
	"context"
	"testing"
	"time"
)

// TestTokenBucket_Wait_StopChannel covers the tb.stop branch in Wait —
// fired when the bucket's lifecycle context is cancelled while Wait blocks
// with a separate, still-live context.
func TestTokenBucket_Wait_StopChannel(t *testing.T) {
	bucketCtx, bucketCancel := context.WithCancel(context.Background())

	tb := newTokenBucket(bucketCtx, 1, 1)

	// Drain the single pre-filled token so tb.tokens is empty.
	if err := tb.Wait(context.Background()); err != nil {
		t.Fatalf("drain token: %v", err)
	}

	// Cancel the bucket's lifecycle context → goroutine will close(tb.stop).
	bucketCancel()

	// Give the goroutine time to close tb.stop.
	time.Sleep(30 * time.Millisecond)

	// Wait with a fresh context that is NOT cancelled.
	// Only tb.stop is ready → must return context.Canceled.
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer waitCancel()

	err := tb.Wait(waitCtx)
	if err != context.Canceled {
		t.Errorf("expected context.Canceled from stopped bucket, got %v", err)
	}
}

// TestFetchSubject_BucketWaitCancelled covers line 141-143 (bucket.Wait error).
func TestFetchSubject_BucketWaitCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	// Create client with token bucket using ctx
	c := NewClient(
		WithRate(ctx, 1),
		WithBaseURL("http://localhost:1"), // unreachable, but bucket.Wait fires first
	)

	// Drain the token
	if err := c.bucket.Wait(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}

	// Cancel the bucket's context so Wait returns immediately
	cancel()
	time.Sleep(10 * time.Millisecond)

	// FetchSubject should get bucket.Wait error
	_, err := c.FetchSubject(context.Background(), "12345678")
	if err == nil {
		t.Error("expected error from FetchSubject when bucket is stopped")
	}
}

// TestFetchSubject_ThrottleError covers line 145-147 (throttle context cancelled).
func TestFetchSubject_ThrottleError(t *testing.T) {
	c := NewClient(
		WithRateLimit(time.Hour), // very long rate limit
		WithBaseURL("http://localhost:1"),
	)
	// Mark last request as now so throttle will wait
	c.lastReq = time.Now()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	_, err := c.FetchSubject(ctx, "12345678")
	if err == nil {
		t.Error("expected error from FetchSubject when context is cancelled during throttle")
	}
}
