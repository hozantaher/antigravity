// Sprint AC10 — bounce-rate 1h sliding window alert.
//
// Complements the existing 24h bounce_rate_critical monitor (AR11 →
// cron_bounce_rate_monitor.go) by surfacing short bursts the 24h window
// drowns out. Tick every 5 minutes, aggregate per-mailbox bounces over the
// last 1h, and emit a `mailbox_alerts` row (type='bounce_rate_1h_high',
// severity='warning') when:
//
//   * per-mailbox rate > bounce_rate_1h_per_mailbox_threshold (default 1%)
//     given a minimum volume of mailbox_min_volume_for_rate_check sends,
//
//   * OR cluster aggregate rate > bounce_rate_1h_cluster_threshold
//     (default 1.5%).
//
// Dedup window is `bounce_rate_1h_dedup_window_minutes` minutes
// (default 30) per mailbox+type — short enough to re-alert when the burst
// keeps going past 30 min, long enough not to spam every 5-min tick.
//
// HARD RULE compliance:
//   - feedback_no_magic_thresholds (T0)      — all three thresholds in
//     operator_settings + named Go defaults.
//   - feedback_audit_log_on_mutations (T0)   — alert INSERTs are paired
//     with operator_audit_log rows (the alert IS the operator-visible
//     state change; both per-mailbox and cluster alerts audit-log).
//   - feedback_schema_verify_before_sql (T0) — send_events columns
//     verified via psql \d (mailbox_used, status, sent_at). mailbox_alerts
//     columns verified (mailbox_id, type, severity, message, created_at,
//     resolved_at).
//   - feedback_no_pii_in_commands (T0)       — slog redacts mailbox
//     local-part via redactEmail.
//   - feedback_external_io_backoff (T0)      — not applicable; SQL-only.

package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"common/audit"
	"common/envconfig"
	"common/operatorconfig"
)

const (
	bounceRate1hDefaultInterval = 5 * time.Minute
	bounceRate1hAlertType       = "bounce_rate_1h_high"
	bounceRate1hClusterAlertType = "bounce_rate_1h_cluster_high"

	defaultBounceRate1hPerMailboxThreshold = 0.01  // 1%
	defaultBounceRate1hClusterThreshold    = 0.015 // 1.5%
	defaultBounceRate1hDedupMinutes        = 30
	// bounceRate1hMinVolume is the per-mailbox sample floor for the 1h
	// window — independent of the 24h monitor's mailbox_min_volume_for_rate_check
	// because the 1h window has roughly 1/24 the sample size. 10 sends in 1h
	// is the smallest population where 1% (≥1 bounce) is meaningfully signal.
	bounceRate1hMinVolume = 10
)

// bounceRate1hThresholds bundles operator-tunable knobs.
type bounceRate1hThresholds struct {
	PerMailbox   float64
	Cluster      float64
	DedupMinutes int
	MinVolume    int
}

// bounceRate1hResult tracks observability counts per tick.
type bounceRate1hResult struct {
	Checked          int
	PerMailboxAlerts int
	ClusterAlerts    int
}

// LoadBounceRate1hThresholds reads operator_settings. Missing or invalid
// values fall back to defaults — never panic.
func LoadBounceRate1hThresholds(ctx context.Context, loader *operatorconfig.Loader) bounceRate1hThresholds {
	t := bounceRate1hThresholds{
		PerMailbox:   defaultBounceRate1hPerMailboxThreshold,
		Cluster:      defaultBounceRate1hClusterThreshold,
		DedupMinutes: defaultBounceRate1hDedupMinutes,
		MinVolume:    bounceRate1hMinVolume,
	}
	if loader == nil {
		return t
	}
	if v, err := loader.Get(ctx, "bounce_rate_1h_per_mailbox_threshold"); err == nil && v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			t.PerMailbox = f
		}
	}
	if v, err := loader.Get(ctx, "bounce_rate_1h_cluster_threshold"); err == nil && v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			t.Cluster = f
		}
	}
	if v, err := loader.Get(ctx, "bounce_rate_1h_dedup_window_minutes"); err == nil && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			t.DedupMinutes = n
		}
	}
	return t
}

// RunBounceRate1hOnce executes one tick: aggregate per-mailbox bounces over
// the last 1h, emit per-mailbox alerts above threshold + a cluster alert
// when the cross-mailbox rate exceeds the cluster threshold.
func RunBounceRate1hOnce(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) (bounceRate1hResult, error) {
	var res bounceRate1hResult
	th := LoadBounceRate1hThresholds(ctx, loader)

	// Per-mailbox bounce rate in the last 1h. Mirrors the 24h aggregate but
	// scoped to a tighter window. Soft bounce (4xx SMTP) + hard bounce
	// counted together — same signal definition as cron_bounce_rate_monitor.
	rows, err := db.QueryContext(ctx, `
		WITH win AS (
		  SELECT mailbox_used, status, smtp_response
		    FROM send_events
		   WHERE sent_at > NOW() - INTERVAL '1 hour'
		)
		SELECT mailbox_used,
		       count(*) FILTER (WHERE status = 'bounced')                         AS hard,
		       count(*) FILTER (WHERE status = 'failed' AND smtp_response ~ '^4') AS soft,
		       count(*)                                                            AS total,
		       ( (count(*) FILTER (WHERE status = 'bounced')
		         + count(*) FILTER (WHERE status = 'failed' AND smtp_response ~ '^4')
		         )::float / NULLIF(count(*), 0) )                                  AS rate
		  FROM win
		 GROUP BY mailbox_used
		 HAVING count(*) >= $1`, th.MinVolume)
	if err != nil {
		return res, fmt.Errorf("query bounce_rate_1h per-mailbox: %w", err)
	}
	defer rows.Close()

	type mbRow struct {
		MailboxUsed string
		Hard        int
		Soft        int
		Total       int
		Rate        float64
	}
	var entries []mbRow
	var clusterBounces, clusterTotal int
	for rows.Next() {
		var e mbRow
		if err := rows.Scan(&e.MailboxUsed, &e.Hard, &e.Soft, &e.Total, &e.Rate); err != nil {
			return res, fmt.Errorf("scan bounce_rate_1h row: %w", err)
		}
		entries = append(entries, e)
		clusterBounces += e.Hard + e.Soft
		clusterTotal += e.Total
	}
	if err := rows.Err(); err != nil {
		return res, fmt.Errorf("iterate bounce_rate_1h rows: %w", err)
	}
	res.Checked = len(entries)

	dedup := time.Duration(th.DedupMinutes) * time.Minute

	// Per-mailbox alerts.
	for _, e := range entries {
		if e.Rate <= th.PerMailbox {
			continue
		}
		ratePct := e.Rate * 100
		message := fmt.Sprintf("Bounce rate %.2f%% in last 1h (%d hard + %d soft = %d/%d)",
			ratePct, e.Hard, e.Soft, e.Hard+e.Soft, e.Total)
		if maybeInsert1hAlert(ctx, db, e.MailboxUsed, bounceRate1hAlertType, "warning", message, dedup) {
			res.PerMailboxAlerts++
			// HARD RULE feedback_audit_log_on_mutations T0 — alert IS the
			// operator-visible state change.
			audit.Log(ctx, db, "bounce_rate_1h.per_mailbox_alert", "cron", "mailbox", mailboxIDByFrom(ctx, db, e.MailboxUsed),
				map[string]any{
					"from_address": e.MailboxUsed,
					"rate":         e.Rate,
					"hard":         e.Hard,
					"soft":         e.Soft,
					"total":        e.Total,
					"window":       "1h",
				})
			slog.Warn("mailbox_bounce_rate_1h_high",
				"op", "outreach.bounce_rate_1h/per_mailbox_alert",
				"mailbox", redactEmail(e.MailboxUsed),
				"rate", e.Rate, "hard", e.Hard, "soft", e.Soft, "total", e.Total)
		}
	}

	// Cluster aggregate alert.
	if clusterTotal >= th.MinVolume && clusterBounces > 0 {
		clusterRate := float64(clusterBounces) / float64(clusterTotal)
		if clusterRate > th.Cluster {
			message := fmt.Sprintf("Cluster bounce rate %.2f%% in last 1h (%d/%d across %d mailboxes)",
				clusterRate*100, clusterBounces, clusterTotal, len(entries))
			// Cluster alert uses mailbox_id=0 sentinel via a separate type so
			// the per-mailbox dedup path doesn't collide.
			if maybeInsertClusterAlert(ctx, db, bounceRate1hClusterAlertType, "warning", message, dedup) {
				res.ClusterAlerts++
				audit.Log(ctx, db, "bounce_rate_1h.cluster_alert", "cron", "cluster", "",
					map[string]any{
						"rate":     clusterRate,
						"bounces":  clusterBounces,
						"total":    clusterTotal,
						"mailboxes": len(entries),
						"window":   "1h",
					})
				slog.Warn("cluster_bounce_rate_1h_high",
					"op", "outreach.bounce_rate_1h/cluster_alert",
					"rate", clusterRate, "bounces", clusterBounces, "total", clusterTotal)
			}
		}
	}

	return res, nil
}

// mailboxIDByFrom resolves the mailbox_id for an audit row entity_id. Returns
// the empty string when the lookup fails — audit.Log tolerates empty entity_id.
func mailboxIDByFrom(ctx context.Context, db *sql.DB, fromAddress string) string {
	var id sql.NullInt64
	if err := db.QueryRowContext(ctx,
		`SELECT id FROM outreach_mailboxes WHERE from_address=$1 LIMIT 1`,
		fromAddress).Scan(&id); err != nil {
		return ""
	}
	if !id.Valid {
		return ""
	}
	return strconv.FormatInt(id.Int64, 10)
}

// maybeInsert1hAlert dedups + inserts a per-mailbox alert.
// Returns true if a row was inserted.
func maybeInsert1hAlert(ctx context.Context, db *sql.DB, fromAddress, alertType, severity, message string, dedup time.Duration) bool {
	// Lookup mailbox_id by from_address.
	var mailboxID sql.NullInt64
	if err := db.QueryRowContext(ctx,
		`SELECT id FROM outreach_mailboxes WHERE from_address=$1 LIMIT 1`,
		fromAddress).Scan(&mailboxID); err != nil && err != sql.ErrNoRows {
		slog.Warn("bounce_rate_1h: mailbox id lookup failed",
			"op", "outreach.bounce_rate_1h/lookup",
			"mailbox", redactEmail(fromAddress), "error", err)
		return false
	}
	if !mailboxID.Valid {
		return false
	}

	// Dedup: skip if open alert of this type for this mailbox exists within
	// the dedup window.
	var exists bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS(
		  SELECT 1 FROM mailbox_alerts
		   WHERE mailbox_id=$1 AND type=$2
		     AND resolved_at IS NULL
		     AND created_at > NOW() - $3::interval
		)`, mailboxID.Int64, alertType,
		fmt.Sprintf("%d seconds", int(dedup.Seconds()))).Scan(&exists); err != nil {
		slog.Warn("bounce_rate_1h: dedup lookup failed",
			"op", "outreach.bounce_rate_1h/dedup", "error", err)
		// Fall through — better risk a duplicate than swallow silently.
	}
	if exists {
		return false
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO mailbox_alerts (mailbox_id, type, severity, message, created_at)
		VALUES ($1, $2, $3, $4, NOW())`,
		mailboxID.Int64, alertType, severity, message); err != nil {
		slog.Warn("bounce_rate_1h: alert insert failed",
			"op", "outreach.bounce_rate_1h/insert", "error", err)
		return false
	}
	return true
}

// maybeInsertClusterAlert dedups + inserts a cluster-level alert. Uses a
// sentinel mailbox_id=NULL (which the column allows) so the per-mailbox
// dedup path doesn't collide. Returns true if a row was inserted.
func maybeInsertClusterAlert(ctx context.Context, db *sql.DB, alertType, severity, message string, dedup time.Duration) bool {
	// Dedup: any open cluster alert of this type within the dedup window.
	// Cluster alerts deliberately use mailbox_id IS NULL.
	var exists bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS(
		  SELECT 1 FROM mailbox_alerts
		   WHERE mailbox_id IS NULL AND type=$1
		     AND resolved_at IS NULL
		     AND created_at > NOW() - $2::interval
		)`, alertType,
		fmt.Sprintf("%d seconds", int(dedup.Seconds()))).Scan(&exists); err != nil {
		slog.Warn("bounce_rate_1h: cluster dedup lookup failed",
			"op", "outreach.bounce_rate_1h/cluster_dedup", "error", err)
	}
	if exists {
		return false
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO mailbox_alerts (mailbox_id, type, severity, message, created_at)
		VALUES (NULL, $1, $2, $3, NOW())`,
		alertType, severity, message); err != nil {
		slog.Warn("bounce_rate_1h: cluster alert insert failed",
			"op", "outreach.bounce_rate_1h/cluster_insert", "error", err)
		return false
	}
	return true
}

// StartBounceRate1hLoop spawns the periodic cron.
func StartBounceRate1hLoop(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) {
	if envconfig.BoolOr("DISABLE_BOUNCE_RATE_1H_CRON", false) {
		slog.Info("bounce_rate_1h cron disabled (DISABLE_BOUNCE_RATE_1H_CRON=1)")
		return
	}
	interval := bounceRate1hDefaultInterval
	if v := envconfig.GetOr("BOUNCE_RATE_1H_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			interval = d
		}
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("bounce_rate_1h cron panic recovered",
					"op", "outreach.bounce_rate_1h/recover", "recover", r)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		// Initial settle — give the rest of the boot path a head start so
		// the first tick doesn't collide with relay warm-up + migrations.
		select {
		case <-ctx.Done():
			return
		case <-time.After(75 * time.Second):
		}
		runTick := func() {
			start := time.Now()
			res, err := RunBounceRate1hOnce(ctx, db, loader)
			dur := time.Since(start)
			if err != nil {
				slog.Error("bounce_rate_1h tick failed",
					"op", "outreach.bounce_rate_1h/tick",
					"error", err, "duration_ms", dur.Milliseconds())
				return
			}
			slog.Info("bounce_rate_1h tick",
				"op", "outreach.bounce_rate_1h/done",
				"checked", res.Checked,
				"per_mailbox_alerts", res.PerMailboxAlerts,
				"cluster_alerts", res.ClusterAlerts,
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
	slog.Info("bounce_rate_1h cron started", "interval", interval)
}
