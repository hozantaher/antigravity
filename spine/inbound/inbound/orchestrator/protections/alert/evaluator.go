// Package alert evaluates probe results from protection_probes and
// opens/resolves/escalates rows in protection_alerts (migration 043).
//
// Escalation rules:
//
//	L2 (alive): first err → immediate critical alert.
//	L3 (correct): 3 consecutive err → warning alert. If the alert has
//	              been open > 2h without a green result → critical.
//
// Auto-resolve: when the last 3 results for a (layer, level) are all
// ok or skip, any open/acked alert for that pair is closed.
//
// The Evaluator is designed to be called from the probe Sink (after
// each Write) or from a standalone ticker. It is idempotent: duplicate
// calls with the same state are safe and produce no duplicate rows.
package alert

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

const (
	// L2 thresholds: alert immediately on first err.
	l2AlertThreshold = 1

	// L3 thresholds: 3 consecutive err before alerting.
	l3AlertThreshold = 3

	// escalateToCritical: promote a warning to critical when it has been
	// open for more than this duration without a green result.
	escalateToCritical = 2 * time.Hour

	// resolveAfterOK: auto-resolve when this many consecutive results are ok/skip.
	resolveAfterOK = 3
)

// Evaluator checks probe history and manages the protection_alerts table.
type Evaluator struct {
	DB *sql.DB
}

// New returns an Evaluator backed by db.
func New(db *sql.DB) *Evaluator { return &Evaluator{DB: db} }

// EvaluateLayer runs the alert/resolve logic for one (layer, level) pair.
// It reads the last max(l3AlertThreshold, resolveAfterOK) rows from
// protection_probes and updates protection_alerts accordingly.
func (e *Evaluator) EvaluateLayer(ctx context.Context, layer string, level int) error {
	if e.DB == nil {
		return nil
	}

	// Fetch the last N recent probe results (enough to cover both thresholds).
	limit := l3AlertThreshold
	if resolveAfterOK > limit {
		limit = resolveAfterOK
	}

	rows, err := e.DB.QueryContext(ctx, `
		SELECT status, checked_at
		  FROM protection_probes
		 WHERE layer = $1 AND level = $2
		 ORDER BY checked_at DESC
		 LIMIT $3`, layer, level, limit)
	if err != nil {
		return fmt.Errorf("alert: query probes: %w", err)
	}
	defer rows.Close()

	type row struct {
		status    string
		checkedAt time.Time
	}
	var recent []row
	for rows.Next() {
		var r row
		// NULL-safe scan: legacy/partial protection_probes rows can have a NULL
		// checked_at, and scanning NULL into time.Time fails — that error was
		// logged but swallowed, silently blinding the whole protection alert
		// layer (RCA 2026-06-01). checked_at only drives ORDER BY in the query.
		var checkedAt sql.NullTime
		if err := rows.Scan(&r.status, &checkedAt); err != nil {
			return fmt.Errorf("alert: scan probes: %w", err)
		}
		r.checkedAt = checkedAt.Time
		recent = append(recent, r)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("alert: iterate probes: %w", err)
	}
	if len(recent) == 0 {
		return nil
	}

	// Derive consecutive-error count and consecutive-green count from the
	// front of the slice (most recent first).
	consecutiveErr := 0
	for _, r := range recent {
		if r.status == "err" {
			consecutiveErr++
		} else {
			break
		}
	}
	consecutiveOK := 0
	for _, r := range recent {
		if r.status == "ok" || r.status == "skip" {
			consecutiveOK++
		} else {
			break
		}
	}

	// --- Auto-resolve ---
	if consecutiveOK >= resolveAfterOK {
		_, err = e.DB.ExecContext(ctx, `
			UPDATE protection_alerts
			   SET status = 'resolved', resolved_at = now(), updated_at = now()
			 WHERE layer = $1 AND level = $2 AND status IN ('open', 'acked')
			   AND resolved_at IS NULL`, layer, level)
		return err
	}

	// --- Escalate existing warning to critical if old enough ---
	_, err = e.DB.ExecContext(ctx, `
		UPDATE protection_alerts
		   SET severity = 'critical', updated_at = now()
		 WHERE layer = $1 AND level = $2 AND status IN ('open', 'acked')
		   AND severity = 'warning'
		   AND fired_at < now() - $3::interval
		   AND resolved_at IS NULL`,
		layer, level, escalateToCritical.String())
	if err != nil {
		return fmt.Errorf("alert: escalate: %w", err)
	}

	// --- Open or update alert ---
	threshold := l3AlertThreshold
	severity := "warning"
	if level == 2 { // L2: immediate critical
		threshold = l2AlertThreshold
		severity = "critical"
	}

	if consecutiveErr < threshold {
		return nil
	}

	lastDetail := recent[0].status
	_, err = e.DB.ExecContext(ctx, `
		INSERT INTO protection_alerts
		       (layer, level, severity, status, consecutive_failures, last_status, detail, fired_at)
		VALUES ($1, $2, $3, 'open', $4, $5, $6, now())
		ON CONFLICT ON CONSTRAINT protection_alerts_layer_level_open_unique
		DO UPDATE SET
		    consecutive_failures = EXCLUDED.consecutive_failures,
		    last_status          = EXCLUDED.last_status,
		    detail               = EXCLUDED.detail,
		    updated_at           = now()`,
		layer, level, severity, consecutiveErr, lastDetail,
		fmt.Sprintf("%d consecutive %s", consecutiveErr, lastDetail))
	if err != nil {
		return fmt.Errorf("alert: upsert: %w", err)
	}
	return nil
}
