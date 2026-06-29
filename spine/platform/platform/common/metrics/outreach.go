package metrics

// Outreach-domain metric definitions. Register once at package init so they
// appear in /metrics output even before the first observation.
var (
	// Send pipeline ---------------------------------------------------------

	// SendTotal counts all send attempts regardless of outcome.
	SendTotal = NewCounter("outreach_send_total",
		"Total number of SMTP send attempts")

	// SendSuccessTotal counts attempts classified as SMTPOK.
	SendSuccessTotal = NewCounter("outreach_send_success_total",
		"Send attempts that completed without SMTP error")

	// SendBounceTotal counts attempts classified as permanent 5xx.
	SendBounceTotal = NewCounter("outreach_send_bounce_total",
		"Send attempts classified as permanent bounces (5xx)")

	// SendGreylistedTotal counts transient 4xx deferrals.
	SendGreylistedTotal = NewCounter("outreach_send_greylisted_total",
		"Send attempts that received a transient 4xx response (greylisting)")

	// LabSkipTotal counts pre-send aborts triggered by the Mail Lab
	// pre-send abort hook (KT-A14 / ML5.2). Increments every time the
	// labhook tells the engine to skip a send (verdict = reject /
	// greylist / spam, or fail-closed when LAB_ONLY=1 and the lab is
	// unreachable).
	LabSkipTotal = NewCounter("outreach_lab_skip_total",
		"Pre-send aborts triggered by the Mail Lab labhook (KT-A14)")

	// LabUnreachableTotal counts the times the labhook could not reach
	// the lab API. Split from LabSkipTotal so operators can tell apart
	// "lab said no" from "lab is down". Always incremented on lab error
	// regardless of LAB_ONLY mode (LAB_ONLY=1 → also increments
	// LabSkipTotal because the engine fails closed).
	LabUnreachableTotal = NewCounter("outreach_lab_unreachable_total",
		"Times the Mail Lab labhook returned a transport error (KT-A14)")

	// SMTPSocketOpenTotal counts attempts to open a real outbound SMTP
	// socket (ports 25, 465, 587, 2525). Under LAB_ONLY=1 this MUST
	// always remain zero — the LabAbortEvaluator gate (G8) must intercept
	// every send before AntiTraceClient.Send reaches the relay. Incremented
	// by the AntiTraceClient at the point of first HTTP I/O toward the
	// relay (which itself would SMTP-dial a real MX). AT3.2 integration
	// test asserts count=0 across 5 contacts with LAB_ONLY=1.
	SMTPSocketOpenTotal = NewCounter("outreach_smtp_socket_open_total",
		"Outbound SMTP socket open attempts — must be 0 under LAB_ONLY=1 (AT3.2)")

	// PreSendDomainCheckSkipTotal counts sends gated by the inline
	// pre-send domain check (sender.PreSendDomainCheck — RFC 5321 §5.1
	// MX-with-A-fallback). Labeled by reason ("no_domain", "empty_mx",
	// "no_mx_no_a", "malformed_email"). Operator monitors this to
	// quantify wasted-send avoidance + bounce-rate reduction (campaign
	// 457 cohort: 31199 unverified contacts, ~4.6% bounce rate target
	// <1% post-gate).
	PreSendDomainCheckSkipTotal = NewLabeledCounter("outreach_presend_domain_check_skip_total",
		"Sends skipped by the pre-send MX/A domain check, labeled by reason",
		"reason")

	// PreSendDomainCheckCacheHitTotal counts domains served from the
	// 24h in-memory MX/A cache (vs. a fresh DNS lookup). Operator uses
	// the hit ratio to size the cache and detect lookup churn.
	PreSendDomainCheckCacheHitTotal = NewCounter("outreach_presend_domain_check_cache_hit_total",
		"Pre-send domain checks served from the in-memory cache")

	// Queue ---------------------------------------------------------------

	// QueueDepth is the current size of the sender queue.
	QueueDepth = NewGauge("outreach_queue_depth",
		"Number of pending send requests in the sender queue")

	// Circuit breaker -----------------------------------------------------

	// CircuitGlobalOpen is 1 when the global circuit is tripped, else 0.
	CircuitGlobalOpen = NewGauge("outreach_circuit_global_open",
		"1 when the global send circuit breaker is open, 0 otherwise")

	// CircuitDomainOpen is 1 per domain currently tripped.
	CircuitDomainOpen = NewLabeledGauge("outreach_circuit_domain_open",
		"1 when the per-domain circuit breaker is open for the given domain",
		"domain")

	// Bounce rate ---------------------------------------------------------

	// BounceRate is the rolling bounce rate (0.0–1.0) for the current
	// hourly window.
	BounceRate = NewGauge("outreach_bounce_rate",
		"Rolling bounce rate in the current hourly window (0.0 – 1.0)")

	// Per-domain counters -------------------------------------------------

	DomainSendTotal = NewLabeledCounter("outreach_domain_send_total",
		"Send attempts by recipient domain", "domain")
	DomainBounceTotal = NewLabeledCounter("outreach_domain_bounce_total",
		"Permanent bounces by recipient domain", "domain")

	// Enrichment / validation ---------------------------------------------

	HoneypotDetectedTotal = NewLabeledCounter("outreach_honeypot_detected_total",
		"Honeypot signals detected by type",
		"signal_type", "severity")

	// Reply classification ------------------------------------------------

	ReplyClassifiedTotal = NewLabeledCounter("outreach_reply_classified_total",
		"Replies classified by type (interested, meeting, later, objection, negative, ooo)",
		"reply_type")

	// Deliverability health (set by intelligence loop each cycle) ----------

	// EmailStatusTotal is a labeled gauge reporting the count of companies
	// per email_status bucket. Updated at the end of each intelligence loop cycle.
	EmailStatusTotal = NewLabeledGauge("outreach_email_status_total",
		"Number of companies by email_status bucket",
		"status")

	// DomainSuppressedTotal is the current count of suppressed outreach domains.
	DomainSuppressedTotal = NewGauge("outreach_domain_suppressed_total",
		"Number of outreach domains currently suppressed")

	// MailboxBounceHoldTotal is the current count of mailboxes in bounce_hold.
	MailboxBounceHoldTotal = NewGauge("outreach_mailbox_bounce_hold_total",
		"Number of mailboxes currently in bounce_hold status")

	// Intelligence loop metrics -------------------------------------------

	// IntelLoopTotal counts completed intelligence loop cycles.
	IntelLoopTotal = NewCounter("outreach_intel_loop_total",
		"Total completed intelligence loop cycles")

	// IntelLoopFailTotal counts failed intelligence loop cycles.
	IntelLoopFailTotal = NewCounter("outreach_intel_loop_fail_total",
		"Total failed or panicked intelligence loop cycles")

	// IntelLoopDurationMs is the duration of the last loop cycle in milliseconds.
	IntelLoopDurationMs = NewGauge("outreach_intel_loop_duration_ms",
		"Duration of the last intelligence loop cycle in milliseconds")

	// IntelScoresRecalculated is the count of scores recalculated in the last cycle.
	IntelScoresRecalculated = NewGauge("outreach_intel_scores_recalculated",
		"Companies whose engagement score was recalculated in the last cycle")

	// IntelCompaniesClassified is the count of companies classified in the last cycle.
	IntelCompaniesClassified = NewGauge("outreach_intel_companies_classified",
		"Companies classified by LLM in the last intelligence loop cycle")

	// Protection probe metrics -----------------------------------------------
	//
	// Labeled by (layer, level, status) so Grafana can build a per-layer
	// heatmap and alert on err-rate spikes independently of the protection_alerts
	// table (double coverage: one via SQL, one via timeseries).

	ProbeRunTotal = NewLabeledCounter("outreach_probe_run_total",
		"Total protection probe runs by outcome",
		"layer", "level", "status")

	ProbeLatencyMs = NewLabeledGauge("outreach_probe_latency_ms",
		"Most recent probe latency in milliseconds",
		"layer", "level")

	ProbeAlertOpen = NewLabeledGauge("outreach_probe_alert_open",
		"1 when an open/acked alert exists for this (layer, level), else 0",
		"layer", "level")

	// Per-mailbox health -----------------------------------------------------
	//
	// These are re-set every intelligence cycle against the current row state.
	// Labeled by canonical from_address so Grafana queries can slice by
	// mailbox. Operators investigating why one mailbox is hot can pull this
	// directly instead of reading the outreach_mailboxes table.

	MailboxStatus = NewLabeledGauge("outreach_mailbox_status",
		"Mailbox status as integer: 1=active, 2=paused, 3=bounce_hold, 4=retired",
		"address")

	MailboxConsecutiveBounces = NewLabeledGauge("outreach_mailbox_consecutive_bounces",
		"Consecutive bounce count on the mailbox", "address")

	MailboxCanaryRemaining = NewLabeledGauge("outreach_mailbox_canary_remaining",
		"Canary sends remaining before normal rotation resumes", "address")

	MailboxCircuitOpen = NewLabeledGauge("outreach_mailbox_circuit_open",
		"1 when the per-mailbox SMTP circuit breaker is open, else 0",
		"address")
)
