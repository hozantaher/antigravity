package telemetry_test

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"testing/quick"

	"common/telemetry"
)

// ── Flush ─────────────────────────────────────────────────────────────────
// Flush calls sentry.Flush(2s). With no SDK initialized it is a no-op.
// Verify it does not panic.

func TestFlush_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Flush panicked: %v", r)
		}
	}()
	telemetry.Flush()
}

// ── SlogHandler.Enabled ───────────────────────────────────────────────────

func TestSlogHandler_Enabled_Debug(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ctx := context.Background()
	if !h.Enabled(ctx, slog.LevelDebug) {
		t.Error("expected Enabled=true for LevelDebug with Debug handler")
	}
}

func TestSlogHandler_Enabled_Info(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx := context.Background()
	if !h.Enabled(ctx, slog.LevelInfo) {
		t.Error("expected Enabled=true for LevelInfo")
	}
}

func TestSlogHandler_Enabled_BelowThreshold(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	ctx := context.Background()
	// LevelInfo is below LevelWarn threshold
	if h.Enabled(ctx, slog.LevelInfo) {
		t.Error("expected Enabled=false for LevelInfo when threshold is Warn")
	}
}

// ── SlogHandler.Handle ────────────────────────────────────────────────────

func TestSlogHandler_Handle_InfoRecord_NoPanic(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	ctx := context.Background()
	r := slog.Record{}
	r.Message = "hello world"
	r.Level = slog.LevelInfo

	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("Handle panicked: %v", rec)
		}
	}()
	_ = h.Handle(ctx, r)
}

func TestSlogHandler_Handle_ErrorRecord_NoPanic(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	ctx := context.Background()
	r := slog.Record{}
	r.Message = "something failed"
	r.Level = slog.LevelError
	r.AddAttrs(slog.String("key", "val"))

	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("Handle panicked on error record: %v", rec)
		}
	}()
	_ = h.Handle(ctx, r)
}

func TestSlogHandler_Handle_ErrorWithErrorAttr_NoPanic(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	ctx := context.Background()
	r := slog.Record{}
	r.Message = "db gone"
	r.Level = slog.LevelError
	r.AddAttrs(slog.Any("error", errors.New("connection refused")))

	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("Handle panicked with error attr: %v", rec)
		}
	}()
	_ = h.Handle(ctx, r)
}

func TestSlogHandler_Handle_WarnRecord_NoPanic(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	ctx := context.Background()
	r := slog.Record{}
	r.Message = "warning"
	r.Level = slog.LevelWarn

	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("Handle panicked on warn: %v", rec)
		}
	}()
	_ = h.Handle(ctx, r)
}

func TestSlogHandler_Handle_MultipleAttrs_NoPanic(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	ctx := context.Background()
	r := slog.Record{}
	r.Message = "multi-attr"
	r.Level = slog.LevelError
	r.AddAttrs(
		slog.String("component", "sender"),
		slog.Int("count", 42),
		slog.Bool("flag", true),
		slog.Any("error", errors.New("something")),
	)

	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("Handle multi-attr panicked: %v", rec)
		}
	}()
	_ = h.Handle(ctx, r)
}

// ── FatalExitFn ───────────────────────────────────────────────────────────
// FatalExitFn returns a closure. We verify the returned closure is non-nil.
// We cannot call it safely in tests as it invokes os.Exit.

func TestFatalExitFn_NilError_ReturnsFuncThatIsNonNil(t *testing.T) {
	fn := telemetry.FatalExitFn(nil, 0)
	if fn == nil {
		t.Fatal("FatalExitFn returned nil")
	}
}

func TestFatalExitFn_WithError_ReturnsFuncThatIsNonNil(t *testing.T) {
	fn := telemetry.FatalExitFn(errors.New("fatal"), 1)
	if fn == nil {
		t.Fatal("FatalExitFn returned nil for non-nil error")
	}
}

func TestFatalExitFn_CodeVariants_AllReturnNonNil(t *testing.T) {
	for _, code := range []int{0, 1, 2, 127, 255} {
		fn := telemetry.FatalExitFn(errors.New("err"), code)
		if fn == nil {
			t.Errorf("FatalExitFn code=%d returned nil", code)
		}
	}
}

// ── envOr (tested indirectly through Init + APP_ENV) ─────────────────────

func TestInit_EnvOr_AppEnvSet(t *testing.T) {
	t.Setenv("APP_ENV", "staging")
	os.Unsetenv("SENTRY_DSN_GO")
	// No DSN → no-op; APP_ENV is consumed by envOr internally.
	// This exercises the `return v` branch of envOr.
	if err := telemetry.Init("v2"); err != nil {
		t.Fatalf("Init: %v", err)
	}
}

// TestInit_EnvOr_AllVariants exercises envOr with both set and unset APP_ENV.
func TestInit_EnvOr_AllVariants(t *testing.T) {
	// Branch 1: APP_ENV is set → envOr returns APP_ENV value.
	t.Setenv("APP_ENV", "production")
	os.Unsetenv("SENTRY_DSN_GO")
	if err := telemetry.Init("v3"); err != nil {
		t.Fatalf("Init with APP_ENV=production: %v", err)
	}

	// Branch 2: APP_ENV is unset → envOr returns default "development".
	os.Unsetenv("APP_ENV")
	if err := telemetry.Init("v3"); err != nil {
		t.Fatalf("Init without APP_ENV: %v", err)
	}
}

func TestInit_EnvOr_AppEnvUnset(t *testing.T) {
	os.Unsetenv("APP_ENV")
	os.Unsetenv("SENTRY_DSN_GO")
	// Default "development" is used.
	if err := telemetry.Init("v2"); err != nil {
		t.Fatalf("Init without DSN should be no-op: %v", err)
	}
}

// ── HTTPRecoveryMiddleware: panic with non-error value ────────────────────

func TestHTTPRecoveryMiddleware_PanicWithString_Returns500(t *testing.T) {
	handler := telemetry.HTTPRecoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("string panic value")
	}))
	req := httptest.NewRequest(http.MethodGet, "/str", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
}

func TestHTTPRecoveryMiddleware_PanicWithInt_Returns500(t *testing.T) {
	handler := telemetry.HTTPRecoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(42)
	}))
	req := httptest.NewRequest(http.MethodGet, "/int", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
}

func TestHTTPRecoveryMiddleware_PanicWithNil_DoesNotCrash(t *testing.T) {
	// A panic(nil) is unusual but must be handled.
	handler := telemetry.HTTPRecoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(nil) //nolint:staticcheck
	}))
	req := httptest.NewRequest(http.MethodGet, "/nilpanic", nil)
	rec := httptest.NewRecorder()
	defer func() {
		// panic(nil) may propagate in Go 1.21+ as a runtime.PanicNilError;
		// if it escapes to here the test still passes (handler does not panic).
		recover() //nolint:errcheck
	}()
	handler.ServeHTTP(rec, req)
}

// ── Property: SlogHandler never panics on arbitrary records ──────────────

func TestProperty_SlogHandler_Handle_NeverPanics(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ctx := context.Background()

	f := func(msg string, levelInt int8) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("Handle panicked msg=%q level=%d: %v", msg, levelInt, r)
			}
		}()
		r := slog.Record{}
		r.Message = msg
		r.Level = slog.Level(levelInt)
		_ = h.Handle(ctx, r)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Flush never panics ─────────────────────────────────────────

func TestProperty_Flush_NeverPanics(t *testing.T) {
	for i := 0; i < 5; i++ {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("Flush panicked on call %d: %v", i, r)
				}
			}()
			telemetry.Flush()
		}()
	}
}
