// dedup_guard.go — cross-campaign + per-domain dedup guard.
//
// Closes operator scenario 2026-05-05:
//   "System must not (1) re-send to a contact already touched in any prior
//   campaign/segment, (2) send multiple emails to the same domain (boss@,
//   asistentka@, info@) — Seznam/Gmail flag it as spam."
//
// Guard runs pre-enqueue in Engine.Run. If CheckEligibility returns
// eligible=false, contact is moved to campaign_contacts.status='skipped'
// with details.skip_reason = result.Reason. No side effect on send_events.
//
// Backed by migration 049_dedup_guard.sql which adds three contacts columns:
//   - email_domain (generated, indexed) — extracted from email lower(split @)
//   - lifetime_touches (int, indexed, trigger-bumped on send_events insert)
//   - dnt (bool) — GDPR Art. 21 right-to-object hard skip
//
// Migration 050_crm_clients_import.sql adds contacts.crm_client_id FK.
// parent_ico + region are pre-existing contacts columns used by runner.go.
//
// Slog op-field discipline (services/campaigns/CLAUDE.md):
//   "op", "dedup.check/<branch>" + "error" key (not "err")
//   Branches: /crm_active_client, /dnt, /lifetime_exhausted,
//             /cross_campaign_cooldown, /bounce_cluster, /region_rate_limit,
//             /engagement_decay, /domain_cooldown, /eligible,
//             /db_query_failed, /contact_missing

package sender

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// knownFreemailDomains — same source of truth as
// services/orchestrator/thread/inbound.go and
// services/contacts/enrichment/domain.go. Per-domain cooldown must NOT
// fire for these: boss@gmail.com does not block asistentka@gmail.com
// because they are unrelated people. Sprint operator-decision 2026-05-12:
// before the fix, 21,725 contacts on freemail domains (14,512 on
// seznam.cz alone) were skipped after only 74 sends because the
// dedup_guard treated each freemail provider as a single corporate
// entity.
var freemailDomainsForDedup = map[string]bool{
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
}

func isFreemailDomainForDedup(domain string) bool {
	return freemailDomainsForDedup[strings.ToLower(strings.TrimSpace(domain))]
}

// IsFreemailDomain is the exported, canonical freemail classifier for the
// whole campaigns service. services/campaigns/campaign/gate.go delegates to
// this so the send gates (per-tick rotation + per-day + per-campaign lifetime
// cap) and the dedup per-domain cooldown share a SINGLE source of truth.
//
// Drift between two hand-maintained copies caused the 2026-06-22 campaign-457
// stall: gate.go's stale map lacked outlook.cz / hotmail.cz / wo.cz / mybox.cz,
// so 35 distinct businesses (35 distinct IČO) on Czech webmail providers were
// all collapsed onto one "corporate domain" and blocked by the
// MaxPerDomainPerCampaign=1 lifetime cap after the first send — outbound went
// to count=0 every tick. This wrapper removes the second copy entirely.
func IsFreemailDomain(domain string) bool {
	return isFreemailDomainForDedup(domain)
}

// DedupGuardConfig holds tunable thresholds. Defaults come from
// DefaultDedupGuardConfig and reflect the operator-stated policy:
//   - cross-campaign cooldown:      90 days (no contact re-touched within)
//   - per-domain cooldown:         180 days (boss@ blocks asistentka@)
//   - lifetime max touches:          3 (more = stop annoying)
//   - bounce cluster threshold:    0.30 (30% bounce rate per IČO blocks all contacts)
//   - bounce cluster window:        30 days (lookback for bounce rate calculation)
//   - region max per hour:            2 (max sends per kraj per rolling hour)
//   - region window:                 1 hour (lookback for region rate limit)
//   - engagement decay min sends:    3 (contact must have ≥3 sends with zero engagement)
//   - engagement decay window:     365 days (lookback for sent+no-engagement check)
//   - engagement decay cooldown:   365 days (block duration if decay applies)
type DedupGuardConfig struct {
	CrossCampaignCooldown   time.Duration
	PerDomainCooldown       time.Duration
	LifetimeMaxTouches      int
	BounceClusterThreshold  float64
	BounceClusterWindow     time.Duration
	RegionMaxPerHour        int
	RegionWindow            time.Duration
	EngagementDecayMinSends int
	EngagementDecayWindow   time.Duration
	EngagementDecayCooldown time.Duration
}

// DefaultDedupGuardConfig returns the operator-validated default policy.
// Per memory feedback_no_speculation these are concrete numbers reflecting
// 2026-05-05 operator request, not made-up.
func DefaultDedupGuardConfig() DedupGuardConfig {
	return DedupGuardConfig{
		CrossCampaignCooldown:   90 * 24 * time.Hour,
		PerDomainCooldown:       180 * 24 * time.Hour,
		LifetimeMaxTouches:      3,
		BounceClusterThreshold:  0.30,
		BounceClusterWindow:     30 * 24 * time.Hour,
		RegionMaxPerHour:        2,
		RegionWindow:            1 * time.Hour,
		EngagementDecayMinSends: 3,
		EngagementDecayWindow:   365 * 24 * time.Hour,
		EngagementDecayCooldown: 365 * 24 * time.Hour,
	}
}

// EligibilityResult is the dedup decision for a single contact at a single
// pre-enqueue moment. Eligible=true means the guard passed all axes.
// Reason is the first axis that fired (in evaluation order:
// crm_active_client → dnt → lifetime → cross-campaign → bounce_cluster →
// region_rate_limit → engagement_decay → per-domain).
// RulesEvaluated lists every axis that ran in order, useful for audit
// reasoning even on the eligible path.
type EligibilityResult struct {
	Eligible       bool
	Reason         string
	RulesEvaluated []string
}

// DedupQuerier is the minimum DB surface CheckEligibility needs. Both
// *sql.DB and *sql.Tx satisfy it, plus go-sqlmock in tests.
type DedupQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// ErrContactMissing means no contacts row matched. Caller should treat
// the missing-contact path as a hard skip — pre-enqueue without a known
// contact has no semantic meaning.
var ErrContactMissing = errors.New("dedup_guard: contact not found")

// CheckEligibility evaluates the eight dedup axes in order and returns
// the first axis that blocks. If all eight pass, returns Eligible=true.
//
// Ordering matters: cheaper checks run first (single-row contact load reads
// crm_client_id + dnt + lifetime), expensive cross-table joins run last.
// Short-circuits on first failure.
func CheckEligibility(
	ctx context.Context,
	db DedupQuerier,
	contactID int64,
	cfg DedupGuardConfig,
) (EligibilityResult, error) {
	res := EligibilityResult{RulesEvaluated: make([]string, 0, 8)}

	// ── 1. Load contact: crm_client_id + dnt + lifetime + email_domain + region + parent_ico ──
	var (
		crmClientID     sql.NullInt64
		dnt             bool
		lifetimeTouches int
		emailDomain     sql.NullString
		region          sql.NullString
		parentICO       sql.NullString
	)
	row := db.QueryRowContext(ctx,
		`SELECT dnt, lifetime_touches, email_domain, region, parent_ico, crm_client_id
		 FROM contacts
		 WHERE id = $1`,
		contactID,
	)
	if err := row.Scan(&dnt, &lifetimeTouches, &emailDomain, &region, &parentICO, &crmClientID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			slog.Warn("contact not found",
				"op", "dedup.check/contact_missing",
				"contact_id", contactID,
			)
			return res, ErrContactMissing
		}
		slog.Error("contact load failed",
			"op", "dedup.check/db_query_failed",
			"contact_id", contactID,
			"error", err,
		)
		return res, fmt.Errorf("dedup_guard load contact: %w", err)
	}

	// ── 1.5. CRM active client (eWAY-CRM import) — hard skip ─────────────
	// Closes operator scenario 2026-05-05: contact is in eWAY-CRM (klient or
	// active OP). Operátor je v custody — automatický mail by zničil důvěru.
	// Kontrola PŘED dnt aby skip reason byl významnější ("aktivní v CRM" >
	// "operátor stiskl DNT").
	res.RulesEvaluated = append(res.RulesEvaluated, "crm_active_client")
	if crmClientID.Valid {
		res.Eligible = false
		res.Reason = "crm_active_client"
		slog.Info("dedup blocked",
			"op", "dedup.check/crm_active_client",
			"contact_id", contactID,
			"crm_client_id", crmClientID.Int64,
		)
		return res, nil
	}

	// ── 2. DNT flag (GDPR Art. 21 right-to-object) — hard skip ───────────
	res.RulesEvaluated = append(res.RulesEvaluated, "dnt")
	if dnt {
		res.Eligible = false
		res.Reason = "dnt_set"
		slog.Info("dedup blocked",
			"op", "dedup.check/dnt",
			"contact_id", contactID,
		)
		return res, nil
	}

	// ── 3. Lifetime touch limit ──────────────────────────────────────────
	res.RulesEvaluated = append(res.RulesEvaluated, "lifetime_touches")
	if lifetimeTouches >= cfg.LifetimeMaxTouches {
		res.Eligible = false
		res.Reason = "lifetime_exhausted"
		slog.Info("dedup blocked",
			"op", "dedup.check/lifetime_exhausted",
			"contact_id", contactID,
			"lifetime_touches", lifetimeTouches,
			"limit", cfg.LifetimeMaxTouches,
		)
		return res, nil
	}

	// ── 4. Cross-campaign cooldown ───────────────────────────────────────
	// Look for ANY successful send to this contact within the window.
	// Independent of campaign_id because operator's stated policy is
	// "doesn't matter which campaign — don't double-touch the contact".
	res.RulesEvaluated = append(res.RulesEvaluated, "cross_campaign_cooldown")
	cooldownStart := time.Now().UTC().Add(-cfg.CrossCampaignCooldown)
	var crossCampaignFound int
	err := db.QueryRowContext(ctx,
		`SELECT 1 FROM send_events
		 WHERE contact_id = $1 AND status = 'sent' AND sent_at > $2
		 LIMIT 1`,
		contactID, cooldownStart,
	).Scan(&crossCampaignFound)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.Error("cross-campaign cooldown query failed",
			"op", "dedup.check/db_query_failed",
			"contact_id", contactID,
			"error", err,
		)
		return res, fmt.Errorf("dedup_guard cross-campaign: %w", err)
	}
	if crossCampaignFound == 1 {
		res.Eligible = false
		res.Reason = "cross_campaign_cooldown"
		slog.Info("dedup blocked",
			"op", "dedup.check/cross_campaign_cooldown",
			"contact_id", contactID,
			"cooldown_days", int(cfg.CrossCampaignCooldown.Hours()/24),
		)
		return res, nil
	}

	// ── 5. Bounce cluster guard ──────────────────────────────────────────
	// Skip when parent_ico is null/empty (standalone company, not in a cluster).
	// Count bounced sends for all contacts of this IČO in the last N days.
	// If bounce_rate >= threshold AND total_sends >= 5 (avoid noise), block.
	res.RulesEvaluated = append(res.RulesEvaluated, "bounce_cluster")
	if parentICO.Valid && parentICO.String != "" {
		clusterWindowStart := time.Now().UTC().Add(-cfg.BounceClusterWindow)
		var totalSends, bouncedCount int
		err := db.QueryRowContext(ctx,
			`SELECT COUNT(*) as total, SUM(CASE WHEN status='bounced' THEN 1 ELSE 0 END)
			 FROM send_events se
			 JOIN contacts c ON c.id = se.contact_id
			 WHERE c.parent_ico = $1
			   AND se.sent_at > $2`,
			parentICO.String, clusterWindowStart,
		).Scan(&totalSends, &bouncedCount)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			slog.Error("bounce cluster query failed",
				"op", "dedup.check/db_query_failed",
				"contact_id", contactID,
				"parent_ico", parentICO.String,
				"error", err,
			)
			return res, fmt.Errorf("dedup_guard bounce cluster: %w", err)
		}
		if totalSends >= 5 && bouncedCount > 0 {
			bounceRate := float64(bouncedCount) / float64(totalSends)
			if bounceRate >= cfg.BounceClusterThreshold {
				res.Eligible = false
				res.Reason = "bounce_cluster"
				slog.Info("dedup blocked",
					"op", "dedup.check/bounce_cluster",
					"contact_id", contactID,
					"parent_ico", parentICO.String,
					"bounce_rate", bounceRate,
					"bounced_count", bouncedCount,
					"total_sends", totalSends,
					"threshold", cfg.BounceClusterThreshold,
				)
				return res, nil
			}
		}
	}

	// ── 6. Region rate limit ────────────────────────────────────────────
	// Skip when region is null/empty (rare — unclassified contact).
	// Count successful sends to contacts in this region within the rolling window.
	// If count >= cfg.RegionMaxPerHour, block to spread sender reputation.
	res.RulesEvaluated = append(res.RulesEvaluated, "region_rate_limit")
	if region.Valid && region.String != "" {
		regionWindowStart := time.Now().UTC().Add(-cfg.RegionWindow)
		var regionSendCount int
		err := db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM send_events se
			 JOIN contacts c ON c.id = se.contact_id
			 WHERE c.region = $1
			   AND se.status = 'sent'
			   AND se.sent_at > $2`,
			region.String, regionWindowStart,
		).Scan(&regionSendCount)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			slog.Error("region rate limit query failed",
				"op", "dedup.check/db_query_failed",
				"contact_id", contactID,
				"region", region.String,
				"error", err,
			)
			return res, fmt.Errorf("dedup_guard region rate limit: %w", err)
		}
		if regionSendCount >= cfg.RegionMaxPerHour {
			res.Eligible = false
			res.Reason = "region_rate_limit"
			slog.Info("dedup blocked",
				"op", "dedup.check/region_rate_limit",
				"contact_id", contactID,
				"region", region.String,
				"send_count", regionSendCount,
				"max_per_hour", cfg.RegionMaxPerHour,
			)
			return res, nil
		}
	}

	// ── 7. Engagement decay ──────────────────────────────────────────────
	// Check if contact had ≥3 sent emails in the last window with zero opens/clicks.
	// If so, apply cooldown to reduce engagement fatigue. Note: send_events tracks
	// status (sent/bounced/softbounce) but opens/clicks are recorded externally via
	// tracking_events table; we use a LEFT JOIN to detect engagement absence.
	res.RulesEvaluated = append(res.RulesEvaluated, "engagement_decay")
	decayWindowStart := time.Now().UTC().Add(-cfg.EngagementDecayWindow)
	var sentCount, engagedCount int
	err = db.QueryRowContext(ctx,
		`SELECT
		   COUNT(se.id) as sent_count,
		   COUNT(DISTINCT CASE WHEN te.id IS NOT NULL THEN se.id END) as engaged_count
		 FROM send_events se
		 LEFT JOIN tracking_events te ON te.send_event_id = se.id
		   AND te.event_type IN ('open', 'click')
		 WHERE se.contact_id = $1
		   AND se.status = 'sent'
		   AND se.sent_at > $2`,
		contactID, decayWindowStart,
	).Scan(&sentCount, &engagedCount)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.Error("engagement decay query failed",
			"op", "dedup.check/db_query_failed",
			"contact_id", contactID,
			"error", err,
		)
		return res, fmt.Errorf("dedup_guard engagement decay: %w", err)
	}
	if sentCount >= cfg.EngagementDecayMinSends && engagedCount == 0 {
		res.Eligible = false
		res.Reason = "engagement_decay"
		slog.Info("dedup blocked",
			"op", "dedup.check/engagement_decay",
			"contact_id", contactID,
			"sent_count", sentCount,
			"engaged_count", engagedCount,
			"min_sends", cfg.EngagementDecayMinSends,
		)
		return res, nil
	}

	// ── 8. Per-domain cooldown ───────────────────────────────────────────
	// Skip when email_domain is null/empty (rare — invalid email row).
	// Look for ANY successful send to ANOTHER contact at the same domain
	// within the per-domain window. The cross-campaign rule above already
	// caught self-self; here we catch boss@firma.cz blocks asistentka@firma.cz.
	//
	// FREEMAIL CARVE-OUT (2026-05-12 incident — campaign 457): freemail
	// providers like seznam.cz, gmail.com etc. host thousands of unrelated
	// individuals; treating them as a single corporate entity blocks 14k+
	// contacts after one send. Skip the per-domain rule entirely for
	// freemail addresses. The cross-campaign cooldown above still protects
	// individual addresses from being re-touched.
	res.RulesEvaluated = append(res.RulesEvaluated, "per_domain_cooldown")
	if emailDomain.Valid && emailDomain.String != "" && !isFreemailDomainForDedup(emailDomain.String) {
		domainCooldownStart := time.Now().UTC().Add(-cfg.PerDomainCooldown)
		var domainFound int
		err := db.QueryRowContext(ctx,
			`SELECT 1 FROM send_events se
			 JOIN contacts c ON c.id = se.contact_id
			 WHERE c.email_domain = $1
			   AND se.status = 'sent'
			   AND se.sent_at > $2
			   AND se.contact_id <> $3
			 LIMIT 1`,
			emailDomain.String, domainCooldownStart, contactID,
		).Scan(&domainFound)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			slog.Error("per-domain cooldown query failed",
				"op", "dedup.check/db_query_failed",
				"contact_id", contactID,
				"domain", emailDomain.String,
				"error", err,
			)
			return res, fmt.Errorf("dedup_guard per-domain: %w", err)
		}
		if domainFound == 1 {
			res.Eligible = false
			res.Reason = "per_domain_cooldown"
			slog.Info("dedup blocked",
				"op", "dedup.check/domain_cooldown",
				"contact_id", contactID,
				"domain", emailDomain.String,
				"cooldown_days", int(cfg.PerDomainCooldown.Hours()/24),
			)
			return res, nil
		}
	}

	// ── 9. All checks passed ─────────────────────────────────────────────
	res.Eligible = true
	res.Reason = ""
	slog.Info("dedup eligible",
		"op", "dedup.check/eligible",
		"contact_id", contactID,
		"rules_evaluated", res.RulesEvaluated,
	)
	return res, nil
}
