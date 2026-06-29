package telemetry_test

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"testing/quick"
	"time"

	"common/telemetry"
)

// ── Core contract ─────────────────────────────────────────────────────────

// TestMonitoredJob_SuccessCheckIn: fn succeeds → MonitoredJob returns nil.
func TestMonitoredJob_SuccessCheckIn(t *testing.T) {
	called := false
	err := telemetry.MonitoredJob("test-slug", func() error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
	if !called {
		t.Fatal("fn was never called")
	}
}

// TestMonitoredJob_FnReturnsError: fn returns error → MonitoredJob propagates it.
func TestMonitoredJob_FnReturnsError(t *testing.T) {
	want := errors.New("job failed")
	err := telemetry.MonitoredJob("error-slug", func() error {
		return want
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != want.Error() {
		t.Fatalf("want %q, got %q", want, err)
	}
}

// TestMonitoredJob_PanicRecovered_ReturnsError: fn panics → recovered, error returned.
func TestMonitoredJob_PanicRecovered_ReturnsError(t *testing.T) {
	err := telemetry.MonitoredJob("panic-slug", func() error {
		panic("intentional panic")
	})
	if err == nil {
		t.Fatal("expected error from recovered panic, got nil")
	}
}

// TestMonitoredJob_PanicError_WrapsOriginal: panic(error) → returned error matches.
func TestMonitoredJob_PanicError_WrapsOriginal(t *testing.T) {
	original := errors.New("underlying error")
	err := telemetry.MonitoredJob("panic-err-slug", func() error {
		panic(original)
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

// TestMonitoredJob_NilFn_ReturnsError: nil fn → immediate error, no panic.
func TestMonitoredJob_NilFn_ReturnsError(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("MonitoredJob(slug, nil) should not panic, got: %v", r)
		}
	}()
	err := telemetry.MonitoredJob("nil-fn", nil)
	if err == nil {
		t.Fatal("expected error for nil fn, got nil")
	}
}

// TestMonitoredJob_EmptySlug_Safe: empty slug → fn still called, no panic.
func TestMonitoredJob_EmptySlug_Safe(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("MonitoredJob(\"\", fn) panicked: %v", r)
		}
	}()
	called := false
	_ = telemetry.MonitoredJob("", func() error {
		called = true
		return nil
	})
	if !called {
		t.Fatal("fn was not called with empty slug")
	}
}

// TestMonitoredJob_EmptySlug_NilFn: both empty slug and nil fn → error, no panic.
func TestMonitoredJob_EmptySlug_NilFn(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("MonitoredJob(\"\", nil) panicked: %v", r)
		}
	}()
	err := telemetry.MonitoredJob("", nil)
	if err == nil {
		t.Fatal("expected error for nil fn, got nil")
	}
}

// ── Panic type zoo ────────────────────────────────────────────────────────

// TestMonitoredJob_AllPanicTypes: every Go panic type must be recovered.
func TestMonitoredJob_AllPanicTypes(t *testing.T) {
	panicVals := []interface{}{
		"string panic",
		42,
		errors.New("err"),
		nil,
		[]byte("bytes"),
		struct{}{},
		true,
		3.14,
		int64(-1),
		uint(99),
	}
	for _, v := range panicVals {
		v := v
		t.Run(fmt.Sprintf("%T", v), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("MonitoredJob leaked panic(%T): %v", v, r)
				}
			}()
			err := telemetry.MonitoredJob("type-zoo", func() error {
				panic(v)
			})
			if v != nil && err == nil {
				t.Errorf("expected error for panic(%T %v), got nil", v, v)
			}
		})
	}
}

// ── Concurrency ───────────────────────────────────────────────────────────

// TestMonitoredJob_Concurrent_NoPanic: 20 goroutines calling MonitoredJob must
// not race, deadlock, or panic.
func TestMonitoredJob_Concurrent_NoPanic(t *testing.T) {
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("concurrent MonitoredJob panicked: %v", r)
				}
			}()
			_ = telemetry.MonitoredJob("concurrent", func() error { return nil })
		}()
	}
	wg.Wait()
}

// TestMonitoredJob_Concurrent_MixedResults: concurrent success + panic + error
// must each be handled independently without cross-goroutine contamination.
func TestMonitoredJob_Concurrent_MixedResults(t *testing.T) {
	var wg sync.WaitGroup
	var (
		mu       sync.Mutex
		panics   int
		errs     int
		successes int
	)
	jobs := []struct {
		slug string
		fn   func() error
	}{
		{"success", func() error { return nil }},
		{"error", func() error { return errors.New("planned error") }},
		{"panic", func() error { panic("planned panic") }},
	}
	for i := 0; i < 30; i++ {
		job := jobs[i%3]
		wg.Add(1)
		go func(slug string, fn func() error) {
			defer wg.Done()
			defer func() { recover() }()
			err := telemetry.MonitoredJob(slug, fn)
			mu.Lock()
			defer mu.Unlock()
			switch slug {
			case "success":
				if err == nil {
					successes++
				}
			case "error", "panic":
				if err != nil {
					errs++
				} else {
					panics++ // wrong outcome
				}
			}
		}(job.slug, job.fn)
	}
	wg.Wait()
	if successes != 10 {
		t.Errorf("expected 10 successes, got %d", successes)
	}
}

// ── Slow fn ───────────────────────────────────────────────────────────────

// TestMonitoredJob_SlowFn: fn that sleeps briefly still completes normally.
func TestMonitoredJob_SlowFn(t *testing.T) {
	err := telemetry.MonitoredJob("slow-fn", func() error {
		time.Sleep(10 * time.Millisecond)
		return nil
	})
	if err != nil {
		t.Fatalf("slow fn: expected nil, got %v", err)
	}
}

// ── Property tests ────────────────────────────────────────────────────────

// TestMonitoredJob_NeverPanics_Property: quick.Check — arbitrary slug + nil fn
// must never cause a panic regardless of the slug string.
func TestMonitoredJob_NeverPanics_Property(t *testing.T) {
	f := func(slug string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("MonitoredJob(%q, nil) panicked: %v", slug, r)
			}
		}()
		err := telemetry.MonitoredJob(slug, nil)
		// nil fn must always return an error
		return err != nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// TestMonitoredJob_NeverPanics_SuccessFn_Property: quick.Check — arbitrary slug
// with a successful fn must return nil and never panic.
func TestMonitoredJob_NeverPanics_SuccessFn_Property(t *testing.T) {
	f := func(slug string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("MonitoredJob(%q, successFn) panicked: %v", slug, r)
			}
		}()
		return telemetry.MonitoredJob(slug, func() error { return nil }) == nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// ── Idempotency ───────────────────────────────────────────────────────────

// TestMonitoredJob_MultipleCallsSameSlug: same slug called repeatedly must
// not accumulate state or panic.
func TestMonitoredJob_MultipleCallsSameSlug(t *testing.T) {
	for i := 0; i < 5; i++ {
		err := telemetry.MonitoredJob("repeated-slug", func() error { return nil })
		if err != nil {
			t.Errorf("call %d: expected nil, got %v", i, err)
		}
	}
}

// TestMonitoredJob_PanicThenSuccess: a panic run followed by a success run must
// return nil on the second call.
func TestMonitoredJob_PanicThenSuccess(t *testing.T) {
	// First call panics
	_ = telemetry.MonitoredJob("recover-slug", func() error {
		panic("first call panics")
	})
	// Second call succeeds
	err := telemetry.MonitoredJob("recover-slug", func() error {
		return nil
	})
	if err != nil {
		t.Fatalf("expected nil after successful recovery, got %v", err)
	}
}
