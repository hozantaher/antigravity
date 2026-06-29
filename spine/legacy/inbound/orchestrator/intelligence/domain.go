package intelligence

import (
	"context"
	"database/sql"
	"log/slog"
)

// DomainHealthConfig holds tunable thresholds for CheckDomainHealthWithConfig.
type DomainHealthConfig struct {
	HighBounceThreshold   float64 // default 0.15
	MediumBounceThreshold float64 // default 0.08
	GoodBounceThreshold   float64 // default 0.02
	HighBounceMinSent     int     // default 5
	MediumBounceMinSent   int     // default 10
	GoodBounceMinSent     int     // default 20
	MaxDailyCap           int     // default 5
}

// DefaultDomainHealthConfig returns the production-default thresholds.
func DefaultDomainHealthConfig() DomainHealthConfig {
	return DomainHealthConfig{
		HighBounceThreshold:   0.15,
		MediumBounceThreshold: 0.08,
		GoodBounceThreshold:   0.02,
		HighBounceMinSent:     5,
		MediumBounceMinSent:   10,
		GoodBounceMinSent:     20,
		MaxDailyCap:           5,
	}
}

// CheckDomainHealth reviews all active domains and adjusts send caps based on performance.
// It uses the default production thresholds. Use CheckDomainHealthWithConfig for custom thresholds.
func CheckDomainHealth(ctx context.Context, db *sql.DB) (checked, flagged int, err error) {
	return CheckDomainHealthWithConfig(ctx, db, DefaultDomainHealthConfig())
}

// CheckDomainHealthWithConfig is the configurable variant of CheckDomainHealth.
func CheckDomainHealthWithConfig(ctx context.Context, db *sql.DB, cfg DomainHealthConfig) (checked, flagged int, err error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, domain, total_sent, total_bounced, total_complained,
			bounce_rate, daily_send_cap, is_suppressed
		FROM outreach_domains
		WHERE total_sent > 0 AND NOT is_suppressed
	`)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id, totalSent, totalBounced, totalComplained, dailyCap int
			domain                                                 string
			bounceRate                                             float64
			isSuppressed                                           bool
		)
		if scanErr := rows.Scan(&id, &domain, &totalSent, &totalBounced, &totalComplained,
			&bounceRate, &dailyCap, &isSuppressed); scanErr != nil {
			slog.Warn("intelligence: domain-health row scan failed — skipping row", "op", "intelligence.CheckDomainHealthWithConfig/scan", "error", scanErr)
			continue
		}

		checked++
		newCap := dailyCap
		shouldFlag := false

		// High bounce rate → reduce cap
		if bounceRate > cfg.HighBounceThreshold && totalSent >= cfg.HighBounceMinSent {
			// Suppress domain entirely. H5 in the 2026-04-21 audit:
			// this Exec was bare, so a failed UPDATE left the domain
			// UNSUPPRESSED while we logged "domain suppressed" — a
			// false-positive that let the next tick keep sending.
			if _, suppErr := db.ExecContext(ctx, `
				UPDATE outreach_domains
				SET is_suppressed = true, suppressed_reason = 'high_bounce_rate',
				    suppressed_at = now(), updated_at = now()
				WHERE id = $1
			`, id); suppErr != nil {
				slog.Error("intelligence: failed to suppress high-bounce domain — SEND GATE NOT APPLIED",
					"op", "intelligence.CheckDomainHealthWithConfig/high_bounce_suppress", "domain", domain, "domain_id", id, "bounce_rate_pct", bounceRate*100, "error", suppErr)
				// Do NOT set shouldFlag — the suppression didn't happen.
				continue
			}
			shouldFlag = true
			slog.Warn("domain suppressed", "op", "intelligence.CheckDomainHealthWithConfig/suppressed", "domain", domain, "bounce_rate_pct", bounceRate*100)
		} else if bounceRate > cfg.MediumBounceThreshold && totalSent >= cfg.MediumBounceMinSent {
			// Reduce cap
			newCap = maxInt(1, dailyCap/2)
			shouldFlag = true
			slog.Warn("domain cap reduced", "op", "intelligence.CheckDomainHealthWithConfig/cap_reduced", "domain", domain, "old_cap", dailyCap, "new_cap", newCap, "bounce_rate_pct", bounceRate*100)
		} else if bounceRate < cfg.GoodBounceThreshold && totalSent >= cfg.GoodBounceMinSent && dailyCap < cfg.MaxDailyCap {
			// Good performance → increase cap
			newCap = minInt(cfg.MaxDailyCap, dailyCap+1)
			slog.Info("domain cap increased", "domain", domain, "old_cap", dailyCap, "new_cap", newCap, "bounce_rate_pct", bounceRate*100)
		}

		// Any complaints → immediate cap reduction
		if totalComplained > 0 {
			newCap = 1
			shouldFlag = true
			slog.Warn("domain cap set to 1 due to complaints", "op", "intelligence.CheckDomainHealthWithConfig/complaints", "domain", domain, "complaints", totalComplained)
		}

		if newCap != dailyCap {
			// H5: cap adjustments must also be observable on failure —
			// a silently dropped cap change lets the pipeline keep
			// sending at the stale cap with no signal to ops.
			if _, capErr := db.ExecContext(ctx, `
				UPDATE outreach_domains SET daily_send_cap = $1, updated_at = now() WHERE id = $2
			`, newCap, id); capErr != nil {
				slog.Warn("intelligence: daily_send_cap update failed",
					"op", "intelligence.CheckDomainHealthWithConfig/cap_update", "domain", domain, "domain_id", id, "old_cap", dailyCap, "new_cap", newCap, "error", capErr)
			}
		}

		if shouldFlag {
			flagged++
		}
	}

	return checked, flagged, rows.Err()
}

// DetectZeroEngagement flags contacts who received 3+ emails with zero opens.
func DetectZeroEngagement(ctx context.Context, db *sql.DB) (int, error) {
	result, err := db.ExecContext(ctx, `
		INSERT INTO outreach_honeypot_signals (contact_id, signal_type, severity, details)
		SELECT c.id, 'zero_engagement', 'medium',
			json_build_object('total_sent', c.total_sent, 'total_opened', c.total_opened)::jsonb
		FROM outreach_contacts c
		WHERE c.total_sent >= 3
			AND c.total_opened = 0
			AND c.status = 'active'
			AND NOT EXISTS (
				SELECT 1 FROM outreach_honeypot_signals h
				WHERE h.contact_id = c.id AND h.signal_type = 'zero_engagement'
			)
	`)
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}

// DomainReport generates a summary of domain performance.
type DomainReport struct {
	Domain        string
	Type          string
	TotalSent     int
	BounceRate    float64
	Complaints    int
	DailyCap      int
	IsSuppressed  bool
	ActiveContacts int
}

// TopDomains returns the most active domains for reporting.
func TopDomains(ctx context.Context, db *sql.DB, limit int) ([]DomainReport, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT domain, domain_type, total_sent, bounce_rate, total_complained,
			daily_send_cap, is_suppressed, active_contacts
		FROM outreach_domains
		WHERE total_sent > 0
		ORDER BY total_sent DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reports []DomainReport
	for rows.Next() {
		var r DomainReport
		rows.Scan(&r.Domain, &r.Type, &r.TotalSent, &r.BounceRate,
			&r.Complaints, &r.DailyCap, &r.IsSuppressed, &r.ActiveContacts)
		reports = append(reports, r)
	}
	return reports, rows.Err()
}

// recoverBounceRateThreshold is the recent hard-bounce rate (3%) at or below
// which a previously-suppressed domain is eligible for auto-recovery.
const recoverBounceRateThreshold = 0.03

// RecoverSuppressedDomains lifts suppression for domains that were suppressed
// at least 30 days ago and whose recent bounce rate (last 30 days of sends) has
// dropped to recoverBounceRateThreshold or below. Returns the number of
// domains recovered.
//
// The recent-bounce subquery used to reference `se.domain`, but send_events
// has no domain column in production (migration 033 declared only campaign_id,
// contact_id, sent_at, status, etc.). The query failed at every 6h
// intelligence tick with `pq: column se.domain does not exist`. Fix: derive
// the recipient domain from contacts via send_events.contact_id.
//
// The rate is hard_bounces / total recent sends: send_events is LEFT JOINed to
// bounce_events so the denominator counts ALL recent sends
// (COUNT(DISTINCT se.id)), not just the sends that bounced. A domain with zero
// recent sends yields a NULL rate and is NOT auto-recovered — recovery
// requires recent evidence the domain has healed, not an absence of data.
func RecoverSuppressedDomains(ctx context.Context, db *sql.DB) (int, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT d.id, d.domain,
		       (SELECT COUNT(*) FILTER (WHERE be.bounce_type = 'hard')::float
		             / NULLIF(COUNT(DISTINCT se.id), 0)
		        FROM send_events se
		        LEFT JOIN bounce_events be ON be.send_event_id = se.id
		        JOIN contacts c            ON c.id = se.contact_id
		        WHERE lower(split_part(c.email, '@', 2)) = d.domain
		          AND se.sent_at > now() - interval '30 days') AS recent_bounce_rate
		FROM outreach_domains d
		WHERE d.is_suppressed = true
		  AND (d.suppressed_at IS NULL OR d.suppressed_at < now() - interval '30 days')
	`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	recovered := 0
	for rows.Next() {
		var id int
		var domain string
		var recentBounceRate sql.NullFloat64
		if err := rows.Scan(&id, &domain, &recentBounceRate); err != nil {
			continue
		}

		// Zero recent sends → NULL rate → no evidence the domain has healed.
		// Keep it suppressed rather than auto-recovering on no data.
		if !recentBounceRate.Valid {
			continue
		}
		if recentBounceRate.Float64 > recoverBounceRateThreshold {
			continue
		}

		_, err := db.ExecContext(ctx, `
			UPDATE outreach_domains
			SET is_suppressed = false, suppressed_reason = NULL,
			    suppressed_at = NULL, updated_at = now()
			WHERE id = $1
		`, id)
		if err != nil {
			slog.Warn("domain recovery update failed", "op", "intelligence.RecoverSuppressedDomains/update", "domain", domain, "error", err)
			continue
		}
		recovered++
		slog.Info("domain auto-recovered", "domain", domain, "recent_bounce_rate_pct", recentBounceRate.Float64*100)
	}
	return recovered, rows.Err()
}

func maxInt(a, b int) int {
	if a > b { return a }
	return b
}

func minInt(a, b int) int {
	if a < b { return a }
	return b
}
