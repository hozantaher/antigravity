package intelligence

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"common/alert"
	"contacts/ares"
	"contacts/category"
	"contacts/classify"
	"contacts/company"
	"contacts/enrichment"
	"common/envconfig"
	"common/health"
	"orchestrator/llm"
	"mailboxes/mailbox"
	"common/metrics"
	"contacts/segment"
	"common/telemetry"
	"orchestrator/thread"
	"contacts/validation"
	"mailboxes/watchdog"
)

// LoopResult summarizes one intelligence loop cycle.
type LoopResult struct {
	CategoryRefreshed       int
	StartedAt               time.Time
	Duration                time.Duration
	PausesResumed           int
	ScoresRecalculated      int
	ScoresUpdated           int
	Promoted                int
	Demoted                 int
	Blocked                 int
	Suppressed              int
	DomainsChecked          int
	DomainsFlagged          int
	DomainsRecovered        int
	CompanySynced           int
	CompanyMetrics          int64
	CategoryPathBackfilled  int
	CategoryReclassified    int
	CompaniesClassified     int
	EmailsVerified          int
	EmailsInvalid           int
	NACEReclassified        int
	NACESubReclassified     int
	ARESSynced              int
	ContactsPromoted        int
	EngagementClusters      int
	SegmentsRefreshed       int
	LLMEnrichProcessed      int
	LLMEnrichBoosted        int
	MailboxesReleased       int
}

// Config for the intelligence loop.
type Config struct {
	TargetIndustries []string
	FirmyDB          *sql.DB               // optional: firmy-cz source DB for company sync
	CompanyStore     *company.Store        // optional: enables company linking and metrics refresh
	Health           *health.Registry      // optional: reports daemon status
	Alert            *alert.Client         // optional: sends webhook notifications
	LLMClient        *llm.Client           // optional: enables LLM description enrichment
	MailboxBP        mailbox.HoldReleaser  // optional: enables auto-release of stale bounce_hold mailboxes
}

// RunOnce executes a single intelligence loop cycle.
func RunOnce(ctx context.Context, db *sql.DB, cfg Config) (*LoopResult, error) {
	start := time.Now()
	result := &LoopResult{StartedAt: start}

	slog.Info("intelligence loop started")

	// 1. Resume expired pauses
	mgr := thread.NewManager(db)
	resumed, err := mgr.ResumeExpiredPauses(ctx)
	if err != nil {
		slog.Error("intel resume pauses error", "op", "intelligence.RunOnce/resume_pauses", "error", err)
	}
	result.PausesResumed = resumed
	if resumed > 0 {
		slog.Info("intel resumed paused threads", "count", resumed)
	}

	// 1b. Expire stale threads (no activity for 30 days)
	expired, err := mgr.ExpireStaleThreads(ctx, 30)
	if err != nil {
		slog.Error("intel expire stale threads error", "op", "intelligence.RunOnce/expire_threads", "error", err)
	} else if expired > 0 {
		slog.Info("intel expired stale threads", "count", expired)
	}

	// 2. Auto-suppress from events (bounces, complaints)
	suppressed, err := enrich.AutoSuppressFromEvents(ctx, db)
	if err != nil {
		slog.Error("intel auto-suppress error", "op", "intelligence.RunOnce/auto_suppress", "error", err)
	}
	result.Suppressed = suppressed
	if suppressed > 0 {
		slog.Info("intel auto-suppressed contacts/domains", "count", suppressed)
		if cfg.Alert != nil {
			cfg.Alert.AutoSuppressed(ctx, suppressed)
		}
	}

	// 3. Domain health check
	checked, flagged, err := CheckDomainHealth(ctx, db)
	if err != nil {
		slog.Error("intel domain health error", "op", "intelligence.RunOnce/domain_health", "error", err)
	}
	result.DomainsChecked = checked
	result.DomainsFlagged = flagged
	if flagged > 0 {
		slog.Warn("intel flagged unhealthy domains", "op", "intelligence.RunOnce/domains_flagged", "flagged", flagged, "checked", checked)
		if cfg.Alert != nil {
			cfg.Alert.DomainsFlagged(ctx, flagged)
		}
	}

	// 3b. Domain auto-recovery — lift suppression for domains that have healed.
	recovered, err := RecoverSuppressedDomains(ctx, db)
	if err != nil {
		slog.Error("intel domain recovery error", "op", "intelligence.RunOnce/domain_recovery", "error", err)
	}
	if recovered > 0 {
		result.DomainsRecovered = recovered
		slog.Info("intel auto-recovered suppressed domains", "count", recovered)
	}

	// 3c. Auto-release mailboxes that have been in bounce_hold for 7+ days.
	if cfg.MailboxBP != nil {
		if released, err := autoReleaseBounceHold(ctx, db, cfg.MailboxBP, 7); err != nil {
			slog.Error("intel mailbox auto-release error", "op", "intelligence.RunOnce/mailbox_autorelease", "error", err)
		} else if released > 0 {
			result.MailboxesReleased = released
			slog.Info("intel auto-released bounce_hold mailboxes", "count", released)
		}
	}

	// 4. Recalculate targeting scores (fast SQL path — single bulk UPDATE)
	recalcResult, err := enrich.RecalculateFast(ctx, db, cfg.TargetIndustries)
	if err != nil {
		slog.Error("intel recalc error", "op", "intelligence.RunOnce/recalculate_scores", "error", err)
	} else {
		result.ScoresRecalculated = recalcResult.Total
		result.ScoresUpdated = recalcResult.Updated
		slog.Info("intel recalculated scores", "total", recalcResult.Total, "duration", recalcResult.Duration.Round(time.Second))
	}

	// 4a. Refresh company quality_tier after scores changed
	if cfg.CompanyStore != nil {
		updated, err := cfg.CompanyStore.UpdateMetrics(ctx)
		if err != nil {
			slog.Error("intel company metrics error", "op", "intelligence.RunOnce/company_metrics", "error", err)
		} else {
			result.CompanyMetrics = updated
			if updated > 0 {
				slog.Info("intel refreshed company metrics", "updated", updated)
			}
		}
	}

	// 4b. Update engagement clusters (total_opened, total_bounced, engagement_cluster)
	if updated, err := UpdateEngagementClusters(ctx, db); err != nil {
		slog.Error("intel engagement clusters error", "op", "intelligence.RunOnce/engagement_clusters", "error", err)
	} else if updated > 0 {
		result.EngagementClusters = updated
	}

	// 5. Sync companies from firmy-cz (when firmy DB is available)
	if cfg.FirmyDB != nil && cfg.CompanyStore != nil {
		syncer := company.NewSyncer(cfg.FirmyDB, db, company.SyncConfig{Incremental: true})
		syncResult, err := syncer.Run(ctx)
		if err != nil {
			slog.Error("intel company sync error", "op", "intelligence.RunOnce/company_sync", "error", err)
		} else {
			result.CompanySynced = syncResult.CompaniesUpserted
			slog.Info("intel company sync complete",
				"upserted", syncResult.CompaniesUpserted,
				"linked_firmy_id", syncResult.LinkedByFirmyID,
				"linked_ico", syncResult.LinkedByICO,
				"metrics_updated", syncResult.MetricsUpdated)
		}

		// 5a. Backfill categories_json for rows where it is still empty.
		// Upsert now populates it for new rows; this catches any remaining historical gaps.
		if backfilledJSON, err := syncer.BackfillCategoriesJSON(ctx); err != nil {
			slog.Error("intel categories_json backfill error", "op", "intelligence.RunOnce/categories_json_backfill", "error", err)
		} else if backfilledJSON > 0 {
			slog.Info("intel categories_json backfill", "updated", backfilledJSON)
		}

		// 5b. Backfill category_path for historical rows that had '' (synced before
		//     the firmy scraper populated the field). Only updates rows still empty.
		backfilled, err := syncer.BackfillCategoryPath(ctx)
		if err != nil {
			slog.Error("intel category_path backfill error", "op", "intelligence.RunOnce/category_path_backfill", "error", err)
		} else if backfilled > 0 {
			result.CategoryPathBackfilled = backfilled
			slog.Info("intel category_path backfill complete", "updated", backfilled)

			// 5b. Reset classified_at for companies that can now be classified more
			//     accurately (had category_path = '' → classified by keywords only).
			reclResult, err := classify.RunReclassifyCategory(ctx, db, 5000)
			if err != nil {
				slog.Error("intel reclassify-category error", "op", "intelligence.RunOnce/reclassify_category", "error", err)
			} else if reclResult.Candidates > 0 {
				result.CategoryReclassified = reclResult.Candidates
				slog.Info("intel category reclassify reset", "reset", reclResult.Candidates)
			}
		}

		// 5c. Classify any unclassified companies (classified_at IS NULL).
		// No cap — processes all pending in one shot; fast due to batch UPDATE.
		classifyResult, err := classify.RunJob(ctx, db, classify.JobConfig{
			BatchSize: 5000,
			ICPConfig: classify.DefaultICPConfig(),
		})
		if err != nil {
			slog.Error("intel classify-new error", "op", "intelligence.RunOnce/classify_new", "error", err)
		} else if classifyResult.Processed > 0 {
			result.CompaniesClassified = classifyResult.Processed
			slog.Info("intel classify-new", "processed", classifyResult.Processed,
				"classified", classifyResult.Classified, "scored", classifyResult.Scored)
		}
	}

	// 6. Detect zero-engagement contacts (potential traps)
	traps, err := DetectZeroEngagement(ctx, db)
	if err != nil {
		slog.Error("intel zero-engagement error", "op", "intelligence.RunOnce/zero_engagement_detect", "error", err)
	}
	if traps > 0 {
		slog.Warn("intel flagged zero-engagement contacts as potential traps", "op", "intelligence.RunOnce/zero_engagement_flagged", "count", traps)
	}

	// 7. Email verification for unverified companies (200k per cycle — DNS cached per domain)
	verified, invalid := verifyEmailsBatch(ctx, db, 200000)
	result.EmailsVerified = verified
	result.EmailsInvalid = invalid
	if verified > 0 {
		slog.Info("intel email verification", "verified", verified, "invalid", invalid)
	}

	// 8. ARES sync — fetch NACE codes for companies with ICO
	// Token bucket at 10 req/s with 5 parallel workers; thread-safe across goroutines.
	aresClient := ares.NewClient(ares.WithRate(ctx, 10))
	aresResult, err := ares.RunSync(ctx, db, aresClient, ares.SyncConfig{
		BatchSize:   50000,
		Concurrency: 5,
	})
	if err != nil {
		slog.Error("intel ares-sync error", "op", "intelligence.RunOnce/ares_sync", "error", err)
	} else if aresResult.Synced > 0 {
		result.ARESSynced = aresResult.Synced
		slog.Info("intel ARES sync", "synced", aresResult.Synced, "not_found", aresResult.NotFound, "errors", aresResult.Errors)
	}

	// 9. NACE reclassification — upgrade companies with NACE codes from keyword/category source
	reclResult, err := classify.RunReclassifyNACE(ctx, db, classify.DefaultICPConfig(), 5000)
	if err != nil {
		slog.Error("intel reclassify-nace error", "op", "intelligence.RunOnce/nace_reclassify", "error", err)
	} else if reclResult.Upgraded > 0 {
		result.NACEReclassified = reclResult.Upgraded
		slog.Info("intel NACE reclassification", "upgraded", reclResult.Upgraded, "candidates", reclResult.Candidates)
	}

	// 9b. LLM description enrichment — fills description_tags, may boost sector_confidence.
	// Only runs when Ollama is reachable (cfg.LLMClient != nil).
	if cfg.LLMClient != nil {
		llmResult, llmErr := RunLLMEnrich(ctx, db, LLMEnrichConfig{
			Client:    cfg.LLMClient,
			BatchSize: 100,
		})
		if llmErr != nil {
			slog.Error("intel llm enrich error", "op", "intelligence.RunOnce/llm_enrich", "error", llmErr)
		} else if llmResult.Processed > 0 {
			result.LLMEnrichProcessed = llmResult.Processed
			result.LLMEnrichBoosted = llmResult.ConfidenceBoosted
			slog.Info("intel llm enrichment",
				"processed", llmResult.Processed,
				"enriched", llmResult.Enriched,
				"boosted", llmResult.ConfidenceBoosted,
				"duration", llmResult.Duration.Round(time.Second))
		}
	}

	// 10. Promote verified companies → outreach contacts (5000 per cycle)
	promResult, err := enrich.PromoteCompanies(ctx, db, enrich.PromoteConfig{
		ICPTiers:         []string{"ideal", "good"},
		EmailStatuses:    []string{"valid"},
		BatchSize:        5000,
		TargetIndustries: cfg.TargetIndustries,
	})
	if err != nil {
		slog.Error("intel promote error", "op", "intelligence.RunOnce/promote_companies", "error", err)
	} else if promResult.Created > 0 {
		result.ContactsPromoted = promResult.Created
		slog.Info("intel promoted companies to contacts", "created", promResult.Created, "queried", promResult.Queried)
	}

	// 11. Refresh category company counts after sync + classify
	catStore := category.NewStore(db)
	if refreshed, err := catStore.RefreshCounts(ctx); err != nil {
		slog.Error("intel category refresh error", "op", "intelligence.RunOnce/category_refresh", "error", err)
	} else if refreshed > 0 {
		result.CategoryRefreshed = refreshed
		slog.Info("intel category counts refreshed", "categories", refreshed)
	}

	// 11b. Refresh segment memberships (compound queries rebuilt from current company state).
	segStore := segment.NewStore(db)
	if total, err := segStore.RefreshAll(ctx); err != nil {
		slog.Error("intel segment refresh error", "op", "intelligence.RunOnce/segment_refresh", "error", err)
	} else if total > 0 {
		result.SegmentsRefreshed = total
	}

	// 12. Audit log retention: delete entries older than AUDIT_LOG_RETENTION_DAYS.
	// Defaults to 1825 days (5 years) to align with BFF cron retention policy
	// and GDPR Art. 30 accountability requirements. Previously hardcoded to
	// 90 days, which conflicted with the BFF's configurable 1825-day window
	// (server.js runAuditLogRetentionCron) and silently destroyed GDPR
	// accountability records. Fix: adversarial-data-layer audit 2026-05-05 (F5).
	// idx_oal_created (created_at DESC) makes this a cheap index scan.
	auditRetentionDaysStr := envconfig.GetOr("AUDIT_LOG_RETENTION_DAYS", "1825")
	auditRetentionDays := 1825
	if d, parseErr := strconv.Atoi(auditRetentionDaysStr); parseErr == nil && d >= 30 {
		auditRetentionDays = d
	} else if parseErr != nil {
		slog.Warn("intel audit log retention: AUDIT_LOG_RETENTION_DAYS not a valid integer — using default 1825",
			"op", "intelligence.RunOnce/audit_log_cleanup",
			"raw", auditRetentionDaysStr)
	} else {
		slog.Warn("intel audit log retention: AUDIT_LOG_RETENTION_DAYS < 30 — using default 1825",
			"op", "intelligence.RunOnce/audit_log_cleanup",
			"requested", d)
	}
	if res, err := db.ExecContext(ctx,
		`DELETE FROM operator_audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
		fmt.Sprintf("%d", auditRetentionDays),
	); err != nil {
		slog.Error("intel audit log cleanup error", "op", "intelligence.RunOnce/audit_log_cleanup",
			"error", err, "retention_days", auditRetentionDays)
	} else if n, _ := res.RowsAffected(); n > 0 {
		slog.Info("intel audit log pruned", "deleted", n, "retention_days", auditRetentionDays)
	}

	// 13. Watchdog checks — detect and auto-heal pipeline anomalies.
	if wdResult, wdErr := watchdog.RunChecks(ctx, db); wdErr != nil {
		slog.Error("intel watchdog error", "op", "intelligence.RunOnce/watchdog", "error", wdErr)
	} else if wdResult.StuckContacts > 0 || wdResult.DissolvedEnrolled > 0 || wdResult.StaleEmails > 0 {
		slog.Info("intel watchdog complete",
			"stuck_contacts", wdResult.StuckContacts,
			"stuck_healed", wdResult.StuckAutoHealed,
			"dissolved_enrolled", wdResult.DissolvedEnrolled,
			"dissolved_removed", wdResult.DissolvedRemoved,
			"stale_emails", wdResult.StaleEmails,
			"duration", wdResult.Duration.Round(time.Millisecond))
	}

	result.Duration = time.Since(start)
	slog.Info("intelligence loop completed", "duration", result.Duration.Round(time.Millisecond))

	// 14. Sender auth DNS check — SPF/DKIM/DMARC for production mailbox domains.
	// AR16: RunSenderAuthenticationCheck was an exported function with no caller.
	// Wired here (every intelligence-loop tick, currently 6h) so that DNS
	// misconfiguration on Seznam's side is detected within one cycle and logged
	// via slog.Warn to Sentry. We cannot fix their auth infra, only alert.
	if _, saErr := RunSenderAuthenticationCheck(ctx, db); saErr != nil {
		slog.Error("intel sender auth check error", "op", "intelligence.RunOnce/sender_auth", "error", saErr)
	}

	// 14b. Emit deliverability health gauges for Prometheus scraping.
	emitDeliverabilityMetrics(ctx, db)
	emitMailboxMetrics(ctx, db)

	if cfg.Health != nil {
		cfg.Health.Report("intel_loop", true, "")
	}

	return result, nil
}

// RunDaemon starts the intelligence loop on a schedule.
// Panics inside RunOnce are recovered — the health registry is marked unhealthy
// and the daemon continues to the next tick instead of dying silently.
// After 3 consecutive failures the alert client is notified (G13).
func RunDaemon(ctx context.Context, db *sql.DB, cfg Config, interval time.Duration) error {
	slog.Info("intel daemon started", "interval", interval)
	consecutiveFails := 0

	markFail := func(errMsg string) {
		consecutiveFails++
		metrics.IntelLoopFailTotal.Add(1)
		if cfg.Health != nil {
			cfg.Health.Report("intel_loop", false, errMsg)
		}
		if consecutiveFails >= 3 && cfg.Alert != nil {
			cfg.Alert.DaemonPanic(ctx, "intel_loop",
				fmt.Sprintf("3 consecutive failures — last: %s", errMsg))
		}
	}

	run := func() {
		err := telemetry.MonitoredJob("intelligence-loop", func() error {
			result, err := RunOnce(ctx, db, cfg)
			if err != nil {
				return err
			}
			consecutiveFails = 0 // reset on success
			metrics.IntelLoopTotal.Add(1)
			metrics.IntelLoopDurationMs.Set(float64(result.Duration.Milliseconds()))
			metrics.IntelScoresRecalculated.Set(float64(result.ScoresRecalculated))
			metrics.IntelCompaniesClassified.Set(float64(result.CompaniesClassified))
			return nil
		})
		if err != nil {
			markFail(err.Error())
		}
	}

	// Run immediately
	run()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("intel daemon stopped")
			return ctx.Err()
		case <-ticker.C:
			run()
		}
	}
}

// verifyEmailsBatch runs email verification for a batch of unverified companies.
// Results are written in bulk via SaveCompanyResultBatch (500 rows per UPDATE)
// instead of one UPDATE per row, reducing DB round-trips by ~200×.
func verifyEmailsBatch(ctx context.Context, db *sql.DB, batch int) (verified, invalid int) {
	const flushSize = 500

	verifier := validation.NewVerifier(db)
	if envconfig.BoolOr("ENABLE_SMTP_PROBE", false) {
		verifier.EnableSMTP = true
	}
	if url := envconfig.GetOr("ANTI_TRACE_URL", ""); url != "" {
		verifier.RelayURL = url
		verifier.RelayToken = envconfig.GetOr("ANTI_TRACE_TOKEN", "")
	}
	if err := verifier.LoadDomainCache(ctx); err != nil {
		slog.Warn("intel verify: load domain cache", "op", "intelligence.verifyEmailsBatch/load_cache", "error", err)
	}

	rows, err := db.QueryContext(ctx, `
		SELECT id, email FROM companies
		WHERE email IS NOT NULL AND email != ''
		  AND exclusion_status = 'pass'
		  AND (
		        email_status = 'unverified'
		     OR (email_status IN ('valid', 'catch_all', 'risky', 'role_only')
		         AND email_verified_at < now() - interval '90 days')
		  )
		ORDER BY icp_score DESC NULLS LAST
		LIMIT $1`, batch)
	if err != nil {
		slog.Error("intel verify: query", "op", "intelligence.verifyEmailsBatch/query", "error", err)
		return 0, 0
	}
	defer rows.Close()

	buf := make([]validation.CompanyVerifyRow, 0, flushSize)

	flush := func() {
		if len(buf) == 0 {
			return
		}
		if err := verifier.SaveCompanyResultBatch(ctx, buf); err != nil {
			slog.Warn("intel verify: batch save", "op", "intelligence.verifyEmailsBatch/save_batch", "count", len(buf), "error", err)
		}
		buf = buf[:0]
	}

	scanErrs := 0
	for rows.Next() {
		var id int64
		var email string
		if err := rows.Scan(&id, &email); err != nil {
			scanErrs++
			continue
		}

		status, result := verifier.VerifyEmail(ctx, email)
		buf = append(buf, validation.CompanyVerifyRow{ID: id, Status: status, Result: result})

		verified++
		if status == validation.StatusInvalid || status == validation.StatusSpamtrap {
			invalid++
		}

		if len(buf) >= flushSize {
			flush()
		}
	}
	flush()

	// Hardening: surface aggregate scan failures so a corrupted column or
	// schema drift becomes visible. Per-row slog would be noisy at batch
	// scale (up to N=500); aggregate is the right granularity.
	if scanErrs > 0 {
		slog.Warn("intel verify: scan errors during batch fetch",
			"op", "intelligence.verifyEmailsBatch/scan_errors", "scan_errs", scanErrs, "verified", verified, "batch_size", batch)
	}

	return verified, invalid
}
