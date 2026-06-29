package main

// daemon_alert.go — H4.3: Sentry alert when the campaign daemon tick is absent.
//
// The campaign scheduler fires every campaignInterval (default 15 min). If
// the health registry shows the campaign_daemon as stale (no Report() within
// daemonDeadThreshold), we fire a Sentry alert.
//
// Uses common/telemetry.CaptureAlert — matches the pattern used by the relay
// queue alert (H4.2) for consistent Sentry grouping.

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"common/envconfig"
	"common/telemetry"
)

const (
	// daemonDeadThreshold: if campaign_daemon has not called Report() within
	// this window, fire an alert.
	daemonDeadThreshold = 5 * time.Minute

	// daemonDeadCooldown: minimum time between successive "daemon dead" alerts.
	daemonDeadCooldown = 1 * time.Hour

	// daemonDeadCheckInterval: how often the ticker polls daemon health.
	daemonDeadCheckInterval = 60 * time.Second

	// daemonAlertName is the daemon name as registered in the health registry.
	daemonAlertName = "campaign_daemon"
)

// daemonHealthReader is the subset of *health.Registry consumed by the alert.
// Narrow interface keeps the alert goroutine testable without a full registry.
type daemonHealthReader interface {
	// Stale returns names of daemons that have not reported within maxAge.
	Stale(maxAge time.Duration) []string
}

// runDaemonDeadAlert monitors the campaign daemon health and fires Sentry
// alerts when the daemon has not reported within daemonDeadThreshold.
//
// Respects ctx cancellation. No-op when SENTRY_DSN_GO is unset.
func runDaemonDeadAlert(ctx context.Context, reg daemonHealthReader) {
	if envconfig.GetOr("SENTRY_DSN_GO", "") == "" {
		return
	}
	runDaemonDeadAlertWithClock(ctx, reg, time.Now)
}

// runDaemonDeadAlertWithClock is the testable core of runDaemonDeadAlert.
func runDaemonDeadAlertWithClock(
	ctx context.Context,
	reg daemonHealthReader,
	clockNow func() time.Time,
) {
	ticker := time.NewTicker(daemonDeadCheckInterval)
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
			checkDaemonOnce(reg, clockNow, &alerted, &lastAlertTime)
		}
	}
}

// checkDaemonOnce performs a single daemon health inspection. Extracted so
// tests can drive it directly without a ticker.
func checkDaemonOnce(
	reg daemonHealthReader,
	clockNow func() time.Time,
	alerted *bool,
	lastAlertTime *time.Time,
) {
	stale := reg.Stale(daemonDeadThreshold)
	now := clockNow()

	isDead := false
	for _, name := range stale {
		if name == daemonAlertName {
			isDead = true
			break
		}
	}

	switch {
	case isDead:
		// Throttle to one alert per cooldown window.
		if !*alerted || now.Sub(*lastAlertTime) >= daemonDeadCooldown {
			thresholdSeconds := int(daemonDeadThreshold.Seconds())
			msg := fmt.Sprintf(
				"Campaign daemon scheduler tick absent for >%ds (threshold)",
				thresholdSeconds,
			)
			telemetry.CaptureAlert(msg, telemetry.AlertTags{
				Alert: "daemon_dead",
				Extras: map[string]any{
					"daemon":             daemonAlertName,
					"threshold_seconds":  thresholdSeconds,
				},
			})
			*alerted = true
			*lastAlertTime = now
			slog.Error("daemon_dead_alert_sent",
				"op", "outreach.daemonAlert/check",
				"daemon", daemonAlertName,
				"threshold_s", thresholdSeconds,
			)
		}

	case *alerted && !isDead:
		// Daemon is reporting again — send recovery.
		telemetry.CaptureAlert(
			fmt.Sprintf("Campaign daemon recovered — %s is healthy", daemonAlertName),
			telemetry.AlertTags{
				Alert: "daemon_recovered",
				Extras: map[string]any{"daemon": daemonAlertName},
			},
		)
		*alerted = false
		slog.Info("daemon_recovered_alert_sent",
			"op", "outreach.daemonAlert/recover",
			"daemon", daemonAlertName,
		)
	}
}
