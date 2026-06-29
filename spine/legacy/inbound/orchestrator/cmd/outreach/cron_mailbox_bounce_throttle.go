// Z3-B: mailbox bounce throttle cron migrated from BFF
// (apps/outreach-dashboard/src/crons/runMailboxBounceThrottleCron.js wraps
// apps/outreach-dashboard/mailboxBounceThrottle.js).
//
// Logic mirrors evaluateBounceThrottleAction in apps/outreach-dashboard/src/lib/automation.js:
//
//   total_sent < minVolume                                  → noop
//   bounce_rate >= pauseRate OR consecutive >= consecutivePause → pause
//   bounce_rate >= throttleRate OR consecutive >= 3         → throttle daily cap to 50%
//
// Thresholds come from operator_settings (HARD RULE feedback_no_magic_thresholds T0):
//   bounce_rate_pause_threshold        (default 0.10  / pause when bounce_rate >= 10%)
//   bounce_rate_throttle_threshold     (default 0.05  / throttle when >= 5%)
//   consecutive_bounces_pause_threshold(default 5)
//   mailbox_min_volume_for_rate_check  (default 10)
//
// Both pause and throttle UPDATEs are race-safe via guard predicates (status='active'
// for pause; daily_cap_override > new_cap for throttle) — mirrors BFF BF-A4 hardening.

package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"time"

	"common/audit"
	"common/envconfig"
	"common/operatorconfig"
)

const (
	bounceThrottleDefaultInterval         = 30 * time.Minute
	bounceThrottleFloorCap                = 10
	bounceThrottleDefaultCap              = 90
	defaultBounceRatePauseThreshold       = 0.10
	defaultBounceRateThrottleThreshold    = 0.05
	defaultConsecutiveBouncesPauseThresh  = 5
	defaultMailboxMinVolumeForRateCheck   = 10
)

// bounceThrottleThresholds bundles operator-tunable knobs so call-sites stay tidy.
type bounceThrottleThresholds struct {
	PauseRate        float64
	ThrottleRate     float64
	ConsecutivePause int
	MinVolume        int
}

// LoadBounceThrottleThresholds reads operator_settings via the cached loader.
// Missing or unparseable values fall back to defaults — never panic.
func LoadBounceThrottleThresholds(ctx context.Context, loader *operatorconfig.Loader) bounceThrottleThresholds {
	t := bounceThrottleThresholds{
		PauseRate:        defaultBounceRatePauseThreshold,
		ThrottleRate:     defaultBounceRateThrottleThreshold,
		ConsecutivePause: defaultConsecutiveBouncesPauseThresh,
		MinVolume:        defaultMailboxMinVolumeForRateCheck,
	}
	if loader == nil {
		return t
	}
	if v, err := loader.Get(ctx, "bounce_rate_pause_threshold"); err == nil && v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			t.PauseRate = f
		}
	}
	if v, err := loader.Get(ctx, "bounce_rate_throttle_threshold"); err == nil && v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			t.ThrottleRate = f
		}
	}
	if v, err := loader.Get(ctx, "consecutive_bounces_pause_threshold"); err == nil && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			t.ConsecutivePause = n
		}
	}
	if v, err := loader.Get(ctx, "mailbox_min_volume_for_rate_check"); err == nil && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			t.MinVolume = n
		}
	}
	return t
}

// bounceThrottleDecision is the verdict computed for a single mailbox row.
type bounceThrottleDecision struct {
	Action string // "pause" | "throttle" | "at_floor" | "noop"
	NewCap int
	Reason string
}

// EvaluateBounceThrottle is the pure decision function (mirrors
// evaluateBounceThrottleAction from automation.js). It is exported for tests.
func EvaluateBounceThrottle(bounceRate float64, consecutive, totalSent, currentCap int, th bounceThrottleThresholds) bounceThrottleDecision {
	if totalSent < th.MinVolume {
		return bounceThrottleDecision{Action: "noop", Reason: fmt.Sprintf("total_sent %d < %d", totalSent, th.MinVolume)}
	}
	if bounceRate >= th.PauseRate*100 || consecutive >= th.ConsecutivePause {
		return bounceThrottleDecision{Action: "pause", Reason: fmt.Sprintf("bounce_rate %.1f%% / consecutive %d", bounceRate, consecutive)}
	}
	if bounceRate >= th.ThrottleRate*100 || consecutive >= 3 {
		cap := currentCap
		if cap <= 0 {
			cap = bounceThrottleDefaultCap
		}
		newCap := int(math.Max(float64(bounceThrottleFloorCap), math.Floor(float64(cap)*0.5)))
		if newCap >= cap {
			return bounceThrottleDecision{Action: "at_floor", NewCap: cap, Reason: fmt.Sprintf("cap %d at/below floor %d", cap, bounceThrottleFloorCap)}
		}
		return bounceThrottleDecision{Action: "throttle", NewCap: newCap, Reason: fmt.Sprintf("cap %d→%d (rate %.1f%% / cb %d)", cap, newCap, bounceRate, consecutive)}
	}
	return bounceThrottleDecision{Action: "noop", Reason: fmt.Sprintf("within thresholds (rate %.1f%% / cb %d)", bounceRate, consecutive)}
}

type bounceThrottleResult struct {
	Paused    int
	Throttled int
	AtFloor   int
}

// RunMailboxBounceThrottleOnce executes one tick across all production mailboxes.
func RunMailboxBounceThrottleOnce(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) (bounceThrottleResult, error) {
	var res bounceThrottleResult
	th := LoadBounceThrottleThresholds(ctx, loader)

	rows, err := db.QueryContext(ctx, `
		SELECT m.id, m.from_address, COALESCE(m.daily_cap_override, 0),
		       COALESCE(m.consecutive_bounces, 0), COALESCE(m.total_sent, 0),
		       CASE WHEN m.total_sent > 0
		            THEN m.total_bounced::float / m.total_sent * 100
		            ELSE 0 END AS bounce_rate_pct
		  FROM outreach_mailboxes m
		 WHERE m.status='active'
		   AND m.environment='production'
		   AND m.total_sent >= $1`, th.MinVolume)
	if err != nil {
		return res, fmt.Errorf("query mailboxes: %w", err)
	}
	defer rows.Close()

	type mbRow struct {
		ID                 int64
		FromAddress        string
		DailyCapOverride   int
		ConsecutiveBounces int
		TotalSent          int
		BounceRatePct      float64
	}
	var mbs []mbRow
	for rows.Next() {
		var r mbRow
		if err := rows.Scan(&r.ID, &r.FromAddress, &r.DailyCapOverride, &r.ConsecutiveBounces, &r.TotalSent, &r.BounceRatePct); err != nil {
			return res, fmt.Errorf("scan mailbox: %w", err)
		}
		mbs = append(mbs, r)
	}
	if err := rows.Err(); err != nil {
		return res, fmt.Errorf("iterate mailboxes: %w", err)
	}

	for _, mb := range mbs {
		decision := EvaluateBounceThrottle(mb.BounceRatePct, mb.ConsecutiveBounces, mb.TotalSent, mb.DailyCapOverride, th)
		switch decision.Action {
		case "pause":
			r, err := db.ExecContext(ctx, `
				UPDATE outreach_mailboxes
				   SET status='paused', status_reason=$2, updated_at=NOW()
				 WHERE id=$1 AND status='active'`, mb.ID, "auto: bounce rate critical")
			if err != nil {
				slog.Warn("bounce_throttle: pause failed",
					"op", "outreach.bounce_throttle/pause", "mailbox_id", mb.ID, "error", err)
				continue
			}
			n, _ := r.RowsAffected()
			if n > 0 {
				res.Paused++
				// HARD RULE feedback_audit_log_on_mutations T0
				audit.Log(ctx, db, "mailbox_bounce_throttle.pause", "cron", "mailbox", strconv.FormatInt(mb.ID, 10),
					map[string]any{
						"reason":              decision.Reason,
						"bounce_rate_pct":     mb.BounceRatePct,
						"consecutive_bounces": mb.ConsecutiveBounces,
					})
				slog.Info("bounce_throttle: paused", "mailbox_id", mb.ID, "reason", decision.Reason)
			}
		case "throttle":
			r, err := db.ExecContext(ctx, `
				UPDATE outreach_mailboxes
				   SET daily_cap_override=$1, updated_at=NOW()
				 WHERE id=$2 AND COALESCE(daily_cap_override, 0) > $1`, decision.NewCap, mb.ID)
			if err != nil {
				slog.Warn("bounce_throttle: throttle failed",
					"op", "outreach.bounce_throttle/throttle", "mailbox_id", mb.ID, "error", err)
				continue
			}
			n, _ := r.RowsAffected()
			if n > 0 {
				res.Throttled++
				audit.Log(ctx, db, "mailbox_bounce_throttle.throttle", "cron", "mailbox", strconv.FormatInt(mb.ID, 10),
					map[string]any{
						"reason":              decision.Reason,
						"new_daily_cap":       decision.NewCap,
						"bounce_rate_pct":     mb.BounceRatePct,
						"consecutive_bounces": mb.ConsecutiveBounces,
					})
				slog.Info("bounce_throttle: throttled", "mailbox_id", mb.ID, "new_cap", decision.NewCap, "reason", decision.Reason)
			}
		case "at_floor":
			res.AtFloor++
		}
	}
	return res, nil
}

// StartMailboxBounceThrottleLoop spawns the periodic cron.
func StartMailboxBounceThrottleLoop(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) {
	if envconfig.BoolOr("DISABLE_MAILBOX_BOUNCE_THROTTLE_CRON", false) {
		slog.Info("mailbox_bounce_throttle cron disabled (DISABLE_MAILBOX_BOUNCE_THROTTLE_CRON=1)")
		return
	}
	interval := bounceThrottleDefaultInterval
	if v := envconfig.GetOr("MAILBOX_BOUNCE_THROTTLE_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			interval = d
		}
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("mailbox_bounce_throttle cron panic recovered",
					"op", "outreach.bounce_throttle/recover", "recover", r)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		select {
		case <-ctx.Done():
			return
		case <-time.After(45 * time.Second):
		}
		runTick := func() {
			start := time.Now()
			res, err := RunMailboxBounceThrottleOnce(ctx, db, loader)
			dur := time.Since(start)
			if err != nil {
				slog.Error("mailbox_bounce_throttle tick failed",
					"op", "outreach.bounce_throttle/tick",
					"error", err, "duration_ms", dur.Milliseconds())
				return
			}
			slog.Info("mailbox_bounce_throttle tick",
				"op", "outreach.bounce_throttle/done",
				"paused", res.Paused, "throttled", res.Throttled, "at_floor", res.AtFloor,
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
	slog.Info("mailbox_bounce_throttle cron started", "interval", interval)
}
