package mailbox

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"
)

// AdaptiveReleaseConfig controls the smart bounce_hold release behaviour.
//
// The original intelligence loop released every bounce_hold mailbox after a
// fixed 7-day window. For low-volume mailboxes (e.g. 30 sends/day) a 5-bounce
// hit from one bad campaign meant a week of downtime — disproportionate to
// the infraction. With AdaptiveEnable set, a mailbox whose 7-day send volume
// is below LowVolumeThreshold is eligible for release after FastWindow
// instead of StandardWindow. On release, the mailbox enters "canary" mode:
// the next CanaryCount sends are marked (enforcement lives in the sender,
// see follow-up).
type AdaptiveReleaseConfig struct {
	AdaptiveEnable     bool          // if false, only StandardWindow applies
	StandardWindow     time.Duration // default 7 * 24h
	FastWindow         time.Duration // default 72h — used when sent_7d < LowVolumeThreshold
	LowVolumeThreshold int           // default 50 — sends over last 7 days below this = low-volume
	CanaryCount        int           // default 10 — canary sends after release
}

// Defaults returns a config with sensible defaults for production.
func (c AdaptiveReleaseConfig) WithDefaults() AdaptiveReleaseConfig {
	if c.StandardWindow <= 0 {
		c.StandardWindow = 7 * 24 * time.Hour
	}
	if c.FastWindow <= 0 {
		c.FastWindow = 72 * time.Hour
	}
	if c.LowVolumeThreshold <= 0 {
		c.LowVolumeThreshold = 50
	}
	if c.CanaryCount <= 0 {
		c.CanaryCount = 10
	}
	return c
}

// ReleaseCandidate is one mailbox currently in bounce_hold that may be
// eligible for release under the active window rules.
type ReleaseCandidate struct {
	ID                  int64
	FromAddress         string
	ConsecutiveBounces  int
	Sent7d              int
	HeldHours           float64
	AdaptiveEligible    bool   // sent_7d < LowVolumeThreshold
	ReleaseReason       string // populated after ShouldRelease returns true
	ReleaseWindowHours  int    // 72 or 168, for audit log
}

// ShouldRelease reports whether this candidate is eligible to leave
// bounce_hold now, applying adaptive rules when enabled. Pure function —
// no DB access — so it can be unit-tested without fixtures.
func (c *ReleaseCandidate) ShouldRelease(cfg AdaptiveReleaseConfig) bool {
	cfg = cfg.WithDefaults()
	stdHours := cfg.StandardWindow.Hours()
	if c.HeldHours >= stdHours {
		c.ReleaseReason = fmt.Sprintf("standard_window_%.0fh", stdHours)
		c.ReleaseWindowHours = int(stdHours)
		return true
	}
	if cfg.AdaptiveEnable && c.AdaptiveEligible && c.HeldHours >= cfg.FastWindow.Hours() {
		c.ReleaseReason = fmt.Sprintf("adaptive_low_volume_%.0fh", cfg.FastWindow.Hours())
		c.ReleaseWindowHours = int(cfg.FastWindow.Hours())
		return true
	}
	return false
}

// CandidatesForRelease scans bounce_hold mailboxes and returns those eligible
// for release now, ranked by how long they've been held (oldest first).
func CandidatesForRelease(ctx context.Context, db *sql.DB, cfg AdaptiveReleaseConfig, now time.Time) ([]ReleaseCandidate, error) {
	if db == nil {
		return nil, fmt.Errorf("mailbox: CandidatesForRelease: nil DB")
	}
	cfg = cfg.WithDefaults()
	rows, err := db.QueryContext(ctx, `
		SELECT m.id, m.from_address, m.consecutive_bounces, m.updated_at,
		       COALESCE(counts.sent_7d, 0) AS sent_7d
		FROM outreach_mailboxes m
		LEFT JOIN (
		    SELECT mailbox_used,
		           COUNT(*) FILTER (WHERE sent_at > now() - interval '7 days')::int AS sent_7d
		    FROM send_events
		    GROUP BY mailbox_used
		) counts ON counts.mailbox_used = m.from_address
		WHERE m.status = 'bounce_hold'
	`)
	if err != nil {
		return nil, fmt.Errorf("mailbox: CandidatesForRelease query: %w", err)
	}
	defer rows.Close()

	var out []ReleaseCandidate
	for rows.Next() {
		var (
			c         ReleaseCandidate
			updatedAt time.Time
		)
		if err := rows.Scan(&c.ID, &c.FromAddress, &c.ConsecutiveBounces, &updatedAt, &c.Sent7d); err != nil {
			return nil, fmt.Errorf("mailbox: CandidatesForRelease scan: %w", err)
		}
		c.HeldHours = now.Sub(updatedAt).Hours()
		c.AdaptiveEligible = c.Sent7d < cfg.LowVolumeThreshold
		if c.ShouldRelease(cfg) {
			out = append(out, c)
		}
	}
	return out, rows.Err()
}

// ReleaseCandidateWithCanary applies a release: calls bp.ReleaseHold,
// records the cooldown log entry (closing any open one), and seeds canary
// state (canary_remaining = cfg.CanaryCount, released_at = now).
func ReleaseCandidateWithCanary(ctx context.Context, db *sql.DB, bp HoldReleaser, cfg AdaptiveReleaseConfig, c ReleaseCandidate) error {
	cfg = cfg.WithDefaults()
	if err := bp.ReleaseHold(ctx, c.FromAddress); err != nil {
		return fmt.Errorf("mailbox: release hold: %w", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE outreach_mailboxes
		SET canary_remaining = $2,
		    released_at      = now(),
		    last_canary_send = NULL
		WHERE id = $1
	`, c.ID, cfg.CanaryCount); err != nil {
		slog.Warn("mailbox: seed canary state failed", "id", c.ID, "error", err)
	}
	// Close any open cooldown log row and insert a fresh left_at record.
	if _, err := db.ExecContext(ctx, `
		UPDATE mailbox_cooldown_log
		SET left_at = now(), release_reason = $2, release_window_hours = $3
		WHERE mailbox_id = $1 AND left_at IS NULL
	`, c.ID, c.ReleaseReason, c.ReleaseWindowHours); err != nil {
		slog.Warn("mailbox: close cooldown log failed", "id", c.ID, "error", err)
	}
	return nil
}

// RecordCooldownEntry inserts a new cooldown log row when a mailbox enters
// bounce_hold. Called from the backpressure auto-hold path.
func RecordCooldownEntry(ctx context.Context, db *sql.DB, mailboxID int64, bounces, sent7d int) error {
	if db == nil {
		return nil
	}
	_, err := db.ExecContext(ctx, `
		INSERT INTO mailbox_cooldown_log (mailbox_id, bounces_at_entry, sent_7d_at_entry)
		VALUES ($1, $2, $3)
	`, mailboxID, bounces, sent7d)
	if err != nil {
		return fmt.Errorf("mailbox: record cooldown entry: %w", err)
	}
	return nil
}

// OnCanaryBounce handles a bounce while a mailbox is in canary mode: flips
// it back to bounce_hold and sets retired_candidate for operator review.
// Caller is responsible for detecting "is in canary" (canary_remaining > 0).
func OnCanaryBounce(ctx context.Context, db *sql.DB, bp Backpressure, mailboxID int64, fromAddress, reason string) error {
	if db == nil {
		return nil
	}
	// RecordBounce increments and may auto-hold; we mark retired_candidate
	// regardless so the operator sees this was a canary failure, not a fresh run.
	bp.RecordBounce(ctx, fromAddress, "canary_"+reason)
	_, err := db.ExecContext(ctx, `
		UPDATE outreach_mailboxes
		SET retired_candidate = TRUE,
		    canary_remaining  = 0
		WHERE id = $1
	`, mailboxID)
	if err != nil {
		return fmt.Errorf("mailbox: canary bounce update: %w", err)
	}
	return nil
}
