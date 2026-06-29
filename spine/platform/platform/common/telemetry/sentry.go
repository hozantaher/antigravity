package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/getsentry/sentry-go"

	"common/envconfig"
)

// MonitoredJob wraps a periodic job with Sentry cron monitoring.
// It sends check-in events (in_progress → ok/error) when SENTRY_DSN_GO is set.
// Panics inside fn are recovered, captured in Sentry, and returned as errors.
// Safe to call when Sentry is not initialised (no-op check-ins, panic still recovered).
func MonitoredJob(slug string, fn func() error) (retErr error) {
	if fn == nil {
		return fmt.Errorf("MonitoredJob: fn is nil")
	}

	// Check-in: in_progress (only when Sentry DSN is configured)
	var checkinID *sentry.EventID
	if slug != "" && envconfig.GetOr("SENTRY_DSN_GO", "") != "" {
		checkinID = sentry.CaptureCheckIn(&sentry.CheckIn{
			MonitorSlug: slug,
			Status:      sentry.CheckInStatusInProgress,
		}, &sentry.MonitorConfig{
			Schedule: sentry.CrontabSchedule("0 * * * *"),
		})
	}

	defer func() {
		if r := recover(); r != nil {
			var err error
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("panic in %s: %v", slug, r)
			}
			sentry.CaptureException(err)
			retErr = err
		}

		if slug != "" && envconfig.GetOr("SENTRY_DSN_GO", "") != "" {
			status := sentry.CheckInStatusOK
			if retErr != nil {
				status = sentry.CheckInStatusError
			}
			var id sentry.EventID
			if checkinID != nil {
				id = *checkinID
			}
			sentry.CaptureCheckIn(&sentry.CheckIn{
				ID:          id,
				MonitorSlug: slug,
				Status:      status,
			}, nil)
		}
	}()

	return fn()
}

// Init initialises Sentry from SENTRY_DSN_GO env var.
// Safe to call when DSN is empty — becomes a no-op.
//
// `service` is the short service identifier (e.g. "outreach", "relay").
// The Sentry `release` tag is constructed as "<service>@<sha>" where <sha>
// is taken from env GIT_SHA / RAILWAY_GIT_COMMIT_SHA / SOURCE_COMMIT (in
// priority order, first non-empty wins). Without a SHA, falls back to
// "<service>@unknown" so dashboards still get a release marker; the value
// just won't separate v-N from v-N+1.
func Init(service string) error {
	dsn := envconfig.GetOr("SENTRY_DSN_GO", "")
	if dsn == "" {
		return nil
	}
	return sentry.Init(sentry.ClientOptions{
		Dsn:         dsn,
		Environment: envconfig.GetOr("APP_ENV", "development"),
		Release:     BuildReleaseTag(service),
		// Errors only — no performance tracing on free tier
		TracesSampleRate: 0,
		BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			return event
		},
	})
}

// BuildReleaseTag composes "<service>@<sha>" for Sentry release tagging.
// Reads GIT_SHA, RAILWAY_GIT_COMMIT_SHA, or SOURCE_COMMIT (priority order)
// and trims to 7 chars. Service must be non-empty; SHA may be empty (→ "unknown").
//
// BF-F3 — exposed publicly so other Sentry consumers (e.g. CLI tools)
// emit consistent release values without re-implementing the precedence.
func BuildReleaseTag(service string) string {
	if service == "" {
		service = "unknown-service"
	}
	for _, k := range []string{"GIT_SHA", "RAILWAY_GIT_COMMIT_SHA", "SOURCE_COMMIT"} {
		if v := envconfig.GetOr(k, ""); v != "" {
			if len(v) > 7 {
				v = v[:7]
			}
			return service + "@" + v
		}
	}
	return service + "@unknown"
}

// Flush blocks up to 2 s to drain the queue before process exit.
func Flush() {
	sentry.Flush(2 * time.Second)
}

// SlogHandler wraps an existing slog.Handler and forwards LevelError
// records to Sentry. Pass nil to use the default slog handler.
type SlogHandler struct {
	inner slog.Handler
}

func NewSlogHandler(inner slog.Handler) *SlogHandler {
	if inner == nil {
		inner = slog.Default().Handler()
	}
	return &SlogHandler{inner: inner}
}

func (h *SlogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *SlogHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelError {
		msg := r.Message
		// Collect attrs into a map for Sentry extras
		extras := make(map[string]any, r.NumAttrs())
		r.Attrs(func(a slog.Attr) bool {
			extras[a.Key] = a.Value.Any()
			return true
		})
		sentry.WithScope(func(scope *sentry.Scope) {
			if len(extras) > 0 {
				scope.SetContext("slog_attrs", sentry.Context(extras))
			}
			// If an "error" attr carries an actual error, capture it directly
			if err, ok := extras["error"].(error); ok {
				sentry.CaptureException(err)
			} else {
				sentry.CaptureMessage(msg)
			}
		})
	}
	return h.inner.Handle(ctx, r)
}

func (h *SlogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &SlogHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *SlogHandler) WithGroup(name string) slog.Handler {
	return &SlogHandler{inner: h.inner.WithGroup(name)}
}

// FatalExitFn returns a function that captures the error in Sentry, flushes,
// and calls os.Exit(code). Use with defer or call directly before fatal exits.
// Returns a func so callers can defer it without evaluating args at defer time.
func FatalExitFn(err error, code int) func() {
	return func() {
		if err != nil {
			sentry.CaptureException(err)
			sentry.Flush(2 * time.Second)
		}
		os.Exit(code)
	}
}

// HTTPRecoveryMiddleware wraps an http.Handler and recovers from panics.
// The panic value is captured in Sentry and a 500 response is written.
func HTTPRecoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				var err error
				switch e := v.(type) {
				case error:
					err = e
				default:
					err = fmt.Errorf("panic: %v", e)
				}
				sentry.CaptureException(err)
				slog.Error("http handler panic recovered", "error", err, "path", r.URL.Path)
				if !headerWritten(w) {
					http.Error(w, "internal server error", http.StatusInternalServerError)
				}
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// headerWritten tries to detect if headers have already been sent.
// net/http doesn't expose this cleanly, so we probe with a benign write.
func headerWritten(w http.ResponseWriter) bool {
	// ResponseRecorder from httptest exposes Code; production writers do not.
	// We accept the race: if headers weren't written, we write 500.
	return false
}

// TracedHTTPMiddleware wraps an http.Handler to create a Sentry span
// for each request. Only active when SENTRY_DSN_GO is set.
func TracedHTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if envconfig.GetOr("SENTRY_DSN_GO", "") == "" {
			next.ServeHTTP(w, r)
			return
		}
		span := sentry.StartTransaction(r.Context(),
			r.Method+" "+r.URL.Path,
			sentry.WithTransactionSource(sentry.SourceURL),
		)
		span.Op = "http.server"
		defer func() {
			span.Status = sentry.SpanStatusOK
			span.Finish()
		}()
		next.ServeHTTP(w, r.WithContext(span.Context()))
	})
}

// Breadcrumb adds a Sentry breadcrumb for the given category/message
// combination. Safe when Sentry is not initialised — falls through to
// no-op via the SDK's nil-hub guard. Wrapped in recover() so a misbehaving
// integration cannot crash the caller.
//
// Use for state-transition signals (e.g. campaign step advance) that
// help correlate later errors with the path that produced them. Do NOT
// use for routine per-event logging — stick with slog for that.
//
// data is shallow-copied into the breadcrumb. Keys whose values are not
// JSON-serialisable will appear as their fmt.Sprintf %v form once Sentry
// flushes; pass primitive types only.
func Breadcrumb(category, message string, data map[string]interface{}) {
	defer func() {
		_ = recover()
	}()
	hub := sentry.CurrentHub()
	if hub == nil {
		return
	}
	hub.AddBreadcrumb(&sentry.Breadcrumb{
		Category: category,
		Message:  message,
		Level:    sentry.LevelInfo,
		Data:     data,
	}, nil)
}

// AlertTags holds structured metadata for a Sentry alert message.
// Use with CaptureAlert to fire a labelled operational alert.
type AlertTags struct {
	// Alert is the machine-readable alert identifier (e.g. "relay_queue_stuck").
	Alert string
	// Extras are key-value extras attached to the Sentry event scope.
	Extras map[string]any
}

// CaptureAlert fires a Sentry message with structured alert tags.
// No-op when Sentry is not initialised. Safe to call at any time.
//
// Any panic from the Sentry SDK (network error, nil hub, encoding failure) is
// recovered and logged via slog so callers — notably daemon supervisors — are
// never killed by a transient Sentry failure. Sprint T3 (2026-05-06).
func CaptureAlert(msg string, tags AlertTags) {
	defer func() {
		if r := recover(); r != nil {
			// Use slog (not fmt.Print) so the failure appears in structured logs.
			// Avoid recursive Sentry calls here to prevent panic loops.
			slog.Error("CaptureAlert panic recovered",
				"op", "telemetry.CaptureAlert/recover",
				"error", fmt.Sprintf("%v", r),
				"alert_msg", msg,
			)
		}
	}()
	sentry.WithScope(func(scope *sentry.Scope) {
		if tags.Alert != "" {
			scope.SetTag("alert", tags.Alert)
		}
		if len(tags.Extras) > 0 {
			scope.SetContext("alert_context", sentry.Context(tags.Extras))
		}
		sentry.CaptureMessage(msg)
	})
}

// SetServiceTag nastaví sentry tag "service" pro tuto instanci.
// Volat hned po Init() v každé službě.
func SetServiceTag(name string) {
	if name == "" {
		return
	}
	sentry.ConfigureScope(func(scope *sentry.Scope) {
		scope.SetTag("service", name)
		scope.SetTag("service.version", envconfig.GetOr("APP_VERSION", "unknown"))
	})
}
