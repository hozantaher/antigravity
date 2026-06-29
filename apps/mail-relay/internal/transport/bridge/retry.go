package bridge

import (
	"context"
	"log/slog"
	"math/rand"
	"time"
)

const (
	maxRetries    = 5
	baseDelay     = time.Second
	maxDelay      = 16 * time.Second
	jitterPercent = 0.25
)

// FailureKind distinguishes permanent from transient failures.
type FailureKind int

const (
	FailureTransient FailureKind = iota // 5xx, timeout, connection refused
	FailurePermanent                    // 4xx (except 429)
)

func classifyHTTPStatus(status int) FailureKind {
	if status == 0 {
		return FailureTransient // connection error
	}
	if status == 429 {
		return FailureTransient // rate limited
	}
	if status >= 400 && status < 500 {
		return FailurePermanent
	}
	return FailureTransient
}

// RetryResult holds the outcome of a retried operation.
type RetryResult struct {
	Success    bool
	Attempts   int
	LastStatus int
	Kind       FailureKind
}

// retryWait is the sleep function used between retries.
// Tests may replace it with a no-op to avoid real delays.
var retryWait = func(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// WithRetry executes fn up to maxRetries times for transient failures.
// fn returns (httpStatus int, err error). httpStatus=0 means connection error.
func WithRetry(ctx context.Context, fn func() (int, error)) RetryResult {
	var lastStatus int
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			delay := baseDelay * (1 << (attempt - 1))
			if delay > maxDelay {
				delay = maxDelay
			}
			jitter := time.Duration(float64(delay) * jitterPercent * rand.Float64())
			if !retryWait(ctx, delay+jitter) {
				return RetryResult{Attempts: attempt, LastStatus: lastStatus, Kind: FailureTransient}
			}
		}
		status, err := fn()
		lastStatus = status
		if err == nil && status >= 200 && status < 300 {
			return RetryResult{Success: true, Attempts: attempt + 1, LastStatus: status}
		}
		kind := classifyHTTPStatus(status)
		if kind == FailurePermanent {
			return RetryResult{Attempts: attempt + 1, LastStatus: status, Kind: FailurePermanent}
		}
		// Log transient failure at debug for diagnostics — not an error, just retrying.
		slog.Debug("bridge: transient retry", "attempt", attempt+1, "status", status, "error", err)
	}
	return RetryResult{Attempts: maxRetries + 1, LastStatus: lastStatus, Kind: FailureTransient}
}
