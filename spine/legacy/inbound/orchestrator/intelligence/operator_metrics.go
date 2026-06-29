// Package intelligence — operator_metrics.go
//
// OperatorMetrics aggregates the metrics an operator needs to assess platform
// health at a glance. The collector runs hourly alongside the main intelligence
// loop and writes its output to a stable in-memory snapshot exposed via
// Snapshot(). The BFF calls Snapshot() to serve GET /api/operator/metrics.
//
// Metrics covered:
//   - Campaign-level: sent_24h, bounce_rate_24h, reply_rate_24h,
//     current_step_distribution
//   - Mailbox-level:  last_score, send_count_today, circuit_state
//   - Operator-level: classifier_overrides_today, training_set_size,
//     accuracy_rolling_7d
//
// Prometheus gauges are also emitted so /metrics picks them up without a
// separate scrape target.
package intelligence

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"common/metrics"
	"common/telemetry"
)

// CampaignMetrics holds per-campaign operator-facing stats.
type CampaignMetrics struct {
	ID                      int64          `json:"id"`
	Name                    string         `json:"name"`
	Status                  string         `json:"status"`
	Sent24h                 int            `json:"sent_24h"`
	BounceRate24h           float64        `json:"bounce_rate_24h"`
	ReplyRate24h            float64        `json:"reply_rate_24h"`
	CurrentStepDistribution map[string]int `json:"current_step_distribution"`
}

// MailboxMetricsRow holds per-mailbox operator-facing stats.
type MailboxMetricsRow struct {
	Address        string `json:"address"`
	LastScore      int    `json:"last_score"`
	SendCountToday int    `json:"send_count_today"`
	// CircuitState is "closed" for healthy mailboxes and "open" for
	// mailboxes in bounce_hold status.
	CircuitState string `json:"circuit_state"`
	Status       string `json:"status"`
}

// OperatorMetricsSnapshot is the stable JSON shape served by
// GET /api/operator/metrics. Fields must remain backward-compatible
// across deploys; add fields only, never remove or rename.
type OperatorMetricsSnapshot struct {
	GeneratedAt              string              `json:"generated_at"`
	Campaigns                []CampaignMetrics   `json:"campaigns"`
	Mailboxes                []MailboxMetricsRow `json:"mailboxes"`
	ClassifierOverridesToday int                 `json:"classifier_overrides_today"`
	TrainingSetSize          int                 `json:"training_set_size"`
	AccuracyRolling7d        float64             `json:"accuracy_rolling_7d"`
}

// Prometheus gauges for operator metrics (registered once at package init).
var (
	opMetricsCampaignSent24h = metrics.NewLabeledGauge(
		"outreach_operator_campaign_sent_24h",
		"Emails sent in the last 24h per campaign",
		"campaign_id", "campaign_name")

	opMetricsCampaignBounceRate24h = metrics.NewLabeledGauge(
		"outreach_operator_campaign_bounce_rate_24h",
		"Bounce rate (0–1) in the last 24h per campaign",
		"campaign_id", "campaign_name")

	opMetricsCampaignReplyRate24h = metrics.NewLabeledGauge(
		"outreach_operator_campaign_reply_rate_24h",
		"Reply rate (0–1) in the last 24h per campaign",
		"campaign_id", "campaign_name")

	opMetricsMailboxScore = metrics.NewLabeledGauge(
		"outreach_operator_mailbox_last_score",
		"Most recent SMTP probe score (0–100) per mailbox",
		"address")

	opMetricsMailboxSendToday = metrics.NewLabeledGauge(
		"outreach_operator_mailbox_send_count_today",
		"Emails sent today per mailbox",
		"address")

	opMetricsClassifierOverrides = metrics.NewGauge(
		"outreach_operator_classifier_overrides_today",
		"Operator reply-classifier overrides in the last 24h")

	opMetricsTrainingSetSize = metrics.NewGauge(
		"outreach_operator_training_set_size",
		"Total rows in operator_audit_log with action=reply_classify_override")

	opMetricsAccuracy7d = metrics.NewGauge(
		"outreach_operator_accuracy_rolling_7d",
		"Fraction of LLM classifications accepted (not overridden) over last 7 days (0–1)")
)

// snapshotMu guards the current cached snapshot so concurrent HTTP reads
// never observe a half-written struct.
var (
	snapshotMu      sync.RWMutex
	currentSnapshot *OperatorMetricsSnapshot
)

// Snapshot returns the most recent operator metrics snapshot. Returns nil
// before the first successful Collect call. Callers should treat nil as
// "metrics not yet available" and respond with HTTP 503.
func Snapshot() *OperatorMetricsSnapshot {
	snapshotMu.RLock()
	defer snapshotMu.RUnlock()
	return currentSnapshot
}

// Collect runs one operator metrics export cycle.
// It queries the DB, updates Prometheus gauges, emits a Sentry breadcrumb,
// and stores the result so Snapshot() can serve it.
//
// Errors from individual sub-queries are logged and skipped; the snapshot is
// still published with whatever data was gathered so a single broken query
// does not blank the entire dashboard view.
func Collect(ctx context.Context, db *sql.DB) *OperatorMetricsSnapshot {
	snap := &OperatorMetricsSnapshot{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
	}

	snap.Campaigns = collectCampaignMetrics(ctx, db)
	snap.Mailboxes = collectMailboxMetrics(ctx, db)
	snap.ClassifierOverridesToday,
		snap.TrainingSetSize,
		snap.AccuracyRolling7d = collectOperatorStats(ctx, db)

	// Update Prometheus gauges.
	for _, c := range snap.Campaigns {
		id := fmt.Sprintf("%d", c.ID)
		opMetricsCampaignSent24h.Set(float64(c.Sent24h), id, c.Name)
		opMetricsCampaignBounceRate24h.Set(c.BounceRate24h, id, c.Name)
		opMetricsCampaignReplyRate24h.Set(c.ReplyRate24h, id, c.Name)
	}
	for _, m := range snap.Mailboxes {
		opMetricsMailboxScore.Set(float64(m.LastScore), m.Address)
		opMetricsMailboxSendToday.Set(float64(m.SendCountToday), m.Address)
	}
	opMetricsClassifierOverrides.Set(float64(snap.ClassifierOverridesToday))
	opMetricsTrainingSetSize.Set(float64(snap.TrainingSetSize))
	opMetricsAccuracy7d.Set(snap.AccuracyRolling7d)

	// Emit Sentry breadcrumb per export so issues can correlate to the tick.
	telemetry.Breadcrumb("operator-metrics", "operator metrics collected", map[string]interface{}{
		"campaigns":                  len(snap.Campaigns),
		"mailboxes":                  len(snap.Mailboxes),
		"classifier_overrides_today": snap.ClassifierOverridesToday,
		"training_set_size":          snap.TrainingSetSize,
		"accuracy_rolling_7d":        snap.AccuracyRolling7d,
	})

	snapshotMu.Lock()
	currentSnapshot = snap
	snapshotMu.Unlock()

	slog.Info("operator metrics collected",
		"op", "Collect/done",
		"campaigns", len(snap.Campaigns),
		"mailboxes", len(snap.Mailboxes),
		"overrides_today", snap.ClassifierOverridesToday,
		"accuracy_7d", snap.AccuracyRolling7d)

	return snap
}

// RunMetricsDaemon starts a daemon that calls Collect every interval.
// It runs one immediate collection on start, then waits for the ticker.
// Stops cleanly on ctx cancel and returns ctx.Err().
func RunMetricsDaemon(ctx context.Context, db *sql.DB, interval time.Duration) error {
	slog.Info("operator metrics daemon started",
		"op", "RunMetricsDaemon/start",
		"interval", interval)

	Collect(ctx, db)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("operator metrics daemon stopped",
				"op", "RunMetricsDaemon/stop")
			return ctx.Err()
		case <-ticker.C:
			Collect(ctx, db)
		}
	}
}

// MarshalSnapshot returns the current snapshot as indented JSON.
func MarshalSnapshot(snap *OperatorMetricsSnapshot) ([]byte, error) {
	return json.MarshalIndent(snap, "", "  ")
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

func collectCampaignMetrics(ctx context.Context, db *sql.DB) []CampaignMetrics {
	// send_events and tracking_events are independent children of a campaign;
	// LEFT JOINing both off c at once produces an S×T cartesian fan-out that
	// multiplies every COUNT (and the bounce/reply rates derived from them).
	// Aggregate each table in its own subquery first, then join the
	// pre-aggregated, campaign-keyed rollups 1:1 so the counts are exact.
	const q = `
		SELECT
			c.id,
			c.name,
			c.status,
			COALESCE(s.sent_24h, 0)    AS sent_24h,
			COALESCE(s.bounced_24h, 0) AS bounced_24h,
			COALESCE(t.replied_24h, 0) AS replied_24h
		FROM outreach_campaigns c
		LEFT JOIN (
			SELECT se.campaign_id,
			       COUNT(se.id) FILTER (WHERE se.sent_at > now() - interval '24h') AS sent_24h,
			       COUNT(be.id) FILTER (WHERE be.created_at > now() - interval '24h') AS bounced_24h
			FROM send_events se
			LEFT JOIN bounce_events be ON be.send_event_id = se.id
			GROUP BY se.campaign_id
		) s ON s.campaign_id = c.id
		LEFT JOIN (
			SELECT te.campaign_id,
			       COUNT(te.id) FILTER (WHERE te.created_at > now() - interval '24h'
			                              AND te.event_type = 'replied') AS replied_24h
			FROM tracking_events te
			GROUP BY te.campaign_id
		) t ON t.campaign_id = c.id
		WHERE c.status IN ('running', 'paused')
		ORDER BY sent_24h DESC
	`
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		slog.Warn("operator metrics: campaign query failed",
			"op", "collectCampaignMetrics/query",
			"error", err)
		return nil
	}
	defer rows.Close()

	result := make([]CampaignMetrics, 0)
	for rows.Next() {
		var cm CampaignMetrics
		var sent24h, bounced24h, replied24h int
		if err := rows.Scan(&cm.ID, &cm.Name, &cm.Status, &sent24h, &bounced24h, &replied24h); err != nil {
			slog.Warn("operator metrics: campaign row scan failed",
				"op", "collectCampaignMetrics/scan",
				"error", err)
			continue
		}
		cm.Sent24h = sent24h
		if sent24h > 0 {
			cm.BounceRate24h = float64(bounced24h) / float64(sent24h)
			cm.ReplyRate24h = float64(replied24h) / float64(sent24h)
		}
		cm.CurrentStepDistribution = collectStepDistribution(ctx, db, cm.ID)
		result = append(result, cm)
	}
	return result
}

func collectStepDistribution(ctx context.Context, db *sql.DB, campaignID int64) map[string]int {
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(current_step, 'unknown'), COUNT(*)
		FROM outreach_contacts
		WHERE campaign_id = $1
		GROUP BY current_step
	`, campaignID)
	if err != nil {
		// Non-fatal: step distribution is best-effort.
		return map[string]int{}
	}
	defer rows.Close()

	dist := map[string]int{}
	for rows.Next() {
		var step string
		var count int
		if err := rows.Scan(&step, &count); err == nil {
			dist[step] = count
		}
	}
	return dist
}

func collectMailboxMetrics(ctx context.Context, db *sql.DB) []MailboxMetricsRow {
	const q = `
		SELECT
			m.from_address,
			COALESCE(m.last_score, 0) AS last_score,
			COUNT(se.id) FILTER (WHERE se.sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS send_count_today,
			m.status
		FROM outreach_mailboxes m
		LEFT JOIN send_events se ON se.mailbox_address = m.from_address
		WHERE m.environment = 'production'
		GROUP BY m.from_address, m.last_score, m.status
		ORDER BY m.from_address
	`
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		slog.Warn("operator metrics: mailbox query failed",
			"op", "collectMailboxMetrics/query",
			"error", err)
		return nil
	}
	defer rows.Close()

	result := make([]MailboxMetricsRow, 0)
	for rows.Next() {
		var mr MailboxMetricsRow
		if err := rows.Scan(&mr.Address, &mr.LastScore, &mr.SendCountToday, &mr.Status); err != nil {
			slog.Warn("operator metrics: mailbox row scan failed",
				"op", "collectMailboxMetrics/scan",
				"error", err)
			continue
		}
		mr.CircuitState = "closed"
		if mr.Status == "bounce_hold" {
			mr.CircuitState = "open"
		}
		result = append(result, mr)
	}
	return result
}

// collectOperatorStats returns (overridesToday, trainingSetSize, accuracy7d).
// Each value is derived from a separate query; a failing query leaves its
// return value at the zero value so partial data is still returned.
func collectOperatorStats(ctx context.Context, db *sql.DB) (overridesToday, trainingSize int, accuracy7d float64) {
	// Classifier overrides today.
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM operator_audit_log
		WHERE created_at > now() - interval '24h'
		  AND action = 'reply_classify_override'
	`).Scan(&overridesToday); err != nil {
		slog.Warn("operator metrics: overrides_today query failed",
			"op", "collectOperatorStats/overrides",
			"error", err)
	}

	// Total training set size (all-time override rows).
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM operator_audit_log
		WHERE action = 'reply_classify_override'
	`).Scan(&trainingSize); err != nil {
		slog.Warn("operator metrics: training_set_size query failed",
			"op", "collectOperatorStats/training_set",
			"error", err)
	}

	// Rolling 7d accuracy: accepted / classified, where accepted = classified - overridden.
	// Division-by-zero is guarded: if classified = 0 we return 0.0 as a sentinel
	// meaning "no data" rather than "100% accurate".
	var classified, overridden7d int
	if err := db.QueryRowContext(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE classified_at > now() - interval '7 days') AS classified,
			COUNT(*) FILTER (WHERE classified_at > now() - interval '7 days'
			                   AND override_at IS NOT NULL) AS overridden
		FROM outreach_threads
		WHERE classified_at IS NOT NULL
	`).Scan(&classified, &overridden7d); err != nil {
		slog.Warn("operator metrics: accuracy_rolling_7d query failed",
			"op", "collectOperatorStats/accuracy",
			"error", err)
		return overridesToday, trainingSize, 0
	}
	if classified > 0 {
		accepted := classified - overridden7d
		accuracy7d = float64(accepted) / float64(classified)
	}
	return overridesToday, trainingSize, accuracy7d
}
