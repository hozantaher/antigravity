// Z3-B: bounce-rate monitor cron migrated from BFF (AR11 —
// apps/outreach-dashboard/src/server-routes/bounceRateMonitor.js).
//
// Monitors send_events for per-mailbox bounce rates in the last 24h and
// auto-pauses mailboxes whose (hard + soft) rate >= bounce_rate_critical
// threshold (default 5%) with a minimum sample of mailbox_min_volume_for_rate_check
// sends. Already-paused mailboxes are skipped — no double-flip.
//
// On every auto-pause:
//   * INSERT INTO mailbox_alerts (type='bounce_rate_critical', severity='critical', mailbox_id, message)
//     — but only if no resolved=NULL row of the same type already exists within
//       the dedup window (default 4h). This prevents spamming the same alert
//       every 30 min while the mailbox is still paused (the healing cron is
//       responsible for clearing it on recovery).
//   * audit.Log entry per pause (HARD RULE feedback_audit_log_on_mutations T0).
//
// HARD RULE feedback_schema_verify_before_sql T0: schema verified via migrations
// 044 (mailbox_alerts) + 090 (outreach_mailboxes from_address/status/status_reason)
// + send_events (status, smtp_response, sent_at, mailbox_used).

package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"common/audit"
	"common/envconfig"
	"common/operatorconfig"
)

const (
	bounceRateMonitorDefaultInterval = 30 * time.Minute
	bounceRateAlertType              = "bounce_rate_critical"
	bounceRateAlertDedupWindow       = 4 * time.Hour
	defaultBounceRateCriticalThreshold = 0.05
)

// bounceRateMonitorResult is a tiny observability struct.
type bounceRateMonitorResult struct {
	Checked      int
	Paused       int
	AlertsEmitted int
}

// LoadBounceRateMonitorThresholds reads operator_settings (HARD RULE
// feedback_no_magic_thresholds T0). Missing keys fall back to defaults.
func LoadBounceRateMonitorThresholds(ctx context.Context, loader *operatorconfig.Loader) (criticalRate float64, minVolume int) {
	criticalRate = defaultBounceRateCriticalThreshold
	minVolume = defaultMailboxMinVolumeForRateCheck
	if loader == nil {
		return
	}
	if v, err := loader.Get(ctx, "bounce_rate_critical_threshold"); err == nil && v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			criticalRate = f
		}
	}
	if v, err := loader.Get(ctx, "mailbox_min_volume_for_rate_check"); err == nil && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			minVolume = n
		}
	}
	return
}

// RunBounceRateMonitorOnce executes one tick: aggregate per-mailbox bounce
// rates over the last 24h, pause any mailbox whose combined hard+soft rate
// exceeds the configured threshold, and emit a dedup'd mailbox_alerts row.
func RunBounceRateMonitorOnce(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) (bounceRateMonitorResult, error) {
	var res bounceRateMonitorResult
	criticalRate, minVolume := LoadBounceRateMonitorThresholds(ctx, loader)

	// Hard (status='bounced') + soft (status='failed' AND smtp_response ~ '^4')
	// bounces aggregated per mailbox_used over the last 24h.
	rows, err := db.QueryContext(ctx, `
		WITH recent AS (
		  SELECT
		    mailbox_used,
		    count(*) FILTER (WHERE status = 'bounced')                                  AS hard_bounces,
		    count(*) FILTER (WHERE status = 'failed' AND smtp_response ~ '^4')          AS soft_bounces,
		    count(*)                                                                     AS total
		  FROM send_events
		  WHERE sent_at > NOW() - INTERVAL '24 hours'
		  GROUP BY mailbox_used
		  HAVING count(*) >= $1
		)
		SELECT
		  mailbox_used,
		  hard_bounces,
		  soft_bounces,
		  (hard_bounces + soft_bounces)                              AS bounces,
		  total,
		  ((hard_bounces + soft_bounces)::float / total)             AS rate
		FROM recent
		WHERE (hard_bounces + soft_bounces)::float / total >= $2`, minVolume, criticalRate)
	if err != nil {
		return res, fmt.Errorf("query mailbox bounce rates: %w", err)
	}
	defer rows.Close()

	type mbRate struct {
		MailboxUsed  string
		HardBounces  int
		SoftBounces  int
		TotalBounces int
		Total        int
		Rate         float64
	}
	var entries []mbRate
	for rows.Next() {
		var e mbRate
		if err := rows.Scan(&e.MailboxUsed, &e.HardBounces, &e.SoftBounces, &e.TotalBounces, &e.Total, &e.Rate); err != nil {
			return res, fmt.Errorf("scan mailbox row: %w", err)
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return res, fmt.Errorf("iterate mailbox rows: %w", err)
	}
	res.Checked = len(entries)

	for _, e := range entries {
		ratePct := e.Rate * 100
		// "auto:" prefix is the orchestrator/BFF convention that marks this
		// pause as platform-driven so the mailbox-healing daemon
		// (cron_mailbox_healing.go) considers the row for auto-resume once
		// last_score recovers and the 24h bounce window clears. Without
		// the prefix the healing daemon treats the pause as operator-
		// intentional and never re-enables the mailbox.
		reason := fmt.Sprintf("auto: bounce_rate_%.1fpct (%d hard + %d soft = %d/%d in 24h)",
			ratePct, e.HardBounces, e.SoftBounces, e.TotalBounces, e.Total)

		// Pause only if currently active — race-safe against operator unpause.
		var mailboxID sql.NullInt64
		err := db.QueryRowContext(ctx, `
			UPDATE outreach_mailboxes
			   SET status='paused', status_reason=$2, updated_at=NOW()
			 WHERE from_address=$1 AND status='active'
			RETURNING id`, e.MailboxUsed, reason).Scan(&mailboxID)
		if err == sql.ErrNoRows {
			// Already paused or no longer active — emit dedup'd alert anyway so
			// operator sees recurrence; but skip audit row.
			res.AlertsEmitted += maybeInsertBounceAlert(ctx, db, e.MailboxUsed, reason, ratePct)
			continue
		}
		if err != nil {
			slog.Warn("bounce_rate_monitor: pause UPDATE failed",
				"op", "outreach.bounce_rate_monitor/pause",
				"mailbox", redactEmail(e.MailboxUsed), "error", err)
			continue
		}
		res.Paused++

		// HARD RULE feedback_audit_log_on_mutations T0
		entityID := ""
		if mailboxID.Valid {
			entityID = strconv.FormatInt(mailboxID.Int64, 10)
		}
		audit.Log(ctx, db, "bounce_rate_monitor.pause", "cron", "mailbox", entityID,
			map[string]any{
				"from_address":  e.MailboxUsed,
				"reason":        reason,
				"rate":          e.Rate,
				"hard_bounces":  e.HardBounces,
				"soft_bounces":  e.SoftBounces,
				"total":         e.Total,
			})
		res.AlertsEmitted += maybeInsertBounceAlert(ctx, db, e.MailboxUsed, reason, ratePct)

		slog.Warn("mailbox_bounce_rate_high",
			"op", "outreach.bounce_rate_monitor/alert",
			"mailbox", redactEmail(e.MailboxUsed),
			"rate", e.Rate, "hard", e.HardBounces, "soft", e.SoftBounces)
	}
	return res, nil
}

// maybeInsertBounceAlert inserts an unresolved mailbox_alerts row unless an
// open alert of the same type for the same mailbox already exists within the
// dedup window. Returns 1 if a row was inserted, 0 otherwise. Errors are
// logged but never propagated — alerts must not block the pause path.
func maybeInsertBounceAlert(ctx context.Context, db *sql.DB, fromAddress, reason string, ratePct float64) int {
	// Resolve mailbox_id by from_address.
	var mailboxID sql.NullInt64
	if err := db.QueryRowContext(ctx,
		`SELECT id FROM outreach_mailboxes WHERE from_address=$1 LIMIT 1`,
		fromAddress).Scan(&mailboxID); err != nil && err != sql.ErrNoRows {
		slog.Warn("bounce_rate_monitor: mailbox id lookup failed",
			"op", "outreach.bounce_rate_monitor/lookup",
			"mailbox", redactEmail(fromAddress), "error", err)
		return 0
	}
	if !mailboxID.Valid {
		return 0
	}

	// Dedup: skip if open (resolved_at IS NULL) alert of this type for this
	// mailbox exists within the dedup window.
	var exists bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS(
		  SELECT 1 FROM mailbox_alerts
		   WHERE mailbox_id=$1 AND type=$2
		     AND resolved_at IS NULL
		     AND created_at > NOW() - $3::interval
		)`, mailboxID.Int64, bounceRateAlertType,
		fmt.Sprintf("%d seconds", int(bounceRateAlertDedupWindow.Seconds()))).Scan(&exists); err != nil {
		slog.Warn("bounce_rate_monitor: dedup lookup failed",
			"op", "outreach.bounce_rate_monitor/dedup", "error", err)
		// Fall through — better to risk a duplicate alert than to silently swallow.
	}
	if exists {
		return 0
	}

	message := fmt.Sprintf("Bounce rate %.1f%% in 24h — %s", ratePct, reason)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO mailbox_alerts (mailbox_id, type, severity, message, created_at)
		VALUES ($1, $2, 'critical', $3, NOW())`,
		mailboxID.Int64, bounceRateAlertType, message); err != nil {
		slog.Warn("bounce_rate_monitor: alert insert failed",
			"op", "outreach.bounce_rate_monitor/insert", "error", err)
		return 0
	}
	return 1
}

// redactEmail keeps just the first ~3 chars of the local part for log lines —
// satisfies HARD RULE feedback_no_pii_in_commands T0 (logs are emitted via slog).
func redactEmail(addr string) string {
	at := strings.IndexByte(addr, '@')
	if at <= 0 {
		return "[redacted]"
	}
	local := addr[:at]
	domain := addr[at:]
	if len(local) <= 3 {
		return local + "…" + domain
	}
	return local[:3] + "…" + domain
}

// StartBounceRateMonitorLoop spawns the periodic cron.
func StartBounceRateMonitorLoop(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) {
	if envconfig.BoolOr("DISABLE_BOUNCE_RATE_MONITOR_CRON", false) {
		slog.Info("bounce_rate_monitor cron disabled (DISABLE_BOUNCE_RATE_MONITOR_CRON=1)")
		return
	}
	interval := bounceRateMonitorDefaultInterval
	if v := envconfig.GetOr("BOUNCE_RATE_MONITOR_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			interval = d
		}
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("bounce_rate_monitor panic recovered",
					"op", "outreach.bounce_rate_monitor/recover", "recover", r)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		select {
		case <-ctx.Done():
			return
		case <-time.After(60 * time.Second):
		}
		runTick := func() {
			start := time.Now()
			res, err := RunBounceRateMonitorOnce(ctx, db, loader)
			dur := time.Since(start)
			if err != nil {
				slog.Error("bounce_rate_monitor tick failed",
					"op", "outreach.bounce_rate_monitor/tick",
					"error", err, "duration_ms", dur.Milliseconds())
				return
			}
			slog.Info("bounce_rate_monitor tick",
				"op", "outreach.bounce_rate_monitor/done",
				"checked", res.Checked, "paused", res.Paused, "alerts", res.AlertsEmitted,
				"duration_ms", dur.Milliseconds())
		}
		runTick()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runTick()
			}
		}
	}()
	slog.Info("bounce_rate_monitor cron started", "interval", interval)
}
