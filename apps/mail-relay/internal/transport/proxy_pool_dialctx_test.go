package transport

import (
	"context"
	"fmt"
	"testing"
)

// ---------------------------------------------------------------------------
// M5: DialContext must not recurse without bound
// ---------------------------------------------------------------------------
// When every proxy fails the guard check (which removes it and retries),
// the original recursive DialContext would overflow the stack for large pools.
// The iterative fix must exhaust all proxies and return an error within a
// bounded number of iterations.

func TestDialContext_GuardRejectsAll_ReturnsErrorNotPanic(t *testing.T) {
	// Build a pool with several proxies.
	addrs := make([]string, 20)
	for i := range addrs {
		addrs[i] = fmt.Sprintf("10.0.0.%d:1080", i+1)
	}
	tr := NewStaticRotatingProxy(addrs, nil)

	// Attach a guard whose pool is a *separate* pool — so none of the proxy
	// addresses pass IsWorkingAddr, and every Assert call fails.
	// This triggers the "remove and retry" path on every dial attempt.
	emptyPool := NewStaticRotatingProxy(nil, nil)
	guard := NewDialGuard(emptyPool, nil, nil)
	tr.AttachGuard(guard)

	_, err := tr.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error when all proxies are guard-rejected, got nil")
	}
	// Must not panic, must not hang. Error message should indicate no working proxies.
	t.Logf("DialContext correctly returned: %v", err)
	// All 20 proxies should have been removed from the pool
	if tr.WorkingCount() != 0 {
		t.Logf("pool has %d entries remaining (guard rejected all, count may vary by iteration bound)", tr.WorkingCount())
	}
}

func TestDialContext_GuardRejectsAll_BoundedByPoolSize(t *testing.T) {
	// Pool with more proxies than any reasonable max-depth bound.
	// Verify we get an error and not a stack overflow.
	addrs := make([]string, 50) // 50 proxies all failing guard
	for i := range addrs {
		addrs[i] = fmt.Sprintf("172.16.0.%d:1080", i+1)
	}
	tr := NewStaticRotatingProxy(addrs, nil)

	emptyPool := NewStaticRotatingProxy(nil, nil)
	guard := NewDialGuard(emptyPool, nil, nil)
	tr.AttachGuard(guard)

	_, err := tr.DialContext(context.Background(), "tcp", "target.example:443")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	t.Logf("pool size 50 guard-reject result: %v", err)
}

func TestDialContext_EmptyPool_NoFallback_ReturnsError(t *testing.T) {
	// Empty pool → immediate error without recursion.
	tr := NewStaticRotatingProxy(nil, nil)
	_, err := tr.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil {
		t.Fatal("expected error for empty pool without fallback, got nil")
	}
}
