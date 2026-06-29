// Sprint AH2 — domain overlap detector cron.
//
// Every 12h, scan campaign_contacts for any (campaign_id, domain) pair
// whose total in-flight + pending count crosses the configured
// `domain_overlap_alert_threshold` (default 5). For each match, emit an
// `operator_notifications`-style alert into `mailbox_alerts` with a
// `domain_overlap_warning` type — the same dedup machinery used by
// bounce_rate_monitor (4h window) keeps repeat alerts from spamming the
// Ochrany panel while the operator triages the cohort.
//
// Why this cron exists:
//   The AF gate (corporate_domain_lifetime_cap) is a runtime per-send
//   check; it does not retire queued in_flight rows. Operator today
//   discovered an 11-domain holding overlap (renofarmy.cz + 10 parent
//   ICO siblings = 104 contacts) manually. This cron surfaces the
//   overlap as a dashboard notification before the operator has to
//   poll psql.
//
// HARD RULE compliance:
//   - feedback_no_magic_thresholds (T0): threshold lives in
//     operator_settings.domain_overlap_alert_threshold (default 5).
//   - feedback_audit_log_on_mutations (T0): every emitted alert ALSO
//     writes an operator_audit_log row (cron actor) so the operator
//     can audit what state triggered the alert.
//   - feedback_schema_verify_before_sql (T0): campaign_contacts +
//     contacts + mailbox_alerts columns verified via migrations 030,
//     034, 044, 049.
//   - feedback_no_pii_in_commands (T0): slog emits campaign_id +
//     domain + count only — no email addresses.

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
	domainOverlapDefaultInterval       = 12 * time.Hour
	domainOverlapAlertType             = "domain_overlap_warning"
	domainOverlapAlertDedupWindow      = 24 * time.Hour
	defaultDomainOverlapAlertThreshold = 5
)

// domainOverlapDefaultFreemails is the conservative skip list. It mirrors
// the freemail set the dedup_guard uses (PR #1270) so the cron never
// alerts on gmail.com / seznam.cz / etc. — those will always have a
// large overlap inside any production campaign and are not actionable.
//
// Keep this in sync with services/contacts/enrichment/domain.go
// (`freemailDomains`). When adding a freemail there, add it here too.
var domainOverlapDefaultFreemails = map[string]bool{
	// Czech
	"seznam.cz": true, "email.cz": true, "centrum.cz": true,
	"volny.cz": true, "tiscali.cz": true, "post.cz": true,
	"atlas.cz": true, "quick.cz": true, "iol.cz": true,
	"azet.cz": true, "wo.cz": true, "in.cz": true,
	"mybox.cz": true, "klikni.cz": true,
	// Slovak
	"azet.sk": true, "centrum.sk": true, "pobox.sk": true, "post.sk": true,
	"zoznam.sk": true, "atlas.sk": true,
	// Global
	"gmail.com": true, "googlemail.com": true,
	"outlook.com": true, "hotmail.com": true, "live.com": true, "msn.com": true,
	"outlook.cz": true, "hotmail.cz": true,
	"yahoo.com": true, "yahoo.co.uk": true, "yahoo.de": true,
	"icloud.com": true, "me.com": true, "mac.com": true,
	"protonmail.com": true, "proton.me": true, "pm.me": true,
	"tutanota.com": true, "tuta.io": true,
	"zoho.com": true, "yandex.com": true, "mail.ru": true,
	"aol.com": true, "gmx.com": true, "gmx.de": true, "gmx.net": true,
	"mail.com": true, "inbox.com": true,
}

// domainOverlapResult is the per-tick observability struct.
type domainOverlapResult struct {
	Checked       int
	AlertsEmitted int
}

// domainOverlapMatch is one (campaign, domain) pair above threshold.
type domainOverlapMatch struct {
	CampaignID int64
	Domain     string
	Count      int
}

// LoadDomainOverlapThreshold reads the operator_settings value with
// fallback to the Go default. HARD RULE feedback_no_magic_thresholds T0.
func LoadDomainOverlapThreshold(ctx context.Context, loader *operatorconfig.Loader) int {
	if loader == nil {
		return defaultDomainOverlapAlertThreshold
	}
	if v, err := loader.Get(ctx, "domain_overlap_alert_threshold"); err == nil && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultDomainOverlapAlertThreshold
}

// isFreemailForOverlap returns true when the cron should skip the domain
// because its overlap signal is uninformative for B2B targeting.
func isFreemailForOverlap(domain string) bool {
	return domainOverlapDefaultFreemails[strings.ToLower(strings.TrimSpace(domain))]
}

// RunDomainOverlapOnce executes one tick: scan campaign_contacts for any
// (campaign_id, domain) pair whose pending+in_flight count exceeds the
// configured threshold, filter freemails, dedup against open alerts, and
// emit a fresh alert row + audit row when warranted.
func RunDomainOverlapOnce(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) (domainOverlapResult, error) {
	var res domainOverlapResult
	threshold := LoadDomainOverlapThreshold(ctx, loader)

	// Aggregate across pending + in_flight (the operator-actionable queue).
	// Skipped + sent rows are deliberately excluded — they are not on the
	// runner's path and surfacing them would be noise.
	rows, err := db.QueryContext(ctx, `
		SELECT cc.campaign_id,
		       LOWER(SPLIT_PART(c.email, '@', 2)) AS domain,
		       COUNT(*)::int AS n
		  FROM campaign_contacts cc
		  JOIN contacts c ON c.id = cc.contact_id
		 WHERE cc.status IN ('pending', 'in_flight')
		   AND c.email IS NOT NULL
		 GROUP BY cc.campaign_id, LOWER(SPLIT_PART(c.email, '@', 2))
		HAVING COUNT(*) > $1
		 ORDER BY n DESC`, threshold)
	if err != nil {
		return res, fmt.Errorf("query domain overlap: %w", err)
	}
	defer rows.Close()

	var matches []domainOverlapMatch
	for rows.Next() {
		var m domainOverlapMatch
		if err := rows.Scan(&m.CampaignID, &m.Domain, &m.Count); err != nil {
			return res, fmt.Errorf("scan overlap row: %w", err)
		}
		if isFreemailForOverlap(m.Domain) {
			continue
		}
		matches = append(matches, m)
	}
	if err := rows.Err(); err != nil {
		return res, fmt.Errorf("iterate overlap rows: %w", err)
	}
	res.Checked = len(matches)

	for _, m := range matches {
		emitted, err := maybeInsertDomainOverlapAlert(ctx, db, m)
		if err != nil {
			slog.Warn("domain_overlap: alert insert failed",
				"op", "outreach.domain_overlap/insert",
				"campaign_id", m.CampaignID, "domain", m.Domain, "error", err)
			continue
		}
		if emitted {
			res.AlertsEmitted++
			// HARD RULE feedback_audit_log_on_mutations T0 — the alert
			// row itself is operator-visible state, so it gets audited.
			audit.Log(ctx, db, "domain_overlap.alert", "cron", "campaign",
				strconv.FormatInt(m.CampaignID, 10),
				map[string]any{
					"domain":    m.Domain,
					"count":     m.Count,
					"threshold": threshold,
				})
			slog.Warn("domain_overlap_warning",
				"op", "outreach.domain_overlap/alert",
				"campaign_id", m.CampaignID,
				"domain", m.Domain,
				"count", m.Count)
		}
	}
	return res, nil
}

// maybeInsertDomainOverlapAlert inserts an unresolved mailbox_alerts row
// unless an open alert of the same type for the same (campaign, domain)
// already exists within the dedup window. Returns true if a row was
// inserted, false otherwise. Errors are returned for the caller to log.
//
// Note: mailbox_alerts.mailbox_id is NULLable (migration 044) — we leave
// it NULL because this is a campaign-level alert. The campaign_id +
// domain are encoded in `message` so the dashboard can filter on them.
func maybeInsertDomainOverlapAlert(ctx context.Context, db *sql.DB, m domainOverlapMatch) (bool, error) {
	// Dedup against open alerts within the window. We use message LIKE
	// because mailbox_alerts has no per-campaign / per-domain columns —
	// the alert payload is the message string.
	prefix := fmt.Sprintf("domain_overlap campaign=%d domain=%s", m.CampaignID, m.Domain)
	var exists bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS(
		  SELECT 1 FROM mailbox_alerts
		   WHERE type = $1
		     AND message LIKE $2 || '%'
		     AND resolved_at IS NULL
		     AND created_at > NOW() - $3::interval
		)`,
		domainOverlapAlertType,
		prefix,
		fmt.Sprintf("%d seconds", int(domainOverlapAlertDedupWindow.Seconds())),
	).Scan(&exists); err != nil {
		// Treat lookup failure as "not seen" — better to risk a duplicate
		// alert than to silently swallow the overlap signal.
		slog.Warn("domain_overlap: dedup lookup failed",
			"op", "outreach.domain_overlap/dedup", "error", err)
	}
	if exists {
		return false, nil
	}

	message := fmt.Sprintf("%s count=%d threshold=%d — overlap detected, consider bulk-skip",
		prefix, m.Count, defaultDomainOverlapAlertThreshold)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO mailbox_alerts (mailbox_id, type, severity, message, created_at)
		VALUES (NULL, $1, 'info', $2, NOW())`,
		domainOverlapAlertType, message); err != nil {
		return false, err
	}
	return true, nil
}

// StartDomainOverlapLoop spawns the periodic cron. Honors
// DISABLE_DOMAIN_OVERLAP_CRON=1 + DOMAIN_OVERLAP_INTERVAL env overrides.
func StartDomainOverlapLoop(ctx context.Context, db *sql.DB, loader *operatorconfig.Loader) {
	if envconfig.BoolOr("DISABLE_DOMAIN_OVERLAP_CRON", false) {
		slog.Info("domain_overlap cron disabled (DISABLE_DOMAIN_OVERLAP_CRON=1)")
		return
	}
	interval := domainOverlapDefaultInterval
	if v := envconfig.GetOr("DOMAIN_OVERLAP_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			interval = d
		}
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("domain_overlap panic recovered",
					"op", "outreach.domain_overlap/recover", "recover", r)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		// Stagger first tick by 90s so boot-storm crons don't all fire
		// at the same wall-clock moment.
		select {
		case <-ctx.Done():
			return
		case <-time.After(90 * time.Second):
		}
		runTick := func() {
			start := time.Now()
			res, err := RunDomainOverlapOnce(ctx, db, loader)
			dur := time.Since(start)
			if err != nil {
				slog.Error("domain_overlap tick failed",
					"op", "outreach.domain_overlap/tick",
					"error", err, "duration_ms", dur.Milliseconds())
				return
			}
			slog.Info("domain_overlap tick",
				"op", "outreach.domain_overlap/done",
				"checked", res.Checked,
				"alerts", res.AlertsEmitted,
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
	slog.Info("domain_overlap cron started", "interval", interval)
}
