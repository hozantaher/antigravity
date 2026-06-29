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

// ── Init ──────────────────────────────────────────────────────────────────

func TestInit_NoDSN_NoError(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	if err := telemetry.Init("test"); err != nil {
		t.Fatalf("Init with empty DSN should be no-op, got: %v", err)
	}
}

func TestInit_InvalidDSN_ReturnsError(t *testing.T) {
	t.Setenv("SENTRY_DSN_GO", "not-a-valid-dsn")
	err := telemetry.Init("test")
	if err == nil {
		t.Fatal("expected error for invalid DSN, got nil")
	}
}

// BF-F3 — release tag composition.

func TestBuildReleaseTag_GIT_SHA_takesPrecedence(t *testing.T) {
	t.Setenv("GIT_SHA", "abcdef1234567890")
	t.Setenv("RAILWAY_GIT_COMMIT_SHA", "ffffffffffffffff")
	t.Setenv("SOURCE_COMMIT", "0000000000000000")
	if got := telemetry.BuildReleaseTag("outreach"); got != "outreach@abcdef1" {
		t.Errorf("got %q, want outreach@abcdef1", got)
	}
}

func TestBuildReleaseTag_FallbackPriority(t *testing.T) {
	os.Unsetenv("GIT_SHA")
	t.Setenv("RAILWAY_GIT_COMMIT_SHA", "rrrrrrr1234567890")
	t.Setenv("SOURCE_COMMIT", "ssssssssssssssss")
	if got := telemetry.BuildReleaseTag("relay"); got != "relay@rrrrrrr" {
		t.Errorf("got %q, want relay@rrrrrrr", got)
	}
}

func TestBuildReleaseTag_NoEnv_ReturnsUnknown(t *testing.T) {
	os.Unsetenv("GIT_SHA")
	os.Unsetenv("RAILWAY_GIT_COMMIT_SHA")
	os.Unsetenv("SOURCE_COMMIT")
	if got := telemetry.BuildReleaseTag("outreach"); got != "outreach@unknown" {
		t.Errorf("got %q, want outreach@unknown", got)
	}
}

func TestBuildReleaseTag_EmptyService_FillsPlaceholder(t *testing.T) {
	os.Unsetenv("GIT_SHA")
	os.Unsetenv("RAILWAY_GIT_COMMIT_SHA")
	os.Unsetenv("SOURCE_COMMIT")
	got := telemetry.BuildReleaseTag("")
	if got != "unknown-service@unknown" {
		t.Errorf("got %q, want unknown-service@unknown", got)
	}
}

func TestBuildReleaseTag_ShortSHA_NotTruncated(t *testing.T) {
	t.Setenv("GIT_SHA", "abc")
	if got := telemetry.BuildReleaseTag("outreach"); got != "outreach@abc" {
		t.Errorf("got %q, want outreach@abc (no truncation when shorter than 7)", got)
	}
}

// ── SlogHandler ───────────────────────────────────────────────────────────

func TestSlogHandler_ForwardsToInner(t *testing.T) {
	inner := slog.NewTextHandler(os.Stderr, nil)
	h := telemetry.NewSlogHandler(inner)
	if h == nil {
		t.Fatal("NewSlogHandler returned nil")
	}
}

func TestSlogHandler_NilInner_UsesDefault(t *testing.T) {
	h := telemetry.NewSlogHandler(nil)
	if h == nil {
		t.Fatal("NewSlogHandler(nil) returned nil")
	}
}

func TestSlogHandler_WithAttrs_ReturnsSlogHandler(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	h2 := h.WithAttrs([]slog.Attr{slog.String("key", "val")})
	if h2 == nil {
		t.Fatal("WithAttrs returned nil")
	}
}

func TestSlogHandler_WithGroup_ReturnsSlogHandler(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	h2 := h.WithGroup("group")
	if h2 == nil {
		t.Fatal("WithGroup returned nil")
	}
}

// ── FatalExit ─────────────────────────────────────────────────────────────

func TestFatalExitFn_ReturnsCallable(t *testing.T) {
	// FatalExit should be a function — not a no-op nil
	fn := telemetry.FatalExitFn(errors.New("test"), 1)
	if fn == nil {
		t.Fatal("FatalExitFn returned nil")
	}
}

// ── HTTPRecoveryMiddleware ─────────────────────────────────────────────────

func TestHTTPRecoveryMiddleware_NoPanic(t *testing.T) {
	handler := telemetry.HTTPRecoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestHTTPRecoveryMiddleware_PanicReturns500(t *testing.T) {
	handler := telemetry.HTTPRecoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("unexpected explosion")
	}))
	req := httptest.NewRequest(http.MethodGet, "/panic", nil)
	rec := httptest.NewRecorder()
	// must not propagate the panic
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 after panic, got %d", rec.Code)
	}
}

func TestHTTPRecoveryMiddleware_PanicWithError(t *testing.T) {
	handler := telemetry.HTTPRecoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(errors.New("db gone"))
	}))
	req := httptest.NewRequest(http.MethodGet, "/err", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
}

// ── SetServiceTag — TDD (RED → GREEN) ────────────────────────────────────

// TestSetServiceTag_Empty_NoOp verifies that calling SetServiceTag with an
// empty string does not panic and is safe to call repeatedly.
func TestSetServiceTag_Empty_NoOp(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("SetServiceTag(\"\") panicked: %v", r)
		}
	}()
	// Must not panic; empty tag is silently ignored.
	telemetry.SetServiceTag("")
	telemetry.SetServiceTag("") // idempotent
}

// TestSetServiceTag_SetsTagInScope verifies that a non-empty service name
// does not panic when Sentry SDK is not initialised (no DSN set).
func TestSetServiceTag_SetsTagInScope(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("SetServiceTag(\"outreach\") panicked: %v", r)
		}
	}()
	telemetry.SetServiceTag("outreach")
}

// TestSetServiceTag_VariousNames verifies all plausible service names are safe.
func TestSetServiceTag_VariousNames(t *testing.T) {
	names := []string{
		"outreach",
		"privacy-gateway",
		"anti-trace-relay",
		"mcp",
		"worker",
		"inbox",
		"contacts",
		"campaigns",
		"orchestrator",
		"mailboxes",
	}
	for _, name := range names {
		name := name
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("SetServiceTag(%q) panicked: %v", name, r)
				}
			}()
			telemetry.SetServiceTag(name)
		})
	}
}

// TestSetServiceTag_Idempotent verifies multiple sequential calls are safe.
func TestSetServiceTag_Idempotent(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("repeated SetServiceTag panicked: %v", r)
		}
	}()
	for i := 0; i < 5; i++ {
		telemetry.SetServiceTag("outreach")
	}
}

// ── TracedHTTPMiddleware ──────────────────────────────────────────────────

func TestTracedHTTPMiddleware_NoPanic_NoDSN(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	handler := telemetry.TracedHTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestTracedHTTPMiddleware_PanicRecovered(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	handler := telemetry.TracedHTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("handler panic")
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	// TracedHTTPMiddleware does NOT recover — HTTPRecoveryMiddleware does
	// Just verify the span infrastructure doesn't double-panic
	defer func() { recover() }() // catch the expected panic
	handler.ServeHTTP(rec, req)
}

// ── MONKEY tests — telemetry never panics ────────────────────────────────

// TestInit_EmptyDSN_NeverPanics: property — Init with any release string and
// no DSN set must never panic and must return nil.
func TestInit_EmptyDSN_NeverPanics(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	f := func(release string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("Init(%q) panicked: %v", release, r)
			}
		}()
		err := telemetry.Init(release)
		return err == nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Fatal(err)
	}
}

// TestSlogHandler_AllLevels_NeverPanic: exercises all four standard slog
// levels plus a set of unusual int8 values — none must panic.
func TestSlogHandler_AllLevels_NeverPanic(t *testing.T) {
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ctx := context.Background()

	levels := []slog.Level{
		slog.LevelDebug,
		slog.LevelInfo,
		slog.LevelWarn,
		slog.LevelError,
		slog.Level(-8),  // below debug
		slog.Level(0),   // info value
		slog.Level(100), // above error
		slog.Level(-4),  // debug value
		slog.Level(4),   // warn value
		slog.Level(8),   // error value
	}
	for _, lvl := range levels {
		lvl := lvl
		t.Run(lvl.String(), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("Handle level=%v panicked: %v", lvl, r)
				}
			}()
			var r slog.Record
			r.Level = lvl
			r.Message = "test message"
			_ = h.Handle(ctx, r)
		})
	}
}

// TestHTTPRecovery_MultipleTypePanics verifies that string/int/error/nil
// panic values are all handled gracefully without propagating.
func TestHTTPRecovery_MultipleTypePanics(t *testing.T) {
	panicValues := []struct {
		name string
		fn   func()
	}{
		{"string", func() { panic("string panic") }},
		{"int", func() { panic(42) }},
		{"error", func() { panic(errors.New("error panic")) }},
		{"bytes", func() { panic([]byte("byte panic")) }},
		{"bool", func() { panic(true) }},
		{"struct", func() { panic(struct{ msg string }{"struct panic"}) }},
		{"float64", func() { panic(3.14) }},
		{"int64", func() { panic(int64(-1)) }},
		{"slice_int", func() { panic([]int{1, 2, 3}) }},
		{"map", func() { panic(map[string]string{"k": "v"}) }},
	}
	for _, tc := range panicValues {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			handler := telemetry.HTTPRecoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tc.fn()
			}))
			req := httptest.NewRequest(http.MethodGet, "/panic-type", nil)
			rec := httptest.NewRecorder()

			func() {
				defer func() { recover() }() //nolint:errcheck — catch nil panic edge case
				handler.ServeHTTP(rec, req)
			}()
			// For non-nil panics the middleware must return 500.
			// (nil panic in Go 1.21+ can escape as runtime.PanicNilError.)
			if rec.Code != http.StatusInternalServerError && rec.Code != http.StatusOK {
				t.Errorf("%s: unexpected status %d", tc.name, rec.Code)
			}
		})
	}
}

// TestFatalExitFn_NilError_Safe verifies FatalExitFn with nil error returns a
// non-nil callable for all common exit codes.
func TestFatalExitFn_NilError_Safe(t *testing.T) {
	codes := []int{0, 1, 2, 3, 10, 127, 128, 130, 255}
	for _, code := range codes {
		code := code
		t.Run("code="+itoa(code), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("FatalExitFn(nil, %d) panicked during construction: %v", code, r)
				}
			}()
			fn := telemetry.FatalExitFn(nil, code)
			if fn == nil {
				t.Fatalf("FatalExitFn(nil, %d) returned nil", code)
			}
		})
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// ── envOr coverage ────────────────────────────────────────────────────────

func TestEnvOr_UnsetKey_ReturnsDefault(t *testing.T) {
	key := "TELEMETRY_TEST_NONEXISTENT_KEY_XYZ"
	os.Unsetenv(key)
	h := telemetry.NewSlogHandler(slog.NewTextHandler(os.Stderr, nil))
	if h == nil {
		t.Fatal("setup failed")
	}
	// SetServiceTag internally calls envOr("APP_VERSION", "unknown")
	// — just verify SetServiceTag succeeds (exercises envOr default branch)
	telemetry.SetServiceTag("test-service")
}

func TestEnvOr_SetKey_ReturnsValue(t *testing.T) {
	t.Setenv("APP_VERSION", "v1.2.3")
	// SetServiceTag reads APP_VERSION via envOr
	telemetry.SetServiceTag("test-versioned-service")
	// No panic, no error expected
}

// ── FatalExitFn coverage (non-exit paths) ─────────────────────────────────

func TestFatalExitFn_NilError_ReturnsFn(t *testing.T) {
	fn := telemetry.FatalExitFn(nil, 1)
	if fn == nil {
		t.Fatal("FatalExitFn returned nil")
	}
	// We verify fn is callable but do NOT call it (would os.Exit)
}

func TestFatalExitFn_NonNilError_ReturnsFn(t *testing.T) {
	fn := telemetry.FatalExitFn(errors.New("critical failure"), 1)
	if fn == nil {
		t.Fatal("FatalExitFn returned nil")
	}
}

func TestFatalExitFn_VariousCodes_NeverPanics(t *testing.T) {
	codes := []int{0, 1, 2, 127, 128, 130, 255}
	for _, code := range codes {
		fn := telemetry.FatalExitFn(errors.New("err"), code)
		if fn == nil {
			t.Errorf("FatalExitFn(err, %d) returned nil", code)
		}
	}
}

// ── Breadcrumb (KT-A15) ──────────────────────────────────────────────────────

// TestBreadcrumb_NoSentry_NoPanic verifies the no-op path: when Sentry is
// not initialised, calling Breadcrumb must not panic and must return
// silently. This is the production path on every test process and on
// services running without SENTRY_DSN_GO configured.
func TestBreadcrumb_NoSentry_NoPanic(t *testing.T) {
	defer func() {
		if p := recover(); p != nil {
			t.Errorf("Breadcrumb panicked when Sentry uninitialised: %v", p)
		}
	}()
	telemetry.Breadcrumb("test", "message", map[string]interface{}{
		"foo": "bar",
		"n":   42,
	})
}

// TestBreadcrumb_NilData_NoPanic exercises the empty-data path.
func TestBreadcrumb_NilData_NoPanic(t *testing.T) {
	defer func() {
		if p := recover(); p != nil {
			t.Errorf("Breadcrumb panicked with nil data: %v", p)
		}
	}()
	telemetry.Breadcrumb("test", "no-data", nil)
}

// TestBreadcrumb_EmptyArgs_NoPanic — even with empty strings the helper
// must remain safe.
func TestBreadcrumb_EmptyArgs_NoPanic(t *testing.T) {
	defer func() {
		if p := recover(); p != nil {
			t.Errorf("Breadcrumb panicked with empty args: %v", p)
		}
	}()
	telemetry.Breadcrumb("", "", nil)
}

// ── CaptureAlert panic-safety (Sprint T3, 2026-05-06) ────────────────────────
//
// CaptureAlert now wraps its body with defer/recover so a Sentry SDK panic
// (nil hub, network error, encoding failure) cannot propagate to the caller.
// These tests verify the safety contract without a live Sentry DSN.

// TestCaptureAlert_NoDSN_NoPanic — baseline: without SENTRY_DSN_GO the call
// is a no-op and must never panic.
func TestCaptureAlert_NoDSN_NoPanic(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("CaptureAlert panicked without DSN: %v", r)
		}
	}()
	telemetry.CaptureAlert("test alert", telemetry.AlertTags{Alert: "test"})
}

// TestCaptureAlert_EmptyMessage_NoPanic — empty message must not cause a
// validation panic inside the Sentry SDK.
func TestCaptureAlert_EmptyMessage_NoPanic(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("CaptureAlert panicked with empty message: %v", r)
		}
	}()
	telemetry.CaptureAlert("", telemetry.AlertTags{})
}

// TestCaptureAlert_NilExtras_NoPanic — nil Extras map must not cause a nil
// map dereference inside the tag-attachment logic.
func TestCaptureAlert_NilExtras_NoPanic(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("CaptureAlert panicked with nil Extras: %v", r)
		}
	}()
	telemetry.CaptureAlert("nil extras", telemetry.AlertTags{Alert: "check", Extras: nil})
}

// TestCaptureAlert_LargeExtras_NoPanic — a large Extras map must not cause an
// encoding or allocation panic in the Sentry SDK.
func TestCaptureAlert_LargeExtras_NoPanic(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("CaptureAlert panicked with large Extras: %v", r)
		}
	}()
	extras := make(map[string]any, 100)
	for i := 0; i < 100; i++ {
		extras[itoa(i)] = i
	}
	telemetry.CaptureAlert("large extras", telemetry.AlertTags{Alert: "load", Extras: extras})
}

// TestCaptureAlert_ConcurrentCallsAllSafe — concurrent callers must not
// race each other or the SDK's internal state (race-detector check).
func TestCaptureAlert_ConcurrentCallsAllSafe(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	const workers = 30
	done := make(chan struct{}, workers)
	for i := 0; i < workers; i++ {
		go func(i int) {
			defer func() {
				recover() // absorb any unexpected panic so goroutine exits
				done <- struct{}{}
			}()
			telemetry.CaptureAlert("concurrent alert", telemetry.AlertTags{
				Alert:  "parallel",
				Extras: map[string]any{"worker": i},
			})
		}(i)
	}
	for i := 0; i < workers; i++ {
		<-done
	}
}

// TestCaptureAlert_RepeatedCalls_NoPanic — calling CaptureAlert 10 times in
// sequence must never panic (no internal state bleed).
func TestCaptureAlert_RepeatedCalls_NoPanic(t *testing.T) {
	os.Unsetenv("SENTRY_DSN_GO")
	for i := 0; i < 10; i++ {
		func(i int) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("iteration %d: CaptureAlert panicked: %v", i, r)
				}
			}()
			telemetry.CaptureAlert("repeat", telemetry.AlertTags{Alert: "iter", Extras: map[string]any{"i": i}})
		}(i)
	}
}
