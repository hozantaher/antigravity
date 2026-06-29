package main

import (
	"campaigns/campaign"
	"campaigns/content"
	"campaigns/sender"
	"campaigns/warmup"
	"common/alert"
	"common/audit"
	"common/config"
	"common/db"
	"common/envconfig"
	"common/health"
	"common/humanize"
	"common/operatorconfig"
	"common/telemetry"
	"contacts/ares"
	"contacts/auditenrich"
	"contacts/category"
	"contacts/classify"
	"contacts/company"
	"contacts/contact"
	"contacts/enrichment"
	"contacts/prospect"
	"contacts/segment"
	"contacts/validation"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mailboxes/mailbox"
	"mailboxes/watchdog"
	"net/http"
	imapPkg "orchestrator/imap"
	"orchestrator/intelligence"
	acllm "orchestrator/internal/llm"
	"orchestrator/llm"
	"orchestrator/mailsim"
	palert "orchestrator/protections/alert"
	"orchestrator/protections/probe"
	"orchestrator/seed"
	"orchestrator/seed/prodlike"
	"orchestrator/thread"
	"orchestrator/web"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := telemetry.Init("outreach"); err != nil {
		slog.Error("sentry init failed", "op", "outreach.main/unknown", "error", err)
	}
	telemetry.SetServiceTag("outreach")
	defer telemetry.Flush()

	// Mail Lab DNS resolver override (ML4.2).
	// When DNS_RESOLVER is set, point net.DefaultResolver at it so every
	// IMAP/SMTP/HTTPS lookup in this process resolves *.lab domains via
	// the lab's unbound (10.20.0.2) instead of the system resolver. This
	// makes orchestrator hermetic against accidental real-Seznam contact
	// during dev — non-lab domains return SERVFAIL from lab DNS.
	//
	// Format: host:port (e.g. "10.20.0.2:53"). Empty = system default.
	if r := envconfig.GetOr("DNS_RESOLVER", ""); r != "" {
		applyCustomResolver(r)
	}

	// Wire slog → Sentry bridge so all slog.Error() calls are forwarded.
	// IMPORTANT: must use a *fresh* inner handler (NewJSONHandler over os.Stderr)
	// rather than slog.Default().Handler(). The default handler delegates to the
	// std `log` package, which under SetDefault gets re-routed through slog —
	// creating a deadlock: SlogHandler → defaultHandler → log.Logger.output →
	// slog handlerWriter → SlogHandler → … (infinite mutex contention on the
	// log.Logger mu). Diagnosed by SIGQUIT stack dump 2026-04-27.
	slog.SetDefault(slog.New(telemetry.NewSlogHandler(slog.NewJSONHandler(os.Stderr, nil))))

	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	// Airtight boot gate (ADR-005, AT2.2) — single source of truth lives in
	// (*config.SendingConfig).ValidateAirtight via cfg.Validate(). It refuses
	// to start when LAB_ONLY=1 is paired with a non-lab transport (exit 47),
	// or when TRANSPORT_MODE is the banned "direct" value / an unknown mode
	// (exit 48). Distinct exit codes let deploy tooling branch on failure
	// type without parsing log messages.
	//
	// Operator dialect for LAB_ONLY (case-insensitive, trimmed): truthy =
	// 1|true|yes|on; falsy / unset = 0|false|no|off|<empty>; unknown =
	// fallback (false). Wired through envconfig.BoolOr in LoadFromEnv.
	cfg := config.LoadFromEnv()
	if err := cfg.Validate(); err != nil {
		var ae *config.AirtightError
		if errors.As(err, &ae) {
			slog.Error("airtight gate refused boot",
				"op", "main.airtightGate",
				"error", ae.Message,
				"exit_code", ae.ExitCode,
				"lab_only", envconfig.GetOr("LAB_ONLY", ""),
				"transport_mode", envconfig.GetOr("TRANSPORT_MODE", ""))
			fmt.Fprintln(os.Stderr, ae.Message)
			os.Exit(ae.ExitCode)
		}
		slog.Error("invalid configuration", "op", "outreach.main/unknown", "error", err)
		telemetry.FatalExitFn(err, 1)()
	}
	cmd := os.Args[1]
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Lazy DB connection — only connect when needed
	var database *sql.DB
	connectDB := func() *sql.DB {
		if database == nil {
			var err error
			database, err = db.Connect(cfg.Database.DSN())
			if err != nil {
				slog.Error("DB connect failed", "op", "outreach.main/unknown", "error", err)
				telemetry.FatalExitFn(err, 1)()
			}
		}
		return database
	}
	defer func() {
		if database != nil {
			database.Close()
		}
	}()

	switch cmd {
	case "migrate":
		migrationsDir := envconfig.GetOr("MIGRATIONS_DIR", "internal/db/migrations")
		if err := db.Migrate(connectDB(), migrationsDir); err != nil {
			slog.Error("Migration failed", "op", "outreach.main/migrate", "error", err)
			os.Exit(1)
		}
		fmt.Println("Migrations applied successfully.")

	case "validate":
		store := contact.NewStore(connectDB())
		pipeline := validation.NewPipeline()

		contacts, err := store.FindBySegment(ctx, contact.SegmentFilter{
			Statuses: []contact.Status{contact.StatusNew},
		}, 10000, 0)
		if err != nil {
			slog.Error("Load contacts", "op", "outreach.main/validate", "error", err)
			os.Exit(1)
		}

		fmt.Printf("Validating %d contacts...\n", len(contacts))
		valid, invalid := 0, 0
		for _, c := range contacts {
			result := pipeline.Run(ctx, c.Email)
			store.UpdateValidation(ctx, c.ID, result)
			if result.SyntaxValid && result.MXExists && !result.IsDisposable {
				valid++
			} else {
				invalid++
			}
		}
		fmt.Printf("Done: %d valid, %d invalid\n", valid, invalid)

	case "stats":
		store := contact.NewStore(connectDB())
		counts, err := store.CountByStatus(ctx)
		if err != nil {
			slog.Error("Stats failed", "op", "outreach.main/stats", "error", err)
			os.Exit(1)
		}
		fmt.Println("Contact status counts:")
		total := 0
		for status, count := range counts {
			fmt.Printf("  %-15s %d\n", status, count)
			total += count
		}
		fmt.Printf("  %-15s %d\n", "TOTAL", total)

	case "campaign-create":
		if len(os.Args) < 3 {
			slog.Error("Usage: outreach campaign-create <name> [--region <r>] [--industry <i>] [--min-score <f>]", "op", "outreach.main/campaign-create")
			os.Exit(1)
		}
		name := os.Args[2]
		steps := campaign.DefaultSequence()

		var enrollFilter campaign.EnrollmentFilter
		for i := 3; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--region":
				if i+1 < len(os.Args) {
					enrollFilter.Region = os.Args[i+1]
					i++
				}
			case "--industry":
				if i+1 < len(os.Args) {
					enrollFilter.Industry = os.Args[i+1]
					i++
				}
			case "--min-score":
				if i+1 < len(os.Args) {
					if v, err := strconv.ParseFloat(os.Args[i+1], 64); err == nil {
						enrollFilter.MinScore = v
					}
					i++
				}
			}
		}

		templatesDir := envconfig.GetOr("TEMPLATES_DIR", "configs/templates")
		contentEngine := content.NewEngineWithDB(connectDB(), templatesDir, nil)
		sendEngine := buildSendEngine(cfg, connectDB())
		targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")
		runner := campaign.NewRunner(connectDB(), contentEngine, sendEngine).
			WithRecalc(connectDB(), targetIndustries)

		id, err := runner.CreateCampaign(ctx, name, "", steps, enrollFilter)
		if err != nil {
			slog.Error("Create campaign", "op", "outreach.main/--min-score", "error", err)
			os.Exit(1)
		}
		audit.Log(ctx, connectDB(), audit.ActionCampaignCreated, "cli", "campaign", strconv.FormatInt(id, 10), map[string]any{
			"name":      name,
			"region":    enrollFilter.Region,
			"industry":  enrollFilter.Industry,
			"min_score": enrollFilter.MinScore,
		})
		fmt.Printf("Campaign '%s' created with ID %d\n", name, id)

	case "campaign-run":
		if len(os.Args) < 3 {
			slog.Error("Usage: outreach campaign-run <id>", "op", "outreach.main/campaign-run")
			os.Exit(1)
		}
		campaignID, err := strconv.ParseInt(os.Args[2], 10, 64)
		if err != nil {
			slog.Error("Invalid campaign ID", "op", "outreach.main/campaign-run", "error", err)
			os.Exit(1)
		}

		templatesDir := envconfig.GetOr("TEMPLATES_DIR", "configs/templates")
		contentEngine := content.NewEngineWithDB(connectDB(), templatesDir, nil)
		sendEngine := buildSendEngine(cfg, connectDB())
		targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")
		runner := campaign.NewRunner(connectDB(), contentEngine, sendEngine).
			WithRecalc(connectDB(), targetIndustries)

		if err := runner.RunCampaign(ctx, campaignID); err != nil {
			slog.Error("Run campaign", "op", "outreach.main/campaign-run", "error", err)
			os.Exit(1)
		}
		audit.Log(ctx, connectDB(), audit.ActionCampaignStarted, "cli", "campaign", strconv.FormatInt(campaignID, 10), nil)

		// Start sender daemon
		fmt.Printf("Campaign %d enqueued. Starting sender...\n", campaignID)
		recorder := thread.NewMessageRecorder(database)
		sendEngine.Run(ctx, wrapSendCallbackWithRecover(ctx, database, "outreach.main/campaign-run",
			func(req sender.SendRequest, result sender.SendResult) {
			// Pre-send domain check skip (presend_skip_handler.go):
			// terminal for the contact (email_status='invalid'), no
			// retry. Returns true when handled so we bypass the legacy
			// failure path below.
			if handlePreSendDomainCheckSkip(ctx, database, "outreach.main/campaign-run", req, result) {
				return
			}
			// Exactly-once send-claim skip (migration 171). The gate in
			// Engine.Run suppressed a duplicate; persist the consequence
			// (finalize-if-already-sent / leave-in_flight) and bypass the
			// normal success/failure path.
			if handleDuplicateSendSkip(ctx, database, "outreach.main/campaign-run", req, result) {
				return
			}
			if result.Error != nil {
				slog.Warn("Send failed", "op", "outreach.main/campaign-run", "contact_id", req.ContactID, "error", result.Error)
				database.Exec(`UPDATE send_events SET status = 'failed', smtp_response = $1 WHERE campaign_id = $2 AND contact_id = $3 AND step = $4`,
					result.Error.Error(), req.CampaignID, req.ContactID, req.Step)
				// AW7 — runner-engine state atomicity (issue #1182).
				// Revert the runner's reservation: in_flight -> pending so
				// the next tick re-attempts the same step. See
				// services/campaigns/campaign/atomicity.go.
				if _, err := campaign.RevertFailedStep(ctx, database, req); err != nil {
					slog.Warn("RevertFailedStep failed", "op", "outreach.main/campaign-run", "contact_id", req.ContactID, "error", err)
				}
				// Release the send-claim (claiming -> failed) so the next
				// tick can re-claim and retry this step. Idempotent.
				if _, err := sender.ReleaseClaim(ctx, database, req); err != nil {
					slog.Warn("ReleaseClaim failed", "op", "outreach.main/campaign-run", "contact_id", req.ContactID, "error", err)
				}
			} else {
				slog.Info("Send OK", "contact_id", req.ContactID, "message_id", result.MessageID, "rfc_message_id", result.RFCMessageID, "mailbox", result.MailboxUsed)
				// R2 (reply-pipeline-recovery): persist rfc_message_id so the
				// inbound matcher can attribute replies whose In-Reply-To
				// references the actual RFC 5322 Message-ID emitted on the
				// wire (vs. the internal envelope_id in message_id).
				//
				// ON CONFLICT: the send_events partial-unique backstop
				// (migration 172) guarantees a duplicate 'sent' row can never
				// land even if the claim gate were somehow bypassed. 0 rows
				// affected = backstop fired — observable, not fatal.
				if seRes, seErr := database.Exec(`INSERT INTO send_events (campaign_id, contact_id, step, mailbox_used, message_id, rfc_message_id, subject, status, sent_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', $8)
					ON CONFLICT (campaign_id, contact_id, step) WHERE status = 'sent' DO NOTHING`,
					req.CampaignID, req.ContactID, req.Step, result.MailboxUsed, result.MessageID, nullableMessageID(result.RFCMessageID), req.Subject, result.SentAt); seErr != nil {
					slog.Warn("send_events insert failed", "op", "outreach.main/campaign-run", "contact_id", req.ContactID, "error", seErr)
				} else if n, _ := seRes.RowsAffected(); n == 0 {
					slog.Warn("duplicate send_event suppressed by backstop index (migration 172)",
						"op", "outreach.main/campaign-run/sendEventsBackstop",
						"campaign_id", req.CampaignID, "contact_id", req.ContactID, "step", req.Step)
				}
				// FUN-1.3 — funnel_events hook (best-effort, additive).
				// Mirrors the send_events row so the funnel analytics can aggregate
				// across campaigns without reading the heavier send_events table.
				if _, fErr := database.ExecContext(ctx,
					`INSERT INTO funnel_events (event_type, contact_id, campaign_id, occurred_at, details)
					 VALUES ('sent', $1, $2, $3, jsonb_build_object('step', $4::int))`,
					req.ContactID, req.CampaignID, result.SentAt, req.Step,
				); fErr != nil {
					slog.Warn("funnel_events insert failed (non-fatal)",
						"op", "outreach.main/funnelHook/cli",
						"contact_id", req.ContactID,
						"error", fErr)
				}
				database.Exec(`UPDATE contacts SET status = 'sent', last_contacted = $1, updated_at = now() WHERE id = $2`,
					result.SentAt, req.ContactID)
				// AW7 — runner-engine state atomicity (issue #1182).
				// Finalize the runner's reservation: in_flight ->
				// in_sequence/completed AFTER send_events is INSERTed.
				// Closes the phantom-completed window from campaign 457
				// (2026-05-09) — see atomicity.go for full contract.
				if _, err := campaign.FinalizeSentStep(ctx, database, req); err != nil {
					slog.Warn("FinalizeSentStep failed", "op", "outreach.main/campaign-run", "contact_id", req.ContactID, "error", err)
				}
				// Confirm the send-claim (claiming -> sent) so future
				// attempts for this (campaign,contact,step) short-circuit.
				// Idempotent (CAS on status='claiming').
				if _, err := sender.ConfirmClaim(ctx, database, req, result.MessageID); err != nil {
					slog.Warn("ConfirmClaim failed", "op", "outreach.main/campaign-run", "contact_id", req.ContactID, "error", err)
				}
				// Track E (migration 019) — outbound channel audit. Best-effort,
				// independent of send_events / contacts upserts above so a future
				// reshape of those tables does not silently regress GDPR audit
				// coverage. Errors are slog-warned by audit.LogChannel.
				audit.LogChannel(ctx, database,
					audit.ChannelEmail, audit.DirectionOutbound,
					req.ToAddress, result.MessageID,
					map[string]any{
						"campaign_id": req.CampaignID,
						"contact_id":  req.ContactID,
						"step":        req.Step,
						"mailbox":     result.MailboxUsed,
					})
				// Mirror to Schema B so the IMAP reply poller can match by Message-ID.
				if err := recordOutboundToThread(ctx, database, recorder, req, result); err != nil {
					if errors.Is(err, errSchemaBMissing) {
						slog.Info("outreach thread skipped — Schema B mirror missing",
							"op", "main.recordOutboundToThread/schemaBMiss",
							"contact_id", req.ContactID)
					} else {
						slog.Warn("recordOutboundToThread failed",
							"op", "main.recordOutboundToThread/error",
							"contact_id", req.ContactID, "error", err)
					}
				}
				// AW7-9 — orchestrator-side APPEND removed. The relay drain
				// now performs the post-send APPEND inside the relay
				// container where wgsocks lives. AW7-7's orchestrator
				// wiring fell back to "127.0.0.1:1080: connection refused"
				// on PROD 2026-05-10 21:35 because the orchestrator
				// container has no wgsocks instance. See
				// services/relay/internal/delivery/sent_appender.go.
				_ = result
			}
		}))

	case "server":
		port := envconfig.GetOr("PORT", fmt.Sprintf("%d", cfg.Web.Port))
		targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")

		healthReg := health.New()
		alertClient := alert.New()
		if alertClient.Enabled() {
			slog.Info("Alert webhook configured")
		}

		// D2.2: reconcile config.yaml mailboxes with outreach_mailboxes registry.
		// Idempotent — runtime counters (status, bounces, last_send_at) are preserved
		// across config reloads. Non-fatal: if migration 035 hasn't been applied yet,
		// we warn and continue; the registry is optional until D2.3 wires selector.
		if res, err := mailbox.SyncFromConfig(ctx, mailbox.NewPGStore(connectDB()), cfg); err != nil {
			slog.Warn("mailbox registry sync failed (continuing)", "op", "outreach.main/server", "error", err)
		} else {
			slog.Info("mailbox registry synced", "synced", res.Synced, "skipped", len(res.Skipped))
			for _, sk := range res.Skipped {
				slog.Warn("mailbox skipped", "op", "outreach.main/server", "address", sk.Address, "reason", sk.Reason)
			}
		}

		// Migration 038: dashboard-managed mailboxes live in the registry.
		// Overlay them onto cfg.Mailboxes so the sender engine — which still
		// consumes []config.MailboxConfig — uses DB credentials and accepts
		// mailboxes that only exist in the DB (no YAML counterpart).
		// This closes the loop: dashboard CRUD → DB → boot overlay → sender.
		if overlaid, added, err := mailbox.OverlayRegistry(ctx, mailbox.NewPGStore(connectDB()), cfg); err != nil {
			slog.Warn("mailbox registry overlay failed (continuing with YAML-only)", "op", "outreach.main/server", "error", err)
		} else {
			slog.Info("mailbox registry overlaid onto config", "overlaid", overlaid, "added", added, "total", len(cfg.Mailboxes))
		}

		// Sprint 1.2 — POST /api/inbound for BFF→orchestrator inbound mail
		// pipeline. The processor handles MIME parsing, attachment
		// extraction, thread matching, classification, and persistence.
		// Wired with the same DB handle as the rest of the orchestrator
		// so PG NOTIFY thread_inbound fires on the shared connection
		// pool the BFF's SSE stream subscribes to.
		inboundProc := thread.NewInboundProcessor(connectDB())

		// AC8 — Haiku pre-classification on the production server path
		// (Z3-A IMAP poll daemon consumes inboundProc at line ~996). The
		// legacy IMAP processor block at line ~920 already calls wireAC8
		// for the dev/test path; this site covers the production hot path
		// that ships replies via the Go-runner cron.
		if wired := wireAC8PreClassifier(inboundProc, connectDB()); wired {
			slog.Info("Server: AC8 Haiku pre-classifier enabled",
				"op", "outreach.main/ac8WiredServer",
				"model", acllm.DefaultModel)
		}

		srv := web.NewServerWithHealth(connectDB(), cfg.Tracking.BaseURL, healthReg, targetIndustries...).
			WithSchemaEndpoint().
			WithInboundProcessor(inboundProc).
			WithRelay(
				envconfig.GetOr("ANTI_TRACE_RELAY_URL", ""),
				envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", envconfig.GetOr("ANTI_TRACE_TOKEN", "")),
				nil,
			)
		addr := fmt.Sprintf("%s:%s", cfg.Web.Host, port)
		httpSrv := &http.Server{Addr: addr, Handler: telemetry.HTTPRecoveryMiddleware(srv.Handler())}

		// Start intelligence loop in background (full pipeline: verify, ARES, classify, promote)
		intelInterval := 1 * time.Hour
		if v := envconfig.GetOr("INTEL_INTERVAL", ""); v != "" {
			if d, err := time.ParseDuration(v); err == nil {
				intelInterval = d
			}
		}
		intelCfg := intelligence.Config{
			TargetIndustries: targetIndustries,
			Health:           healthReg,
			Alert:            alertClient,
		}
		// Wire Ollama LLM client when OLLAMA_URL is set.
		if ollamaURL := envconfig.GetOr("OLLAMA_URL", ""); ollamaURL != "" {
			intelCfg.LLMClient = llm.NewClient(llm.Config{
				BaseURL: ollamaURL,
				Model:   envconfig.GetOr("OLLAMA_MODEL", "gemma2:2b"),
			})
			slog.Info("intel loop: LLM enrichment enabled", "url", ollamaURL, "model", envconfig.GetOr("OLLAMA_MODEL", "gemma2:2b"))
		}
		if cfg.FirmyDSN != "" {
			if firmyDB, err := sql.Open("postgres", cfg.FirmyDSN); err == nil {
				firmyDB.SetMaxOpenConns(5)
				intelCfg.FirmyDB = firmyDB
				intelCfg.CompanyStore = company.NewStore(connectDB())
				defer firmyDB.Close()
				slog.Info("intel loop: company sync enabled")
			} else {
				slog.Warn("intel loop: failed to open firmy DB, company sync disabled", "op", "outreach.main/server", "error", err)
			}
		}
		// One-time backfill: sync outreach_contacts → contacts (Schema A) on startup.
		// Idempotent via ON CONFLICT — safe to run every boot.
		go func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("startup backfill panic recovered", "op", "outreach.main/server", "recover", r)
				}
			}()
			res, err := database.ExecContext(ctx, `
				INSERT INTO contacts (email, email_hash, first_name, company_name, ico, region, industry, company_size, score, status, source)
				SELECT oc.email, oc.email_hash, oc.first_name, oc.company_name, oc.ico, oc.region,
					COALESCE(oc.industry_tags[1], ''), oc.company_size,
					LEAST(GREATEST(ROUND(oc.targeting_score * 100)::int, 0), 100),
					'valid', 'promoted'
				FROM outreach_contacts oc
				WHERE oc.status NOT IN ('bounced','unsubscribed','blacklisted','invalid')
				ON CONFLICT (email_hash) DO UPDATE SET
					score = EXCLUDED.score,
					status = CASE WHEN contacts.status IN ('bounced','unsubscribed','blacklisted') THEN contacts.status ELSE 'valid' END,
					company_name = COALESCE(EXCLUDED.company_name, contacts.company_name),
					region = COALESCE(EXCLUDED.region, contacts.region),
					industry = COALESCE(EXCLUDED.industry, contacts.industry),
					updated_at = now()`)
			if err != nil {
				slog.Warn("startup backfill contacts failed", "op", "outreach.main/server", "error", err)
			} else {
				affected, _ := res.RowsAffected()
				slog.Info("startup backfill contacts", "synced", affected)
			}
		}()

		go intelligence.RunDaemon(ctx, connectDB(), intelCfg, intelInterval)
		slog.Info("Intelligence loop started", "interval", intelInterval)

		// Mailbox watchdog daemon: 5-min self-heal loop (bounce decay, proxy
		// swap on auth-fail spike). Separate from intelligence which runs hourly.
		// Opt-out with DISABLE_WATCHDOG=1. Proxy-pool BFF URL comes from
		// OUTREACH_DASHBOARD_URL (BFF itself); if unset, swaps are disabled
		// (fail-open — the daemon still does bounce decay + audit logging).
		if !envconfig.BoolOr("DISABLE_WATCHDOG", false) {
			watchdogInterval := 5 * time.Minute
			if v := envconfig.GetOr("WATCHDOG_INTERVAL", ""); v != "" {
				if d, err := time.ParseDuration(v); err == nil {
					watchdogInterval = d
				}
			}
			wdDB := connectDB()
			wdCfg := watchdog.DaemonConfig{
				Store:     mailbox.NewPGStore(wdDB),
				Events:    watchdog.NewEventRecorder(wdDB),
				AuthFails: watchdog.NewAuthFailStore(wdDB),
				Circuit:   &watchdog.PGCircuitBreakerStore{DB: wdDB},
				Interval:  watchdogInterval,
			}
			if bff := envconfig.GetOr("OUTREACH_DASHBOARD_URL", ""); bff != "" {
				wdCfg.ProxyPool = &watchdog.ProxyPoolClient{BaseURL: bff}
				slog.Info("watchdog: proxy pool BFF wired", "url", bff)
			} else {
				slog.Warn("watchdog: OUTREACH_DASHBOARD_URL unset — proxy swaps disabled", "op", "outreach.main/server")
			}
			go watchdog.NewDaemon(wdCfg).Run(ctx)
			slog.Info("Watchdog daemon started", "interval", watchdogInterval)
		}

		// Protection verification scheduler: per-layer L2/L3 probes that
		// populate protection_probes for the OchranyPanel UI. Opt-out with
		// DISABLE_PROTECTION_PROBES=1. Fail-open: a misconfigured probe
		// writes status=skip and the scheduler keeps running the rest.
		if !envconfig.BoolOr("DISABLE_PROTECTION_PROBES", false) {
			probeDB := connectDB()
			pgSink := probe.NewPGRecorder(probeDB)
			// S7: wire alert evaluator; S8: wrap with metrics counter sink.
			alertEval := palert.New(probeDB)
			sink := &probe.MetricsSink{Inner: &probe.AlertingSink{Inner: pgSink, Evaluator: alertEval}}
			sched := probe.NewScheduler(sink)
			sched.OnError(func(p probe.Prober, err error) {
				slog.Warn("protection probe sink write failed", "op", "outreach.main/server",
					"layer", p.Layer(), "level", int(p.Level()), "error", err)
			})

			// L2 probes run on 30–60s cadence.
			if at := envconfig.GetOr("ANTI_TRACE_RELAY_URL", ""); at != "" {
				sched.Add(probe.NewAntiTraceL2(at, 30*time.Second))
			}
			if bff := envconfig.GetOr("OUTREACH_DASHBOARD_URL", ""); bff != "" {
				sched.Add(probe.NewProxyPoolL2(bff, envconfig.GetOr("OUTREACH_API_KEY", ""), 30*time.Second))
			}
			sched.Add(probe.NewWatchdogL2(probeDB, 60*time.Second, 15*time.Minute))
			sched.Add(probe.NewDBPoolL2(probeDB, 30*time.Second))
			sched.Add(probe.NewSenderEngineL2(probeDB, 60*time.Second, 30*time.Minute))

			// L3 probes (slower, correctness-proving canaries).
			if at := envconfig.GetOr("ANTI_TRACE_RELAY_URL", ""); at != "" {
				sched.Add(probe.NewAntiTraceL3(at, envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", ""), 5*time.Minute))
			}
			if bff := envconfig.GetOr("OUTREACH_DASHBOARD_URL", ""); bff != "" {
				sched.Add(probe.NewProxyPoolL3(bff, envconfig.GetOr("OUTREACH_API_KEY", ""), 10*time.Minute))
			}
			sched.Add(probe.NewHeaderGateL3(sender.BuildCanaryMessage, 15*time.Minute))

			// S3 state-machine L3 probes (shadow-tenant, always rolled back).
			sched.Add(probe.NewCircuitBreakerL3(probeDB, 5*time.Minute))
			sched.Add(probe.NewCanaryL3(probeDB, 5*time.Minute))
			sched.Add(probe.NewBounceGuardL3(probeDB, 10*time.Minute))
			sched.Add(probe.NewSendRateL3(30 * time.Minute))
			sched.Add(probe.NewWarmupRespectL3("configs/warmup.yaml", 15*time.Minute))

			// S4 DNS + Watchdog meta L3 probes.
			if raw := envconfig.GetOr("SENDING_DOMAINS", ""); raw != "" {
				domains := strings.Split(raw, ",")
				for i := range domains {
					domains[i] = strings.TrimSpace(domains[i])
				}
				sched.Add(probe.NewSpfDmarcL3(domains, 15*time.Minute))
			} else {
				sched.Add(probe.NewSpfDmarcL3(nil, 15*time.Minute))
			}
			sched.Add(probe.NewWatchdogMetaL3(probeDB, 30*time.Minute))

			// Stub probes fill the 24-cell (12 layers × 2 levels) UI matrix
			// for layers that are meaningful at only one level. Each stub
			// writes one skip row per cadence so the Ochrany panel renders
			// "Nepoužito" (green) instead of "Bez dat" (muted).
			stubL2 := []struct{ layer, detail string }{
				{"header_gate", "in-process guard; L3 canary proves correctness"},
				{"warmup", "warmup is a plan/limit layer; L3 checks plan adherence"},
				{"bounce_guard", "state transitions only; L3 tallies bounce counters"},
				{"circuit_breaker", "in-memory circuit; L3 checks opened_at freshness"},
				{"send_rate", "rate limiter is in-memory; L3 reviews sender cadence"},
				{"spf_dmarc", "DNS-only layer; L3 resolves SPF/DMARC records"},
				{"canary", "canary budget is per-mailbox; L3 checks reservation health"},
			}
			for _, s := range stubL2 {
				sched.Add(probe.NewStubProbe(s.layer, probe.LevelAlive, probe.StatusSkip, s.detail, 5*time.Minute))
			}
			stubL3 := []struct{ layer, detail string }{
				{"db_pool", "pool correctness = L2 SELECT 1; no separate L3 needed"},
				{"sender_engine", "correctness surfaced via send_events traces"},
			}
			for _, s := range stubL3 {
				sched.Add(probe.NewStubProbe(s.layer, probe.LevelCorrect, probe.StatusSkip, s.detail, 5*time.Minute))
			}

			go sched.Run(ctx)
			slog.Info("Protection probe scheduler started",
				"l2_probes", 5+len(stubL2),
				"l3_probes", 10+len(stubL3))

			// Sender engine heartbeat: independent ticker that stamps
			// outreach_config[sender_heartbeat_at] = now() every 30s so
			// the sender_engine L2 probe has a freshness signal even
			// during quiet hours / empty queue.
			go probe.NewHeartbeat(probeDB, "sender_heartbeat_at", 30*time.Second).Run(ctx)

			// Watchdog heartbeat: stamp watchdog_events every 60s so the
			// watchdog L2/L3 probes have freshness + cadence-completeness
			// signal even when no auto-heal actions have fired.
			watchdogRecorder := watchdog.NewEventRecorder(probeDB)
			go func() {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("watchdog heartbeat panic recovered", "op", "outreach.main/server", "recover", r)
					}
				}()
				ticker := time.NewTicker(60 * time.Second)
				defer ticker.Stop()
				writeHB := func() {
					hbCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
					defer cancel()
					_ = watchdogRecorder.Record(hbCtx, watchdog.Event{
						Type:       watchdog.EventHeartbeat,
						AutoHealed: false,
						Reason:     "daemon_tick",
					})
				}
				writeHB()
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticker.C:
						writeHB()
					}
				}
			}()
		}

		// Campaign daemon: process running campaigns every 15 minutes.
		campaignInterval := 15 * time.Minute
		if v := envconfig.GetOr("CAMPAIGN_INTERVAL", ""); v != "" {
			if d, err := time.ParseDuration(v); err == nil {
				campaignInterval = d
			}
		}
		if !envconfig.BoolOr("DISABLE_CAMPAIGN_DAEMON", false) {
			templatesDir := envconfig.GetOr("TEMPLATES_DIR", "configs/templates")
			campaignContentEngine := content.NewEngineWithDB(connectDB(), templatesDir, nil)
			campaignSendEngine := buildSendEngine(cfg, connectDB())
			campaignRunner := campaign.NewRunner(connectDB(), campaignContentEngine, campaignSendEngine).
				WithRecalc(connectDB(), targetIndustries)

			// Start sender daemon for campaign sends.
			// Wrapped with recover so a panic in the send loop (nil map, SMTP
			// library bug, unmarshalling error) does not silently kill the
			// goroutine — we alert the operator and mark the daemon unhealthy.
			campaignRecorder := thread.NewMessageRecorder(database)

			// S6: per-send protection trace. Build a static layer map once at
			// wire time — which layers are active is determined by config, not per-send.
			ptrace := sender.NewProtectionTrace(connectDB())
			traceLayers := map[string]string{
				"header_gate":     "ok",
				"send_rate":       "ok",
				"circuit_breaker": "ok",
			}
			if cfg.AntiTrace.Enabled {
				traceLayers["anti_trace"] = "ok"
			}
			if envconfig.GetOr("OUTREACH_DASHBOARD_URL", "") != "" {
				traceLayers["proxy_pool"] = "ok"
			}
			if _, err := warmup.LoadPlansFromYAML(envconfig.GetOr("WARMUP_PLANS_PATH", "configs/warmup.yaml")); err == nil {
				traceLayers["warmup"] = "ok"
			}

			// AA1 — multi-worker send pacing (Sprint AA).
			//
			// Engine.Run() is a single goroutine: one Poisson timer governs
			// the whole cluster, so N active mailboxes share ~30 sends/h
			// (POISSON_MEAN_SECONDS=120 produces ~30/h max single-stream).
			// SENDER_WORKER_COUNT spawns N copies of Run() that share the
			// engine's mutex-protected state (queue, counters, currentIdx,
			// circuit breaker). Each worker has its own Poisson timer so
			// cluster throughput scales N×; per-mailbox cap still
			// rate-limits per-mb (registry + daily_cap_override).
			//
			// Default 1 keeps the legacy single-worker behaviour for
			// dev/test environments. Production sets the env per
			// active-mailbox count (current: 4).
			//
			// BulkRevertInFlight on panic — only when WorkerCount=1.
			// With N>1 workers the recover handler logs + alerts but
			// does NOT bulk-revert: the InFlight reaper (AW7-3) handles
			// stranded reservations on a 24h threshold. Bulk-reverting
			// from one worker's panic would race against the other N-1
			// workers' in-flight sends.
			workerCount := 1
			if v := envconfig.GetOr("SENDER_WORKER_COUNT", ""); v != "" {
				if n, err := strconv.Atoi(v); err == nil && n > 0 {
					workerCount = n
				}
			}
			slog.Info("sender daemon worker pool starting",
				"op", "outreach.main/senderWorkerPool",
				"worker_count", workerCount)
			senderCallback := wrapSendCallbackWithRecover(ctx, database, "outreach.main/server",
					func(req sender.SendRequest, result sender.SendResult) {
					// Pre-send domain check skip (presend_skip_handler.go):
					// terminal for the contact (email_status='invalid'), no
					// retry. Returns true when handled so we bypass the
					// legacy failure path below.
					if handlePreSendDomainCheckSkip(ctx, database, "outreach.main/server", req, result) {
						return
					}
					// Exactly-once send-claim skip (migration 171). The gate in
					// Engine.Run suppressed a duplicate; persist the consequence
					// and bypass the normal success/failure path.
					if handleDuplicateSendSkip(ctx, database, "outreach.main/server", req, result) {
						return
					}
					if result.Error != nil {
						slog.Warn("campaign send failed", "op", "outreach.main/server", "contact_id", req.ContactID, "error", result.Error)
						database.Exec(`UPDATE send_events SET status = 'failed', smtp_response = $1 WHERE campaign_id = $2 AND contact_id = $3 AND step = $4`,
							result.Error.Error(), req.CampaignID, req.ContactID, req.Step)
						// AW7 — runner-engine state atomicity (issue #1182).
						// Revert the runner's in_flight reservation so the
						// next tick re-attempts the same step. See
						// services/campaigns/campaign/atomicity.go.
						if _, err := campaign.RevertFailedStep(ctx, database, req); err != nil {
							slog.Warn("RevertFailedStep failed", "op", "outreach.main/server", "contact_id", req.ContactID, "error", err)
						}
						// Release the send-claim (claiming -> failed) so the next
						// tick can re-claim and retry this step. Idempotent.
						if _, err := sender.ReleaseClaim(ctx, database, req); err != nil {
							slog.Warn("ReleaseClaim failed", "op", "outreach.main/server", "contact_id", req.ContactID, "error", err)
						}
					} else {
						slog.Info("campaign send OK", "contact_id", req.ContactID, "message_id", result.MessageID, "rfc_message_id", result.RFCMessageID)
						// R2 (reply-pipeline-recovery): persist rfc_message_id
						// for inbound reply attribution. See the CLI send
						// branch (~line 278) for the full rationale.
						//
						// ON CONFLICT: send_events partial-unique backstop
						// (migration 172) — a duplicate 'sent' row can never land
						// even if the claim gate were bypassed. 0 rows = backstop
						// fired (observable, not fatal).
						if seRes, seErr := database.Exec(`INSERT INTO send_events (campaign_id, contact_id, step, mailbox_used, message_id, rfc_message_id, subject, status, sent_at)
							VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', $8)
							ON CONFLICT (campaign_id, contact_id, step) WHERE status = 'sent' DO NOTHING`,
							req.CampaignID, req.ContactID, req.Step, result.MailboxUsed, result.MessageID, nullableMessageID(result.RFCMessageID), req.Subject, result.SentAt); seErr != nil {
							slog.Warn("send_events insert failed", "op", "outreach.main/server", "contact_id", req.ContactID, "error", seErr)
						} else if n, _ := seRes.RowsAffected(); n == 0 {
							slog.Warn("duplicate send_event suppressed by backstop index (migration 172)",
								"op", "outreach.main/server/sendEventsBackstop",
								"campaign_id", req.CampaignID, "contact_id", req.ContactID, "step", req.Step)
						}
						// FUN-1.3 — funnel_events hook (best-effort, additive).
						// Campaign daemon send path. Mirrors the CLI branch above.
						if _, fErr := database.ExecContext(ctx,
							`INSERT INTO funnel_events (event_type, contact_id, campaign_id, occurred_at, details)
							 VALUES ('sent', $1, $2, $3, jsonb_build_object('step', $4::int))`,
							req.ContactID, req.CampaignID, result.SentAt, req.Step,
						); fErr != nil {
							slog.Warn("funnel_events insert failed (non-fatal)",
								"op", "outreach.main/funnelHook/daemon",
								"contact_id", req.ContactID,
								"error", fErr)
						}
						database.Exec(`UPDATE contacts SET status = 'sent', last_contacted = $1, updated_at = now() WHERE id = $2`,
							result.SentAt, req.ContactID)
						// AW7 — runner-engine state atomicity (issue #1182).
						// Finalize the runner's in_flight reservation:
						// in_flight -> in_sequence/completed AFTER
						// send_events is INSERTed. Closes the phantom-
						// completed window from campaign 457 (2026-05-09).
						if _, err := campaign.FinalizeSentStep(ctx, database, req); err != nil {
							slog.Warn("FinalizeSentStep failed", "op", "outreach.main/server", "contact_id", req.ContactID, "error", err)
						}
						// Confirm the send-claim (claiming -> sent) so future
						// attempts for this (campaign,contact,step) short-circuit.
						if _, err := sender.ConfirmClaim(ctx, database, req, result.MessageID); err != nil {
							slog.Warn("ConfirmClaim failed", "op", "outreach.main/server", "contact_id", req.ContactID, "error", err)
						}
						// Track E (migration 019) — outbound channel audit on the
						// campaign daemon's send path. Mirrors the CLI `send` branch
						// above so both code paths land equivalent rows.
						audit.LogChannel(ctx, database,
							audit.ChannelEmail, audit.DirectionOutbound,
							req.ToAddress, result.MessageID,
							map[string]any{
								"campaign_id": req.CampaignID,
								"contact_id":  req.ContactID,
								"step":        req.Step,
								"mailbox":     result.MailboxUsed,
							})
						if err := recordOutboundToThread(ctx, database, campaignRecorder, req, result); err != nil {
							if errors.Is(err, errSchemaBMissing) {
								slog.Info("campaign outreach thread skipped — Schema B mirror missing",
									"op", "main.campaignRecordOutbound/schemaBMiss",
									"contact_id", req.ContactID)
							} else {
								slog.Warn("campaign recordOutbound failed",
									"op", "main.campaignRecordOutbound/error",
									"contact_id", req.ContactID, "error", err)
							}
						}
						if err := ptrace.Record(ctx, result.MessageID, traceLayers); err != nil {
							slog.Warn("protection_trace record failed", "op", "outreach.main/server", "message_id", result.MessageID, "error", err)
						}
						// AW7-9 — orchestrator-side APPEND removed (moved
						// to relay container). See companion edit at the
						// CLI entry point ~line 320 + RCA in
						// services/relay/internal/delivery/sent_appender.go.
						_ = result
					}
				})

			// Spawn workerCount goroutines. Each one runs Engine.Run() and
			// participates in the mutex-protected dequeue/pickMailbox path.
			// Per-worker panic recovery isolates one crash from the others;
			// BulkRevertInFlight is preserved only when N==1 (legacy single-
			// worker semantic). With N>1 the reaper (AW7-3, 24h threshold)
			// handles stranded in_flight rows.
			for workerIdx := 0; workerIdx < workerCount; workerIdx++ {
				workerIdx := workerIdx // capture for closure
				go func() {
					defer func() {
						if r := recover(); r != nil {
							errMsg := fmt.Sprintf("panic: %v", r)
							slog.Error("sender worker panic recovered",
								"op", "outreach.main/senderWorker",
								"worker_idx", workerIdx,
								"recover", r)
							healthReg.Report("sender_daemon", false, errMsg)
							alertClient.DaemonPanic(ctx, "sender_daemon", errMsg)
							if workerCount == 1 {
								// AW7-4 — single-worker BulkRevert preserved.
								// With one worker, a panic strands every
								// in_flight reservation the runner made; bulk
								// revert is the explicit escape valve. With
								// N>1, the surviving workers are still
								// consuming the queue — bulk-reverting from
								// one panic would race against their sends.
								bulkCtx, bulkCancel := context.WithTimeout(context.Background(), 10*time.Second)
								defer bulkCancel()
								if reverted, err := campaign.BulkRevertInFlight(bulkCtx, database); err != nil {
									slog.Warn("BulkRevertInFlight after engine panic failed",
										"op", "outreach.main/server-engine-panic",
										"error", err)
								} else {
									audit.Log(bulkCtx, database,
										audit.ActionEnginePanicRecovered, "engine.run", "campaign", "*",
										map[string]any{
											"scope":    "engine_run_goroutine",
											"reverted": reverted,
											"recover":  errMsg,
										})
								}
							}
						}
					}()
					campaignSendEngine.Run(ctx, senderCallback)
				}()
			}

			go func() {
				slog.Info("campaign daemon started", "interval", campaignInterval)
				campaignConsecutiveFails := 0
				processCampaigns := func() {
					defer func() {
						if r := recover(); r != nil {
							errMsg := fmt.Sprintf("panic: %v", r)
							slog.Error("campaign daemon panic recovered", "op", "outreach.main/server", "recover", r)
							campaignConsecutiveFails++
							healthReg.Report("campaign_daemon", false, errMsg)
							alertClient.DaemonPanic(ctx, "campaign_daemon", errMsg)
							if campaignConsecutiveFails >= 3 {
								alertClient.DaemonPanic(ctx, "campaign_daemon",
									fmt.Sprintf("3 consecutive failures — last: %s", errMsg))
							}
						}
					}()
					schedDB := campaign.NewPostgresSchedulerDB(connectDB())
					schedLocker := campaign.NewPostgresLocker(connectDB())
					sched := campaign.NewScheduler(schedDB, campaignRunner, schedLocker)
					sched.Tick(ctx)
					campaignConsecutiveFails = 0 // reset on success
					healthReg.Report("campaign_daemon", true, "")
				}
				processCampaigns()
				ticker := time.NewTicker(campaignInterval)
				defer ticker.Stop()
				for {
					select {
					case <-ctx.Done():
						slog.Info("campaign daemon stopped")
						return
					case <-ticker.C:
						processCampaigns()
					}
				}
			}()
			slog.Info("Campaign daemon started", "interval", campaignInterval)

			// H4.3: Sentry alert when campaign_daemon tick is absent >5 min.
			// No-op when SENTRY_DSN_GO is unset.
			go runDaemonDeadAlert(ctx, healthReg)

			// AW7-3 — watchdog reaper for stuck campaign_contacts.status='in_flight'
			// rows. AW7 (PR #1186) atomicity left a gap: if the engine never
			// invokes the onSent callback (process crash, container OOM-kill,
			// abrupt shutdown), the row stays 'in_flight' forever. The
			// next-tick filter excludes it, so it becomes dark inventory.
			// This daemon sweeps stuck rows back to 'pending' so the next
			// tick re-picks them. Threshold default 24h, override via
			// IN_FLIGHT_STUCK_THRESHOLD_HOURS. 1h tick is conservative —
			// no race pressure to react faster.
			if !envconfig.BoolOr("DISABLE_IN_FLIGHT_REAPER", false) {
				reaperInterval := 1 * time.Hour
				if v := envconfig.GetOr("IN_FLIGHT_REAPER_INTERVAL", ""); v != "" {
					if d, err := time.ParseDuration(v); err == nil {
						reaperInterval = d
					}
				}
				reaper := campaign.NewInFlightReaper(connectDB())
				go func() {
					slog.Info("in-flight reaper daemon started",
						"interval", reaperInterval,
						"threshold_hours", reaper.Threshold().Hours())
					processStuckInFlight := func() {
						defer func() {
							if r := recover(); r != nil {
								errMsg := fmt.Sprintf("panic: %v", r)
								slog.Error("in-flight reaper panic recovered",
									"op", "outreach.main/inFlightReaper",
									"recover", r)
								healthReg.Report("in_flight_reaper", false, errMsg)
								alertClient.DaemonPanic(ctx, "in_flight_reaper", errMsg)
							}
						}()
						reapCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
						defer cancel()
						if _, err := reaper.Run(reapCtx); err != nil {
							slog.Warn("in-flight reaper sweep failed",
								"op", "outreach.main/inFlightReaper",
								"error", err)
							healthReg.Report("in_flight_reaper", false, err.Error())
							return
						}
						healthReg.Report("in_flight_reaper", true, "")
					}
					processStuckInFlight()
					ticker := time.NewTicker(reaperInterval)
					defer ticker.Stop()
					for {
						select {
						case <-ctx.Done():
							slog.Info("in-flight reaper daemon stopped")
							return
						case <-ticker.C:
							processStuckInFlight()
						}
					}
				}()
			} else {
				slog.Info("In-flight reaper disabled (DISABLE_IN_FLIGHT_REAPER=1)")
			}
		} else {
			slog.Info("Campaign daemon disabled (DISABLE_CAMPAIGN_DAEMON=1)")
		}

		// IMAP reply polling daemon — checks mailboxes for incoming replies.
		if len(cfg.Mailboxes) > 0 && !envconfig.BoolOr("DISABLE_IMAP_POLL", false) {
			imapInterval := 2 * time.Minute
			if v := envconfig.GetOr("IMAP_INTERVAL", ""); v != "" {
				if d, err := time.ParseDuration(v); err == nil {
					imapInterval = d
				}
			}
			imapProcessor := thread.NewInboundProcessor(database)
			if pp := wirePhotoProcessor(database); pp != nil {
				imapProcessor.WithPhotoProcessor(pp)
			}
			if ollamaURL := envconfig.GetOr("OLLAMA_URL", ""); ollamaURL != "" {
				ollamaModel := envconfig.GetOr("OLLAMA_MODEL", "gemma2:2b")
				llmClient := llm.NewClient(llm.Config{BaseURL: ollamaURL, Model: ollamaModel})
				if err := llmClient.Ping(ctx); err == nil {
					imapProcessor.WithClassifier(llm.NewReplySentimentClassifier(llmClient))
					slog.Info("IMAP: LLM sentiment classifier enabled", "model", ollamaModel)
				}
			}
			// AC8 — Haiku pre-classification. Optional, fire-and-forget.
			if wired := wireAC8PreClassifier(imapProcessor, database); wired {
				slog.Info("IMAP: AC8 Haiku pre-classifier enabled",
					"op", "outreach.main/ac8Wired",
					"model", acllm.DefaultModel)
			}
			imapAlertClient := alert.New()
			imapProcessor.WithInterestedHook(func(hCtx context.Context, from string, threadID int64) {
				imapAlertClient.InterestedReply(hCtx, from, threadID)
			})
			imapPoller := imapPkg.NewPoller(cfg.Mailboxes, imapProcessor).
				WithHealth(healthReg).
				WithAuditDB(database) // Track E inbound audit (migration 019)
			// Wrap PollDaemon with recover so a panic (e.g. malformed MIME,
			// IMAP library state bug) does not silently kill the reply path.
			// Without this, bounces and unsubscribes would stop flowing and
			// the only visible symptom would be "no replies" on the dashboard.
			go func() {
				defer func() {
					if r := recover(); r != nil {
						errMsg := fmt.Sprintf("panic: %v", r)
						slog.Error("imap poll daemon panic recovered", "op", "outreach.main/server", "recover", r)
						healthReg.Report("imap_daemon", false, errMsg)
						alertClient.DaemonPanic(ctx, "imap_daemon", errMsg)
					}
				}()
				imapPoller.PollDaemon(ctx, imapInterval)
			}()
			slog.Info("IMAP poll daemon started", "interval", imapInterval, "mailboxes", len(cfg.Mailboxes))
		} else if len(cfg.Mailboxes) == 0 {
			slog.Info("IMAP poll disabled (no mailboxes configured)")
		} else {
			slog.Info("IMAP poll disabled (DISABLE_IMAP_POLL=1)")
		}

		// Mailbox score loop — CAD-S8 / issue #539.
		// Runs every 4h (configurable via MAILBOX_SCORE_INTERVAL) and probes
		// each active mailbox via relay POST /v1/probe, writing last_score +
		// last_score_at to outreach_mailboxes.  Moved here from BFF-side
		// runFullCheckCron so scoring runs 24/7 on Railway rather than only
		// when pnpm dev is active.
		if !envconfig.BoolOr("DISABLE_MAILBOX_SCORE_LOOP", false) {
			relayURL := envconfig.GetOr("ANTI_TRACE_RELAY_URL", "")
			relayToken := envconfig.GetOr("ANTI_TRACE_TOKEN", "")
			scoreOpts := []intelligence.MailboxScoreOption{}
			if v := envconfig.GetOr("MAILBOX_SCORE_INTERVAL", ""); v != "" {
				if d, err := time.ParseDuration(v); err == nil {
					scoreOpts = append(scoreOpts, intelligence.WithScoreInterval(d))
				}
			}
			scoreLoop := intelligence.NewMailboxScoreLoop(connectDB(), relayURL, relayToken, scoreOpts...)
			go func() {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("mailbox score loop panic recovered",
							"op", "main.scoreLoop/recover",
							"recover", r)
					}
				}()
				if err := scoreLoop.Run(ctx); err != nil && ctx.Err() == nil {
					slog.Error("mailbox score loop exited unexpectedly",
						"op", "main.scoreLoop/exit",
						"error", err)
				}
			}()
			slog.Info("Mailbox score loop started", "relay_url", relayURL)
		} else {
			slog.Info("Mailbox score loop disabled (DISABLE_MAILBOX_SCORE_LOOP=1)")
		}

		// Z3-A — IMAP poll + outbound reply crons migrated from BFF.
		startImapPollLoop(ctx, connectDB(), inboundProc)
		startOutboundReplyLoop(ctx, connectDB())

		// Z3-B: bounce-defense crons migrated from BFF.
		{
			bounceDB := connectDB()
			opConf := operatorconfig.New(bounceDB)
			StartBounceFlipLoop(ctx, bounceDB)
			StartMailboxBounceThrottleLoop(ctx, bounceDB, opConf)
			StartBounceRateMonitorLoop(ctx, bounceDB, opConf)
			// Sprint AC10 — 1h sliding-window bounce alert (warning).
			StartBounceRate1hLoop(ctx, bounceDB, opConf)
			// Sprint AC6 — per-mailbox distribution audit (info).
			StartDistributionAuditLoop(ctx, bounceDB, opConf)
			// Sprint AH2 — campaign-level domain overlap detector.
			StartDomainOverlapLoop(ctx, bounceDB, opConf)
		}

		// Z3 Bundle C — mailbox healing cron migrated from BFF.
		if !envconfig.BoolOr("DISABLE_MAILBOX_HEALING", false) {
			startMailboxHealingDaemon(ctx, connectDB(), loadMailboxHealingConfig())
		} else {
			slog.Info("Mailbox healing daemon disabled (DISABLE_MAILBOX_HEALING=1)")
		}

		// Z3-D — greylist retry loop.
		if !envconfig.BoolOr("DISABLE_GREYLIST_RETRY_LOOP", false) {
			greylistLoop := intelligence.NewGreylistRetryLoop(connectDB())
			go func() {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("greylist retry loop panic recovered",
							"op", "main.greylistRetryLoop/recover",
							"recover", r)
					}
				}()
				if err := greylistLoop.Run(ctx); err != nil && ctx.Err() == nil {
					slog.Error("greylist retry loop exited unexpectedly",
						"op", "main.greylistRetryLoop/exit",
						"error", err)
				}
			}()
			slog.Info("Greylist retry loop started")
		} else {
			slog.Info("Greylist retry loop disabled (DISABLE_GREYLIST_RETRY_LOOP=1)")
		}

		go func() {
			<-ctx.Done()
			slog.Info("Shutting down server")
			// Graceful in-flight reclaim (2026-06-26): on SIGTERM (redeploy/
			// restart) release reserved status='in_flight' leases back to
			// 'pending' immediately, instead of leaving them for the periodic
			// InFlightReaper's IN_FLIGHT_STUCK_THRESHOLD_HOURS window. A redeploy
			// otherwise strands the active batch for ~1h, during which the
			// backlog guard (LIMIT = batch - in_flight) blocks re-enqueue and the
			// campaign goes idle. Threshold 0 → reclaim regardless of age; this is
			// a single-sender deployment so all in_flight is this instance's own
			// batch. Reuses the CAS-gated, audit-logged, send-claim-expiring Run.
			if !envconfig.BoolOr("DISABLE_SHUTDOWN_INFLIGHT_RECLAIM", false) {
				reclaimCtx, rcCancel := context.WithTimeout(context.Background(), 8*time.Second)
				if n, err := campaign.NewInFlightReaperWithThreshold(connectDB(), 0).Run(reclaimCtx); err != nil {
					slog.Warn("shutdown in-flight reclaim failed",
						"op", "outreach.main/shutdownReclaim", "error", err)
				} else if n > 0 {
					slog.Info("shutdown in-flight reclaim",
						"op", "outreach.main/shutdownReclaim", "reclaimed", n)
				}
				rcCancel()
			}
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			httpSrv.Shutdown(shutdownCtx)
		}()

		slog.Info("Tracking server started", "addr", addr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("Server failed", "op", "outreach.main/track-listen", "error", err)
			os.Exit(1)
		}

	case "import":
		if len(os.Args) < 3 {
			slog.Error("Usage: outreach import <csv_file> [--verbose]", "op", "outreach.main/import")
			os.Exit(1)
		}
		verbose := false
		for i := 3; i < len(os.Args); i++ {
			if os.Args[i] == "--verbose" {
				verbose = true
			}
		}
		importCSV(ctx, connectDB(), os.Args[2], verbose)

	case "prospect":
		firmyDSN := envconfig.GetOr("FIRMY_DSN", "")
		if firmyDSN == "" {
			slog.Error("FIRMY_DSN not set. Set it to Railway Postgres public URL.", "op", "outreach.main/prospect")
			os.Exit(1)
		}

		filter := prospect.FirmyFilter{
			HasEmail: true,
			Limit:    1000,
		}
		var scheduleInterval time.Duration
		importAll := false
		incremental := false
		pageSize := 10000

		// Parse flags
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--region":
				if i+1 < len(os.Args) {
					filter.Region = os.Args[i+1]
					i++
				}
			case "--description":
				if i+1 < len(os.Args) {
					filter.Description = os.Args[i+1]
					i++
				}
			case "--categories":
				if i+1 < len(os.Args) {
					filter.Categories = os.Args[i+1]
					i++
				}
			case "--limit":
				if i+1 < len(os.Args) {
					filter.Limit, _ = strconv.Atoi(os.Args[i+1])
					i++
				}
			case "--page-size":
				if i+1 < len(os.Args) {
					pageSize, _ = strconv.Atoi(os.Args[i+1])
					i++
				}
			case "--all":
				importAll = true
			case "--incremental":
				incremental = true
				importAll = true // incremental implies full scan from checkpoint
			case "--has-phone":
				filter.HasPhone = true
			case "--has-ico":
				filter.HasICO = true
			case "--schedule":
				if i+1 < len(os.Args) {
					if d, err := time.ParseDuration(os.Args[i+1]); err == nil {
						scheduleInterval = d
					}
					i++
				}
			case "--count":
				firmy, err := prospect.NewFirmySource(firmyDSN)
				if err != nil {
					slog.Error("Connect to firmy-cz", "op", "outreach.main/--count", "error", err)
					os.Exit(1)
				}
				defer firmy.Close()
				count, err := firmy.Count(ctx, filter)
				if err != nil {
					slog.Error("Count failed", "op", "outreach.main/--count", "error", err)
					os.Exit(1)
				}
				fmt.Printf("Matching businesses: %d\n", count)
				os.Exit(0)
			}
		}

		targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")
		buildPipeline := func(db *sql.DB) *enrich.Pipeline {
			var classifier enrich.IndustryClassifier
			var summarizer enrich.DescriptionSummarizer
			if ollamaURL := envconfig.GetOr("OLLAMA_URL", ""); ollamaURL != "" {
				ollamaModel := envconfig.GetOr("OLLAMA_MODEL", "gemma2:2b")
				llmClient := llm.NewClient(llm.Config{BaseURL: ollamaURL, Model: ollamaModel})
				if err := llmClient.Ping(ctx); err == nil {
					classifier = llm.NewIndustryClassifier(llmClient, true)
					summarizer = llm.NewDescriptionSummarizer(llmClient)
					slog.Info("Using LLM classifier + summarizer", "model", ollamaModel, "url", ollamaURL)
				}
			}
			return enrich.NewPipeline(enrich.PipelineConfig{
				TargetIndustries:      targetIndustries,
				MinTargetingScore:     0.2,
				IndustryClassifier:    classifier,
				DescriptionSummarizer: summarizer,
				CompanyStore:          company.NewStore(db),
				Workers:               10,
			})
		}

		businessesToRaw := func(businesses []prospect.FirmyBusiness) []enrich.RawContact {
			raw := make([]enrich.RawContact, 0, len(businesses))
			for _, b := range businesses {
				raw = append(raw, enrich.RawContact{
					Email:       b.Email,
					Name:        b.Name,
					ICO:         b.ICO,
					Phone:       b.Telephone,
					Website:     b.Website,
					Region:      b.Region,
					Address:     b.StreetAddress,
					PostalCode:  b.PostalCode,
					CompanySize: b.VelikostFirmy,
					Description: b.Description,
					FirmyCzID:   b.ID,
				})
			}
			return raw
		}

		runProspect := func() {
			firmy, err := prospect.NewFirmySource(firmyDSN)
			if err != nil {
				slog.Error("Connect to firmy-cz", "op", "outreach.main/--count", "error", err)
				return
			}
			defer firmy.Close()

			total, err := firmy.Count(ctx, filter)
			if err != nil {
				slog.Error("Count failed", "op", "outreach.main/--count", "error", err)
				return
			}

			db := connectDB()
			pipeline := buildPipeline(db)

			// KT-A9.1 — multi-source enrichment audit (#353).
			//
			// For every business with a non-empty ICO, run the new Pipeline.Enrich
			// (ARES + firmy.cz parallel + justice.cz fallback) and persist a
			// row to enrichment_log. The legacy pipeline.RunPipeline below
			// continues to handle honeypot detection, classification, scoring,
			// and contact INSERT — the audit here is a side-channel write so
			// operators can correlate per-source outcomes to contact IDs.
			//
			// Best-effort: if the runner cannot be constructed (no DB / no
			// ARES client), the cron skips audit and the legacy path runs
			// unchanged.
			aresClient := ares.NewClient()
			auditRunner := auditenrich.NewRunner(db, aresClient, 90*24*time.Hour)
			businessesToAuditInputs := func(businesses []prospect.FirmyBusiness) []auditenrich.Input {
				inputs := make([]auditenrich.Input, 0, len(businesses))
				for _, b := range businesses {
					if b.ICO == "" {
						continue
					}
					inputs = append(inputs, auditenrich.Input{
						ContactID: int64(b.ID),
						ICO:       b.ICO,
					})
				}
				return inputs
			}

			if importAll {
				// Cursor-based paginated import — more efficient than OFFSET for large tables.
				// Uses AfterID (WHERE id > ?) instead of OFFSET to avoid full table scans on later pages.
				// When --incremental is set, loads the checkpoint from the DB so re-runs only fetch new rows.
				startID := 0
				const checkpointSource = "firmy-cz-prospect"
				if incremental {
					row := db.QueryRowContext(ctx, `SELECT last_source_id FROM sync_checkpoints WHERE source = $1`, checkpointSource)
					if err := row.Scan(&startID); err != nil {
						slog.Warn("checkpoint load failed, starting from 0", "op", "outreach.main/--count", "error", err)
						startID = 0
					}
					fmt.Printf("Incremental import starting after firmy_cz id=%d\n", startID)
				}

				fmt.Printf("Full import started: %d matching businesses, page size %d\n", total, pageSize)
				totalImported, totalSkipped := 0, 0
				page := 0
				lastID := startID
				pageFilter := filter
				for {
					pageFilter.Limit = pageSize
					pageFilter.AfterID = lastID
					businesses, err := firmy.Fetch(ctx, pageFilter)
					if err != nil {
						slog.Error("Fetch page failed", "op", "outreach.main/--count", "page", page, "last_id", lastID, "error", err)
						break
					}
					if len(businesses) == 0 {
						break
					}
					// KT-A9.1 — audit multi-source enrichment per ICO before
					// the legacy pipeline persists the contact rows.
					auditRes := auditRunner.AuditBatch(ctx, businessesToAuditInputs(businesses))
					if auditRes.WriteFailures > 0 {
						slog.Warn("enrichment audit page — some rows nezapsány",
							"op", "outreach.runProspect/audit-page",
							"page", page,
							"audited", auditRes.Audited,
							"write_failures", auditRes.WriteFailures,
						)
					}
					imp, skip, err := pipeline.RunPipeline(ctx, db, businessesToRaw(businesses))
					if err != nil {
						slog.Error("Pipeline page failed", "op", "outreach.main/--count", "page", page, "error", err)
						break
					}
					totalImported += imp
					totalSkipped += skip
					lastID = prospect.MaxID(businesses)
					fmt.Printf("  page %d: +%d imported, %d skipped (last_id=%d, total: %d/%d)\n",
						page+1, imp, skip, lastID, totalImported, total)
					page++

					// Save checkpoint after each page so partial runs are resumable.
					if incremental {
						db.ExecContext(ctx, `
							INSERT INTO sync_checkpoints (source, last_source_id, last_run_at, records_synced, updated_at)
							VALUES ($1, $2, now(), $3, now())
							ON CONFLICT (source) DO UPDATE SET
								last_source_id = GREATEST(sync_checkpoints.last_source_id, EXCLUDED.last_source_id),
								records_synced = sync_checkpoints.records_synced + EXCLUDED.records_synced,
								last_run_at    = now(),
								updated_at     = now()
						`, checkpointSource, lastID, imp) //nolint:errcheck
					}

					if len(businesses) < pageSize {
						break // last page
					}
				}
				fmt.Printf("Full import done: %d imported, %d skipped\n", totalImported, totalSkipped)
			} else {
				fmt.Printf("Found %d matching businesses in firmy-cz\n", total)
				if filter.Limit > 0 && total > filter.Limit {
					fmt.Printf("Importing first %d (use --all for full import)\n", filter.Limit)
				}
				businesses, err := firmy.Fetch(ctx, filter)
				if err != nil {
					slog.Error("Fetch failed", "op", "outreach.main/--count", "error", err)
					return
				}
				// KT-A9.1 — audit multi-source enrichment per ICO before the
				// legacy pipeline persists the contact rows.
				auditRes := auditRunner.AuditBatch(ctx, businessesToAuditInputs(businesses))
				if auditRes.WriteFailures > 0 {
					slog.Warn("enrichment audit — některé řádky nezapsány",
						"op", "outreach.runProspect/audit-batch",
						"audited", auditRes.Audited,
						"write_failures", auditRes.WriteFailures,
					)
				}
				imported, skipped, err := pipeline.RunPipeline(ctx, db, businessesToRaw(businesses))
				if err != nil {
					slog.Error("Enrich pipeline failed", "op", "outreach.main/--count", "error", err)
					return
				}
				fmt.Printf("Enriched: %d imported, %d skipped\n", imported, skipped)
			}
		}

		if scheduleInterval > 0 {
			fmt.Printf("Prospect scheduler started (interval: %v)\n", scheduleInterval)
			runProspect() // run immediately on start
			ticker := time.NewTicker(scheduleInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					slog.Info("Scheduled prospect run starting")
					runProspect()
				}
			}
		} else {
			runProspect()
		}

	case "dashboard":
		stats, err := enrich.Stats(ctx, connectDB())
		if err != nil {
			slog.Error("Dashboard stats failed", "op", "outreach.main/dashboard", "error", err)
			os.Exit(1)
		}
		fmt.Println("╔══════════════════════════════════════╗")
		fmt.Println("║    Outreach Contact Dashboard        ║")
		fmt.Println("╠══════════════════════════════════════╣")
		fmt.Printf("║  Total contacts:    %6d           ║\n", stats["total"])
		fmt.Printf("║  New:               %6d           ║\n", stats["new"])
		fmt.Printf("║  Active:            %6d           ║\n", stats["active"])
		fmt.Printf("║  Suppressed:        %6d           ║\n", stats["suppressed"])
		fmt.Println("╠══════════════════════════════════════╣")
		fmt.Println("║  Targeting Score Distribution        ║")
		fmt.Printf("║  Auto (≥0.7):       %6d           ║\n", stats["score_auto"])
		fmt.Printf("║  Low (0.4-0.7):     %6d           ║\n", stats["score_low"])
		fmt.Printf("║  Manual (0.2-0.4):  %6d           ║\n", stats["score_manual"])
		fmt.Printf("║  Blocked (<0.2):    %6d           ║\n", stats["score_block"])
		fmt.Println("╚══════════════════════════════════════╝")

		// Suppression stats
		suppStats, err := enrich.SuppressionStats(ctx, connectDB())
		if err == nil && len(suppStats) > 0 {
			fmt.Println("\nSuppressions:")
			for reason, count := range suppStats {
				fmt.Printf("  %-20s %d\n", reason, count)
			}
		}

	case "recalc":
		targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")
		fast := len(os.Args) > 2 && os.Args[2] == "--fast"
		if fast {
			fmt.Printf("Recalculating targeting scores (fast SQL mode) for industries: %v\n", targetIndustries)
			result, err := enrich.RecalculateFast(ctx, connectDB(), targetIndustries)
			if err != nil {
				slog.Error("Fast recalc failed", "op", "outreach.main/recalc", "error", err)
				os.Exit(1)
			}
			fmt.Printf("Recalculated %d contacts in %v\n", result.Total, result.Duration.Round(time.Millisecond))
		} else {
			fmt.Println("Recalculating targeting scores...")
			result, err := enrich.RecalculateAll(ctx, connectDB(), targetIndustries)
			if err != nil {
				slog.Error("Recalc failed", "op", "outreach.main/recalc", "error", err)
				os.Exit(1)
			}
			fmt.Printf("Recalculated %d contacts in %v:\n", result.Total, result.Duration.Round(time.Millisecond))
			fmt.Printf("  Updated:  %d\n", result.Updated)
			fmt.Printf("  Promoted: %d (→ auto)\n", result.Promoted)
			fmt.Printf("  Demoted:  %d (→ lower tier)\n", result.Demoted)
			fmt.Printf("  Blocked:  %d (→ do not contact)\n", result.Blocked)
		}

	case "suppress":
		if len(os.Args) < 3 {
			slog.Error("Usage: outreach suppress <email-or-domain> [reason]", "op", "outreach.main/suppress")
			os.Exit(1)
		}
		target := os.Args[2]
		reason := "manual"
		if len(os.Args) > 3 {
			reason = os.Args[3]
		}
		if strings.Contains(target, "@") {
			err := enrich.SuppressEmail(ctx, connectDB(), target, enrich.SuppressionReason(reason), nil)
			if err != nil {
				slog.Error("Suppress email failed", "op", "outreach.main/suppress", "error", err)
				os.Exit(1)
			}
			audit.Log(ctx, connectDB(), audit.ActionContactSuppress, "cli", "email", target, map[string]any{"reason": reason})
			fmt.Printf("Suppressed email: %s (%s)\n", target, reason)
		} else {
			err := enrich.SuppressDomain(ctx, connectDB(), target, enrich.SuppressionReason(reason))
			if err != nil {
				slog.Error("Suppress domain failed", "op", "outreach.main/suppress", "error", err)
				os.Exit(1)
			}
			audit.Log(ctx, connectDB(), audit.ActionContactSuppress, "cli", "domain", target, map[string]any{"reason": reason})
			fmt.Printf("Suppressed domain: %s (%s)\n", target, reason)
		}

	case "intel":
		targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")
		intelCfg := intelligence.Config{TargetIndustries: targetIndustries}
		if cfg.FirmyDSN != "" {
			if firmyDB, err := sql.Open("postgres", cfg.FirmyDSN); err == nil {
				firmyDB.SetMaxOpenConns(5)
				intelCfg.FirmyDB = firmyDB
				intelCfg.CompanyStore = company.NewStore(connectDB())
				defer firmyDB.Close()
				slog.Info("intel: company sync enabled")
			} else {
				slog.Warn("intel: failed to open firmy DB, company sync disabled", "op", "outreach.main/intel", "error", err)
			}
		}

		// One-shot or daemon mode
		daemon := false
		interval := 6 * time.Hour
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--daemon" {
				daemon = true
			}
			if os.Args[i] == "--interval" && i+1 < len(os.Args) {
				d, err := time.ParseDuration(os.Args[i+1])
				if err == nil {
					interval = d
				}
				i++
			}
		}

		if daemon {
			fmt.Printf("Intel daemon started (interval: %v)\n", interval)
			intelligence.RunDaemon(ctx, connectDB(), intelCfg, interval)
		} else {
			result, err := intelligence.RunOnce(ctx, connectDB(), intelCfg)
			if err != nil {
				slog.Error("Intel failed", "op", "outreach.main/intel", "error", err)
				os.Exit(1)
			}
			fmt.Printf("Intel loop: %d scores recalculated, %d updated, %d suppressed (%v)\n",
				result.ScoresRecalculated, result.ScoresUpdated, result.Suppressed, result.Duration.Round(time.Millisecond))
		}

	case "report":
		report, err := intelligence.GenerateWeeklyReport(ctx, connectDB())
		if err != nil {
			slog.Error("Report failed", "op", "outreach.main/report", "error", err)
			os.Exit(1)
		}
		fmt.Print(intelligence.FormatReport(report))

	case "validate-honeypot":
		database := connectDB()
		start := time.Now()

		// Query all contacts: email, engagement counters, DB signal count
		type row struct {
			id           int
			email        string
			totalSent    int
			totalOpened  int
			totalReplied int
			dbSignals    int
		}
		rows, err := database.QueryContext(ctx, `
			SELECT c.id, c.email, c.total_sent, c.total_opened, c.total_replied,
				(SELECT COUNT(*) FROM outreach_honeypot_signals h WHERE h.contact_id = c.id AND NOT h.resolved)
			FROM outreach_contacts c
			ORDER BY c.id
		`)
		if err != nil {
			slog.Error("Honeypot validation query failed", "op", "outreach.main/validate-honeypot", "error", err)
			os.Exit(1)
		}
		defer rows.Close()

		var (
			total, patternDetected, dbFlagged int
			engagementFP, openedWithSignal    int
			missedDetections, newDetections   int
			fpEmails                          []string
		)

		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.email, &r.totalSent, &r.totalOpened, &r.totalReplied, &r.dbSignals); err != nil {
				slog.Error("Honeypot validation scan error", "op", "outreach.main/validate-honeypot", "error", err)
				continue
			}
			total++

			freshSignals := enrich.DetectHoneypot(r.email)
			isFreshDetected := len(freshSignals) > 0
			isDBFlagged := r.dbSignals > 0

			if isFreshDetected {
				patternDetected++
			}
			if isDBFlagged {
				dbFlagged++
			}

			// Drift: DB flagged but pattern scan clean → stale / zero-engagement signal only
			if isDBFlagged && !isFreshDetected {
				missedDetections++
			}
			// Drift: pattern scan detects but no DB signal → missed by pipeline
			if isFreshDetected && !isDBFlagged {
				newDetections++
			}

			// Engagement FPR: replied contacts with any unresolved signal
			if r.totalReplied > 0 && isDBFlagged {
				engagementFP++
				fpEmails = append(fpEmails, r.email)
			}
			// Soft FP: opened (not replied) with unresolved signals
			if r.totalOpened > 0 && r.totalReplied == 0 && isDBFlagged {
				openedWithSignal++
			}
		}
		if err := rows.Err(); err != nil {
			slog.Error("Honeypot validation rows error", "op", "outreach.main/validate-honeypot", "error", err)
			os.Exit(1)
		}

		patternFPR := 0.0
		cleanContacts := total - patternDetected
		if cleanContacts > 0 {
			// Pattern FPR: clean-pattern emails that are DB-flagged (zero-engagement signals on legitimate addresses)
			cleanWithDBSignals := dbFlagged - (patternDetected - missedDetections)
			if cleanWithDBSignals < 0 {
				cleanWithDBSignals = 0
			}
			patternFPR = float64(cleanWithDBSignals) / float64(cleanContacts) * 100
		}
		engFPR := 0.0
		if total > 0 {
			engFPR = float64(engagementFP) / float64(total) * 100
		}

		fmt.Printf("=== Honeypot Validation Report (Live Data) ===\n")
		fmt.Printf("Timestamp:              %s\n", time.Now().Format(time.RFC3339))
		fmt.Printf("Duration:               %v\n\n", time.Since(start).Round(time.Millisecond))
		fmt.Printf("Contacts scanned:       %d\n", total)
		fmt.Printf("Pattern detections:     %d  (fresh DetectHoneypot scan)\n", patternDetected)
		fmt.Printf("DB signals (unresolved):%d  (across contacts with signals)\n\n", dbFlagged)
		fmt.Printf("Pattern-scan FPR:       %.1f%%  (clean-pattern emails with DB signals)\n", patternFPR)
		fmt.Printf("Engagement FPR:         %.1f%%  (replied contacts with unresolved signals)\n\n", engFPR)
		fmt.Printf("False positives (replied with signals): %d\n", engagementFP)
		for _, e := range fpEmails {
			fmt.Printf("  ! %s\n", e)
		}
		fmt.Printf("Soft FP (opened-only with signals):     %d\n", openedWithSignal)
		fmt.Printf("Stale signals (DB flagged, scan clean): %d\n", missedDetections)
		fmt.Printf("Missed by pipeline (scan+, DB-):        %d\n", newDetections)

	case "poll":
		pollDB := connectDB()
		processor := thread.NewInboundProcessor(pollDB)
		if pp := wirePhotoProcessor(pollDB); pp != nil {
			processor.WithPhotoProcessor(pp)
		}
		// Optional LLM-based sentiment classifier for reply routing
		if ollamaURL := envconfig.GetOr("OLLAMA_URL", ""); ollamaURL != "" {
			ollamaModel := envconfig.GetOr("OLLAMA_MODEL", "gemma2:2b")
			llmClient := llm.NewClient(llm.Config{BaseURL: ollamaURL, Model: ollamaModel})
			if err := llmClient.Ping(ctx); err == nil {
				processor.WithClassifier(llm.NewReplySentimentClassifier(llmClient))
				slog.Info("Using LLM sentiment classifier for replies", "model", ollamaModel)
			}
		}
		// AC8 — Haiku pre-classification (poll subcommand path).
		if wired := wireAC8PreClassifier(processor, pollDB); wired {
			slog.Info("Poll: AC8 Haiku pre-classifier enabled",
				"op", "outreach.main/ac8WiredPollCmd",
				"model", acllm.DefaultModel)
		}
		// Wire alert hook for interested/meeting replies
		pollAlertClient := alert.New()
		processor.WithInterestedHook(func(hCtx context.Context, from string, threadID int64) {
			pollAlertClient.InterestedReply(hCtx, from, threadID)
		})
		pollHealthReg := health.New()
		// Track E inbound audit (migration 019). connectDB() opens a fresh handle
		// for the audit sink so a transient pool issue on the processor's DB
		// does not bleed into channel_audit_log writes.
		poller := imapPkg.NewPoller(cfg.Mailboxes, processor).
			WithHealth(pollHealthReg).
			WithAuditDB(connectDB())

		daemon := false
		interval := 2 * time.Minute
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--daemon" {
				daemon = true
			}
			if os.Args[i] == "--interval" && i+1 < len(os.Args) {
				d, err := time.ParseDuration(os.Args[i+1])
				if err == nil {
					interval = d
				}
				i++
			}
		}

		if daemon {
			fmt.Printf("IMAP poll daemon started (interval: %v, mailboxes: %d)\n", interval, len(cfg.Mailboxes))
			poller.PollDaemon(ctx, interval)
		} else {
			results, err := poller.PollOnce(ctx)
			if err != nil {
				slog.Error("Poll failed", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
			total := 0
			for _, r := range results {
				fmt.Printf("  %s: fetched %d, matched %d, errors %d (%v)\n",
					r.Mailbox, r.Fetched, r.Matched, r.Errors, r.Duration.Round(time.Millisecond))
				total += r.Matched
			}
			fmt.Printf("Total matched: %d\n", total)
		}

	case "sync-companies", "sync-mvp":
		syncArgs := os.Args[2:]
		if cmd == "sync-mvp" {
			fmt.Println("Running sync MVP profile (incremental + prod metadata + categories + verify)...")
			syncArgs = buildSyncMVPArgs(syncArgs)
		}
		opts := parseSyncCompaniesOptions(syncArgs, envconfig.GetOr("SYNC_BATCH_SIZE", ""))
		if opts.MetadataOnly && opts.BackfillCategoriesJSON {
			slog.Error("--metadata-only cannot be combined with --backfill-categories-json", "op", "outreach.main/poll")
			os.Exit(1)
		}
		// Fast metadata iteration mode should avoid expensive quality-tier aggregates.
		if opts.MetadataOnly {
			opts.SkipTierStats = true
		}

		var firmyDB *sql.DB
		if !opts.MetadataOnly {
			firmyDSN := envconfig.GetOr("FIRMY_DSN", "")
			if firmyDSN == "" {
				slog.Error("FIRMY_DSN not set. Set it to Railway Postgres public URL.", "op", "outreach.main/poll")
				os.Exit(1)
			}

			var err error
			firmyDB, err = sql.Open("postgres", firmyDSN)
			if err != nil {
				slog.Error("Connect to firmy-cz", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
			defer firmyDB.Close()
			firmyDB.SetMaxOpenConns(5)

			if err := firmyDB.PingContext(ctx); err != nil {
				slog.Error("Ping firmy-cz", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
		}

		var prodDB *sql.DB
		if opts.SyncProdMetadata || opts.VerifySync {
			prodDSN := envconfig.GetOr("OUTREACH_PROD_DSN", "")
			if prodDSN == "" {
				slog.Error("OUTREACH_PROD_DSN not set. Set it to production outreach Postgres URL.", "op", "outreach.main/poll")
				os.Exit(1)
			}

			var err error
			prodDB, err = sql.Open("postgres", prodDSN)
			if err != nil {
				slog.Error("Connect to production outreach DB", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
			defer prodDB.Close()
			prodDB.SetMaxOpenConns(5)
			if err := prodDB.PingContext(ctx); err != nil {
				slog.Error("Ping production outreach DB", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
		}

		if !opts.MetadataOnly {
			syncer := company.NewSyncer(firmyDB, connectDB(), company.SyncConfig{
				BatchSize:   opts.BatchSize,
				Incremental: opts.Incremental,
			})

			if opts.BackfillCategoriesJSON {
				fmt.Println("Backfilling categories_json from firmy-cz...")
				n, err := syncer.BackfillCategoriesJSON(ctx)
				if err != nil {
					slog.Error("Backfill categories_json failed", "op", "outreach.main/poll", "error", err)
					os.Exit(1)
				}
				fmt.Printf("Backfill complete: %d companies updated with categories_json\n", n)
				break
			}

			if opts.Incremental {
				fmt.Println("Starting incremental company sync from firmy-cz...")
			} else {
				fmt.Println("Starting full company sync from firmy-cz...")
			}
			result, err := syncer.Run(ctx)
			if err != nil {
				slog.Error("Sync failed", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
			fmt.Printf("Sync complete:\n")
			fmt.Printf("  Companies upserted: %d\n", result.CompaniesUpserted)
			fmt.Printf("  Linked by firmy_id: %d\n", result.LinkedByFirmyID)
			fmt.Printf("  Linked by ICO:      %d\n", result.LinkedByICO)
			fmt.Printf("  Metrics updated:    %d\n", result.MetricsUpdated)
		} else {
			fmt.Println("Skipping firmy sync (--metadata-only).")
		}

		if opts.SyncProdMetadata {
			fmt.Println("Syncing classification metadata from production outreach DB...")
			metadataSyncer := company.NewMetadataSyncer(prodDB, connectDB(), company.MetadataSyncConfig{
				BatchSize:     opts.BatchSize,
				StartAfterID:  opts.MetadataStartID,
				UseCheckpoint: true,
				MaxBatches:    opts.MetadataMaxBatches,
			})
			metaResult, err := metadataSyncer.Run(ctx)
			if err != nil {
				slog.Error("Production metadata sync failed", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
			fmt.Printf("  Metadata source rows: %d\n", metaResult.SourceRows)
			fmt.Printf("  Metadata updated:     %d\n", metaResult.UpdatedRows)
			fmt.Printf("  Metadata batches:     %d\n", metaResult.Batches)
		}

		if opts.RefreshCategories {
			fmt.Println("Refreshing category tree counts...")
			updatedCategories, err := category.NewStore(connectDB()).RefreshCounts(ctx)
			if err != nil {
				slog.Error("Category refresh failed", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
			fmt.Printf("  Categories refreshed: %d\n", updatedCategories)
		}

		if opts.VerifySync {
			fmt.Println("Verifying production vs localhost metadata snapshot...")
			sourceSnapshot, err := company.LoadMetadataSnapshot(ctx, prodDB)
			if err != nil {
				slog.Error("Load production snapshot failed", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}
			targetSnapshot, err := company.LoadMetadataSnapshot(ctx, connectDB())
			if err != nil {
				slog.Error("Load localhost snapshot failed", "op", "outreach.main/poll", "error", err)
				os.Exit(1)
			}

			drift := company.CompareMetadataSnapshots(sourceSnapshot, targetSnapshot)
			fmt.Printf("  Snapshot(prod): companies=%d classified=%d sector_primary=%d pass=%d hard=%d soft=%d categories=%d cat_sum=%d\n",
				sourceSnapshot.Companies, sourceSnapshot.Classified, sourceSnapshot.SectorPrimary,
				sourceSnapshot.Pass, sourceSnapshot.HardBlock, sourceSnapshot.SoftBlock,
				sourceSnapshot.CategoriesRows, sourceSnapshot.CategoriesCompanySum)
			fmt.Printf("  Snapshot(local): companies=%d classified=%d sector_primary=%d pass=%d hard=%d soft=%d categories=%d cat_sum=%d\n",
				targetSnapshot.Companies, targetSnapshot.Classified, targetSnapshot.SectorPrimary,
				targetSnapshot.Pass, targetSnapshot.HardBlock, targetSnapshot.SoftBlock,
				targetSnapshot.CategoriesRows, targetSnapshot.CategoriesCompanySum)
			fmt.Printf("  Drift(local-prod): companies=%d classified=%d sector_primary=%d pass=%d hard=%d soft=%d categories=%d cat_sum=%d\n",
				drift.Companies, drift.Classified, drift.SectorPrimary, drift.Pass,
				drift.HardBlock, drift.SoftBlock, drift.CategoriesRows, drift.CategoriesCompanySum)

			if !drift.Aligned {
				slog.Error("Sync verification failed: localhost still differs from production snapshot", "op", "outreach.main/poll")
				os.Exit(1)
			}
			fmt.Println("  Sync verification: aligned.")
		}

		if shouldPrintTierStats(opts) {
			stats, err := company.NewStore(connectDB()).TierStats(ctx)
			if err == nil {
				fmt.Println("  Quality tiers:")
				for _, tier := range []string{"raw", "enriched", "scored", "contacted", "engaged"} {
					fmt.Printf("    %-12s %d\n", tier, stats[tier])
				}
			}
		}

	case "classify":
		dryRun := false
		force := false
		batchSize := 5000
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--dry-run":
				dryRun = true
			case "--force":
				force = true
			case "--batch":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						batchSize = n
					}
					i++
				}
			}
		}
		d := connectDB()
		if force {
			_, err := d.ExecContext(ctx, `UPDATE companies SET classified_at = NULL`)
			if err != nil {
				slog.Error("Reset classified_at failed", "op", "outreach.main/--batch", "error", err)
				os.Exit(1)
			}
			fmt.Println("Reset all classified_at — re-classifying all companies.")
		}
		result, err := classify.RunJob(ctx, d, classify.JobConfig{
			BatchSize: batchSize,
			DryRun:    dryRun,
			ICPConfig: classify.DefaultICPConfig(),
		})
		if err != nil {
			slog.Error("Classify job failed", "op", "outreach.main/--batch", "error", err)
			os.Exit(1)
		}
		fmt.Printf("Classify done: processed=%d hard_block=%d soft_block=%d needs_review=%d classified=%d scored=%d\n",
			result.Processed, result.HardBlocked, result.SoftBlocked,
			result.NeedsReview, result.Classified, result.Scored)

	case "reclassify-nace":
		reclBatch := 5000
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--batch" && i+1 < len(os.Args) {
				if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
					reclBatch = n
				}
				i++
			}
		}
		d := connectDB()
		reclResult, err := classify.RunReclassifyNACE(ctx, d, classify.DefaultICPConfig(), reclBatch)
		if err != nil {
			slog.Error("Reclassify NACE failed", "op", "outreach.main/reclassify-nace", "error", err)
			os.Exit(1)
		}
		fmt.Printf("Reclassify NACE: candidates=%d upgraded=%d unchanged=%d\n",
			reclResult.Candidates, reclResult.Upgraded, reclResult.Unchanged)

	case "promote":
		targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")
		promoteCfg := enrich.PromoteConfig{
			ICPTiers:         []string{"ideal", "good"},
			EmailStatuses:    []string{"valid"},
			BatchSize:        5000,
			TargetIndustries: targetIndustries,
		}
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--tier":
				if i+1 < len(os.Args) {
					promoteCfg.ICPTiers = strings.Split(os.Args[i+1], ",")
					i++
				}
			case "--email-status":
				if i+1 < len(os.Args) {
					promoteCfg.EmailStatuses = strings.Split(os.Args[i+1], ",")
					i++
				}
			case "--batch":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						promoteCfg.BatchSize = n
					}
					i++
				}
			case "--dry-run":
				promoteCfg.DryRun = true
			}
		}
		fmt.Printf("Promoting companies → outreach contacts (tiers: %v, email: %v)...\n",
			promoteCfg.ICPTiers, promoteCfg.EmailStatuses)
		promResult, err := enrich.PromoteCompanies(ctx, connectDB(), promoteCfg)
		if err != nil {
			slog.Error("Promote failed", "op", "outreach.main/--dry-run", "error", err)
			os.Exit(1)
		}
		fmt.Printf("Promote done: queried=%d created=%d errors=%d\n",
			promResult.Queried, promResult.Created, promResult.Errors)
		if !promoteCfg.DryRun && promResult.Created > 0 {
			fmt.Println("Run 'outreach recalc' to recalculate targeting scores for new contacts.")
		}

	case "backfill-contacts":
		// One-time backfill: sync existing outreach_contacts → contacts (Schema A)
		// so campaign enrollment can find promoted companies.
		d := connectDB()
		dryRun := false
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--dry-run" {
				dryRun = true
			}
		}
		query := `
			INSERT INTO contacts (email, email_hash, first_name, company_name, ico, region, industry, company_size, score, status, source)
			SELECT
				oc.email,
				oc.email_hash,
				oc.first_name,
				oc.company_name,
				oc.ico,
				oc.region,
				COALESCE(oc.industry_tags[1], ''),
				oc.company_size,
				LEAST(GREATEST(ROUND(oc.targeting_score * 100)::int, 0), 100),
				'valid',
				'promoted'
			FROM outreach_contacts oc
			WHERE oc.status NOT IN ('bounced', 'unsubscribed', 'blacklisted', 'invalid')
			ON CONFLICT (email_hash) DO UPDATE SET
				score = EXCLUDED.score,
				status = 'valid',
				company_name = COALESCE(EXCLUDED.company_name, contacts.company_name),
				region = COALESCE(EXCLUDED.region, contacts.region),
				industry = COALESCE(EXCLUDED.industry, contacts.industry),
				updated_at = now()`
		if dryRun {
			var count int
			d.QueryRowContext(ctx, `SELECT COUNT(*) FROM outreach_contacts WHERE status NOT IN ('bounced','unsubscribed','blacklisted','invalid')`).Scan(&count)
			fmt.Printf("[dry-run] Would backfill %d outreach_contacts → contacts\n", count)
		} else {
			res, err := d.ExecContext(ctx, query)
			if err != nil {
				slog.Error("Backfill failed", "op", "outreach.main/backfill-contacts", "error", err)
				os.Exit(1)
			}
			affected, _ := res.RowsAffected()
			fmt.Printf("Backfill complete: %d contacts synced to Schema A\n", affected)
		}

	case "ares-sync":
		aresDryRun := false
		batchSize := 1000
		rateMs := 1000
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--dry-run":
				aresDryRun = true
			case "--batch":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						batchSize = n
					}
					i++
				}
			case "--rate-ms":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						rateMs = n
					}
					i++
				}
			}
		}
		client := ares.NewClient(
			ares.WithRateLimit(time.Duration(rateMs) * time.Millisecond),
		)
		result, err := ares.RunSync(ctx, connectDB(), client, ares.SyncConfig{
			BatchSize: batchSize,
			DryRun:    aresDryRun,
		})
		if err != nil {
			slog.Error("ARES sync failed", "op", "outreach.main/--rate-ms", "error", err)
			os.Exit(1)
		}
		fmt.Printf("ARES sync done: total=%d synced=%d not_found=%d errors=%d skipped=%d\n",
			result.Total, result.Synced, result.NotFound, result.Errors, result.Skipped)

	case "res-import":
		// Bulk import from CSÚ RES (res_data.csv) — NACE codes + founding date.
		// Much faster than per-ICO ARES API calls.
		resDryRun := false
		resBatch := 2000
		resSkipClosed := true
		resURL := ""
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--dry-run":
				resDryRun = true
			case "--batch":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						resBatch = n
					}
					i++
				}
			case "--url":
				if i+1 < len(os.Args) {
					resURL = os.Args[i+1]
					i++
				}
			case "--include-closed":
				resSkipClosed = false
			}
		}
		fmt.Println("Starting CSÚ RES bulk import (NACE codes + founding date)...")
		if resDryRun {
			fmt.Println("  DRY RUN — no DB writes")
		}
		t0 := time.Now()
		resResult, err := ares.RunRESImport(ctx, connectDB(), ares.RESImportConfig{
			DataURL:    resURL,
			SkipClosed: resSkipClosed,
			DryRun:     resDryRun,
			BatchSize:  resBatch,
		})
		if err != nil {
			slog.Error("RES import failed", "op", "outreach.main/--include-closed", "error", err)
			os.Exit(1)
		}
		fmt.Print(ares.FormatRESResult(resResult, time.Since(t0)))

	case "enrich-local":
		if len(os.Args) < 3 {
			slog.Error("Usage: outreach enrich-local <csv_file>", "op", "outreach.main/enrich-local")
			os.Exit(1)
		}
		enrichLocalCSV(ctx, connectDB(), os.Args[2])

	case "audit-log":
		limit := 50
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--limit" && i+1 < len(os.Args) {
				if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
					limit = n
				}
				i++
			}
		}
		entries, err := audit.Recent(ctx, connectDB(), limit)
		if err != nil {
			slog.Error("Audit log failed", "op", "outreach.main/audit-log", "error", err)
			os.Exit(1)
		}
		if len(entries) == 0 {
			fmt.Println("No audit log entries.")
		} else {
			fmt.Printf("%-24s %-8s %-22s %-12s %-20s %s\n", "Time", "Actor", "Action", "EntityType", "EntityID", "Details")
			fmt.Println(strings.Repeat("─", 100))
			for _, e := range entries {
				details := ""
				if len(e.Details) > 0 {
					if b, err := json.Marshal(e.Details); err == nil {
						details = string(b)
					}
				}
				fmt.Printf("%-24s %-8s %-22s %-12s %-20s %s\n",
					e.CreatedAt.Format("2006-01-02 15:04:05 MST"),
					e.Actor, e.Action, e.EntityType, e.EntityID, details)
			}
		}

	case "preview":
		// preview <template> [--contact-id <id>] [--step <n>] [--email <e>]
		//                    [--name <n>] [--company <c>] [--region <r>] [--html]
		if len(os.Args) < 3 {
			slog.Error("Usage: outreach preview <template> [--contact-id <id>] [--step <n>] [--name <n>] [--company <c>] [--region <r>] [--html]", "op", "outreach.main/preview")
			os.Exit(1)
		}
		templateName := os.Args[2]

		var (
			contactID int64
			step      int
			showHTML  bool
			vars      content.TemplateVars
		)
		for i := 3; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--contact-id":
				if i+1 < len(os.Args) {
					contactID, _ = strconv.ParseInt(os.Args[i+1], 10, 64)
					i++
				}
			case "--step":
				if i+1 < len(os.Args) {
					step, _ = strconv.Atoi(os.Args[i+1])
					i++
				}
			case "--name":
				if i+1 < len(os.Args) {
					vars.Jmeno = os.Args[i+1]
					i++
				}
			case "--company":
				if i+1 < len(os.Args) {
					vars.Firma = os.Args[i+1]
					i++
				}
			case "--region":
				if i+1 < len(os.Args) {
					vars.Region = os.Args[i+1]
					i++
				}
			case "--html":
				showHTML = true
			}
		}

		// If contact-id provided, load contact from DB
		if contactID > 0 {
			store := contact.NewStore(connectDB())
			c, err := store.FindByID(ctx, contactID)
			if err != nil {
				slog.Error("Contact not found", "op", "outreach.main/--html", "id", contactID, "error", err)
				os.Exit(1)
			}
			if vars.Jmeno == "" {
				vars.Jmeno = c.FirstName
			}
			if vars.Firma == "" {
				vars.Firma = c.CompanyName
			}
			if vars.Region == "" {
				vars.Region = c.Region
			}
			vars.Prijmeni = c.LastName
			vars.ICO = c.ICO
		}

		// Fill placeholders for any empty fields so preview is readable
		if vars.Jmeno == "" {
			vars.Jmeno = "Jan"
		}
		if vars.Firma == "" {
			vars.Firma = "Stroje s.r.o."
		}
		if vars.Region == "" {
			vars.Region = "Praha"
		}
		// Apply persona signature (use first mailbox persona or global)
		persona := cfg.Persona
		if len(cfg.Mailboxes) > 0 {
			persona = cfg.Mailboxes[0].ResolvePersona(cfg.Persona)
		}
		previewHumanize := humanize.NewEngine(humanize.Persona{
			Name: persona.Name, Role: persona.Role, Company: persona.Company,
			Phone: persona.Phone, Email: persona.Email, Website: persona.Website,
			Region: persona.Region,
		})
		vars.Podpis = previewHumanize.Signature.Render(previewHumanize.Signature.Select(time.Now()))

		templatesDir := envconfig.GetOr("TEMPLATES_DIR", "configs/templates")
		contentEngine := content.NewEngineWithDB(connectDB(), templatesDir, nil)

		rendered, err := contentEngine.Render(templateName, vars, contactID, step)
		if err != nil {
			slog.Error("Render failed", "op", "outreach.main/--html", "template", templateName, "error", err)
			os.Exit(1)
		}

		seedVal := contactID*100 + int64(step)
		fmt.Printf("=== Preview: %s (contact=%d, step=%d, seed=%d) ===\n\n", templateName, contactID, step, seedVal)
		fmt.Printf("Subject: %s\n\n", rendered.Subject)
		fmt.Println("--- Body (plain) ---")
		fmt.Println(rendered.BodyPlain)
		if showHTML {
			fmt.Println("\n--- Body (HTML) ---")
			fmt.Println(rendered.BodyHTML)
		}
		fmt.Printf("\nHeaders:\n")
		for k, v := range rendered.Headers {
			fmt.Printf("  %s: %s\n", k, v)
		}

	case "seed":
		clear := false
		clearProdlike := false
		clearAll := false
		withEdgeCases := false
		withDashboard := false
		scaleFlag := ""    // empty → legacy E2E seed (data.go); otherwise prodlike
		scenariosArg := "" // comma-separated list, or "all"
		for i := 2; i < len(os.Args); i++ {
			switch {
			case os.Args[i] == "--clear":
				clear = true
			case os.Args[i] == "--clear-prodlike":
				clearProdlike = true
			case os.Args[i] == "--clear-all":
				clearAll = true
			case os.Args[i] == "--with-edge-cases":
				withEdgeCases = true
			case os.Args[i] == "--with-dashboard":
				withDashboard = true
			case os.Args[i] == "--scale" && i+1 < len(os.Args):
				scaleFlag = os.Args[i+1]
				i++
			case strings.HasPrefix(os.Args[i], "--scale="):
				scaleFlag = strings.TrimPrefix(os.Args[i], "--scale=")
			case os.Args[i] == "--scenarios" && i+1 < len(os.Args):
				scenariosArg = os.Args[i+1]
				i++
			case strings.HasPrefix(os.Args[i], "--scenarios="):
				scenariosArg = strings.TrimPrefix(os.Args[i], "--scenarios=")
			}
		}

		database := connectDB()

		// Optional firmy-db connection
		var firmyDB *sql.DB
		if dsn := envconfig.GetOr("FIRMY_DSN", ""); dsn != "" {
			var err error
			firmyDB, err = sql.Open("postgres", dsn)
			if err == nil {
				firmyDB.SetMaxOpenConns(5)
				defer firmyDB.Close()
			} else {
				slog.Warn("firmy-db connect failed, skipping", "op", "outreach.main/seed", "error", err)
			}
		}

		// --clear-all: wipe both E2E and prodlike rows; explicit caller action.
		if clearAll {
			if err := seed.ClearAll(ctx, database, firmyDB); err != nil {
				slog.Error("Clear E2E seed data failed", "op", "outreach.main/seed", "error", err)
				os.Exit(1)
			}
			if err := prodlike.ClearProdLike(ctx, database); err != nil {
				slog.Error("Clear prodlike data failed", "op", "outreach.main/seed", "error", err)
				os.Exit(1)
			}
			fmt.Println("All seed data cleared (E2E + prodlike).")
			return
		}

		if clearProdlike {
			if err := prodlike.ClearProdLike(ctx, database); err != nil {
				slog.Error("Clear prodlike data failed", "op", "outreach.main/seed", "error", err)
				os.Exit(1)
			}
			fmt.Println("Prodlike seed data cleared.")
			return
		}

		if clear {
			if err := seed.ClearAll(ctx, database, firmyDB); err != nil {
				slog.Error("Clear seed data failed", "op", "outreach.main/seed", "error", err)
				os.Exit(1)
			}
			fmt.Println("E2E seed data cleared.")
			return
		}

		// Prodlike path: opt-in via --scale=<tiny|small|medium|large>.
		// Existing 60-contact E2E seed stays the default to preserve CI.
		if scaleFlag != "" {
			scale := prodlike.Scale(scaleFlag)
			// Validate scale early so typos fail fast.
			switch scale {
			case prodlike.ScaleTiny, prodlike.ScaleSmall, prodlike.ScaleMedium, prodlike.ScaleLarge:
			default:
				slog.Error("invalid --scale value", "op", "outreach.main/seed", "got", scaleFlag, "expected", "tiny|small|medium|large")
				os.Exit(1)
			}
			result, err := prodlike.SeedProdLikeWith(ctx, database, scale, prodlike.Options{
				WithEdgeCases: withEdgeCases,
			})
			if err != nil {
				slog.Error("prodlike seed failed", "op", "outreach.main/seed", "error", err)
				os.Exit(1)
			}
			fmt.Printf("Prodlike seeded: scale=%s domains=%d companies=%d contacts=%d\n",
				result.Scale, result.Domains, result.Companies, result.Contacts)
			if withEdgeCases {
				fmt.Printf("Edge cases: contacts=%d honeypot_signals=%d\n",
					result.EdgeContacts, result.HoneypotSignals)
			}
			if withDashboard {
				dres, err := prodlike.SeedDashboard(ctx, database)
				if err != nil {
					slog.Error("dashboard seed failed", "op", "outreach.main/seed", "error", err)
					os.Exit(1)
				}
				fmt.Printf("Dashboard: categories=%d personas=%d segments=%d flags=%d users=%d\n",
					dres.Categories, dres.Personas, dres.Segments, dres.FeatureFlags, dres.Users)
			}
			// Run Schema A↔B sync so campaign_contacts enrollments
			// find Schema A rows for our prodlike contacts. Same upsert
			// the intel daemon performs at startup (main.go:277-299),
			// lifted into the seed so the dataset is consistent without
			// requiring the daemon to have run.
			synced, err := prodlike.SyncSchemaA(ctx, database)
			if err != nil {
				slog.Warn("schema A sync failed", "op", "outreach.main/seed", "error", err)
			} else {
				fmt.Printf("Schema A sync: upserted=%d\n", synced)
			}
			if ocCount, contCount, parity, err := prodlike.VerifySchemaParity(ctx, database); err == nil {
				status := "OK"
				if !parity {
					status = "MISMATCH"
				}
				fmt.Printf("Schema parity: outreach_contacts=%d contacts=%d — %s\n",
					ocCount, contCount, status)
			}
			// Run scenarios if requested. Separate transaction(s) so a
			// scenario failure doesn't roll back the baseline seed that
			// we just committed.
			if scenariosArg != "" {
				var names []string
				if scenariosArg == "all" {
					names = prodlike.AllScenarios()
				} else {
					names = strings.Split(scenariosArg, ",")
				}
				sres, err := prodlike.RunScenarios(ctx, database, names)
				if err != nil {
					slog.Error("scenarios failed", "op", "outreach.main/seed", "error", err)
					os.Exit(1)
				}
				fmt.Println("\nScenarios:")
				for _, r := range sres {
					fmt.Printf("  %s: campaigns=%d threads=%d messages=%d replies=%d bounces=%d unsubs=%d suppress=%d honeypot=%d companies_upd=%d\n",
						r.Name, r.Campaigns, r.Threads, r.Messages,
						r.Replies, r.Bounces, r.Unsubscribes, r.Suppressions,
						r.HoneypotSignals, r.CompaniesUpdated)
				}
			}
			fmt.Println("\nNext steps:")
			fmt.Println("  - Inspect: psql -c \"SELECT source, COUNT(*) FROM outreach_contacts GROUP BY 1;\"")
			fmt.Println("  - Remove:  outreach seed --clear-prodlike")
			return
		}

		result, err := seed.SeedAll(ctx, database, firmyDB)
		if err != nil {
			slog.Error("Seed failed", "op", "outreach.main/seed", "error", err)
			os.Exit(1)
		}
		if result.ContactsSchemaA == 0 {
			fmt.Println("E2E seed data already exists. Use 'seed --clear' to reset.")
			return
		}
		fmt.Print(seed.FormatResult(result))

	case "bouncer":
		// Localhost email pipeline simulator: polls Mailpit, generates
		// DSN bounces / OOO / realistic replies based on recipient
		// pattern, and injects them into GreenMail IMAP so the
		// production `poll` command consumes them exactly as in prod.
		//
		// Intended for dev only. Never wire this against a real SMTP.
		mailsimCfg := mailsim.DefaultBouncerConfig()
		for i := 2; i < len(os.Args); i++ {
			switch {
			case os.Args[i] == "--mailpit" && i+1 < len(os.Args):
				mailsimCfg.MailpitBaseURL = os.Args[i+1]
				i++
			case os.Args[i] == "--greenmail" && i+1 < len(os.Args):
				mailsimCfg.GreenMailSMTPAddr = os.Args[i+1]
				i++
			case os.Args[i] == "--inbox" && i+1 < len(os.Args):
				mailsimCfg.InboxAddress = os.Args[i+1]
				i++
			case os.Args[i] == "--poll" && i+1 < len(os.Args):
				if d, err := time.ParseDuration(os.Args[i+1]); err == nil {
					mailsimCfg.PollInterval = d
				}
				i++
			}
		}
		bouncer := mailsim.NewBouncer(mailsimCfg)
		slog.Info("starting mailsim bouncer daemon", "inbox", mailsimCfg.InboxAddress)
		if err := bouncer.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("bouncer exited", "op", "outreach.main/bouncer-run", "error", err)
			os.Exit(1)
		}

	case "sync-all":
		// Combined pipeline: incremental sync → classify → ares sync → verify emails
		skipAres := false
		skipVerify := false
		aresBatch := 1000
		aresRateMs := 500
		verifyBatch := 5000
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--skip-ares":
				skipAres = true
			case "--skip-verify":
				skipVerify = true
			case "--ares-batch":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						aresBatch = n
					}
					i++
				}
			case "--ares-rate-ms":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						aresRateMs = n
					}
					i++
				}
			case "--verify-batch":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						verifyBatch = n
					}
					i++
				}
			}
		}

		// Step 1: Incremental sync from firmy-cz
		firmyDSN := envconfig.GetOr("FIRMY_DSN", "")
		if firmyDSN == "" {
			slog.Error("FIRMY_DSN not set", "op", "outreach.main/--verify-batch")
			os.Exit(1)
		}
		firmyDB, err := sql.Open("postgres", firmyDSN)
		if err != nil {
			slog.Error("Connect firmy-cz", "op", "outreach.main/--verify-batch", "error", err)
			os.Exit(1)
		}
		defer firmyDB.Close()
		firmyDB.SetMaxOpenConns(5)
		if err := firmyDB.PingContext(ctx); err != nil {
			slog.Error("Ping firmy-cz", "op", "outreach.main/--verify-batch", "error", err)
			os.Exit(1)
		}

		db := connectDB()
		syncer := company.NewSyncer(firmyDB, db, company.SyncConfig{
			BatchSize:   5000,
			Incremental: true,
		})

		steps := 6 // sync + classify + ARES + reclassify + verify + promote
		if skipAres {
			steps -= 2 // ARES + reclassify-nace
		}
		if skipVerify {
			steps--
		}
		step := 0

		step++
		fmt.Printf("[%d/%d] Incremental company sync...\n", step, steps)
		syncResult, err := syncer.Run(ctx)
		if err != nil {
			slog.Error("Sync failed", "op", "outreach.main/--verify-batch", "error", err)
			os.Exit(1)
		}
		fmt.Printf("  Synced: %d new companies\n", syncResult.CompaniesUpserted)

		// Step 2: Classify unclassified
		step++
		fmt.Printf("[%d/%d] Classifying new companies...\n", step, steps)
		classifyResult, err := classify.RunJob(ctx, db, classify.JobConfig{
			BatchSize: 5000,
			ICPConfig: classify.DefaultICPConfig(),
		})
		if err != nil {
			slog.Error("Classify failed", "op", "outreach.main/--verify-batch", "error", err)
			os.Exit(1)
		}
		fmt.Printf("  Classified: %d (ideal=%d, good=%d)\n",
			classifyResult.Processed, classifyResult.Scored, classifyResult.Classified)

		// Step 3: ARES sync (optional, can be slow)
		if !skipAres {
			step++
			fmt.Printf("[%d/%d] ARES sync (NACE codes)...\n", step, steps)
			aresClient := ares.NewClient(
				ares.WithRateLimit(time.Duration(aresRateMs) * time.Millisecond),
			)
			aresResult, err := ares.RunSync(ctx, db, aresClient, ares.SyncConfig{
				BatchSize: aresBatch,
			})
			if err != nil {
				slog.Error("ARES sync failed", "op", "outreach.main/--verify-batch", "error", err)
				os.Exit(1)
			}
			fmt.Printf("  ARES: synced=%d not_found=%d errors=%d\n",
				aresResult.Synced, aresResult.NotFound, aresResult.Errors)
		} else {
			fmt.Println("  ARES sync skipped (--skip-ares)")
		}

		// Step 3b: NACE reclassification (after ARES populates nace_codes)
		if !skipAres {
			step++
			fmt.Printf("[%d/%d] NACE reclassification...\n", step, steps)
			reclResult, err := classify.RunReclassifyNACE(ctx, db, classify.DefaultICPConfig(), 10000)
			if err != nil {
				slog.Error("Reclassify NACE failed", "op", "outreach.main/--verify-batch", "error", err)
			} else {
				fmt.Printf("  Reclassified: candidates=%d upgraded=%d unchanged=%d\n",
					reclResult.Candidates, reclResult.Upgraded, reclResult.Unchanged)
			}
		}

		// Step 5: Verify emails (optional)
		if !skipVerify {
			step++
			fmt.Printf("[%d/%d] Email verification (batch=%d)...\n", step, steps, verifyBatch)
			verifier := validation.NewVerifier(db)
			if cfg.AntiTrace.Enabled {
				verifier.RelayURL = cfg.AntiTrace.URL
				verifier.RelayToken = cfg.AntiTrace.Token
			}
			if err := verifier.LoadDomainCache(ctx); err != nil {
				slog.Warn("load domain cache", "op", "outreach.main/--verify-batch", "error", err)
			}

			vRows, err := db.QueryContext(ctx, `
				SELECT id, email FROM companies
				WHERE email IS NOT NULL AND email != ''
				  AND email_status = 'unverified'
				  AND exclusion_status = 'pass'
				ORDER BY icp_score DESC NULLS LAST
				LIMIT $1`, verifyBatch)
			if err != nil {
				slog.Error("Query unverified emails", "op", "outreach.main/--verify-batch", "error", err)
			} else {
				type ce struct {
					ID    int64
					Email string
				}
				var toVerify []ce
				for vRows.Next() {
					var c ce
					if err := vRows.Scan(&c.ID, &c.Email); err == nil {
						toVerify = append(toVerify, c)
					}
				}
				vRows.Close()

				counts := map[validation.EmailStatus]int{}
				for i, c := range toVerify {
					status, result := verifier.VerifyEmail(ctx, c.Email)
					counts[status]++
					if err := verifier.SaveCompanyResult(ctx, c.ID, status, result); err != nil {
						slog.Warn("save verify result", "op", "outreach.main/--verify-batch", "id", c.ID, "error", err)
					}
					if (i+1)%1000 == 0 {
						fmt.Fprintf(os.Stderr, "  Verified: %d/%d\n", i+1, len(toVerify))
					}
				}
				fmt.Printf("  Verified: %d emails", len(toVerify))
				for status, count := range counts {
					fmt.Printf(" %s=%d", status, count)
				}
				fmt.Println()
			}
		} else {
			fmt.Println("  Email verification skipped (--skip-verify)")
		}

		// Step 6: Promote verified companies to outreach contacts
		step++
		fmt.Printf("[%d/%d] Promoting verified companies → outreach contacts...\n", step, steps)
		targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")
		promResult, err := enrich.PromoteCompanies(ctx, db, enrich.PromoteConfig{
			ICPTiers:         []string{"ideal", "good"},
			EmailStatuses:    []string{"valid"},
			BatchSize:        5000,
			TargetIndustries: targetIndustries,
		})
		if err != nil {
			slog.Error("Promote failed", "op", "outreach.main/--verify-batch", "error", err)
		} else {
			fmt.Printf("  Promoted: %d new outreach contacts (errors=%d)\n", promResult.Created, promResult.Errors)
		}

		// Step 7: Recalculate targeting scores
		if promResult != nil && promResult.Created > 0 {
			step++
			fmt.Printf("[%d/%d] Recalculating targeting scores...\n", step, steps+1)
			recalcResult, err := enrich.RecalculateAll(ctx, db, targetIndustries)
			if err != nil {
				slog.Error("Recalc failed", "op", "outreach.main/--verify-batch", "error", err)
			} else {
				fmt.Printf("  Recalculated: %d contacts (%d updated, %d promoted, %d demoted)\n",
					recalcResult.Total, recalcResult.Updated, recalcResult.Promoted, recalcResult.Demoted)
			}
		}

		fmt.Println("All done.")

	case "verify-emails":
		// Email verification: syntax → spamtrap → role → MX → catch-all → SMTP probe
		// Protects sender reputation by filtering out undeliverable/dangerous addresses
		batch := 5000
		enableSMTP := false
		dryRun := false
		rateMs := 2000
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--batch":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						batch = n
					}
					i++
				}
			case "--smtp":
				enableSMTP = true
			case "--dry-run":
				dryRun = true
			case "--rate-ms":
				if i+1 < len(os.Args) {
					if n, err := strconv.Atoi(os.Args[i+1]); err == nil {
						rateMs = n
					}
					i++
				}
			}
		}

		database := connectDB()
		verifier := validation.NewVerifier(database)
		verifier.EnableSMTP = enableSMTP
		verifier.DryRun = dryRun
		// J2 (PR #1302) replaced legacy global RateLimit with per-MX-host
		// intervals (MXProbeIntervalGmail/Outlook/Default in verifier.go).
		// CLI flag --rate-ms is now a no-op; intervals are constants per MX.
		_ = rateMs
		if cfg.AntiTrace.Enabled {
			verifier.RelayURL = cfg.AntiTrace.URL
			verifier.RelayToken = cfg.AntiTrace.Token
		}

		// Load cached domain results
		if err := verifier.LoadDomainCache(ctx); err != nil {
			slog.Warn("load domain cache", "op", "outreach.main/--rate-ms", "error", err)
		}

		// Fetch unverified companies with emails
		rows, err := database.QueryContext(ctx, `
			SELECT id, email FROM companies
			WHERE email IS NOT NULL AND email != ''
			  AND email_status = 'unverified'
			  AND exclusion_status = 'pass'
			ORDER BY icp_score DESC NULLS LAST
			LIMIT $1`, batch)
		if err != nil {
			slog.Error("Query companies", "op", "outreach.main/--rate-ms", "error", err)
			os.Exit(1)
		}

		type companyEmail struct {
			ID    int64
			Email string
		}
		var companies []companyEmail
		for rows.Next() {
			var c companyEmail
			if err := rows.Scan(&c.ID, &c.Email); err != nil {
				slog.Error("Scan", "op", "outreach.main/--rate-ms", "error", err)
				os.Exit(1)
			}
			companies = append(companies, c)
		}
		rows.Close()

		fmt.Printf("Verifying %d company emails (smtp=%v, dry-run=%v)...\n",
			len(companies), enableSMTP, dryRun)

		counts := map[validation.EmailStatus]int{}
		for i, c := range companies {
			status, result := verifier.VerifyEmail(ctx, c.Email)
			counts[status]++

			if err := verifier.SaveCompanyResult(ctx, c.ID, status, result); err != nil {
				slog.Warn("save result", "op", "outreach.main/--rate-ms", "id", c.ID, "error", err)
			}

			if (i+1)%1000 == 0 {
				fmt.Fprintf(os.Stderr, "  Progress: %d/%d\n", i+1, len(companies))
			}
		}

		fmt.Println("\nResults:")
		for status, count := range counts {
			fmt.Printf("  %-15s %d\n", status, count)
		}

	case "segment":
		// segment <subcommand> [flags]
		// Subcommands: list, build [--name <n>], show <id>
		if len(os.Args) < 3 {
			fmt.Println("Usage: outreach segment <list|build|show> [flags]")
			os.Exit(1)
		}
		segStore := segment.NewStore(connectDB())
		switch os.Args[2] {
		case "list":
			segs, err := segStore.List(ctx)
			if err != nil {
				slog.Error("Segment list failed", "op", "outreach.main/list", "error", err)
				os.Exit(1)
			}
			if len(segs) == 0 {
				fmt.Println("No segments found.")
			} else {
				fmt.Printf("%-6s %-30s %-10s %-24s\n", "ID", "Name", "Companies", "Last Built")
				fmt.Println(strings.Repeat("─", 75))
				for _, s := range segs {
					built := "never"
					if s.LastBuiltAt != nil {
						built = s.LastBuiltAt.Format("2006-01-02 15:04:05")
					}
					fmt.Printf("%-6d %-30s %-10d %-24s\n", s.ID, s.Name, s.CompanyCount, built)
				}
			}
		case "build":
			// Rebuild memberships for all segments (or one by name)
			name := ""
			for i := 3; i < len(os.Args); i++ {
				if os.Args[i] == "--name" && i+1 < len(os.Args) {
					name = os.Args[i+1]
					i++
				}
			}
			if name != "" {
				seg, err := segStore.GetByName(ctx, name)
				if err != nil {
					slog.Error("Segment not found", "op", "outreach.main/build", "name", name, "error", err)
					os.Exit(1)
				}
				n, err := segStore.BuildMemberships(ctx, seg)
				if err != nil {
					slog.Error("Build memberships failed", "op", "outreach.main/build", "error", err)
					os.Exit(1)
				}
				fmt.Printf("Segment %q rebuilt: %d companies\n", seg.Name, n)
			} else {
				total, err := segStore.RefreshAll(ctx)
				if err != nil {
					slog.Error("RefreshAll failed", "op", "outreach.main/build", "error", err)
					os.Exit(1)
				}
				fmt.Printf("All segments refreshed: %d total memberships\n", total)
			}
		case "show":
			if len(os.Args) < 4 {
				fmt.Println("Usage: outreach segment show <id>")
				os.Exit(1)
			}
			id, err := strconv.ParseInt(os.Args[3], 10, 64)
			if err != nil {
				slog.Error("Invalid segment ID", "op", "outreach.main/show", "arg", os.Args[3])
				os.Exit(1)
			}
			seg, err := segStore.Get(ctx, id)
			if err != nil {
				slog.Error("Segment not found", "op", "outreach.main/show", "id", id, "error", err)
				os.Exit(1)
			}
			b, _ := json.MarshalIndent(seg, "", "  ")
			fmt.Println(string(b))
		default:
			fmt.Printf("Unknown segment subcommand: %s\n", os.Args[2])
			os.Exit(1)
		}

	case "health-report":
		report, err := intelligence.BuildHealthReport(ctx, connectDB())
		if err != nil {
			slog.Error("Health report failed", "op", "outreach.main/health-report", "error", err)
			os.Exit(1)
		}
		if err := intelligence.PrintHealthReport(report); err != nil {
			slog.Error("Print health report failed", "op", "outreach.main/health-report", "error", err)
			os.Exit(1)
		}

	case "mailbox-sync":
		// D2.2: reconcile config.yaml mailboxes with outreach_mailboxes registry.
		// Safe to run repeatedly — runtime counters are preserved.
		store := mailbox.NewPGStore(connectDB())
		res, err := mailbox.SyncFromConfig(ctx, store, cfg)
		if err != nil {
			slog.Error("mailbox sync failed", "op", "outreach.main/mailbox-sync", "error", err)
			os.Exit(1)
		}
		fmt.Printf("Mailbox registry sync: %d synced, %d skipped.\n", res.Synced, len(res.Skipped))
		for _, sk := range res.Skipped {
			fmt.Printf("  SKIP %s: %s\n", sk.Address, sk.Reason)
		}

	case "mailbox-list":
		// D2.2: list mailboxes in the registry with status + counters.
		store := mailbox.NewPGStore(connectDB())
		mboxes, err := store.List(ctx, mailbox.Filter{})
		if err != nil {
			slog.Error("mailbox list failed", "op", "outreach.main/mailbox-list", "error", err)
			os.Exit(1)
		}
		fmt.Printf("%-32s %-12s %-8s %-8s %-8s %s\n", "FROM_ADDRESS", "STATUS", "SENT", "BOUNCED", "CONSECUT", "LAST_SEND")
		for _, m := range mboxes {
			last := "never"
			if m.LastSendAt != nil {
				last = m.LastSendAt.Format(time.RFC3339)
			}
			fmt.Printf("%-32s %-12s %-8d %-8d %-8d %s\n",
				m.FromAddress, m.Status, m.TotalSent, m.TotalBounced, m.ConsecutiveBounces, last)
		}
		fmt.Printf("Total: %d mailbox(es).\n", len(mboxes))

	case "warmup-tick":
		// Advance warmup_day by 1 for every non-paused mailbox whose
		// last_advanced_at is older than 20 hours. Idempotent within a day.
		plansPath := envconfig.GetOr("WARMUP_PLANS_PATH", "configs/warmup.yaml")
		plans, err := warmup.LoadPlansFromYAML(plansPath)
		if err != nil {
			slog.Error("Load warmup plans", "op", "outreach.main/warmup-tick", "error", err)
			os.Exit(1)
		}
		d := warmup.NewDaemon(connectDB(), plans)
		n, err := d.Tick(ctx)
		if err != nil {
			slog.Error("Warmup tick failed", "op", "outreach.main/warmup-tick", "error", err)
			os.Exit(1)
		}
		fmt.Printf("Warmup: advanced %d mailbox(es).\n", n)

	case "warmup-enroll":
		// Usage: outreach warmup-enroll --mailbox a@x.cz --plan default_30d
		var mbox, plan string
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--mailbox":
				if i+1 < len(os.Args) {
					mbox = os.Args[i+1]
					i++
				}
			case "--plan":
				if i+1 < len(os.Args) {
					plan = os.Args[i+1]
					i++
				}
			}
		}
		if mbox == "" || plan == "" {
			slog.Error("Usage: outreach warmup-enroll --mailbox <addr> --plan <name>", "op", "outreach.main/--plan")
			os.Exit(1)
		}
		plansPath := envconfig.GetOr("WARMUP_PLANS_PATH", "configs/warmup.yaml")
		plans, err := warmup.LoadPlansFromYAML(plansPath)
		if err != nil {
			slog.Error("Load warmup plans", "op", "outreach.main/--plan", "error", err)
			os.Exit(1)
		}
		d := warmup.NewDaemon(connectDB(), plans)
		if err := d.EnrollMailbox(ctx, mbox, plan); err != nil {
			slog.Error("Enroll failed", "op", "outreach.main/--plan", "error", err)
			os.Exit(1)
		}
		fmt.Printf("Enrolled %s on plan %s.\n", mbox, plan)

	case "warmup-pause":
		// Usage: outreach warmup-pause --mailbox a@x.cz --reason "bounce spike"
		var mbox, reason string
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--mailbox":
				if i+1 < len(os.Args) {
					mbox = os.Args[i+1]
					i++
				}
			case "--reason":
				if i+1 < len(os.Args) {
					reason = os.Args[i+1]
					i++
				}
			}
		}
		if mbox == "" {
			slog.Error("Usage: outreach warmup-pause --mailbox <addr> [--reason <r>]", "op", "outreach.main/--reason")
			os.Exit(1)
		}
		d := warmup.NewDaemon(connectDB(), nil)
		if err := d.Pause(ctx, mbox, reason); err != nil {
			slog.Error("Pause failed", "op", "outreach.main/--reason", "error", err)
			os.Exit(1)
		}
		fmt.Printf("Paused %s: %s.\n", mbox, reason)

	case "warmup-resume":
		// Usage: outreach warmup-resume --mailbox a@x.cz
		var mbox string
		for i := 2; i < len(os.Args); i++ {
			if os.Args[i] == "--mailbox" && i+1 < len(os.Args) {
				mbox = os.Args[i+1]
				i++
			}
		}
		if mbox == "" {
			slog.Error("Usage: outreach warmup-resume --mailbox <addr>", "op", "outreach.main/warmup-resume")
			os.Exit(1)
		}
		d := warmup.NewDaemon(connectDB(), nil)
		if err := d.Resume(ctx, mbox); err != nil {
			slog.Error("Resume failed", "op", "outreach.main/warmup-resume", "error", err)
			os.Exit(1)
		}
		fmt.Printf("Resumed %s.\n", mbox)

	default:
		printUsage()
		os.Exit(1)
	}
}

func importCSV(ctx context.Context, database *sql.DB, path string, verbose bool) {
	// Simple CSV import: email,first_name,last_name,company_name,ico,region
	data, err := os.ReadFile(path)
	if err != nil {
		slog.Error("Read file", "op", "outreach.main/warmup-resume", "path", path, "error", err)
		os.Exit(1)
	}

	store := contact.NewStore(database)
	var contacts []contact.Contact

	for _, line := range splitLines(string(data)) {
		fields := splitCSV(line)
		if len(fields) < 1 || fields[0] == "" || fields[0] == "email" {
			continue
		}
		c := contact.Contact{
			Email:  fields[0],
			Source: filepath.Base(path),
		}
		if len(fields) > 1 {
			c.FirstName = fields[1]
		}
		if len(fields) > 2 {
			c.LastName = fields[2]
		}
		if len(fields) > 3 {
			c.CompanyName = fields[3]
		}
		if len(fields) > 4 {
			c.ICO = fields[4]
		}
		if len(fields) > 5 {
			c.Region = fields[5]
		}
		contacts = append(contacts, c)
	}

	result, err := store.BulkImport(ctx, contacts)
	if err != nil {
		slog.Error("Import failed", "op", "outreach.main/warmup-resume", "error", err)
		os.Exit(1)
	}
	audit.Log(ctx, database, audit.ActionImportCompleted, "cli", "file", filepath.Base(path), map[string]any{
		"imported": result.Imported,
		"skipped":  len(result.Skipped),
	})
	fmt.Printf("Imported: %d, Skipped (duplicates): %d\n", result.Imported, len(result.Skipped))
	if verbose && len(result.Skipped) > 0 {
		fmt.Println("Skipped emails:")
		for _, email := range result.Skipped {
			fmt.Printf("  - %s\n", email)
		}
	}
}

func enrichLocalCSV(ctx context.Context, database *sql.DB, path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		slog.Error("Read file", "op", "outreach.main/warmup-resume", "path", path, "error", err)
		os.Exit(1)
	}

	targetIndustries := parseCSVEnv("TARGET_INDUSTRIES", "machinery,metalwork,construction,agriculture,transport,woodwork,automotive,energy")

	// Optional LLM summarizer for local enrichment
	var summarizer enrich.DescriptionSummarizer
	if ollamaURL := envconfig.GetOr("OLLAMA_URL", ""); ollamaURL != "" {
		ollamaModel := envconfig.GetOr("OLLAMA_MODEL", "gemma2:2b")
		llmClient := llm.NewClient(llm.Config{BaseURL: ollamaURL, Model: ollamaModel})
		if err := llmClient.Ping(ctx); err == nil {
			summarizer = llm.NewDescriptionSummarizer(llmClient)
		}
	}

	pipeline := enrich.NewPipeline(enrich.PipelineConfig{
		TargetIndustries:      targetIndustries,
		MinTargetingScore:     0.2,
		DescriptionSummarizer: summarizer,
	})

	var rawContacts []enrich.RawContact
	for _, line := range splitLines(string(data)) {
		fields := splitCSV(line)
		if len(fields) < 1 || fields[0] == "" || fields[0] == "email" {
			continue
		}
		rc := enrich.RawContact{Email: fields[0]}
		if len(fields) > 3 {
			rc.Name = fields[3]
		}
		if len(fields) > 4 {
			rc.ICO = fields[4]
		}
		if len(fields) > 5 {
			rc.Region = fields[5]
		}
		if len(fields) > 6 {
			rc.CompanySize = fields[6]
		}
		if len(fields) > 7 {
			rc.Description = fields[7]
		}
		rawContacts = append(rawContacts, rc)
	}

	imported, skipped, err := pipeline.RunPipeline(ctx, database, rawContacts)
	if err != nil {
		slog.Error("Enrich pipeline failed", "op", "outreach.main/warmup-resume", "error", err)
		os.Exit(1)
	}
	fmt.Printf("Enriched: %d imported, %d skipped\n", imported, skipped)
}

type syncCompaniesOptions struct {
	BatchSize              int
	Incremental            bool
	BackfillCategoriesJSON bool
	SyncProdMetadata       bool
	RefreshCategories      bool
	VerifySync             bool
	MetadataStartID        int
	MetadataOnly           bool
	MetadataMaxBatches     int
	SkipTierStats          bool
}

func parseSyncCompaniesOptions(args []string, batchSizeEnv string) syncCompaniesOptions {
	opts := syncCompaniesOptions{
		BatchSize: 5000,
	}
	if n, err := strconv.Atoi(batchSizeEnv); err == nil && n > 0 {
		opts.BatchSize = n
	}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--incremental":
			opts.Incremental = true
		case "--backfill-categories-json":
			opts.BackfillCategoriesJSON = true
		case "--sync-prod-metadata":
			opts.SyncProdMetadata = true
		case "--refresh-categories":
			opts.RefreshCategories = true
		case "--verify-sync":
			opts.VerifySync = true
		case "--metadata-start-id":
			if i+1 < len(args) {
				if n, err := strconv.Atoi(args[i+1]); err == nil && n > 0 {
					opts.MetadataStartID = n
				}
				i++
			}
		case "--metadata-only":
			opts.MetadataOnly = true
		case "--metadata-max-batches":
			if i+1 < len(args) {
				if n, err := strconv.Atoi(args[i+1]); err == nil && n > 0 {
					opts.MetadataMaxBatches = n
				}
				i++
			}
		case "--skip-tier-stats":
			opts.SkipTierStats = true
		}
	}
	return opts
}

func shouldPrintTierStats(opts syncCompaniesOptions) bool {
	return !opts.SkipTierStats && !opts.MetadataOnly
}

func buildSyncMVPArgs(args []string) []string {
	defaults := []string{
		"--incremental",
		"--sync-prod-metadata",
		"--refresh-categories",
		"--verify-sync",
		"--skip-tier-stats",
	}
	result := append([]string{}, defaults...)
	result = append(result, args...)
	return result
}

// nullableMessageID returns nil for empty Message-IDs so PG stores NULL —
// the rfc_message_id partial index `WHERE rfc_message_id IS NOT NULL` only
// indexes populated rows, and IS NULL filters in operator queries behave
// as expected. Used by both send_events INSERT call sites.
func nullableMessageID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func parseCSVEnv(key, fallback string) []string {
	v := envconfig.GetOr(key, fallback)
	var result []string
	for _, s := range splitOn(v, ',') {
		s = trimSpace(s)
		if s != "" {
			result = append(result, s)
		}
	}
	return result
}

func splitLines(s string) []string {
	var lines []string
	for _, line := range append([]string{}, splitOn(s, '\n')...) {
		line = trimCR(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func splitOn(s string, sep rune) []string {
	var parts []string
	start := 0
	for i, c := range s {
		if c == sep {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	parts = append(parts, s[start:])
	return parts
}

func splitCSV(line string) []string {
	var fields []string
	for _, f := range splitOn(line, ',') {
		fields = append(fields, trimSpace(f))
	}
	return fields
}

func trimCR(s string) string {
	if len(s) > 0 && s[len(s)-1] == '\r' {
		return s[:len(s)-1]
	}
	return s
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

// errSchemaBMissing is returned by recordOutboundToThread when a successful
// send has no Schema B (outreach_contacts) counterpart. Callers should
// downgrade this from warn → info because the send itself was fine.
var errSchemaBMissing = errors.New("outreach contact missing in Schema B")

// recordOutboundToThread mirrors a successful send into Schema B (outreach_messages)
// so the IMAP reply poller can match inbound replies by Message-ID.
// Schema A uses contacts.id; Schema B uses outreach_contacts.id — they differ.
func recordOutboundToThread(
	ctx context.Context,
	database *sql.DB,
	recorder *thread.MessageRecorder,
	req sender.SendRequest,
	result sender.SendResult,
) error {
	// Resolve Schema B outreach_contacts.id via shared email.
	// Schema A contacts (synthetic test rows, internal mailbox-as-recipient,
	// or any contact created before Schema B mirroring catches up) may not
	// have a Schema B counterpart. In that case the send still succeeded —
	// we simply cannot create the thread/message audit row. Caller logs
	// at info level instead of warn so this does not pollute Sentry.
	var outreachContactID int
	err := database.QueryRowContext(ctx, `
		SELECT oc.id FROM outreach_contacts oc
		JOIN contacts c ON c.email = oc.email
		WHERE c.id = $1
	`, req.ContactID).Scan(&outreachContactID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Schema A → Schema B mirror gap. Audit downstream metric, return
			// sentinel so caller can demote to info-level.
			return errSchemaBMissing
		}
		return fmt.Errorf("resolve outreach contact: %w", err)
	}

	// Get or create thread for this (outreach_contact, campaign) pair.
	var threadID int
	err = database.QueryRowContext(ctx, `
		SELECT id FROM outreach_threads
		WHERE contact_id = $1 AND campaign_id = $2
		ORDER BY id LIMIT 1
	`, outreachContactID, req.CampaignID).Scan(&threadID)
	if errors.Is(err, sql.ErrNoRows) {
		err = database.QueryRowContext(ctx, `
			INSERT INTO outreach_threads (contact_id, campaign_id, status, current_step, next_action)
			VALUES ($1, $2, 'active', $3, 'wait_reply')
			RETURNING id
		`, outreachContactID, req.CampaignID, req.Step).Scan(&threadID)
	}
	if err != nil {
		return fmt.Errorf("get/create thread: %w", err)
	}

	// R2 (reply-pipeline-recovery): prefer the RFC 5322 Message-ID since
	// that's what recipients echo back via In-Reply-To / References. Fall
	// back to the envelope_id only when the engine didn't populate the
	// RFC field (legacy code path or dry-run with empty headers). Strip
	// angle brackets so matchToThread.cleanMessageID returns the same
	// canonical form when the inbound poller hands us a "<id>" header.
	rawMsgID := result.RFCMessageID
	if rawMsgID == "" {
		rawMsgID = result.MessageID
	}
	msgID := strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(rawMsgID), ">"), "<")
	_, err = recorder.RecordOutbound(ctx, thread.OutboundMessage{
		ThreadID:    threadID,
		MessageID:   msgID,
		Subject:     req.Subject,
		SentAt:      result.SentAt,
		MailboxUsed: result.MailboxUsed,
	})
	return err
}

// AW7-9 — appendSentAsync was removed (2026-05-11). The orchestrator
// container has no wgsocks instance, so the AW7-7 dial to
// 127.0.0.1:1080 fail-closed with "connection refused" on PROD
// 2026-05-10 21:35. The APPEND is now performed inside the relay
// drain (services/relay/internal/delivery/sent_appender.go) where
// wgsocks lives and can route IMAP through the same Mullvad endpoint
// used for SMTP.
//
// The helper functions in services/orchestrator/imap (AppendToSent,
// BuildWireMIMEForAppend, AuditAppendOutcome) are intentionally left
// in place: they remain test-covered + may host a future
// orchestrator-side discovery path; AW7-9 simply removes the broken
// runtime call from main.go.

// buildPreSendHook creates a sender.PreSendHook that applies per-mailbox humanization.
// Each mailbox resolves its persona (mailbox-level → global fallback) and uses it
// for signature, fingerprint, imperfections, and bump wrapping.
// loadPersonaFromDB looks up persona data stored in the personas table.
// Falls back to the env/config persona if not found or on error.
func loadPersonaFromDB(db *sql.DB, mailboxAddress string, fallback config.PersonaConfig) config.PersonaConfig {
	var p config.PersonaConfig
	err := db.QueryRow(`
		SELECT name, COALESCE(role,''), COALESCE(company,''), COALESCE(phone,''),
		       COALESCE(email,$1), COALESCE(website,''), COALESCE(region,'')
		FROM personas WHERE mailbox = $1 AND active = true`,
		mailboxAddress,
	).Scan(&p.Name, &p.Role, &p.Company, &p.Phone, &p.Email, &p.Website, &p.Region)
	if err != nil {
		return fallback
	}
	// Fill blanks from fallback
	if p.Company == "" {
		p.Company = fallback.Company
	}
	if p.Website == "" {
		p.Website = fallback.Website
	}
	return p
}

// warmupLimiterAdapter bridges sender.WarmupLimiter (no ctx) onto
// warmup.Daemon (ctx-aware after D-3). pickMailbox does not yet thread
// ctx, so we pass context.Background() at the boundary; the DB call is
// still cancellable once the send pipeline propagates ctx through pickMailbox.
type warmupLimiterAdapter struct{ d *warmup.Daemon }

func (a warmupLimiterAdapter) LimitForMailbox(address string, fallback int) (int, error) {
	return a.d.LimitForMailbox(context.Background(), address, fallback)
}

// buildSendEngine creates a sender.Engine with anti-trace wired when enabled.
func buildSendEngine(cfg *config.Config, db *sql.DB) *sender.Engine {
	e := sender.NewEngine(cfg.Mailboxes, cfg.Sending, cfg.Safety).
		WithPreSendHook(buildPreSendHook(db, cfg.Persona)).
		// Exactly-once send-claim gate (migration 171 send_claims). Both the
		// CLI campaign-run path and the campaign daemon build their engine
		// here, so both acquire a shared claim on (campaign,contact,step)
		// immediately before the relay submit. Confirm/release happen in the
		// onSent callback (ConfirmClaim on success, ReleaseClaim on failure).
		WithSendClaim(func(ctx context.Context, req sender.SendRequest) (sender.ClaimDecision, error) {
			return sender.AcquireClaim(ctx, db, req, sender.ClaimedByGoEngine)
		})
	if cfg.AntiTrace.Enabled {
		slog.Info("anti-trace relay enabled", "url", cfg.AntiTrace.URL, )
		// engine-bypass-allowed: canonical production wiring — client is
		// passed straight to Engine.WithAntiTrace below, never invoked
		// directly. Documented in docs/subsystem-maps/anti-trace.md G10.
		e = e.WithAntiTrace(sender.NewAntiTraceClient(cfg.AntiTrace.URL, cfg.AntiTrace.Token))
	}
	// MESSAGE_ID_HMAC_KEY seeds the per-recipient Message-ID HMAC in
	// services/campaigns/sender/headers.go (anti-trace anonymity FIX 1).
	// Absent key falls through to the legacy per-envelope generateMessageID
	// path — never blocks delivery; the audit ratchet
	// sender/message_id_audit_test.go fails CI when a SendRequest leaves
	// Engine.Run without a Message-ID header. Rotate by regenerating
	// `head -c 32 /dev/urandom | base64`, setting MESSAGE_ID_HMAC_KEY
	// in Railway, and redeploying.
	if keyBytes, err := envconfig.RequireBase64Bytes("MESSAGE_ID_HMAC_KEY", 32); err == nil {
		e = e.WithMessageIDHMACKey(keyBytes)
		slog.Info("message-id HMAC seeded", "key_bytes", len(keyBytes))
	} else {
		slog.Warn("message-id HMAC key absent — falling through to legacy per-envelope IDs",
			"op", "buildSendEngine/messageIDHMAC",
			"error", err)
	}
	// DB-backed warmup limiter — optional. If configs/warmup.yaml is missing
	// or unreadable, fall through to the static MailboxConfig.DailyLimit.
	plansPath := envconfig.GetOr("WARMUP_PLANS_PATH", "configs/warmup.yaml")
	if plans, err := warmup.LoadPlansFromYAML(plansPath); err == nil {
		e = e.WithWarmupLimiter(warmupLimiterAdapter{d: warmup.NewDaemon(db, plans)})
		slog.Info("warmup limiter wired", "plans_loaded", len(plans), "path", plansPath)
	} else {
		slog.Debug("warmup limiter disabled", "reason", err)
	}
	// Restart-durable daily-cap oracle (D3.1). The engine's in-memory
	// sentCounts map zeroes on every process boot, so a mid-day restart would
	// re-grant each mailbox its full daily budget and over-send — the warmup DB
	// trigger only rejects the post-send send_events row, not the relay submit
	// that already left. This oracle counts today's actually-sent send_events
	// per mailbox (Europe/Prague day) and compares to the same
	// compute_daily_cap() trg_enforce_warmup_cap enforces, so pickMailbox skips
	// an already-capped mailbox after a restart. DB read only; fail-open on
	// error per the DailyCapFunc contract (a transient DB hiccup never blocks
	// delivery).
	e = e.WithDailyCapFunc(newDailyCapFunc(db))
	slog.Info("daily-cap oracle wired (restart-durable send_events count)",
		"op", "buildSendEngine/dailyCap")
	// D2.3: wire the outreach_mailboxes registry so operator cockpit toggles
	// (pause / bounce_hold / retired) take effect without config redeploy,
	// and so consecutive bounces auto-hold the mailbox at the configured
	// threshold. Fail-safe: the registry is optional; if the migration
	// hasn't been applied yet, the adapter still functions as a no-op with
	// a non-nil interface value, and pickMailbox falls through to config-only.
	e = e.WithMailboxRegistry(mailbox.NewBackpressure(mailbox.NewPGStore(db)))
	slog.Info("mailbox registry wired into send engine")

	// Pre-send domain check gate (sender/presend.go). RFC 5321 §5.1
	// MX-with-A fallback runs inline before antiTrace.Send so a
	// guaranteed-bounce domain never spends a relay submit. Enabled by
	// default; operator can disable via PRE_SEND_DOMAIN_CHECK=0 on
	// incident (env-as-boot-bootstrap per
	// feedback_env_var_needs_db_fallback — the long-term home is
	// operator_settings). Campaign 457 target: 4.6% → <1% bounce rate.
	if envconfig.BoolOr("PRE_SEND_DOMAIN_CHECK", true) {
		opts := &sender.PreSendDomainCheckOptions{}

		// Sprint AE — level-2 RCPT probe for high-risk domains.
		// Operator data (campaign 457 forensics 2026-05-14) found
		// tiscali.cz with valid MX but ~1% RCPT user-unknown reject
		// rate that level-1 cannot catch. Wire when the relay URL is
		// present (probe forwards there per R6 egress lockdown) AND
		// operator_settings names at least one high-risk domain.
		relayURL := envconfig.GetOr("ANTI_TRACE_RELAY_URL", envconfig.GetOr("ANTI_TRACE_URL", ""))
		relayToken := envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", envconfig.GetOr("ANTI_TRACE_TOKEN", ""))
		if relayURL != "" {
			loader := operatorconfig.New(db)
			loadCtx, loadCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer loadCancel()
			domainsCSV, _ := loader.Get(loadCtx, "presend_smtp_probe_high_risk_domains")
			if domainsCSV != "" {
				domains := strings.Split(domainsCSV, ",")
				probe := &validation.SMTPProbeValidator{
					RelayURL:   relayURL,
					RelayToken: relayToken,
				}
				opts.Probe = probe
				opts.HighRiskDomains = domains
				slog.Info("pre-send level-2 RCPT probe enabled",
					"op", "buildSendEngine/preSendDomainCheck/level2",
					"domains_count", len(domains))
			}
		}

		e = e.WithPreSendDomainCheck(sender.NewPreSendDomainChecker(opts))
		slog.Info("pre-send domain check enabled (RFC 5321 §5.1 MX with A fallback)",
			"op", "buildSendEngine/preSendDomainCheck")
	} else {
		slog.Warn("pre-send domain check DISABLED via PRE_SEND_DOMAIN_CHECK=0",
			"op", "buildSendEngine/preSendDomainCheck")
	}

	// Diagnostic (incident 2026-06-27 — subset-of-mailboxes-sending): when
	// SENDER_DEBUG_SNAPSHOT=1, log per-mailbox in-memory send-eligibility state
	// (sent_count vs effective_limit, cooldown, allow-set) every 120s so the
	// next time the rotation collapses to a subset we can read WHY from logs.
	// Read-only; default off; safe to leave merged. Remove once root cause is
	// confirmed and fixed.
	if envconfig.BoolOr("SENDER_DEBUG_SNAPSHOT", false) {
		go func() {
			t := time.NewTicker(120 * time.Second)
			defer t.Stop()
			e.LogDebugSnapshot()
			for range t.C {
				e.LogDebugSnapshot()
			}
		}()
		slog.Info("sender debug snapshot loop enabled (120s)",
			"op", "buildSendEngine/debugSnapshot")
	}
	return e
}

// dailyCapOracleTimeout bounds the per-mailbox daily-cap count query.
// pickMailbox calls the oracle while holding the engine mutex, so a slow query
// would stall the send loop; keep it tight and fail open on timeout.
const dailyCapOracleTimeout = 5 * time.Second

// newDailyCapFunc returns a restart-durable sender.DailyCapFunc backed by
// send_events. It reports a mailbox "exhausted" when today's sent count (in the
// Europe/Prague send day) has reached the mailbox's effective cap — the same
// compute_daily_cap(lifecycle_phase, daily_cap_override) the
// trg_enforce_warmup_cap trigger enforces on INSERT (migrations 071/115). This
// survives a process restart that zeroes the engine's in-memory sentCounts map,
// which otherwise re-grants a fresh daily budget mid-day and over-sends.
//
// Contract (sender.DailyCapFunc): returning (false, err) signals an oracle
// outage and pickMailbox fails open. A mailbox absent from outreach_mailboxes
// (test fixture / manual probe) returns (false, nil) — the same "no opinion"
// the trigger applies by allowing the INSERT. DB read only.
func newDailyCapFunc(db *sql.DB) sender.DailyCapFunc {
	return func(address string) (bool, error) {
		if db == nil {
			return false, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), dailyCapOracleTimeout)
		defer cancel()

		var exhausted bool
		err := db.QueryRowContext(ctx, `
			SELECT (
			    SELECT count(*)
			      FROM send_events
			     WHERE mailbox_used = m.from_address
			       AND status = 'sent'
			       AND sent_at >= (now() AT TIME ZONE 'Europe/Prague')::date
			) >= compute_daily_cap(m.lifecycle_phase, m.daily_cap_override)
			  FROM outreach_mailboxes m
			 WHERE m.from_address = $1
			 LIMIT 1`, address).Scan(&exhausted)
		if err == sql.ErrNoRows {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		return exhausted, nil
	}
}

func buildPreSendHook(db *sql.DB, globalPersona config.PersonaConfig) sender.PreSendHook {
	return func(mailbox config.MailboxConfig, req *sender.SendRequest) {
		// D3.6: hand-authored legal notices (opt-out confirmations,
		// consent-tier transition messages, GDPR data-subject responses)
		// declare {{/* humanize: off */}} at the top of the template and
		// must ship verbatim — humanize rewriting would alter the legally
		// significant wording. Early-return before constructing the
		// humanize engine so BodyPlain / Subject / BodyHTML stay as the
		// template rendered them.
		if req.SkipHumanize {
			return
		}
		// DB persona takes precedence over env-var config
		envPersona := mailbox.ResolvePersona(globalPersona)
		persona := loadPersonaFromDB(db, mailbox.Address, envPersona)
		engine := humanize.NewEngine(humanize.Persona{
			Name:    persona.Name,
			Role:    persona.Role,
			Company: persona.Company,
			Phone:   persona.Phone,
			Email:   persona.Email,
			Website: persona.Website,
			Region:  persona.Region,
		})

		humanized := engine.PrepareEmail(
			req.Subject,
			req.BodyPlain,
			req.Step,
			time.Now(),
			req.FirstName,
			"", "", "", time.Time{},
		)
		req.Subject = humanized.Subject
		req.BodyPlain = humanized.Body
		req.BodyHTML = humanized.BodyHTML

		// Merge humanize headers (humanize wins on conflict)
		for k, v := range humanized.Headers {
			if req.Headers == nil {
				req.Headers = make(map[string]string)
			}
			req.Headers[k] = v
		}
	}
}

func printUsage() {
	fmt.Println(`Hozan Taher - B2B Email System

Usage: outreach <command> [args]

Commands:
  migrate              Run database migrations
  import <file.csv>    Import contacts from CSV [--verbose shows skipped emails]
  prospect             Import + enrich contacts from firmy-cz (Railway Postgres)
  dashboard            Show outreach contacts dashboard + targeting distribution
  recalc               Recalculate targeting scores for all contacts
  suppress <target>    Suppress email or domain (e.g. suppress user@x.cz manual)
  intel                Run intelligence loop (targeting recalc, domain health, auto-suppress)
  intel --daemon       Run as background daemon (default: every 6h)
  report               Generate weekly intelligence report
  poll                 Poll IMAP mailboxes for replies (one-shot)
  poll --daemon        Poll continuously (default: every 2m)
  validate             Validate all new contacts (syntax, MX, disposable)
  stats                Show contact status counts (legacy)
  campaign-create <n>  Create campaign with name <n>
  campaign-run <id>    Run campaign and start sending
  preview <template>   Render and print email template (no send)
  audit-log            Show recent operator actions [--limit <n>]
  enrich-local <csv>   Enrich contacts from CSV (local dev — no FIRMY_DSN needed)
  classify             Classify companies (exclusion, sector, ICP, region)
  classify --dry-run   Classify without writing to DB
  classify --force     Re-classify all companies (reset classified_at)
  res-import           Bulk import NACE + founding date from CSÚ RES (fastest, ~minutes)
  res-import --dry-run Count rows without writing to DB
  res-import --batch   Batch size for DB updates (default: 2000)
  res-import --include-closed Also import companies with a closing date
  ares-sync            Per-ICO ARES API sync (slow, 1 req/s — use res-import instead)
  ares-sync --rate-ms  Rate limit in ms (default: 1000 = 1 req/s)
  sync-companies       Sync all companies from firmy-cz to outreach DB
  sync-mvp             MVP profile: incremental sync + prod metadata + categories refresh + verification
  sync-companies --sync-prod-metadata  Pull classify/enrichment metadata from production outreach DB
  sync-companies --refresh-categories  Rebuild category tree counters after sync
  sync-companies --verify-sync         Compare production/local sync snapshots and fail on drift
  sync-companies --metadata-start-id <n>  Resume metadata sync from firmy_cz_id > n
  sync-companies --metadata-max-batches <n>  Limit metadata sync batches (fast dev iterations)
  sync-companies --metadata-only       Skip firmy source sync, run only metadata/refresh/verify steps
  sync-companies --skip-tier-stats     Skip quality tier aggregate query (faster completion)
  sync-all             Full pipeline: sync → classify → ARES → reclassify-nace → verify
  reclassify-nace      Re-classify companies with NACE codes (upgrade from keywords)
  promote              Create outreach contacts from classified+verified companies
  promote --tier <t>   ICP tiers to include (default: ideal,good)
  promote --dry-run    Count without writing
  backfill-contacts    Sync outreach_contacts → contacts (Schema A) for campaign enrollment
  backfill-contacts --dry-run  Count without writing
  sync-all --skip-ares Skip ARES sync step
  sync-all --skip-verify Skip email verification step
  sync-all --verify-batch <n> Verification batch size (default: 5000)
  verify-emails        Verify company emails (syntax, spamtrap, role, MX, catch-all)
  verify-emails --smtp Enable SMTP RCPT TO probe (slower, more accurate)
  verify-emails --batch <n>  Batch size (default: 5000)
  verify-emails --dry-run    Don't write results to DB
  seed                 Seed E2E test data (contacts, campaign, domains)
  seed --clear         Remove all E2E test data
  server               Start tracking web server
  warmup-tick          Advance warmup_day for non-paused mailboxes (run 1x/day from cron)
  warmup-enroll        --mailbox <addr> --plan <name>   Register mailbox on warmup plan
  warmup-pause         --mailbox <addr> [--reason <r>]  Pause ramp (e.g. bounce spike)
  warmup-resume        --mailbox <addr>                 Resume paused mailbox

Preview flags:
  --contact-id <id>    Load contact vars from DB by ID
  --step <n>           Step index for deterministic spin resolution (default: 0)
  --name <n>           Override first name
  --company <c>        Override company name
  --region <r>         Override region
  --html               Also print HTML body

Prospect flags:
  --region <name>      Filter by city/region (ILIKE)
  --description <text> Filter by business description (ILIKE)
  --categories <text>  Filter by categories (ILIKE)
  --has-phone          Only businesses with phone
  --has-ico            Only businesses with ICO
  --limit <n>          Max businesses to import (default: 1000)
  --count              Just count matching businesses, don't import
  --schedule <dur>     Run prospect repeatedly at this interval (e.g. 24h, 12h)

Environment:
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
  FIRMY_DSN            Railway Postgres URL for firmy-cz data
  OUTREACH_PROD_DSN    Production outreach Postgres URL (for sync-companies --sync-prod-metadata)
  TARGET_INDUSTRIES    Comma-separated target industries (default: machinery,metalwork,construction)
  PERSONA_*            Sender persona (NAME, ROLE, COMPANY, PHONE, EMAIL, WEBSITE, REGION)
  TEMPLATES_DIR (default: configs/templates)
  MIGRATIONS_DIR (default: internal/db/migrations)`)
}
