package bridge

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func init() {
	// Replace the real sleep with an instant, context-aware stub so retry tests run fast.
	retryWait = func(ctx context.Context, _ time.Duration) bool {
		select {
		case <-ctx.Done():
			return false
		default:
			return true
		}
	}
}

func TestWithRetry_SuccessOnFirstAttempt(t *testing.T) {
	calls := 0
	fn := func() (int, error) {
		calls++
		return 200, nil
	}

	result := WithRetry(context.Background(), fn)

	if !result.Success {
		t.Errorf("expected Success=true, got false")
	}
	if result.Attempts != 1 {
		t.Errorf("expected Attempts=1, got %d", result.Attempts)
	}
	if calls != 1 {
		t.Errorf("expected fn called 1 time, got %d", calls)
	}
}

func TestWithRetry_SuccessAfterTransientFailures(t *testing.T) {
	calls := 0
	fn := func() (int, error) {
		calls++
		if calls < 3 {
			return 500, nil
		}
		return 200, nil
	}

	result := WithRetry(context.Background(), fn)

	if !result.Success {
		t.Errorf("expected Success=true, got false")
	}
	if result.Attempts != 3 {
		t.Errorf("expected Attempts=3, got %d", result.Attempts)
	}
	if calls != 3 {
		t.Errorf("expected fn called 3 times, got %d", calls)
	}
}

func TestWithRetry_PermanentFailure404(t *testing.T) {
	calls := 0
	fn := func() (int, error) {
		calls++
		return 404, nil
	}

	result := WithRetry(context.Background(), fn)

	if result.Success {
		t.Errorf("expected Success=false, got true")
	}
	if result.Kind != FailurePermanent {
		t.Errorf("expected Kind=FailurePermanent, got %v", result.Kind)
	}
	if result.Attempts != 1 {
		t.Errorf("expected Attempts=1 (no retry on permanent), got %d", result.Attempts)
	}
	if calls != 1 {
		t.Errorf("expected fn called 1 time, got %d", calls)
	}
}

func TestWithRetry_MaxRetriesOnTransient500(t *testing.T) {
	calls := 0
	fn := func() (int, error) {
		calls++
		return 500, nil
	}

	result := WithRetry(context.Background(), fn)

	if result.Success {
		t.Errorf("expected Success=false, got true")
	}
	if result.Kind != FailureTransient {
		t.Errorf("expected Kind=FailureTransient, got %v", result.Kind)
	}
	expectedAttempts := maxRetries + 1
	if result.Attempts != expectedAttempts {
		t.Errorf("expected Attempts=%d, got %d", expectedAttempts, result.Attempts)
	}
	if calls != expectedAttempts {
		t.Errorf("expected fn called %d times, got %d", expectedAttempts, calls)
	}
}

func TestWithRetry_ConnectionError(t *testing.T) {
	calls := 0
	fn := func() (int, error) {
		calls++
		// status=0 means connection error
		return 0, nil
	}

	result := WithRetry(context.Background(), fn)

	if result.Success {
		t.Errorf("expected Success=false, got true")
	}
	if result.Kind != FailureTransient {
		t.Errorf("expected Kind=FailureTransient for connection error, got %v", result.Kind)
	}
	expectedAttempts := maxRetries + 1
	if result.Attempts != expectedAttempts {
		t.Errorf("expected Attempts=%d, got %d", expectedAttempts, result.Attempts)
	}
}

func TestWithRetry_429IsTransient(t *testing.T) {
	calls := 0
	fn := func() (int, error) {
		calls++
		if calls < 3 {
			return 429, nil
		}
		return 201, nil
	}

	result := WithRetry(context.Background(), fn)

	if !result.Success {
		t.Errorf("expected Success=true after 429 retries, got false")
	}
	if result.Attempts != 3 {
		t.Errorf("expected Attempts=3, got %d", result.Attempts)
	}
}

func TestWithRetry_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	calls := 0
	fn := func() (int, error) {
		calls++
		if calls == 1 {
			// Cancel context after first transient failure so next sleep is interrupted.
			cancel()
		}
		return 500, nil
	}

	result := WithRetry(ctx, fn)

	if result.Success {
		t.Errorf("expected Success=false after context cancel, got true")
	}
	// Must not have retried all maxRetries times.
	if result.Attempts >= maxRetries+1 {
		t.Errorf("expected fewer than %d attempts after cancel, got %d", maxRetries+1, result.Attempts)
	}
}

func TestClassifyHTTPStatus(t *testing.T) {
	cases := []struct {
		status int
		want   FailureKind
	}{
		{0, FailureTransient},
		{200, FailureTransient},
		{400, FailurePermanent},
		{404, FailurePermanent},
		{422, FailurePermanent},
		{429, FailureTransient},
		{499, FailurePermanent},
		{500, FailureTransient},
		{503, FailureTransient},
	}
	for _, tc := range cases {
		got := classifyHTTPStatus(tc.status)
		if got != tc.want {
			t.Errorf("classifyHTTPStatus(%d) = %v, want %v", tc.status, got, tc.want)
		}
	}
}

// --- M4: transient error at _ = err should be logged at debug ---

func TestWithRetry_TransientErrorIsLogged(t *testing.T) {
	// Install a custom slog handler to capture debug records.
	records := make([]string, 0)
	handler := &captureSlogHandler{records: &records}
	oldLogger := slog.Default()
	slog.SetDefault(slog.New(handler))
	t.Cleanup(func() { slog.SetDefault(oldLogger) })

	calls := 0
	fn := func() (int, error) {
		calls++
		if calls < 2 {
			return 500, fmt.Errorf("transient failure")
		}
		return 200, nil
	}

	result := WithRetry(context.Background(), fn)
	if !result.Success {
		t.Fatalf("expected success, got failure")
	}

	// Verify that the transient error was captured at debug level
	if len(records) == 0 {
		t.Fatal("expected at least one debug log for transient error, got none")
	}
	found := false
	for _, r := range records {
		if strings.Contains(r, "transient") || strings.Contains(r, "retry") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected log message containing 'transient' or 'retry', got: %v", records)
	}
}

// captureSlogHandler captures slog records for test assertions.
type captureSlogHandler struct {
	records *[]string
}

func (h *captureSlogHandler) Enabled(_ context.Context, _ slog.Level) bool { return true }

func (h *captureSlogHandler) Handle(_ context.Context, r slog.Record) error {
	msg := r.Message
	r.Attrs(func(a slog.Attr) bool {
		msg += " " + a.Key + "=" + fmt.Sprint(a.Value.Any())
		return true
	})
	*h.records = append(*h.records, msg)
	return nil
}

func (h *captureSlogHandler) WithAttrs(attrs []slog.Attr) slog.Handler { return h }
func (h *captureSlogHandler) WithGroup(name string) slog.Handler       { return h }
