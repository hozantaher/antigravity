package main

// queue_alert.go — H4.2: Sentry alert when the relay queue is stuck.
//
// A queue is considered stuck when the oldest pending envelope has been
// waiting longer than queueStuckThreshold. The goroutine fires a Sentry
// message at most once per queueAlertCooldown, and sends a recovery message
// when the queue drains below queueRecoveredThreshold.
//
// Uses common/telemetry.CaptureAlert — the relay has no direct sentry-go
// import; alert dispatch is delegated to the shared wrapper.

import (
	"context"
	"fmt"
	"time"

	"common/envconfig"
	"common/telemetry"
	"relay/internal/minlog"
)

const (
	// queueStuckThreshold is the age at which the oldest pending envelope
	// triggers a "queue stuck" alert.
	queueStuckThreshold = 10 * time.Minute

	// queueAlertCooldown is the minimum time between successive stuck alerts
	// for the same condition (prevents alert storms).
	queueAlertCooldown = 1 * time.Hour

	// queueRecoveredThreshold: oldest pending age below this after a stuck
	// alert triggers a recovery notification.
	queueRecoveredThreshold = 1 * time.Minute

	// queueCheckInterval is how often the ticker inspects queue health.
	queueCheckInterval = 60 * time.Second
)

// queueStatsProvider exposes the subset of *relay.Scheduler used by the alert.
// Injectable so tests can drive it without a real Scheduler.
type queueStatsProvider interface {
	// OldestPendingAge returns the age of the oldest scheduled envelope, or
	// a negative duration when the queue is empty.
	OldestPendingAge() time.Duration
	// PendingCount returns the number of envelopes waiting to be relayed.
	PendingCount() int
}

// runQueueStuckAlert monitors the relay queue for stuck envelopes and fires
// Sentry alerts when the oldest pending envelope age exceeds queueStuckThreshold.
//
// Respects ctx cancellation for clean shutdown. No-op when SENTRY_DSN_GO is
// unset so development environments remain unaffected.
func runQueueStuckAlert(ctx context.Context, stats queueStatsProvider, logger *minlog.Logger) {
	if envconfig.GetOr("SENTRY_DSN_GO", "") == "" {
		return
	}
	runQueueStuckAlertWithClock(ctx, stats, logger, time.Now)
}

// runQueueStuckAlertWithClock is the testable core of runQueueStuckAlert.
// clockNow is injectable so tests can control the passage of time.
func runQueueStuckAlertWithClock(
	ctx context.Context,
	stats queueStatsProvider,
	logger *minlog.Logger,
	clockNow func() time.Time,
) {
	ticker := time.NewTicker(queueCheckInterval)
	defer ticker.Stop()

	var (
		alerted       bool
		lastAlertTime time.Time
	)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			checkQueueOnce(stats, logger, clockNow, &alerted, &lastAlertTime)
		}
	}
}

// checkQueueOnce performs a single queue health inspection. Extracted so
// tests can drive it directly without a ticker.
func checkQueueOnce(
	stats queueStatsProvider,
	logger *minlog.Logger,
	clockNow func() time.Time,
	alerted *bool,
	lastAlertTime *time.Time,
) {
	age := stats.OldestPendingAge()
	depth := stats.PendingCount()

	switch {
	case age >= queueStuckThreshold:
		// Only alert once per cooldown window.
		if !*alerted || clockNow().Sub(*lastAlertTime) >= queueAlertCooldown {
			msg := fmt.Sprintf(
				"Anti-trace relay queue stuck: oldest envelope age %ds > %ds threshold",
				int(age.Seconds()),
				int(queueStuckThreshold.Seconds()),
			)
			telemetry.CaptureAlert(msg, telemetry.AlertTags{
				Alert: "relay_queue_stuck",
				Extras: map[string]any{
					"queue_depth":        depth,
					"oldest_age_seconds": int(age.Seconds()),
					"threshold_seconds":  int(queueStuckThreshold.Seconds()),
				},
			})
			*alerted = true
			*lastAlertTime = clockNow()
			logger.Error("relay_queue_stuck_alert_sent",
				minlog.F("oldest_age_s", fmt.Sprintf("%d", int(age.Seconds()))),
				minlog.F("queue_depth", fmt.Sprintf("%d", depth)),
			)
		}

	case *alerted && (age < 0 || age < queueRecoveredThreshold):
		// Queue drained or recovered — send a single recovery notification.
		telemetry.CaptureAlert("Anti-trace relay queue recovered — no longer stuck", telemetry.AlertTags{
			Alert: "relay_queue_recovered",
		})
		*alerted = false
		logger.Info("relay_queue_recovered_alert_sent")
	}
}
