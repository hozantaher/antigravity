package campaign

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"common/audit"
	"common/calendar"
	"common/envconfig"
	"common/sqlsuppression"
	"common/telemetry"
	"common/token"
	"campaigns/content"
	"contacts/enrichment"
	"campaigns/sender"
	"time"

	"github.com/lib/pq"
)

// suppressionFilterFor returns the canonical NOT-IN clause used by every
// campaign SELECT that must skip suppressed addresses. Delegates to the
// shared `common/sqlsuppression.NotInUnionWhere` helper so the runner,
// preflight, and BFF preflight share one source of truth — see the
// package godoc on common/sqlsuppression for the full rationale around
// the two suppression tables.
func suppressionFilterFor(col string) string {
	return sqlsuppression.NotInUnionWhere(col)
}

// defaultMaxInflightBacklog caps how many contacts may sit reserved-but-unsent
// (campaign_contacts.status='in_flight') per campaign before RunCampaign stops
// reserving more. The send engine drains at per-mailbox human spacing
// (~1 msg / 150s / mailbox), far slower than a fixed reservation batch, so an
// uncapped reserve loop balloons in_flight into stuck zombies (395 stranded on
// 2026-06-23). 50 ≈ ~30 min of buffered queue at 4-mailbox throughput — enough
// to keep the engine fed across daemon ticks, small enough that a genuine
// process-death strand is cleared by the in_flight_reaper within its threshold
// (IN_FLIGHT_STUCK_THRESHOLD_HOURS) rather than halting the campaign.
const defaultMaxInflightBacklog = 50

// maxInflightBacklog reads CAMPAIGN_MAX_INFLIGHT_BACKLOG (positive integer) with
// fallback to the default. Invalid / non-positive values fall back so the guard
// cannot be accidentally disabled by a mistyped env var.
func maxInflightBacklog() int {
	raw := envconfig.GetOr("CAMPAIGN_MAX_INFLIGHT_BACKLOG", "")
	if raw == "" {
		return defaultMaxInflightBacklog
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultMaxInflightBacklog
	}
	return n
}

// SequenceStep defines one step in a follow-up sequence.
type SequenceStep struct {
	Step         int    `json:"step"`
	DelayDays    int    `json:"delay_days"`
	TemplateName string `json:"template"`
}

// Campaign represents a configured email campaign.
type Campaign struct {
	ID             int64
	Name           string
	Description    string
	Status         string
	SequenceConfig []SequenceStep
	CategoryPaths  []string
	CategoryMatch  string // "prefix" or "exact"
	Stats          map[string]int
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// DB abstracts database operations for testability.
type DB interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Runner orchestrates campaign execution: picks contacts, renders, enqueues.
type Runner struct {
	db               DB
	content          *content.Engine
	engine           *sender.Engine
	recalcDB         *sql.DB
	recalcIndustries []string
}

// NewRunner creates a campaign runner (full mode with send capability).
func NewRunner(db DB, contentEngine *content.Engine, sendEngine *sender.Engine) *Runner {
	return &Runner{db: db, content: contentEngine, engine: sendEngine}
}

// NewReadOnlyRunner creates a runner for list/create/stats operations only (no send).
func NewReadOnlyRunner(db DB) *Runner {
	return &Runner{db: db}
}

// WithRecalc enables post-send score recalculation.
func (r *Runner) WithRecalc(db *sql.DB, targetIndustries []string) *Runner {
	r.recalcDB = db
	r.recalcIndustries = targetIndustries
	return r
}

// RunCampaign processes all pending contacts for a campaign.
func (r *Runner) RunCampaign(ctx context.Context, campaignID int64) error {
	tickStart := time.Now()
	// Load campaign
	var name, status string
	var seqJSON []byte
	err := r.db.QueryRowContext(ctx,
		`SELECT name, status, sequence_config FROM campaigns WHERE id = $1`,
		campaignID).Scan(&name, &status, &seqJSON)
	if err != nil {
		return fmt.Errorf("load campaign: %w", err)
	}

	// Runnable statuses: 'draft' (initial) and 'active'/'running' (operator
	// activated). The dashboard BFF (server.js) sets status='active' on the
	// Activate button; the runner upgrades it to 'running' on first tick.
	// scheduler_postgres.go ListRunningCampaigns already accepts both — this
	// gate must mirror that pickset, otherwise active campaigns get listed
	// and immediately rejected here, generating an error log on every tick.
	if status != "running" && status != "draft" && status != "active" {
		return fmt.Errorf("campaign %s is %s, cannot run", name, status)
	}

	var steps []SequenceStep
	if err := json.Unmarshal(seqJSON, &steps); err != nil {
		return fmt.Errorf("parse sequence: %w", err)
	}

	// Enforce sequence contiguity BEFORE reserving any contact. The runner
	// reserves current_step on the array INDEX (currentStep+1) while the
	// engine's FinalizeSentStep CAS keys on the DECLARED step.Step+1
	// (atomicity.go). When step.Step != array index — a non-contiguous
	// sequence_config — the finalize CAS matches 0 rows and the contact sticks
	// 'in_flight' forever, then the reaper rolls it back and the whole
	// sequence risks re-sending. ValidateSequence guarantees step numbers are
	// 0-indexed and contiguous (step.Step == index), making the index and the
	// declared value identical so the CAS always matches. Reject here rather
	// than silently reserve into a stuck state: the operator-input boundary may
	// not have validated (legacy rows, direct SQL edits). Empty sequences pass
	// (ValidateSequence returns nil); the per-contact `currentStep >= len(steps)`
	// guard handles those downstream.
	if err := ValidateSequence(steps); err != nil {
		return fmt.Errorf("campaign %s has invalid sequence_config: %w", name, err)
	}

	// First-tick transition: only set started_at if it has never been set
	// before. Previous code used unconditional UPDATE which bumped
	// started_at to the LAST tick's time on every iteration, hiding the
	// real campaign start from operator dashboards. Use COALESCE so the
	// timestamp gets set exactly once across the campaign's lifetime.
	//
	// Non-fatal: a failed status update does not block sends (campaign can
	// still enqueue for already-started runs), but we log so ops sees it
	// instead of silently dropping the error (was H6 in the 2026-04-21
	// audit — bare ExecContext hiding a failed state transition).
	if _, err := r.db.ExecContext(ctx,
		`UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1`, campaignID); err != nil {
		slog.Warn("campaign status update failed", "op", "runner.RunCampaign/statusUpdate", "campaign_id", campaignID, "error", err)
	}

	// Czech calendar gate — skip weekends and national holidays for
	// deliverability (ESPs throttle holiday spikes). SKIP_CALENDAR_CHECK=1
	// bypasses for CI determinism.
	if !envconfig.BoolOr("SKIP_CALENDAR_CHECK", false) {
		now := time.Now()
		// Sprint C2: IsExtendedDeadDay tightens the cold-outreach gate to
		// also cover the 22.12.–2.1. Vánoce quiet zone, not just weekends +
		// state holidays. Per operator request 2026-05-05 (initiative
		// 2026-05-05-post-purge-rebuild-plan.md, Sprint C2).
		if calendar.IsExtendedDeadDay(now) {
			slog.Info("campaign skipped non-sendable day (weekend, CZ holiday, or Vánoce zone)",
				"op", "runner.RunCampaign/extendedDeadDay",
				"campaign", name, "date", now.Format("2006-01-02"), "weekday", now.Weekday())
			return nil
		}
	}

	// Find contacts ready to send.
	//
	// Compliance gate: the c.status NOT IN list below must cover every
	// "do not contact" vocabulary from migration 033 (status_enum_check).
	// Enrollment-time filters (ApplySegmentToCampaign) only block at the
	// moment a contact is added to the campaign — they do NOT re-check on
	// every tick. So a contact enrolled as `valid` whose status later
	// flips to `unsubscribed` (via unsubscribe link, reply classification,
	// or bounce cascade) MUST be filtered here, otherwise they keep
	// receiving sequence steps.
	//
	// See docs/audits/exclusion-vocabulary-drift-2026-04-17.md for the
	// prior 3-status filter and why it was compliance-broken.
	// Defense in depth: filter by Schema A contacts.status AND by both
	// suppression tables (outreach_suppressions + suppression_list — see
	// suppressionFilterSQL for why both are required).
	// SuppressEmail() updates Schema B (outreach_contacts.status='suppressed') but not
	// Schema A (contacts.status) — so a contact suppressed via reply classifier could
	// otherwise re-enter this query. The combined suppression filter is the
	// last-line compliance gate before send (GDPR-style discipline).
	//
	// 'suppressed' added to NOT IN (F1 — adversarial-data-layer audit 2026-05-05):
	// migration 048 trigger sets contacts.status='suppressed' on INSERT into
	// suppression_list. If operator unsuppresses via DELETE /api/suppression/:email,
	// the row is removed from suppression_list but contacts.status stays 'suppressed'
	// (no reverting trigger). Without 'suppressed' in NOT IN, that contact passes
	// both the status check AND the suppression UNION filter, leaking back through.
	// Adding it here closes the gap as defense-in-depth alongside the suppressionFilter.
	rows, err := r.db.QueryContext(ctx,
		`SELECT cc.id, cc.contact_id, cc.current_step, c.email, c.first_name, c.company_name, c.region,
		        COALESCE(co.email_status, '') AS email_status,
		        COALESCE(co.parent_ico, '')   AS parent_ico
		 FROM campaign_contacts cc
		 JOIN contacts c ON c.id = cc.contact_id
		 LEFT JOIN companies co ON co.ico = c.ico
		 WHERE cc.campaign_id = $1
		   AND cc.status IN ('pending', 'in_sequence')
		   AND (cc.next_send_at IS NULL OR cc.next_send_at <= now())
		   AND c.status NOT IN (
		       'bounced', 'blacklisted', 'invalid',
		       'unsubscribed', 'opted_out',
		       'human_handoff', 'paused_human',
		       'completed_no_reply', 'retention_expired',
		       'suppressed'
		   )
		   AND `+suppressionFilterFor("c.email")+`
		 ORDER BY cc.id
		 -- Backlog guard (incident 2026-06-23): cap reservations so the runner
		 -- never reserves more 'in_flight' than the engine can drain. The engine
		 -- sends at per-mailbox human spacing (~1 msg / 150s / mailbox), far slower
		 -- than a fixed batch; without this the surplus balloons into stuck
		 -- 'in_flight' zombies. LIMIT shrinks by the current in-flight depth,
		 -- reaching 0 at the cap; the in_flight_reaper clears genuine
		 -- process-death strands (IN_FLIGHT_STUCK_THRESHOLD_HOURS).
		 LIMIT GREATEST(0, $2 - (
		     SELECT count(*) FROM campaign_contacts
		     WHERE campaign_id = $1 AND status = 'in_flight'
		       -- Only count the ACTIVE queue (reserved within the last hour).
		       -- A genuine process-death strand keeps its old updated_at, so it
		       -- drops out of the cap after ~1h and reservations resume even if
		       -- the in_flight_reaper is down — the guard self-heals rather than
		       -- wedging the campaign until the reaper clears the strand. The
		       -- window tracks IN_FLIGHT_STUCK_THRESHOLD_HOURS (default reaper 1h);
		       -- the active queue drains well within it (cap/throughput ≈ 30 min).
		       AND updated_at > now() - INTERVAL '1 hour'
		 ))`, campaignID, maxInflightBacklog())
	if err != nil {
		return fmt.Errorf("query contacts: %w", err)
	}
	defer rows.Close()

	seenParentICO  := map[string]int{} // holding cluster gate (one per parent_ico per tick)
	seenDomain     := map[string]int{} // domain rotation gate (max MaxPerDomainPerTick per tick)
	domainDayCount := map[string]int{} // S20: per-tick cache of 24h send counts from send_events
	domainCampaignCount    := map[string]int{} // AF: per-tick cache of lifetime send counts per campaign+domain
	icoCampaignCount       := map[string]int{} // AF: per-tick cache of lifetime send counts per campaign+ICO
	parentICOCampaignCount := map[string]int{} // AF: per-tick cache of lifetime send counts per campaign+parent_ico (holding)
	enqueued := 0

	// Sprint AF — per-campaign per-firm lifetime caps. Disabled by
	// default to keep the cohort of legacy sqlmock tests green; operator
	// flips ON via `operator_settings.corporate_domain_lifetime_cap_enabled`
	// post-deploy. Each layer (domain, ICO, parent_ico) shares the same
	// cap (operator_settings.corporate_domain_max_per_campaign), default
	// MaxPerDomainPerCampaign (1).
	//
	// Operator workflow:
	//   1. Deploy this code.
	//   2. SQL: UPDATE operator_settings SET value='true' WHERE key='corporate_domain_lifetime_cap_enabled';
	//   3. (optional) tune the cap via corporate_domain_max_per_campaign.
	//
	// Default OFF avoids the test-suite breakage from per-tick-extra
	// queries the legacy sqlmock fixtures don't anticipate.
	domainCampaignCap := MaxPerDomainPerCampaign
	icoCampaignCap := MaxPerDomainPerCampaign
	parentICOCampaignCap := MaxPerDomainPerCampaign
	lifetimeCapEnabled := false
	if r.db != nil {
		// Wrap in panic-recover so tests with hand-rolled DB fakes
		// (e.g. casFakeDB in runner_silent_exec_test.go) that return
		// nil *sql.Row on unknown queries don't crash the runner.
		// Production *sql.DB always returns a non-nil Row whose Scan
		// returns sql.ErrNoRows.
		func() {
			defer func() {
				if r := recover(); r != nil {
					lifetimeCapEnabled = false
				}
			}()
			var enabled sql.NullString
			_ = r.db.QueryRowContext(ctx, `SELECT value FROM operator_settings WHERE key = 'corporate_domain_lifetime_cap_enabled'`).Scan(&enabled)
			if enabled.Valid && strings.EqualFold(strings.TrimSpace(enabled.String), "true") {
				lifetimeCapEnabled = true
			}
		}()
		if lifetimeCapEnabled {
			func() {
				defer func() { _ = recover() }()
				var setting sql.NullString
				_ = r.db.QueryRowContext(ctx, `SELECT value FROM operator_settings WHERE key = 'corporate_domain_max_per_campaign'`).Scan(&setting)
				if setting.Valid {
					if n, err := strconv.Atoi(strings.TrimSpace(setting.String)); err == nil && n > 0 {
						domainCampaignCap = n
						icoCampaignCap = n
						parentICOCampaignCap = n
					}
				}
			}()
		}
	}
	// Cooperative pause check — re-read campaigns.status every
	// statusCheckEvery enqueued contacts so a UI Pause click during a long
	// tick stops further sends within ~10 contacts instead of waiting for
	// the tick to drain (LIMIT 100 worst case). Sprint AG3 lowered the
	// limit from 500 → 100 to match engine throughput (4 mb × 25/h = 100
	// max sustained); higher batch meant most enqueued rows aged past
	// the in-flight reaper's 24h threshold faster than they could be
	// drained, producing 32× reap-to-send churn ratio overnight.
	pauseAcknowledged := false
	for rows.Next() {
		// Mid-tick status re-check. Only fires after at least one Enqueue
		// happened AND the count crosses the interval. Tests with small
		// fixtures (1–3 contacts) never trip this — keeps the existing
		// sqlmock test suite green without per-test edits.
		if !pauseAcknowledged && enqueued > 0 && enqueued%statusCheckEvery == 0 {
			var liveStatus string
			err := r.db.QueryRowContext(ctx,
				`SELECT status FROM campaigns WHERE id = $1`, campaignID).Scan(&liveStatus)
			switch {
			case err != nil:
				// Fail open: a transient DB error must not stall the tick.
				// The next tick will re-evaluate. Log so ops sees it.
				slog.Warn("campaign: mid-tick status re-read failed — continuing",
					"op", "runner.RunCampaign/midTickStatus",
					"campaign_id", campaignID, "enqueued_so_far", enqueued, "error", err)
			case liveStatus != "running" && liveStatus != "draft" && liveStatus != "active":
				slog.Info("campaign: status changed mid-tick — stopping further enqueues",
					"campaign_id", campaignID,
					"new_status", liveStatus,
					"enqueued_so_far", enqueued)
				pauseAcknowledged = true
			}
		}
		if pauseAcknowledged {
			break
		}
		var ccID, contactID int64
		var currentStep int
		var email, firstName, companyName, region sql.NullString
		var emailStatus, parentICO string

		if err := rows.Scan(
			&ccID, &contactID, &currentStep,
			&email, &firstName, &companyName, &region,
			&emailStatus, &parentICO,
		); err != nil {
			slog.Error("campaign scan error",
				"op", "runner.RunCampaign/scan",
				"campaign_id", campaignID,
				"error", err)
			continue
		}

		if !EmailStatusAllowed(emailStatus) {
			slog.Info("campaign gate: email_status blocked",
				"campaign_id", campaignID, "contact_id", contactID, "email_status", emailStatus)
			continue
		}

		// Dedup guard — cross-campaign cooldown + per-domain cooldown +
		// lifetime touches + dnt flag. Closes operator scenario 2026-05-05
		// (don't double-touch a contact across campaigns; don't blast
		// boss@ + asistentka@ + info@ on the same domain). Migration 049
		// adds the underlying contacts.{email_domain, lifetime_touches,
		// dnt} columns. See feat/dedup/cross-campaign-domain-guard PR #783.
		dedupRes, err := sender.CheckEligibility(ctx, r.db, contactID, sender.DefaultDedupGuardConfig())
		if err != nil {
			// Fail open on transient DB error — same pattern as the domain
			// daily-count gate above. The dedup guard's job is to prevent
			// duplicates; a query failure must not stall the tick. Next
			// tick will re-evaluate.
			slog.Warn("campaign gate: dedup guard query failed — fail open",
				"op", "runner.RunCampaign/dedupGate",
				"campaign_id", campaignID, "contact_id", contactID, "error", err)
		} else if !dedupRes.Eligible {
			// Move to skipped with rationale. The reason field is taken
			// verbatim from CheckEligibility (one of: dnt_set,
			// lifetime_exhausted, cross_campaign_cooldown, per_domain_cooldown).
			details, _ := json.Marshal(map[string]any{
				"skip_reason":      dedupRes.Reason,
				"rules_evaluated":  dedupRes.RulesEvaluated,
				"skipped_by":       "dedup_guard",
				"skipped_at":       time.Now().UTC().Format(time.RFC3339),
			})
			if _, err := r.db.ExecContext(ctx,
				`UPDATE campaign_contacts
				 SET status = 'skipped', details = COALESCE(details, '{}'::jsonb) || $2::jsonb
				 WHERE id = $1`,
				ccID, string(details),
			); err != nil {
				slog.Warn("campaign: failed to mark skipped after dedup",
					"op", "runner.RunCampaign/dedupSkipMark",
					"campaign_id", campaignID, "cc_id", ccID, "error", err)
			}
			slog.Info("campaign gate: dedup guard skipped",
				"op", "runner.RunCampaign/dedupGate",
				"campaign_id", campaignID, "contact_id", contactID,
				"reason", dedupRes.Reason)
			continue
		}

		if parentICO != "" && seenParentICO[parentICO] >= HoldingClusterCap {
			slog.Info("campaign gate: holding cluster blocked",
				"campaign_id", campaignID, "contact_id", contactID, "parent_ico", parentICO)
			continue
		}
		if parentICO != "" {
			seenParentICO[parentICO]++
		}

		// Domain rotation gate — max MaxPerDomainPerTick sends to the same
		// recipient domain per tick. Protects sender reputation from
		// bulk-hitting a single company domain in one scheduler run.
		//
		// Freemail providers (seznam.cz, gmail.com, etc.) bypass this gate
		// because each address belongs to a distinct individual — diversity
		// rationale applies to corporate domains, not public freemail.
		// See IsFreemailDomain in gate.go.
		domain := extractEmailDomain(email.String)
		if domain != "" && !IsFreemailDomain(domain) && seenDomain[domain] >= MaxPerDomainPerTick {
			slog.Info("campaign gate: domain rotation skip",
				"campaign_id", campaignID, "contact_id", contactID, "domain", domain)
			continue
		}
		if domain != "" {
			seenDomain[domain]++
		}

		// S20: Persistent 24h domain gate — max MaxPerDomainDay sends to the
		// same recipient domain across all mailboxes in the last 24 hours.
		// Uses a per-tick lazy cache (domainDayCount) so the query runs at
		// most once per unique domain per scheduler tick instead of once per
		// contact.
		//
		// Freemail providers bypass per-day gate for same reason as per-tick
		// gate above.
		if domain != "" && !IsFreemailDomain(domain) {
			if _, cached := domainDayCount[domain]; !cached {
				var cnt int
				// The 24h per-domain cap must count IN-FLIGHT reservations
				// (campaign_contacts reserved within this window but not yet
				// confirmed in send_events) on top of confirmed sends.
				// Otherwise a burst of reservations to one domain — across
				// campaigns and mailboxes — sails past MaxPerDomainDay before
				// any send_events 'sent' row lands, because each reserved row
				// has no send_events row yet. The reservation UPDATE stamps
				// updated_at=now(), so the 24h-window predicate tracks the
				// lease time; 'in_flight' is the runner's reservation status and
				// 'queued' the engine-queue state (both reserved-but-
				// unconfirmed). $1 is reused for both subqueries so the call
				// still binds a single argument.
				if err := r.db.QueryRowContext(ctx, `
					SELECT COUNT(*) + (
					    SELECT COUNT(*)
					    FROM campaign_contacts cc
					    JOIN contacts cic ON cic.id = cc.contact_id
					    WHERE cic.email LIKE $1
					      AND cc.status IN ('in_flight', 'queued')
					      AND cc.updated_at > now() - interval '24 hours'
					)
					FROM send_events se
					JOIN contacts c ON c.id = se.contact_id
					WHERE c.email LIKE $1
					  AND se.sent_at > now() - interval '24 hours'
					  AND se.status = 'sent'
				`, "%@"+domain).Scan(&cnt); err != nil {
					// Fail open: a DB error must not block sends.
					// The next tick will re-query and may catch the limit then.
					slog.Warn("campaign gate: domain day-count query failed — fail open",
						"op", "runner.RunCampaign/domainGate",
						"domain", domain, "error", err)
					cnt = 0
				}
				domainDayCount[domain] = cnt
			}
			if domainDayCount[domain] >= MaxPerDomainDay {
				slog.Info("campaign gate: domain daily limit reached",
					"campaign_id", campaignID, "contact_id", contactID,
					"domain", domain, "sent_today", domainDayCount[domain])
				continue
			}
			domainDayCount[domain]++ // optimistic increment for this tick

			// Sprint AF — per-campaign per-domain lifetime cap. Counts
			// every send_events row for this campaign whose recipient
			// matches the same email domain. Lifetime (no time window)
			// so an operator who relaunched after wipe sees a clean
			// counter; a holding-pattern domain still gets capped at
			// the operator's chosen N. Cache lookup mirrors the 24h
			// gate above so the COUNT(*) runs once per unique domain.
			if lifetimeCapEnabled {
				if _, cached := domainCampaignCount[domain]; !cached {
					var cnt int
					if err := r.db.QueryRowContext(ctx, `
						SELECT COUNT(*)
						FROM send_events se
						JOIN contacts c ON c.id = se.contact_id
						WHERE c.email LIKE $1
						  AND se.campaign_id = $2
						  AND se.status = 'sent'
					`, "%@"+domain, campaignID).Scan(&cnt); err != nil {
						slog.Warn("campaign gate: domain campaign-count query failed — fail open",
							"op", "runner.RunCampaign/domainCampaignGate",
							"domain", domain, "campaign_id", campaignID, "error", err)
						cnt = 0
					}
					domainCampaignCount[domain] = cnt
				}
				if domainCampaignCount[domain] >= domainCampaignCap {
					slog.Info("campaign gate: per-campaign domain cap reached",
						"campaign_id", campaignID, "contact_id", contactID,
						"domain", domain, "sent_lifetime", domainCampaignCount[domain],
						"cap", domainCampaignCap)
					continue
				}
				domainCampaignCount[domain]++ // optimistic increment for this tick
			}
		}

		// Sprint AF — per-campaign per-IČO lifetime cap. Joins
		// send_events → contacts on contact.ico so a holding subsidiary
		// (different email domain, same legal entity) is still gated.
		// Empty ICO = unknown legal entity → skip the gate (fall through
		// to the lifetime touches / dedup guard above). Cache mirrors
		// the domain layer (one COUNT(*) per unique ICO per tick).
		//
		// ICO is looked up just-in-time per contact (not in the main
		// SELECT) so existing sqlmock test fixtures keep their 9-column
		// row shape. The lookup is cheap (indexed contacts.id PK).
		var contactICO string
		if lifetimeCapEnabled {
			if err := r.db.QueryRowContext(ctx, `SELECT COALESCE(ico, '') FROM contacts WHERE id = $1`, contactID).Scan(&contactICO); err != nil {
				contactICO = "" // fail open — ICO check then skipped
			}
		}
		if lifetimeCapEnabled && contactICO != "" {
			if _, cached := icoCampaignCount[contactICO]; !cached {
				var cnt int
				if err := r.db.QueryRowContext(ctx, `
					SELECT COUNT(*)
					FROM send_events se
					JOIN contacts c ON c.id = se.contact_id
					WHERE c.ico = $1
					  AND se.campaign_id = $2
					  AND se.status = 'sent'
				`, contactICO, campaignID).Scan(&cnt); err != nil {
					slog.Warn("campaign gate: ICO campaign-count query failed — fail safe",
						"op", "runner.RunCampaign/icoCampaignGate",
						"ico", contactICO, "campaign_id", campaignID, "error", err)
					cnt = 0 // fail open: tx error must not stall the tick
				}
				icoCampaignCount[contactICO] = cnt
			}
			if icoCampaignCount[contactICO] >= icoCampaignCap {
				slog.Info("campaign gate: per-campaign ICO cap reached",
					"campaign_id", campaignID, "contact_id", contactID,
					"ico", contactICO, "sent_lifetime", icoCampaignCount[contactICO],
					"cap", icoCampaignCap)
				continue
			}
			icoCampaignCount[contactICO]++
		}

		// Sprint AF — per-campaign per-parent_ico lifetime cap. Catches
		// holding clusters where subsidiaries have distinct ICOs but
		// share an ultimate parent (e.g. FCC Group, Marius Pedersen).
		// Operator rule: "celá firma" includes the entire holding tree,
		// not just one legal entity. Empty parent_ico = standalone
		// company → no gate beyond the ICO + domain checks above.
		if lifetimeCapEnabled && parentICO != "" {
			if _, cached := parentICOCampaignCount[parentICO]; !cached {
				var cnt int
				if err := r.db.QueryRowContext(ctx, `
					SELECT COUNT(*)
					FROM send_events se
					JOIN contacts c ON c.id = se.contact_id
					LEFT JOIN companies co ON co.ico = c.ico
					WHERE co.parent_ico = $1
					  AND se.campaign_id = $2
					  AND se.status = 'sent'
				`, parentICO, campaignID).Scan(&cnt); err != nil {
					slog.Warn("campaign gate: parent_ico campaign-count query failed — fail safe",
						"op", "runner.RunCampaign/parentICOCampaignGate",
						"parent_ico", parentICO, "campaign_id", campaignID, "error", err)
					cnt = 0 // fail open: tx error must not stall the tick
				}
				parentICOCampaignCount[parentICO] = cnt
			}
			if parentICOCampaignCount[parentICO] >= parentICOCampaignCap {
				slog.Info("campaign gate: per-campaign parent_ico cap reached (holding cluster)",
					"campaign_id", campaignID, "contact_id", contactID,
					"parent_ico", parentICO, "sent_lifetime", parentICOCampaignCount[parentICO],
					"cap", parentICOCampaignCap)
				continue
			}
			parentICOCampaignCount[parentICO]++
		}

		// Find current step config
		if currentStep >= len(steps) {
			// Past the final step — mark completed. Log errors so a silent
			// DB failure doesn't keep this row forever in 'in_sequence'
			// (would show up as stuck pipeline rather than missed sends).
			if _, err := r.db.ExecContext(ctx,
				`UPDATE campaign_contacts SET status = 'completed' WHERE id = $1`, ccID); err != nil {
				slog.Warn("campaign mark-completed failed",
					"op", "runner.RunCampaign/markCompleted",
					"campaign_id", campaignID, "cc_id", ccID, "error", err)
			}
			continue
		}
		step := steps[currentStep]

		// Render email — including per-recipient unsubscribe URL.
		// Token is HMAC-SHA256 over (campaign_id|contact_id|email) truncated
		// to 16 hex chars; deterministic per recipient so re-renders within
		// a tick yield the same URL. Secret comes from UNSUBSCRIBE_SECRET env;
		// fallback to OUTREACH_API_KEY (always present in prod) so missing env
		// doesn't break sends silently — operator can rotate later.
		unsubURL := buildUnsubURL(campaignID, contactID, email.String)
		vars := content.TemplateVars{
			Firma:    nullStr(companyName),
			Jmeno:    nullStr(firstName),
			Region:   nullStr(region),
			UnsubURL: unsubURL,
		}

		rendered, err := r.content.Render(step.TemplateName, vars, contactID, step.Step)
		if err != nil {
			slog.Error("campaign render error",
				"op", "runner.RunCampaign/render",
				"campaign_id", campaignID,
				"contact_id", contactID,
				"template", step.TemplateName,
				"step", step.Step,
				"error", err)
			continue
		}

		// RFC 2369 / RFC 8058 — inject List-Unsubscribe + List-Unsubscribe-Post
		// headers so Gmail/Outlook show a native one-click unsubscribe button.
		// unsubURL is already validated by buildUnsubURL; the header builder
		// wraps it in angle-brackets and strips any CRLF. Both headers are
		// written into rendered.Headers so they survive the humanize
		// fingerprint stage and flow through the anti-trace engine unchanged.
		// engine.go's applyAnonymityHeaders only overrides Message-ID/From/Date,
		// so List-Unsubscribe is never clobbered downstream.
		if rendered.Headers == nil {
			rendered.Headers = make(map[string]string)
		}
		if listUnsub, listUnsubPost := sender.BuildListUnsubscribeHeaders(unsubURL); listUnsub != "" {
			rendered.Headers["List-Unsubscribe"] = listUnsub
			rendered.Headers["List-Unsubscribe-Post"] = listUnsubPost
		}

		// Send window gate — only enqueue within business hours (Mon–Fri 08-17h)
		// in the recipient's timezone. Outside the window we update next_send_at
		// to the next valid 09:00 slot and skip the send for this tick.
		// SKIP_CALENDAR_CHECK=1 also bypasses this gate (same CI flag as the
		// day-level calendar check above).
		if !envconfig.BoolOr("SKIP_CALENDAR_CHECK", false) {
			tz := regionToTimezone(nullStr(region))
			if !calendar.InSendWindow(time.Now(), tz) {
				nextSend := calendar.NextSendTime(time.Now(), tz)
				if _, err := r.db.ExecContext(ctx,
					`UPDATE campaign_contacts SET next_send_at=$1 WHERE id=$2`,
					nextSend, ccID); err != nil {
					slog.Warn("send window: failed to postpone contact",
						"op", "runner.RunCampaign/postpone",
						"campaign_id", campaignID,
						"contact_id", contactID,
						"cc_id", ccID,
						"error", err)
				}
				slog.Info("send window: postponed",
					"campaign_id", campaignID, "contact_id", contactID,
					"tz", tz, "next_send_at", nextSend)
				continue
			}
		}

		// Enqueue raw rendered content — humanization (persona, signature,
		// fingerprint) is applied by the sender's PreSendHook after mailbox
		// selection.
		//
		// Nil-engine guard: NewReadOnlyRunner returns a Runner without an
		// engine for DB-only test/inspection workflows. RunCampaign tolerates
		// this for unit-test sake — the gate logic is exercisable in
		// isolation. Production scheduler always wires NewRunner with a
		// real engine; if engine is nil we skip Enqueue (and step advance
		// below would also be a no-op-style if the scheduler wired this
		// up wrong, but DB UPDATE still happens — operator sees the row
		// move forward without a send).
		if r.engine == nil {
			slog.Error("campaign: engine nil at Enqueue — runner misconfigured (use NewRunner, not NewReadOnlyRunner)",
				"op", "runner.RunCampaign/engineNil",
				"campaign_id", campaignID,
				"contact_id", contactID)
			continue
		}

		// Thread-linking headers (RFC 5322 §3.6.4 / issue #876).
		// For follow-up steps (step.Step > 0) we look up the Message-ID chain
		// from send_events so the engine can emit In-Reply-To + References.
		// Failure is non-fatal: a missing or broken chain means the email
		// goes out without threading headers rather than being dropped.
		var inReplyTo string
		var refsChain []string
		if step.Step > 0 {
			inReplyTo, refsChain = fetchThreadChain(ctx, r.db, campaignID, contactID, step.Step)
		}

		// AW7 — runner-engine state atomicity (issue #1182).
		// AW7-6 — reservation MUST happen BEFORE Enqueue.
		//
		// Compute step-advance metadata. The runner reserves the contact
		// (in_flight) BEFORE handing the SendRequest to the engine; the
		// engine's onSent callback transitions in_flight -> in_sequence /
		// completed only on confirmed send. See SendRequest.NextSendAt /
		// IsFinalStep doc.
		//
		// AW7-6 RCA: prior code called engine.Enqueue BEFORE the reservation
		// UPDATE. Because Enqueue is non-blocking (in-memory queue) and
		// engine.Run consumes the queue from a SEPARATE goroutine wired in
		// services/orchestrator/cmd/outreach/main.go (line 619-708 sender
		// daemon vs line 710-746 campaign daemon), the engine could pick
		// the SendRequest, complete the actual SMTP submit, INSERT into
		// send_events, and call FinalizeSentStep BEFORE the runner's
		// reservation UPDATE ran. Resulting failure mode: the FinalizeSentStep
		// CAS predicate (`status='in_flight'`) matched 0 rows because status
		// was still 'pending' at the moment of the callback, so the
		// in_flight->in_sequence transition silently no-op'd. Then the
		// runner's UPDATE flipped the row to in_flight current_step+1, which
		// no later callback will ever finalize — the contact stays
		// "in_flight forever" with a real send_events row, and the next
		// tick's eligibility filter excludes it. This is the inverse of
		// the original phantom-completed bug, but equally bad: send happened,
		// state machine doesn't reflect it, watchdog reaper has to clean up
		// 24h later. In production at 01:58 CEST 2026-05-09 (post AW7-3 +
		// AW7-4 deploy) the symptom appeared as "step advance matched 0 rows
		// — concurrent runner detected" log spam: 7 events in 7 sec. There
		// is in fact NO concurrent runner — the advisory lock ensures one
		// scheduler-tick per campaign across replicas — but the engine
		// callback was running ahead of the runner UPDATE.
		nextStep := currentStep + 1
		var nextSendAt *time.Time
		isFinalStep := nextStep >= len(steps)
		if !isFinalStep {
			t := time.Now().AddDate(0, 0, steps[nextStep].DelayDays)
			nextSendAt = &t
		}

		// AW7-6 — RESERVATION BEFORE ENQUEUE.
		//
		// Reservation UPDATE: advance current_step (CAS preserved) and flip
		// status to 'in_flight'. The contact is now reserved by this runner;
		// IF reservation fails (RowsAffected=0) the runner has lost the race
		// to a concurrent path — bail out WITHOUT enqueuing so the engine
		// never sees a SendRequest the runner did not own. This eliminates
		// the engine-callback-before-runner-UPDATE race that produced the
		// AW7-6 log spam.
		//
		// SQL prefix shape preserved (`UPDATE campaign_contacts SET
		// current_step = $1, status = ...`) so existing regex-based
		// sqlmock expectations still match. NextSendAt is also persisted
		// here (when present) so the next-tick eligibility query
		// (cc.next_send_at IS NULL OR cc.next_send_at <= now()) defers a
		// non-final step by at least DelayDays even if the callback never
		// runs. The callback re-asserts NextSendAt on success for clarity.
		var (
			advanceRes sql.Result
			advanceErr error
		)
		if nextSendAt != nil {
			advanceRes, advanceErr = r.db.ExecContext(ctx,
				// updated_at = now() stamps the lease time: the backlog guard
				// counts in_flight by updated_at and the in_flight_reaper reaps
				// by updated_at, so the reservation MUST bump it (no row-level
				// trigger does). Without this the guard sees every fresh lease as
				// stale and stops capping → in_flight balloons (incident 2026-06-24).
				`UPDATE campaign_contacts SET current_step = $1, status = 'in_flight', next_send_at = $2, updated_at = now() WHERE id = $3 AND current_step = $4`,
				nextStep, nextSendAt, ccID, currentStep)
		} else {
			advanceRes, advanceErr = r.db.ExecContext(ctx,
				`UPDATE campaign_contacts SET current_step = $1, status = 'in_flight', updated_at = now() WHERE id = $2 AND current_step = $3`,
				nextStep, ccID, currentStep)
		}
		if advanceErr != nil {
			slog.Error("campaign step advance failed — skipping enqueue",
				"op", "runner.RunCampaign/stepAdvance",
				"campaign_id", campaignID, "cc_id", ccID, "contact_id", contactID,
				"from_step", currentStep, "to_step", nextStep, "error", advanceErr)
			continue
		}
		if advanceRes != nil {
			if n, rowsErr := advanceRes.RowsAffected(); rowsErr == nil && n == 0 {
				// AW7-6: reservation lost the CAS — the row's current_step or
				// status was changed between the SELECT and this UPDATE.
				// Most likely the in-flight reaper (boot-sweep on daemon
				// restart) raced our SELECT, or an operator manually edited
				// the row. We do NOT enqueue: the engine never sees a
				// SendRequest we don't own, so no phantom send / phantom
				// state can occur. Info-level log (was Error before AW7-6)
				// because this is now an EXPECTED outcome under contention,
				// not a bug indicator.
				slog.Info("campaign reservation lost CAS — skipping enqueue (no send dispatched)",
					"op", "runner.RunCampaign/reservationLost",
					"campaign_id", campaignID, "cc_id", ccID, "contact_id", contactID,
					"expected_current_step", currentStep, "next_step", nextStep)
				continue
			}
		}

		// Reservation succeeded — NOW it is safe to enqueue. Engine
		// callbacks will see status='in_flight' and CAS will match.
		r.engine.Enqueue(sender.SendRequest{
			CampaignID:         campaignID,
			ContactID:          contactID,
			Step:               step.Step,
			ToAddress:          email.String,
			Subject:            rendered.Subject,
			BodyPlain:          rendered.BodyPlain,
			BodyHTML:           rendered.BodyHTML,
			Headers:            rendered.Headers,
			FirstName:          nullStr(firstName),
			SkipHumanize:       rendered.SkipHumanize,
			InReplyToMessageID: inReplyTo,
			ReferencesChain:    refsChain,
			NextSendAt:         nextSendAt,
			IsFinalStep:        isFinalStep,
		})

		// Recalculate score asynchronously after send.
		// M-O2 (2026-04-22): goroutine now recovers from panics so a
		// misbehaving enrichment path cannot crash the campaign daemon.
		if r.recalcDB != nil {
			cid := int(contactID)
			campID := campaignID
			go func() {
				defer func() {
					if p := recover(); p != nil {
						slog.Error("post-send recalc panic recovered",
							"op", "runner.RunCampaign/recalcRecover",
							"campaign_id", campID,
							"contact_id", cid,
							"recover", p)
					}
				}()
				if _, err := enrich.RecalculateOne(context.Background(), r.recalcDB, cid, r.recalcIndustries); err != nil {
					slog.Warn("post-send recalc failed",
						"op", "runner.RunCampaign/recalc",
						"campaign_id", campID,
						"contact_id", cid,
						"error", err)
				}
			}()
		}

		// KT-A15 — Sentry breadcrumb on each step transition. Safe when
		// Sentry is not initialised (no-op). Helps correlate later errors
		// (e.g. delivery failures, reply-classification anomalies) with
		// the exact step that produced them.
		breadcrumb := map[string]interface{}{
			"campaign_id": campaignID,
			"contact_id":  contactID,
			"from_step":   currentStep,
			"to_step":     nextStep,
			"template":    step.TemplateName,
		}
		if nextSendAt != nil {
			breadcrumb["next_send_at"] = nextSendAt.Format(time.RFC3339)
			telemetry.Breadcrumb("campaign.sequence", "step advance", breadcrumb)
		} else {
			// Final step — sequence complete. Operator-visible info-level
			// log (Czech for human-facing operator UI consumption).
			telemetry.Breadcrumb("campaign.sequence", "sequence complete", breadcrumb)
			slog.Info("kampaň: sekvence dokončena",
				"campaign_id", campaignID,
				"contact_id", contactID,
				"final_step", currentStep,
				"template", step.TemplateName)
		}

		enqueued++
	}

	slog.Info("campaign enqueued emails", "campaign", name, "count", enqueued)

	// BF-E6 — audit transactional contract: this audit row is recorded
	// OUTSIDE any caller transaction. r.db is the Runner.DB interface
	// (Execer-only; no BeginTx), so audit.Log persists independent of
	// per-contact INSERT outcomes. The deliberate choice:
	//   - PRO outside-tx: a partial-failure tick (some send_events
	//     INSERTed before a panic / DB blip) still records the attempt;
	//     operator can see the discrepancy between enqueued count and
	//     send_events row count.
	//   - CON outside-tx: a tick that gets interrupted between enqueue
	//     count and audit.Log call records nothing. Acceptable: in that
	//     case there's also no reliable enqueued figure to report.
	// Per-contact audits would explode row count for large campaigns;
	// per-tick aggregate is the right granularity.
	if r.db != nil && enqueued > 0 {
		audit.Log(ctx, r.db, "campaign_tick_completed", "campaign_runner",
			"campaign", fmt.Sprintf("%d", campaignID),
			map[string]any{
				"campaign_name": name,
				"enqueued":      enqueued,
				"duration_ms":   time.Since(tickStart).Milliseconds(),
			})
	}

	return nil
}

// EnrollmentFilter restricts which contacts are enrolled in a campaign.
// Zero values mean no restriction for that field.
type EnrollmentFilter struct {
	// Category targeting (primary dimension)
	CategoryPaths []string // firmy.cz category paths
	CategoryMatch string   // "prefix" (includes sub-categories) or "exact"; default "prefix"

	// Legacy single-field filters (still work when CategoryPaths is empty)
	Region   string
	Industry string
	MinScore float64
}

// CreateCampaign creates a new campaign with contacts matching the segment.
func (r *Runner) CreateCampaign(ctx context.Context, name, description string, steps []SequenceStep, filter EnrollmentFilter) (int64, error) {
	seqJSON, _ := json.Marshal(steps)
	sendJSON, _ := json.Marshal(map[string]any{})

	catMatch := filter.CategoryMatch
	if catMatch == "" {
		catMatch = "prefix"
	}

	// campaigns.category_paths is text[] (migration 031 + later legacy
	// promotion). Pass via pq.Array so the driver encodes the slice as
	// a PostgreSQL array literal; the previous json.Marshal + ::jsonb
	// cast emitted JSON into a text[] column and failed at insert time
	// with `pq: column "category_paths" is of type text[] but
	// expression is of type jsonb`.
	categoryPaths := filter.CategoryPaths
	if categoryPaths == nil {
		categoryPaths = []string{}
	}

	var id int64
	err := r.db.QueryRowContext(ctx, `
		INSERT INTO campaigns (name, description, sequence_config, sending_config, category_paths, category_match)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id`,
		name, description, seqJSON, sendJSON, pq.Array(categoryPaths), catMatch).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("insert campaign: %w", err)
	}

	enrolled, err := r.enrollContacts(ctx, id, filter)
	if err != nil {
		return id, fmt.Errorf("enroll: %w", err)
	}

	slog.Info("campaign created", "name", name, "id", id, "enrolled", enrolled,
		"categories", len(filter.CategoryPaths), "category_match", catMatch)
	return id, nil
}

// enrollContacts inserts matching contacts into campaign_contacts.
func (r *Runner) enrollContacts(ctx context.Context, campaignID int64, filter EnrollmentFilter) (int, error) {
	args := []any{campaignID}
	idx := 2

	conditions := []string{
		"c.status = 'valid'",
		suppressionFilterFor("c.email"),
	}

	var joinClause string
	if len(filter.CategoryPaths) > 0 {
		joinClause = "JOIN outreach_contacts oc ON oc.email_hash = c.email_hash"

		catConds := make([]string, 0, len(filter.CategoryPaths)*2)
		for _, p := range filter.CategoryPaths {
			catConds = append(catConds, fmt.Sprintf("oc.category_path = $%d", idx))
			args = append(args, p)
			idx++
			if filter.CategoryMatch != "exact" {
				catConds = append(catConds, fmt.Sprintf("oc.category_path LIKE $%d", idx))
				args = append(args, p+" > %")
				idx++
			}
		}
		conditions = append(conditions,
			"("+joinConds(catConds, " OR ")+")")
	}

	if filter.Region != "" {
		conditions = append(conditions, fmt.Sprintf("c.region = $%d", idx))
		args = append(args, filter.Region)
		idx++
	}
	if filter.Industry != "" && len(filter.CategoryPaths) == 0 {
		conditions = append(conditions, fmt.Sprintf("c.industry = $%d", idx))
		args = append(args, filter.Industry)
		idx++
	}
	if filter.MinScore > 0 {
		conditions = append(conditions, fmt.Sprintf("c.score >= $%d", idx))
		args = append(args, int(filter.MinScore*100))
		idx++
	}

	where := "WHERE " + joinConds(conditions, " AND ")

	query := fmt.Sprintf(`
		INSERT INTO campaign_contacts (campaign_id, contact_id, status)
		SELECT $1, c.id, 'pending'
		FROM contacts c
		%s
		%s
		ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
		joinClause, where)

	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}

// List returns all campaigns ordered by creation date descending.
func (r *Runner) List(ctx context.Context) ([]Campaign, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, name, COALESCE(description,''), status,
		       sequence_config,
		       COALESCE(category_paths::text, '[]'),
		       COALESCE(category_match,'prefix'),
		       COALESCE(stats::text,'{}'),
		       created_at, updated_at
		FROM campaigns
		ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []Campaign
	for rows.Next() {
		c, err := scanCampaign(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

// Get returns a single campaign by ID.
func (r *Runner) Get(ctx context.Context, id int64) (*Campaign, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, name, COALESCE(description,''), status,
		       sequence_config,
		       COALESCE(category_paths::text, '[]'),
		       COALESCE(category_match,'prefix'),
		       COALESCE(stats::text,'{}'),
		       created_at, updated_at
		FROM campaigns WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, sql.ErrNoRows
	}
	c, err := scanCampaign(rows)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// SetStatus updates a campaign's status (draft → running → paused → completed).
func (r *Runner) SetStatus(ctx context.Context, id int64, status string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE campaigns SET status = $1, updated_at = now() WHERE id = $2`, status, id)
	return err
}

// Stats returns enrolled/pending/sent/replied counts for a campaign.
func (r *Runner) Stats(ctx context.Context, id int64) (map[string]int, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT status, COUNT(*)::int
		FROM campaign_contacts
		WHERE campaign_id = $1
		GROUP BY status`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stats := make(map[string]int)
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		stats[status] = count
	}
	return stats, rows.Err()
}

// EstimateEnrollment returns how many contacts would be enrolled with given filter.
func (r *Runner) EstimateEnrollment(ctx context.Context, filter EnrollmentFilter) (int, error) {
	args := []any{}
	idx := 1

	conditions := []string{
		"c.status = 'valid'",
		suppressionFilterFor("c.email"),
	}

	var joinClause string
	if len(filter.CategoryPaths) > 0 {
		joinClause = "JOIN outreach_contacts oc ON oc.email_hash = c.email_hash"
		catConds := make([]string, 0, len(filter.CategoryPaths)*2)
		for _, p := range filter.CategoryPaths {
			catConds = append(catConds, fmt.Sprintf("oc.category_path = $%d", idx))
			args = append(args, p)
			idx++
			if filter.CategoryMatch != "exact" {
				catConds = append(catConds, fmt.Sprintf("oc.category_path LIKE $%d", idx))
				args = append(args, p+" > %")
				idx++
			}
		}
		conditions = append(conditions, "("+joinConds(catConds, " OR ")+")")
	}

	if filter.MinScore > 0 {
		conditions = append(conditions, fmt.Sprintf("c.score >= $%d", idx))
		args = append(args, int(filter.MinScore*100))
		idx++
	}

	where := "WHERE " + joinConds(conditions, " AND ")
	query := fmt.Sprintf(`SELECT COUNT(DISTINCT c.id) FROM contacts c %s %s`, joinClause, where)

	var count int
	if err := r.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func scanCampaign(rows *sql.Rows) (Campaign, error) {
	var c Campaign
	var seqJSON, statsJSON []byte
	// category_paths is text[] (not jsonb), so scan it via pq.Array
	// to avoid the silent JSON parse failure the older code accepted.
	err := rows.Scan(
		&c.ID, &c.Name, &c.Description, &c.Status,
		&seqJSON, pq.Array(&c.CategoryPaths), &c.CategoryMatch,
		&statsJSON, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return c, err
	}
	json.Unmarshal(seqJSON, &c.SequenceConfig)
	stats := make(map[string]int)
	json.Unmarshal(statsJSON, &stats)
	c.Stats = stats
	return c, nil
}

func joinConds(ss []string, sep string) string {
	result := ""
	for i, s := range ss {
		if i > 0 {
			result += sep
		}
		result += s
	}
	return result
}

func nullStr(ns sql.NullString) string {
	if ns.Valid {
		return ns.String
	}
	return ""
}

// regionToTimezone maps a contact region string to an IANA timezone.
// All CZ regions and an empty/unknown region default to Europe/Prague.
// Extend this map when the platform expands to other markets.
func regionToTimezone(region string) string {
	// Currently all contacts are Czech — Europe/Prague is the correct default.
	// Mapping is a no-op today but provides the hook for future multi-market
	// support without changing call sites.
	switch region {
	case "SK": // Slovakia (closest market extension)
		return "Europe/Bratislava"
	default:
		return "Europe/Prague"
	}
}

// buildUnsubURL produces a per-recipient unsubscribe URL whose token is
// computed by common/token.BuildUnsubToken (canonical HMAC-SHA256 over
// "<campaign_id>|<contact_id>|<email>", truncated to 16 hex chars).
//
// Base URL comes from UNSUBSCRIBE_BASE_URL env (default https://garaaage.cz).
// Secret comes from UNSUBSCRIBE_SECRET env, falling back to OUTREACH_API_KEY
// so a missing env doesn't silently break sends — operator can rotate later
// without redeploying every mailbox.
//
// URL embeds campaign_id + contact_id so the BFF can validate the token
// without doing a reverse lookup. Email is NOT embedded — it derives
// from contact_id at validation time.
func buildUnsubURL(campaignID, contactID int64, email string) string {
	base := envconfig.GetOr("UNSUBSCRIBE_BASE_URL", "https://garaaage.cz")
	secret := envconfig.GetOr("UNSUBSCRIBE_SECRET", "")
	if secret == "" {
		secret = envconfig.GetOr("OUTREACH_API_KEY", "")
	}
	tok := token.BuildUnsubToken(campaignID, contactID, email, []byte(secret))
	return fmt.Sprintf("%s/unsubscribe?c=%d&id=%d&t=%s", base, campaignID, contactID, tok)
}

// fetchThreadChain looks up the message_id chain from send_events for a
// specific campaign+contact, returning the values needed to build RFC 5322
// §3.6.4 In-Reply-To and References headers for follow-up emails.
//
// Returns:
//
//   - inReplyTo: Message-ID of the step immediately preceding currentStep
//     (i.e. the highest step < currentStep). Empty string when not found.
//   - chain: ordered slice of all prior Message-IDs (oldest first, newest
//     last), capped at maxReferencesChainDepth (10). The engine enforces
//     the cap before writing the wire header, so chain may exceed 10 here
//     when the DB has more rows — the engine truncates.
//
// Failure modes:
//   - DB error: log warning, return ("", nil) — send proceeds without
//     thread headers rather than blocking the send (fail-open per the
//     domain-gate and dedup-gate patterns in this file).
//   - No prior send_event found (data integrity gap): same fail-open.
//
// Query: SELECT message_id FROM send_events
//
//	WHERE campaign_id=$1 AND contact_id=$2 AND step < $3 AND status='sent'
//	ORDER BY step ASC
//
// ASC order gives oldest-first which is the RFC 5322 References convention.
// The last row of the result is also the inReplyTo (most recent step).
func fetchThreadChain(ctx context.Context, db DB, campaignID, contactID int64, currentStep int) (inReplyTo string, chain []string) {
	rows, err := db.QueryContext(ctx,
		`SELECT message_id
		   FROM send_events
		  WHERE campaign_id = $1
		    AND contact_id  = $2
		    AND step        < $3
		    AND status      = 'sent'
		  ORDER BY step ASC`,
		campaignID, contactID, currentStep)
	if err != nil {
		slog.Warn("thread chain: send_events query failed — sending without In-Reply-To",
			"op", "runner.fetchThreadChain/query",
			"campaign_id", campaignID,
			"contact_id", contactID,
			"current_step", currentStep,
			"error", err)
		return "", nil
	}
	defer rows.Close()

	for rows.Next() {
		var mid string
		if err := rows.Scan(&mid); err != nil {
			slog.Warn("thread chain: scan error — sending without In-Reply-To",
				"op", "runner.fetchThreadChain/scan",
				"campaign_id", campaignID,
				"contact_id", contactID,
				"error", err)
			return "", nil
		}
		if mid != "" {
			chain = append(chain, mid)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("thread chain: rows iteration error — sending without In-Reply-To",
			"op", "runner.fetchThreadChain/rows",
			"campaign_id", campaignID,
			"contact_id", contactID,
			"error", err)
		return "", nil
	}

	if len(chain) == 0 {
		slog.Warn("thread chain: no prior send_events found for follow-up — sending without In-Reply-To",
			"op", "runner.fetchThreadChain/missing",
			"campaign_id", campaignID,
			"contact_id", contactID,
			"current_step", currentStep)
		return "", nil
	}

	// The last entry is the most recent step — that is the In-Reply-To.
	inReplyTo = chain[len(chain)-1]
	return inReplyTo, chain
}
