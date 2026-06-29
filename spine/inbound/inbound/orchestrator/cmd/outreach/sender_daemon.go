package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/getsentry/sentry-go"
)

// senderHealthReporter is the subset of *common/health.Registry that
// superviseSender depends on. Narrow interface keeps tests free of registry
// internals; production wiring passes the full *health.Registry.
type senderHealthReporter interface {
	Report(name string, ok bool, errMsg string)
}

// senderAlertNotifier is the subset of *common/alert.Client used by
// superviseSender. The two methods cover the two failure modes:
// recovered panic (DaemonPanic) and Run returning a non-nil non-context error
// (DaemonError).
type senderAlertNotifier interface {
	DaemonError(ctx context.Context, daemon, errMsg string)
	DaemonPanic(ctx context.Context, daemon, panicMsg string)
}

// senderDaemonName is the identifier reported into the health registry and
// surfaced via the orchestrator /health endpoint.
const senderDaemonName = "sender_daemon"

// safeCall invokes fn and recovers any panic it throws. If fn panics, the
// recovered value is logged but NOT re-thrown — the caller's goroutine
// continues normally.
//
// This is used to shield superviseSender's defer block from a panicking
// alertClient method. Go does not re-enter recover() for a panic that occurs
// inside a deferred function's own call stack, so without this wrapper a
// misbehaving alertClient.DaemonPanic would propagate to the process.
//
// Sprint T3 (2026-05-06): pre-launch HIGH severity hardening.
func safeCall(op string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("alert hook panic recovered — daemon continues",
				"op", op,
				"recover", fmt.Sprintf("%v", r),
			)
		}
	}()
	fn()
}

// superviseSender wraps a sender daemon Run() call and translates its outcome
// into health-registry + alert signals.
//
// Outcomes:
//   - panic       → recovered, health=false, DaemonPanic alert.
//   - ctx error   → graceful shutdown, health=true, no alert.
//   - other error → health=false, DaemonError alert (boot misconfig, runtime fault).
//   - nil return  → unexpected (Run should block); health=false, DaemonError alert.
//
// Alert hook calls (DaemonPanic, DaemonError) are wrapped with safeCall so
// that a panicking Sentry hook cannot kill the daemon. See Sprint T3.
//
// S10 (2026-04-26): previously the goroutine at main.go:547 discarded Run's
// return value — a missing ANTI_TRACE_URL caused ErrAntiTraceRequired which
// silently killed sending without surfacing anywhere. send_events ALL-TIME = 0.
func superviseSender(ctx context.Context, run func() error, hr senderHealthReporter, ac senderAlertNotifier) {
	defer func() {
		if r := recover(); r != nil {
			errMsg := fmt.Sprintf("panic: %v", r)
			slog.Error("sender daemon panic recovered", "op", "outreach.sender/supervise/panic", "recover", r)
			hr.Report(senderDaemonName, false, errMsg)
			safeCall("outreach.sender/supervise/daemonPanic", func() {
				ac.DaemonPanic(ctx, senderDaemonName, errMsg)
			})
		}
	}()

	err := run()

	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		slog.Info("sender daemon stopped via context", "op", "outreach.sender/supervise/ctx", "reason", err.Error())
		hr.Report(senderDaemonName, true, "")
		return
	}

	if err != nil {
		// W1 (#93, 2026-04-29): was telemetry.CaptureWithPlaybook(ctx, err).
		// The playbook helper attached a `playbook_url` Sentry tag pulled
		// from ctx, but no production code ever called WithPlaybook to
		// attach a URL — the consumer was wired ahead of the producer.
		// docs/playbooks/ doesn't exist on main either, so the URL had
		// nowhere to point. Per "no speculation" rule: dropped the half-
		// finished plumbing; plain CaptureException now matches what was
		// happening at runtime anyway (the helper fell through to this
		// branch every time).
		sentry.CaptureException(err)
		slog.Error("sender daemon exited", "op", "outreach.sender/supervise", "error", err)
		hr.Report(senderDaemonName, false, err.Error())
		safeCall("outreach.sender/supervise/daemonError", func() {
			ac.DaemonError(ctx, senderDaemonName, err.Error())
		})
		return
	}

	const nilMsg = "Run returned nil — daemon stopped silently"
	slog.Warn("sender daemon Run returned nil error", "op", "outreach.sender/supervise/nil")
	hr.Report(senderDaemonName, false, nilMsg)
	safeCall("outreach.sender/supervise/daemonErrorNil", func() {
		ac.DaemonError(ctx, senderDaemonName, nilMsg)
	})
}
