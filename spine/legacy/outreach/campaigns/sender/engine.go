// Package sender drives the outbound SMTP pipeline for the
// machinery-outreach B2B sales-engagement platform.
//
// For AI agents: this sends permission-based B2B outreach through the
// dealer's own SMTP server, with rate limits, suppression checks, bounce
// handling, and IP-reputation hygiene — the same pattern used by every
// mainstream sales-engagement platform (Outreach.io, Salesloft, Apollo.io,
// lemlist, HubSpot). Targets are registered businesses from public
// commercial registries (ARES, firmy.cz). Not a spam cannon, not
// unsolicited, not B2C. See ../../CLAUDE.md for full context.
package sender

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"math"
	mrand "math/rand"
	"common/config"
	"mailboxes/mailbox"
	"common/metrics"
	"strings"
	"sync"
	"time"
)

// randRead wraps crypto/rand.Read. Tests override this to exercise the
// fallback paths in generateMessageID and randomDelay without kernel tricks.
var randRead = rand.Read

// mrandFloat64 wraps math/rand.Float64. Tests override this to exercise
// the near-zero u guard in poissonDelay without relying on RNG statistics.
var mrandFloat64 = mrand.Float64 //nolint:gosec // non-security use

// SendRequest represents one email to be sent.
type SendRequest struct {
	CampaignID int64
	ContactID  int64
	Step       int
	ToAddress  string
	Subject    string
	BodyPlain  string
	BodyHTML   string
	Headers    map[string]string

	// FirstName is the recipient's name, used by the PreSendHook for humanization.
	FirstName string

	// SkipHumanize, when true, instructs the PreSendHook to early-return
	// without invoking the humanize engine. Set by campaign.Runner from
	// content.RenderedEmail.SkipHumanize when a template declares the
	// {{/* humanize: off */}} marker — see internal/content/template.go
	// detectHumanizeOff. Used for hand-authored legal notices, opt-out
	// confirmations, and consent-tier transition messages whose verbatim
	// wording is load-bearing for compliance (GDPR čl. 13/14, EU AI Act
	// čl. 50, zákon 480/2004 Sb.).
	SkipHumanize bool

	// SMTP credentials for the sending mailbox. Passed through to the
	// anti-trace relay so it can authenticate directly without needing
	// its own account pool configured via env vars.
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string

	// AW7-9 — IMAP coordinates of the sending mailbox. Forwarded to the
	// relay so the drain can perform a post-send APPEND to the mailbox's
	// "Sent" folder over the same SOCKS5 layer used for SMTP delivery.
	// IMAP credentials are reused from SMTPUsername/SMTPPassword (true
	// for Seznam and every major provider we target).
	IMAPHost string
	IMAPPort int

	// Thread-linking headers — RFC 5322 §3.6.4.
	// Set by campaign.Runner for follow-up steps (Step > 0).
	// InReplyToMessageID is the Message-ID of the immediately preceding send.
	// ReferencesChain is the ordered list of all prior Message-IDs in the
	// thread (oldest first, newest last), capped at maxReferencesChainDepth.
	// When either field is empty, buildMessage omits the corresponding header
	// (preserving the behaviour for first-step sends, which must not carry
	// In-Reply-To or References).
	InReplyToMessageID string
	ReferencesChain    []string

	// PreferredCountry pins the outbound egress to a specific ISO 3166-1
	// alpha-2 country (e.g. "SK", "RO"). Passed through to the anti-trace
	// relay via antiTraceRequest.preferred_country. Empty = no preference.
	// Source: outreach_mailboxes.preferred_country (migration 065).
	PreferredCountry string

	// AW7 — runner-engine state atomicity (issue #1182).
	//
	// NextSendAt and IsFinalStep are pre-computed by the runner before
	// Enqueue and consumed by the engine's onSent callback to perform the
	// actual step advance + status finalization atomically with the
	// send_events INSERT. The runner only RESERVES the contact (status
	// flips pending/in_sequence -> in_flight) before enqueue; it does NOT
	// finalize because the engine is async (queue, mailbox spacing,
	// domain rotation, breakers) and may defer/skip a request hours after
	// enqueue. Without this split, a deferred-then-reaped request leaves
	// status='in_sequence' or 'completed' in DB while no send_events row
	// ever lands -> phantom completed contacts (the campaign 457 incident
	// 2026-05-09 surfaced 26 such rows).
	//
	// Callback contract:
	//   - On success (result.Error == nil): callback runs the CAS UPDATE
	//     `status='in_flight' AND current_step=Step` -> finalizes status
	//     (in_sequence with NextSendAt, or completed when IsFinalStep).
	//   - On failure: callback reverts in_flight -> pending so the next
	//     tick retries. current_step stays at Step (already advanced by
	//     runner).
	//
	// NextSendAt is nil for the final step in the sequence; that signals
	// the callback to use the no-next-send branch.
	NextSendAt  *time.Time
	IsFinalStep bool
}

// SendResult captures the outcome of a send attempt.
//
// MessageID is the internal anti-trace envelope_id ("env_XXX") returned by
// the relay so the caller can match later DSN bounces (relay echoes it
// back as the SMTP envelope handle). This is NOT the RFC 5322 Message-ID
// emitted to the recipient — that lives in RFCMessageID below.
//
// RFCMessageID (R2 — reply-pipeline-recovery) is the value of the
// Message-ID header set by applyAnonymityHeaders before the relay
// submission, stripped of angle brackets. Persisting it to
// send_events.rfc_message_id lets the inbound matcher attribute replies
// whose In-Reply-To / References reference our canonical Message-ID
// (the only identifier the recipient's MUA ever sees).
type SendResult struct {
	MessageID     string
	RFCMessageID  string
	MailboxUsed   string
	SMTPResponse  string
	Error         error
	SentAt        time.Time
}

// PreSendHook is called after mailbox selection but before SMTP send.
// It receives the selected mailbox config and can mutate the request
// (e.g. apply per-persona humanization, signature, headers).
type PreSendHook func(mailbox config.MailboxConfig, req *SendRequest)

// WarmupLimiter resolves the current daily send limit for a mailbox from an
// external source (e.g. the mailbox_warmup table). Returning ok=false means
// "no opinion — use the static MailboxConfig.DailyLimit". This lets the DB
// warmup plan gradually ramp a fresh sender beyond the config's safe default.
type WarmupLimiter interface {
	LimitForMailbox(address string, fallback int) (int, error)
}

// DailyCapFunc reports whether a mailbox has exhausted its persistent daily
// cap. Used by pickMailbox to survive process restarts: the in-memory
// sentCounts map resets on restart, but a Postgres-backed counter behind
// DailyCapFunc does not — so a crash at 18:00 does not grant the mailbox a
// fresh 1000-send budget at 18:01.
//
// Returning (false, error) signals an oracle outage; pickMailbox falls
// through to config-only behaviour on error (same fail-open contract as
// the mailbox registry wiring — never let a transient DB hiccup block
// delivery).
type DailyCapFunc func(address string) (exhausted bool, err error)

// LabAbortEvaluator is the engine's hook into the Mail Lab pre-send abort
// pipeline (KT-A14 / ML5.2). It mirrors orchestrator/labhook.LabEvaluator
// without importing the orchestrator package — which would create a
// reverse module dependency (campaigns → orchestrator). The orchestrator
// wires its concrete evaluator at boot via Engine.WithLabEvaluator.
//
// Contract:
//   - skip=true  → engine MUST NOT call antiTrace.Send. The send is
//                  recorded as skipped (no SMTP attempt, no rate-limit
//                  counter increment, no recordSendResult). reason is
//                  surfaced through the SendResult to the onSent callback
//                  so audit/log layers can persist it.
//   - skip=false, err=nil → proceed with the normal SMTP submit.
//   - err != nil → the lab API was unreachable. Engine inspects LAB_ONLY:
//                  fail-closed (skip) when 1, fail-open (proceed) when 0.
//
// Implementations MUST be safe for concurrent use; Run holds no lock
// across the call.
type LabAbortEvaluator interface {
	ShouldAbort(ctx context.Context, sender, recipient string) (skip bool, reason string, err error)
}

// Engine orchestrates email sending with rate limiting, rotation, and safety.
type Engine struct {
	mailboxes   []config.MailboxConfig
	sending     config.SendingConfig
	safety      config.SafetyConfig
	preSendHook   PreSendHook
	antiTrace     *AntiTraceClient
	warmupLimiter WarmupLimiter
	dailyCap      DailyCapFunc
	dryRun        bool

	// sendClaim is the exactly-once send gate (sendclaim.go, migration 171
	// send_claims). When non-nil, Run calls it immediately before
	// antiTrace.Send to acquire a durable, shared claim on
	// (campaign,contact,step) so a retry / crash / dual send-path race
	// cannot physically send the same message twice. Nil disables the gate
	// (legacy / unit-test path). Wired by the orchestrator via WithSendClaim.
	sendClaim ClaimFunc

	// messageIDHMACKey seeds the per-recipient Message-ID HMAC built in
	// services/campaigns/sender/headers.go. Wired by the orchestrator at
	// boot via Engine.WithMessageIDHMACKey from MESSAGE_ID_HMAC_KEY env.
	// Nil falls through to legacy generateMessageID — fail-open so a
	// forgotten env var never drops sends; the audit ratchet
	// (services/campaigns/sender/message_id_audit_test.go) blocks
	// regressions where Engine.Run leaves a SendRequest without a
	// Message-ID header.
	messageIDHMACKey []byte

	// Mail Lab pre-send abort hook (KT-A14 / ML5.2). When labEvaluator is
	// non-nil, Run consults it before every SMTP submit. labOnly governs
	// the failure mode when the lab API is unreachable: true ⇒ fail-closed
	// (skip the send); false ⇒ fail-open (proceed and log a warning).
	labEvaluator LabAbortEvaluator
	labOnly      bool

	// Pre-send domain check gate (presend.go). When non-nil, Run probes
	// the recipient domain's MX (with A-record fallback per RFC 5321
	// §5.1) immediately before antiTrace.Send. Negative verdicts skip
	// the submit, surface ErrPreSendDomainCheck through SendResult, and
	// rely on the orchestrator's onSent callback to mark the contact
	// email_status='invalid'. A nil checker disables the gate (legacy
	// path).
	preSendDomainChecker *PreSendDomainChecker

	// D2.3: optional backpressure wiring. When set, pickMailbox consults
	// ActiveAddresses() to skip paused/held/retired mailboxes, and send
	// outcomes update the registry (TouchLastSend, IncrementBounce, auto-hold).
	// Nil means "no registry connected" — engine behaves as before.
	registry            mailbox.Backpressure
	registryAllowed     map[string]struct{} // cached per pass
	registryAllowedAt   time.Time
	registryAllowedTTL  time.Duration
	// registryStrict (INCIDENT 2026-05-13) — when true, pickMailbox REFUSES
	// to select any mailbox whose canonical address is not present in the
	// registry's ActiveAddresses set. The legacy fail-open behaviour
	// (allowed==nil ⇒ fall through to config-only) is bypass surface: env-var
	// mailboxes from config.LoadFromEnv (MAILBOX_N_*) survive a hard-delete
	// in outreach_mailboxes and silently keep sending. Strict mode forbids
	// that. Set by WithMailboxRegistry; default true so production wiring
	// never regresses to the buggy fail-open path. Tests that want the
	// legacy behaviour can call WithStrictRegistryEnforcement(false).
	registryStrict bool

	mu           sync.Mutex
	queue        []SendRequest
	currentIdx   int
	sentCounts   map[string]int // per mailbox today
	domainCounts map[string]int // per domain this hour (rate limit)
	bounceCount  int
	totalSent    int
	circuitOpen  bool

	// resetCountersIfNeeded tracks the hourly and daily reset windows with
	// two INDEPENDENT timestamps. They used to share a single field, which
	// defeated the daily reset entirely: the hourly branch overwrote the
	// shared timestamp to `now` before the daily check ran, so
	// `now.Day() != <shared>.Day()` compared now against now and never fired
	// across calendar days — mailboxes stayed pinned at their daily cap until
	// the process restarted.
	lastReset      time.Time // hourly rate-limit / circuit-breaker window anchor
	lastDailyReset time.Time // per-mailbox daily sentCounts window anchor

	// Per-domain state for greylisting retry and domain-level circuit breaker.
	// domainSent + domainBounces replace the global counters for bounce-rate
	// computation, so one misbehaving domain cannot flip the global circuit.
	domainSent           map[string]int
	domainBounces        map[string]int
	domainCircuitOpen    map[string]time.Time // opened_at timestamp
	domainDeferredUntil  map[string]time.Time // greylisting: do not attempt until
	domainBackoffAttempt map[string]int       // how many 4xx retries have we done

	// Per-mailbox isolation: when a mailbox keeps failing connection/TLS/auth
	// we cool it down locally so pickMailbox stops selecting it. Registry
	// auto-hold is bounce-rate based and too slow for dial-level failures
	// (bad creds, DNS flap). Cleared on first successful send.
	mailboxCooldownUntil    map[string]time.Time
	mailboxConsecutiveFails map[string]int

	// mailboxLastSend — last dispatch wall-clock time per sender mailbox.
	// Used by mailboxSpacingOK to enforce
	// SendingConfig.MailboxMinSpacingSeconds (anti-burst dampening).
	mailboxLastSend map[string]time.Time
}

// NewEngine creates a sending engine.
func NewEngine(mailboxes []config.MailboxConfig, sending config.SendingConfig, safety config.SafetyConfig) *Engine {
	return &Engine{
		mailboxes:            mailboxes,
		sending:              sending,
		safety:               safety,
		sentCounts:           make(map[string]int),
		domainCounts:         make(map[string]int),
		domainSent:              make(map[string]int),
		domainBounces:           make(map[string]int),
		domainCircuitOpen:       make(map[string]time.Time),
		domainDeferredUntil:     make(map[string]time.Time),
		domainBackoffAttempt:    make(map[string]int),
		mailboxCooldownUntil:    make(map[string]time.Time),
		mailboxConsecutiveFails: make(map[string]int),
		mailboxLastSend:         make(map[string]time.Time),
		lastReset:               time.Now(),
		lastDailyReset:          time.Now(),
	}
}

// subjectMarkerPrefix is the leading literal that the cmd/anonymity-test
// CLI prepends to a rendered Subject for harvest-side run-id correlation.
// Engine strips this prefix in production unless
// SendingConfig.AllowTestMarkers=true. See docs/subsystem-maps/anti-trace.md
// and services/orchestrator/cmd/anonymity-test/main.go injectSubjectMarker.
const subjectMarkerPrefix = "[A:"

// xTestRunIDHeader is the custom header that carries the test-run UUID
// pre-relay. T2 SanitizeIntake at the relay strips X-* fingerprinting
// headers, so the harvester reads it from the rendered envelope before
// sealing — never from the delivered message. Production must never let
// the marker leak into the plaintext Subject.
const xTestRunIDHeader = "X-Test-Run-ID"

// scrubSubjectMarker enforces the production subject scrub. When the
// engine is running in production AND AllowTestMarkers is false, any
// envelope whose Subject starts with "[A:" has the marker moved into
// req.Headers as X-Test-Run-ID (the relay strips X-* at T2/D5, so it
// never reaches the recipient). Returns true when the envelope was
// modified.
//
// Tests and dev (Environment != "production" OR AllowTestMarkers=true)
// are pass-through: marker remains in Subject so anonymity-harvest can
// correlate the delivered message back to the test run.
func (e *Engine) scrubSubjectMarker(req *SendRequest) bool {
	if !e.sending.IsProduction() {
		return false
	}
	if e.sending.AllowTestMarkers {
		return false
	}
	if !strings.HasPrefix(req.Subject, subjectMarkerPrefix) {
		return false
	}
	end := strings.Index(req.Subject, "]")
	if end < 0 {
		// Malformed marker — strip the literal prefix only (defensive).
		req.Subject = strings.TrimPrefix(req.Subject, subjectMarkerPrefix)
		return true
	}
	marker := req.Subject[len(subjectMarkerPrefix):end]
	rest := strings.TrimLeft(req.Subject[end+1:], " ")
	req.Subject = rest
	if req.Headers == nil {
		req.Headers = map[string]string{}
	}
	if _, exists := req.Headers[xTestRunIDHeader]; !exists {
		req.Headers[xTestRunIDHeader] = marker
	}
	return true
}

// mailboxLocalTimezone resolves the IANA timezone the engine should use
// for the working-hours gate. Per-mailbox override (Display-Name PR adds
// the DB column) wins; fallback is the global SendingConfig.Timezone;
// final fallback is "Europe/Prague" per CLAUDE.md TZ assumption.
func mailboxLocalTimezone(global config.SendingConfig, mb config.MailboxConfig) string {
	if mb.Timezone != "" {
		return mb.Timezone
	}
	if global.Timezone != "" {
		return global.Timezone
	}
	return "Europe/Prague"
}

// inWorkingHours reports whether `now` falls inside the per-mailbox-local
// working window. In production the gate is hard: weekend sends (when
// WeekdaysOnly=true) and out-of-window sends are rejected. In
// non-production mode the function returns true unconditionally so
// existing tests and the anonymity-test CLI keep their permissive
// behaviour.
func (e *Engine) inWorkingHours(now time.Time, mb config.MailboxConfig) bool {
	if !e.sending.IsProduction() {
		return true
	}
	tz := mailboxLocalTimezone(e.sending, mb)
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	local := now.In(loc)
	if e.sending.WeekdaysOnly {
		switch local.Weekday() {
		case time.Saturday, time.Sunday:
			return false
		}
	}
	start, end := e.sending.EffectiveSendWindow()
	return config.HourInSendWindow(local.Hour(), start, end)
}

// nextWorkingHour returns the earliest time at-or-after `now` that
// satisfies inWorkingHours for the given mailbox. The caller uses the
// returned time to compute a deferral duration. Loop is bounded at 14
// days as a safety net.
func (e *Engine) nextWorkingHour(now time.Time, mb config.MailboxConfig) time.Time {
	if !e.sending.IsProduction() {
		return now
	}
	tz := mailboxLocalTimezone(e.sending, mb)
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	// Scan forward hour-by-hour for up to 14 days. Hour-granularity is
	// required to handle the overnight wrap window (start > end, e.g.
	// 22→3): a "day-jump to start hour" probe would skip the post-midnight
	// tail of the window. The 14-day bound is a safety net against
	// pathological WeekdaysOnly + zero-width window configs.
	local := now.In(loc)
	const maxScanHours = 14 * 24
	for i := 0; i < maxScanHours; i++ {
		candidate := local.Add(time.Duration(i) * time.Hour).Truncate(time.Hour)
		if !candidate.After(local) {
			continue
		}
		if e.inWorkingHours(candidate, mb) {
			return candidate.UTC()
		}
	}
	return now.Add(time.Hour)
}

// mailboxSpacingOK enforces SendingConfig.MailboxMinSpacingSeconds.
// Returns (true, 0) when the mailbox is free to send; (false, wait) when
// the caller must defer for `wait`.
func (e *Engine) mailboxSpacingOK(address string, now time.Time) (bool, time.Duration) {
	min := e.sending.MailboxMinSpacingSeconds
	if min <= 0 {
		return true, 0
	}
	e.mu.Lock()
	last, ok := e.mailboxLastSend[address]
	e.mu.Unlock()
	if !ok {
		return true, 0
	}
	elapsed := now.Sub(last)
	want := time.Duration(min) * time.Second
	if elapsed >= want {
		return true, 0
	}
	return false, want - elapsed
}

// Per-mailbox cooldown policy after connection/TLS/auth failures. Threshold is
// intentionally low because dial-level failures are almost always configuration
// or upstream-server problems; retrying fast just burns cycles and produces
// noisy logs. 30 minutes is long enough to ride out a transient DNS blip or a
// provider restart without operator intervention.
const (
	mailboxFailThreshold = 3
	mailboxCooldown      = 30 * time.Minute
)

// WithPreSendHook registers a hook called after mailbox selection but before sending.
// This is where per-mailbox humanization (persona, signature, fingerprint) is applied.
func (e *Engine) WithPreSendHook(hook PreSendHook) *Engine {
	e.preSendHook = hook
	return e
}

// WithAntiTrace routes all outbound email through the anti-trace-relay instead of
// direct SMTP. When set, mailbox selection is skipped and the relay's fromAddr is used.
func (e *Engine) WithAntiTrace(client *AntiTraceClient) *Engine {
	e.antiTrace = client
	return e
}

// WithWarmupLimiter wires a DB-backed warmup limiter. When set, pickMailbox
// calls LimitForMailbox(address, mb.DailyLimit) to get the effective daily
// limit for the mailbox, so the ramp from configs/warmup.yaml overrides the
// static config value. A nil limiter means the legacy config.MailboxConfig
// path (MailboxConfig.DailyLimit or MailboxConfig.WarmupDay) is used.
func (e *Engine) WithWarmupLimiter(l WarmupLimiter) *Engine {
	e.warmupLimiter = l
	return e
}

// WithDryRun toggles the send-mode gate. In dry_run mode send() short-circuits
// before any SMTP I/O and returns a synthetic SendResult so the cockpit can
// exercise the full render/queue/audit pipeline without producing deliverable
// mail. Default is live (false). Flip this for QA of a new template or for a
// suspicious campaign before flipping back to live.
func (e *Engine) WithDryRun(v bool) *Engine {
	e.dryRun = v
	return e
}

// IsDryRun reports whether the engine is currently in dry_run mode.
func (e *Engine) IsDryRun() bool { return e.dryRun }

// WithLabEvaluator wires the Mail Lab pre-send abort hook (KT-A14 / ML5.2).
//
// When ev is non-nil, Run calls ev.ShouldAbort(ctx, sender, recipient) right
// before each SMTP submit. The labOnly flag mirrors the LAB_ONLY env var:
//   - labOnly=true  → lab API errors fail-CLOSED: skip the send, increment
//                     LabUnreachableTotal + LabSkipTotal. Used in airtight
//                     dev to guarantee no real SMTP traffic ever escapes
//                     when the lab is down.
//   - labOnly=false → lab API errors fail-OPEN: log a warning and proceed
//                     with the SMTP submit. Production sets this so a lab
//                     outage cannot block real campaign delivery.
//
// A nil evaluator disables the hook entirely (legacy code path).
func (e *Engine) WithLabEvaluator(ev LabAbortEvaluator, labOnly bool) *Engine {
	e.labEvaluator = ev
	e.labOnly = labOnly
	return e
}

// LabOnly reports the configured fail-mode for the Mail Lab labhook.
// Exposed for boot-log clarity ("airtight LAB_ONLY=1" vs "LAB_ONLY=0").
func (e *Engine) LabOnly() bool { return e.labOnly }

// WithPreSendDomainCheck enables the inline MX-with-A-fallback gate
// (presend.go). When the gate flags a recipient domain as undeliverable
// the engine skips antiTrace.Send and surfaces ErrPreSendDomainCheck
// through the SendResult so the onSent callback can:
//
//   - INSERT a failed send_events row (existing failure-path code);
//   - UPDATE contacts SET email_status='invalid',
//     email_verification='pre_send_fail_<reason>';
//   - audit.Log the skip.
//
// Pre-send skips do NOT advance per-mailbox daily caps, per-domain
// counters, or trip the bounce circuit-breaker — they're not SMTP
// attempts. recordSendResult enforces this via IsPreSendDomainCheckSkip.
//
// Passing nil disables the gate (legacy code path). Callers that want
// the production wiring without supplying a checker can call
// WithPreSendDomainCheck(NewPreSendDomainChecker(nil)).
func (e *Engine) WithPreSendDomainCheck(checker *PreSendDomainChecker) *Engine {
	e.preSendDomainChecker = checker
	return e
}

// PreSendDomainCheckEnabled reports whether the inline domain check is
// wired. Exposed for boot-log clarity (mirrors LabOnly()).
func (e *Engine) PreSendDomainCheckEnabled() bool {
	return e.preSendDomainChecker != nil
}

// WithDailyCapFunc wires the persistent daily-cap oracle used by pickMailbox
// to honour the real on-disk counter rather than the in-memory one. A nil
// argument is the no-op default. Oracle errors are logged and treated as
// "no opinion" so a transient DB outage never blocks delivery.
func (e *Engine) WithDailyCapFunc(fn DailyCapFunc) *Engine {
	e.dailyCap = fn
	return e
}

// WithSendClaim wires the exactly-once send gate (sendclaim.go, migration 171).
// When fn is non-nil, Run acquires a durable, shared claim on
// (campaign,contact,step) immediately before antiTrace.Send — the single
// chokepoint both send paths cross. A duplicate verdict skips the submit
// without consuming a rate-limit slot. A nil fn disables the gate (legacy /
// unit-test path); the engine then behaves exactly as before.
func (e *Engine) WithSendClaim(fn ClaimFunc) *Engine {
	e.sendClaim = fn
	return e
}

// WithMessageIDHMACKey wires the seed used to build per-recipient
// Message-ID headers. The key MUST be ≥32 raw bytes (operator passes a
// base64-encoded 32-byte value via MESSAGE_ID_HMAC_KEY; the boot path
// decodes it through common/envconfig.RequireBase64Bytes). A shorter
// or nil key falls through to the legacy generateMessageID path —
// fail-open so a misconfigured env var never blocks delivery, but the
// audit ratchet message_id_audit_test.go fails CI when the engine
// emits a SendRequest without a Message-ID header.
func (e *Engine) WithMessageIDHMACKey(key []byte) *Engine {
	// Defensive copy so a caller mutating its own slice (e.g. zeroing
	// the secret post-boot) doesn't race with the send hot loop.
	if len(key) > 0 {
		buf := make([]byte, len(key))
		copy(buf, key)
		e.messageIDHMACKey = buf
	}
	return e
}

// WithMailboxRegistry wires the outreach_mailboxes registry backpressure
// adapter. When set:
//   - pickMailbox skips any config mailbox whose address is not in the
//     registry's ActiveAddresses set (so operators can pause/hold via the
//     cockpit without redeploying config.yaml).
//   - Every SMTPOK outcome calls RecordSuccess to touch last_send_at and
//     reset consecutive_bounces.
//   - Every SMTPPermanent / SMTPUnknown outcome calls RecordBounce, which
//     increments counters and auto-holds the mailbox after BackpressureThreshold
//     consecutive bounces.
//
// A nil argument or a Backpressure backed by a nil Store keeps the legacy
// config-only behaviour (fail-safe on registry outages).
//
// INCIDENT 2026-05-13: WithMailboxRegistry now defaults to STRICT mode —
// pickMailbox refuses to select any mailbox whose address is not in the
// registry's ActiveAddresses set. Callers that need the legacy fail-open
// behaviour (tests, dev scripts) must opt out via
// WithStrictRegistryEnforcement(false) AFTER WithMailboxRegistry.
func (e *Engine) WithMailboxRegistry(bp mailbox.Backpressure) *Engine {
	e.registry = bp
	if e.registryAllowedTTL == 0 {
		// Refresh the active-address cache at most once per 30s so the
		// send hot loop doesn't hammer the registry.
		e.registryAllowedTTL = 30 * time.Second
	}
	// Default to strict mode when a registry is wired — the only legitimate
	// production source of truth is outreach_mailboxes. Env-var mailboxes
	// must NOT outlive a hard-delete (INCIDENT 2026-05-13).
	e.registryStrict = true
	return e
}

// WithStrictRegistryEnforcement toggles whether pickMailbox refuses to send
// from a mailbox absent from the registry's allow-set. Default true after
// WithMailboxRegistry. Tests/dev scripts that intentionally exercise the
// config-only path can call (false). Calling (true) without a wired
// registry has no effect — pickMailbox short-circuits when e.registry==nil
// to preserve the legacy unit-test contract.
func (e *Engine) WithStrictRegistryEnforcement(strict bool) *Engine {
	e.registryStrict = strict
	return e
}

// Enqueue adds a send request to the queue.
func (e *Engine) Enqueue(req SendRequest) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.queue = append(e.queue, req)
}

// QueueDepth returns the number of pending sends.
func (e *Engine) QueueDepth() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.queue)
}

// ErrAntiTraceRequired is returned by Engine.Run when AntiTraceClient is missing.
// SMTP-EGRESS-LOCKDOWN R4: direct SMTP egress is disabled — all mail must go
// through the anti-trace-relay SOCKS5 proxy pool.
var ErrAntiTraceRequired = errors.New("sender.Engine.Run: AntiTraceClient is required — direct SMTP egress is disabled (use WithAntiTrace)")

// ErrMailboxNotProvisioned (INCIDENT 2026-05-13) is returned by pickMailbox
// when an env-var (MAILBOX_N_*) mailbox survives in cfg.Mailboxes but its
// row has been hard-deleted from outreach_mailboxes. Surfaces from the
// strict-registry gate added after operator deleted nowak.goran/goran.nowak
// at 14:18 UTC and the Go runner still emitted 17 sends from them at
// 15:00–15:34 UTC via the static-config fallback.
var ErrMailboxNotProvisioned = errors.New("sender.pickMailbox: mailbox not in registry (env-var fallback blocked)")

// ErrRegistryUnavailable (INCIDENT 2026-05-13) is returned by pickMailbox
// when the mailbox registry is wired but ActiveAddresses() failed AND
// strict mode is on. The engine refuses to send rather than fall back to
// config-only: a transient DB error must not authorise sends from a
// possibly-deleted mailbox. The Run loop re-enqueues the request and
// retries on the next tick (same as ErrMailboxNotProvisioned).
var ErrRegistryUnavailable = errors.New("sender.pickMailbox: mailbox registry unreachable; refusing to fall through to config-only")

// Run starts the sending loop. Blocks until context is cancelled.
//
// SMTP-EGRESS-LOCKDOWN R4: anti-trace-relay is mandatory — Run returns
// ErrAntiTraceRequired if no AntiTraceClient is configured. Direct SMTP egress
// was removed after a 2026-04-21 incident exposed the platform's IP to seznam.cz,
// damaging sender reputation. Mail still flows over SMTP, just from the relay
// process (services/anti-trace-relay) through its SOCKS5 proxy pool.
func (e *Engine) Run(ctx context.Context, onSent func(req SendRequest, result SendResult)) error {
	if e.antiTrace == nil {
		return ErrAntiTraceRequired
	}

	loc, err := time.LoadLocation(e.sending.Timezone)
	if err != nil {
		loc = time.UTC
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Check business hours. Use EffectiveSendWindow + HourInSendWindow so
		// the wrap-around shape (start > end, e.g. 22→3) honored by
		// inWorkingHours is also honored on the Run-loop gate. Per operator
		// spec 2026-05-13 ("6-3 wrap = 06:00 Prague → 03:00 next day").
		now := time.Now().In(loc)
		winStart, winEnd := e.sending.EffectiveSendWindow()
		if !config.HourInSendWindow(now.Hour(), winStart, winEnd) {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Minute):
			}
			continue
		}

		// Reset hourly counters
		e.resetCountersIfNeeded()

		// Circuit breaker check
		if e.isCircuitOpen() {
			slog.Warn("sender circuit breaker open, pausing", "op", "engine.Run/circuitOpen")
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Minute):
			}
			continue
		}

		// Dequeue
		req, ok := e.dequeue()
		if !ok {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(5 * time.Second):
			}
			continue
		}

		domain := config.DomainFromEmail(req.ToAddress)

		// Production subject-scrub: any "[A:<short>]" run-id marker in the
		// rendered Subject is moved into the X-Test-Run-ID header (relay
		// strips X-* at T2/D5) so production recipients never see the
		// internal correlation tag. Test mode (Environment != "production"
		// OR AllowTestMarkers=true) leaves the marker in Subject for the
		// harvester.
		e.scrubSubjectMarker(&req)

		// SMTP-EGRESS-LOCKDOWN R4: anti-trace-relay is the only egress path.
		// We still rotate mailboxes so rate-limits and from-address rotation
		// behave the same as before — the relay just replaces the raw SMTP dial.
		mailbox, err := e.pickMailbox(req.ToAddress)
		if err != nil {
			slog.Error("sender no available mailbox", "op", "engine.pickMailbox", "error", err)
			e.mu.Lock()
			e.queue = append([]SendRequest{req}, e.queue...)
			e.mu.Unlock()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Minute):
			}
			continue
		}

		if !e.allowDomain(domain) {
			e.mu.Lock()
			e.queue = append(e.queue, req)
			e.mu.Unlock()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(10 * time.Second):
			}
			continue
		}

		// Working-hours hard gate (production only). Anonymity ratchet
		// 2026-05-01: the harvester flagged 22:17–22:19 sends as
		// "off-hours, suspicious". In production, defer envelopes until
		// the next mailbox-local working window (start-of-day per
		// SEND_WINDOW_START_HOUR, weekdays only when SEND_WEEKDAYS_ONLY=true).
		// In test mode this is a no-op.
		if !e.inWorkingHours(time.Now(), mailbox) {
			next := e.nextWorkingHour(time.Now(), mailbox)
			wait := time.Until(next)
			if wait <= 0 {
				wait = time.Minute
			}
			slog.Info("send deferred to next working window",
				"op", "engine.Run/workingHours",
				"mailbox", mailbox.Address,
				"recipient_domain", domain,
				"defer_seconds", int(wait.Seconds()))
			e.mu.Lock()
			e.queue = append(e.queue, req)
			e.mu.Unlock()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(minDuration(wait, time.Minute)):
			}
			continue
		}

		// Per-mailbox anti-burst dampening: enforce
		// MailboxMinSpacingSeconds between consecutive sends from the same
		// mailbox.
		if ok, wait := e.mailboxSpacingOK(mailbox.Address, time.Now()); !ok {
			slog.Info("mailbox spacing not yet satisfied",
				"op", "engine.Run/mailboxSpacing",
				"mailbox", mailbox.Address,
				"wait_seconds", int(wait.Seconds()))
			e.mu.Lock()
			e.queue = append(e.queue, req)
			e.mu.Unlock()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(minDuration(wait, 10*time.Second)):
			}
			continue
		}

		if e.preSendHook != nil {
			e.preSendHook(mailbox, &req)
		}

		// Anti-trace anonymity bundle (FIX 1 / 2 / 3 — 2026-05-01 brutal
		// anonymity test scored 17/100). Override Message-ID, From, Date
		// AFTER humanize fingerprint so the relay receives the
		// anonymity-correct values:
		//   - Message-ID: HMAC-SHA256(recipient + envelope_id) — per-
		//     recipient unlinkable, not per-envelope linkable.
		//   - From: "Display Name <addr>" — never bare-address, which is
		//     a strong webmail-vs-bot signal in spamfilter heuristics.
		//   - Date: formatted in mailbox.Timezone, not server local TZ.
		//
		// Headers map is allocated lazily so callers that pre-populated
		// req.Headers (e.g. legacy tests) keep working. Audit ratchet at
		// services/campaigns/sender/message_id_audit_test.go enforces
		// that this assignment runs on every send.
		if req.Headers == nil {
			req.Headers = make(map[string]string)
		}
		applyAnonymityHeaders(
			req.Headers,
			req.ToAddress,
			mailbox.Address,
			mailbox.DisplayName,
			mailbox.Timezone,
			e.messageIDHMACKey,
			time.Now(),
		)

		// Thread-linking headers (RFC 5322 §3.6.4).
		// In-Reply-To and References are set only for follow-up steps
		// (Step > 0). The runner populates InReplyToMessageID /
		// ReferencesChain before enqueuing; the engine writes them into
		// req.Headers so buildMessage emits them via the custom-headers loop.
		// First-step sends leave both fields empty → no headers emitted.
		if req.InReplyToMessageID != "" {
			if inReplyToVal, refsVal := BuildThreadHeaders(req.InReplyToMessageID, req.ReferencesChain); inReplyToVal != "" {
				req.Headers["In-Reply-To"] = inReplyToVal
				if refsVal != "" {
					req.Headers["References"] = refsVal
				}
			}
		}

		// KT-A14 — Mail Lab pre-send abort hook. Ask the lab whether this
		// send should proceed. When the evaluator says skip=true (verdict
		// = reject/greylist/spam, or fail-closed in airtight LAB_ONLY=1
		// mode) the engine bypasses antiTrace.Send and records the skip
		// directly. recordSendResult is intentionally NOT called: a
		// pre-send abort is not an SMTP attempt and must not advance the
		// per-mailbox / per-domain rate-limit counters.
		if abort, abortReason, abortResult, ok := e.checkLabAbort(ctx, mailbox.Address, req.ToAddress); ok {
			if abort {
				slog.Info("lab pre-send abort",
					"op", "engine.Run/labAbort",
					"mailbox", mailbox.Address,
					"recipient_domain", config.DomainFromEmail(req.ToAddress),
					"reason", abortReason)
				if onSent != nil {
					onSent(req, abortResult)
				}
				// Brief breather so a steady stream of lab-skips doesn't
				// hot-loop — same shape as the post-send pacing below.
				delay := humanSendDelay(e.sending.MinDelaySeconds, e.sending.MaxDelaySeconds, time.Now())
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(delay):
				}
				continue
			}
		}

		// Pre-send domain check (presend.go). RFC 5321 §5.1 MX-with-A
		// fallback. Runs AFTER mailbox selection so the gated SendResult
		// carries MailboxUsed for the audit log, and BEFORE antiTrace.Send
		// so we never spend a relay submit on a guaranteed-bounce domain.
		// Cache is 24h in-memory, so a cohort with thousands of
		// @same-domain contacts pays one DNS lookup. Skips bypass
		// recordSendResult — pre-send skips are not SMTP attempts and
		// must not affect rate limits or circuit breakers.
		if e.preSendDomainChecker != nil {
			check := e.preSendDomainChecker.Check(ctx, req.ToAddress)
			if check.Cached {
				metrics.PreSendDomainCheckCacheHitTotal.Inc()
			}
			if !check.OK {
				metrics.PreSendDomainCheckSkipTotal.Inc(check.Reason)
				logPreSendSkip(mailbox.Address, req.ToAddress, check.Reason, check.Cached)
				skipResult := preSendSkipResult(mailbox.Address, check.Reason)
				if onSent != nil {
					onSent(req, skipResult)
				}
				// Brief breather so a steady stream of pre-send skips
				// doesn't hot-loop — same shape as the lab-abort path.
				delay := humanSendDelay(e.sending.MinDelaySeconds, e.sending.MaxDelaySeconds, time.Now())
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(delay):
				}
				continue
			}
		}

		// Exactly-once send-claim gate (sendclaim.go, migration 171
		// send_claims). Acquire a durable, shared claim on
		// (campaign,contact,step) immediately before the relay submit so a
		// retry, a process crash, or the dual send-path race (Go daemon vs
		// Node script) cannot physically send the same message twice. This
		// is the narrow waist both paths cross; the UNIQUE constraint on
		// send_claims is the real mutex.
		//
		// Skipped in dry-run (no real mail → nothing to claim). On a
		// duplicate verdict we do NOT call recordSendResult — a skip is not
		// an SMTP attempt and must not advance per-mailbox / per-domain
		// rate-limit counters or trip the breaker (same contract as the
		// lab-abort and presend-skip gates above).
		//
		// Fail-OPEN on a claim-table error (consistent with dailyCap and the
		// lab fail-open contract): a transient DB hiccup must never halt the
		// whole pipeline. The send_events partial-unique backstop (migration
		// 153) still prevents a duplicate RECORD, and the in_flight
		// reservation bounds the blast radius.
		if !e.dryRun && e.sendClaim != nil {
			decision, claimErr := e.sendClaim(ctx, req)
			switch {
			case claimErr != nil:
				slog.Warn("send-claim acquire error — fail-open (proceeding)",
					"op", "engine.Run/sendClaimError",
					"campaign_id", req.CampaignID,
					"contact_id", req.ContactID,
					"step", req.Step,
					"error", claimErr)
			case decision != ClaimProceed:
				slog.Info("send skipped — duplicate prevented by send-claim",
					"op", "engine.Run/sendClaimSkip",
					"campaign_id", req.CampaignID,
					"contact_id", req.ContactID,
					"step", req.Step,
					"decision", decision.String())
				if onSent != nil {
					onSent(req, dupSkipResult(mailbox.Address, decision))
				}
				delay := humanSendDelay(e.sending.MinDelaySeconds, e.sending.MaxDelaySeconds, time.Now())
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(delay):
				}
				continue
			}
		}

		var result SendResult
		// Stash the RFC Message-ID applyAnonymityHeaders wrote into the
		// header map so we can surface it on every SendResult — both
		// dry-run and real submit. Strip angle brackets so callers writing
		// to send_events.rfc_message_id store the same canonical form the
		// inbound matcher (cleanMessageID) compares against.
		rfcMessageID := stripAngleBrackets(req.Headers["Message-ID"])
		if e.dryRun {
			// Dry-run short-circuits BEFORE calling the relay so the cockpit
			// can exercise the full render/queue/audit pipeline without
			// producing deliverable mail.
			messageID := req.Headers["Message-ID"]
			if messageID == "" {
				messageID = generateMessageID(mailbox.Address)
				rfcMessageID = stripAngleBrackets(messageID)
			}
			slog.Info("dry_run send (relay not fired)",
				"mailbox", mailbox.Address, "to", req.ToAddress, "subject", req.Subject)
			result = SendResult{
				MessageID:    "dry-run-" + messageID,
				RFCMessageID: rfcMessageID,
				MailboxUsed:  mailbox.Address,
				SMTPResponse: "dry-run: no SMTP attempt",
				SentAt:       time.Now(),
			}
		} else {
			// Inject SMTP credentials from the selected mailbox so the relay
			// can authenticate directly — no need for relay-side env vars.
			req.SMTPHost = mailbox.SMTPHost
			req.SMTPPort = mailbox.SMTPPort
			req.SMTPUsername = mailbox.Username
			req.SMTPPassword = mailbox.Password
			// AW7-9 — forward IMAP coordinates so the relay can perform
			// post-send APPEND to the sender's "Sent" folder inside its
			// own container (where wgsocks runs).
			req.IMAPHost = mailbox.IMAPHost
			req.IMAPPort = mailbox.IMAPPort
			// Inject per-mailbox egress country pin (migration 065).
			// Empty when not set — relay uses hash-based rotation.
			req.PreferredCountry = mailbox.PreferredCountry
			result = e.antiTrace.Send(ctx, req)
			// antitrace.Send populates MessageID with the relay envelope
			// id; the RFC Message-ID we generated is the one the recipient
			// will see, so attach it here before the callback fires.
			if result.RFCMessageID == "" {
				result.RFCMessageID = rfcMessageID
			}
		}
		e.recordSendResult(mailbox.Address, domain, result.Error)

		// Stamp last-send time for the per-mailbox anti-burst dampener.
		e.mu.Lock()
		e.mailboxLastSend[mailbox.Address] = time.Now()
		e.mu.Unlock()

		if onSent != nil {
			onSent(req, result)
		}

		// Human-like send pacing. The Poisson distribution mean and clamp
		// are operator-tunable via SendingConfig.Poisson{Mean,Min,Max}Seconds.
		// Defaults: mean=120s, min=30s, max=300s — humans replying back to
		// back rarely fire faster than ~30s and rarely slower than 5min.
		delay := humanSendDelayConfig(e.sending, time.Now())
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
}

// minDuration returns the smaller of two durations. Used in the
// working-hours and mailbox-spacing defer paths to bound the sleep — we
// never want to block the engine for hours, only enough that the queue
// does not hot-loop.
func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// checkLabAbort consults the Mail Lab labhook (KT-A14 / ML5.2) and decides
// whether the engine should skip the current send.
//
// Returns:
//   - abort=true  → engine MUST NOT call antiTrace.Send. result holds the
//                   synthetic SendResult that was recorded for the skip.
//   - abort=false → proceed with the normal SMTP submit; result is unused.
//   - ok=false    → no labhook configured, the legacy code path applies.
//
// Failure modes:
//   - Lab returned a verdict (verdict ≠ accept) → abort, increment
//     LabSkipTotal.
//   - Lab unreachable + labOnly=true → fail-closed: abort, increment
//     LabUnreachableTotal + LabSkipTotal.
//   - Lab unreachable + labOnly=false → fail-open: proceed, increment
//     LabUnreachableTotal, log warning.
func (e *Engine) checkLabAbort(ctx context.Context, sender, recipient string) (abort bool, reason string, result SendResult, ok bool) {
	if e.labEvaluator == nil {
		return false, "", SendResult{}, false
	}
	skip, labReason, err := e.labEvaluator.ShouldAbort(ctx, sender, recipient)
	if err != nil {
		// Lab API was unreachable. Always count the outage; the LAB_ONLY
		// flag decides whether to fail-closed (skip) or fail-open
		// (proceed).
		metrics.LabUnreachableTotal.Inc()
		if e.labOnly {
			slog.Error("lab unreachable, fail-closed (LAB_ONLY=1)",
				"op", "engine.checkLabAbort/labOnly",
				"mailbox", sender,
				"recipient_domain", config.DomainFromEmail(recipient),
				"error", err)
			metrics.LabSkipTotal.Inc()
			closedReason := fmt.Sprintf("lab unreachable (LAB_ONLY=1): %v", err)
			return true, closedReason, SendResult{
				MailboxUsed:  sender,
				SMTPResponse: "lab-skip: " + closedReason,
				SentAt:       time.Now(),
			}, true
		}
		slog.Warn("lab unreachable, fail-open (LAB_ONLY=0)",
			"op", "engine.checkLabAbort/failOpen",
			"mailbox", sender,
			"recipient_domain", config.DomainFromEmail(recipient),
			"error", err)
		return false, "", SendResult{}, true
	}
	if !skip {
		return false, "", SendResult{}, true
	}
	metrics.LabSkipTotal.Inc()
	return true, labReason, SendResult{
		MailboxUsed:  sender,
		SMTPResponse: "lab-skip: " + labReason,
		SentAt:       time.Now(),
	}, true
}

func (e *Engine) dequeue() (SendRequest, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.queue) == 0 {
		return SendRequest{}, false
	}
	req := e.queue[0]
	e.queue = e.queue[1:]
	return req, true
}

// pickMailbox selects the next available sender mailbox for a send to
// `recipient`. Pass "" to skip the self-send guard (e.g. from tests that
// only exercise rotation/cooldown logic).
//
// INCIDENT 2026-05-13 gating contract:
//   - registry not wired (e.registry == nil) — config-only behaviour
//     (legacy; unit-test friendly).
//   - registry wired + ActiveAddresses ok + strict mode (default) —
//     refuse any mailbox not in the allow-set. Returns
//     ErrMailboxNotProvisioned for the no-survivors case.
//   - registry wired + ActiveAddresses errored + strict mode —
//     refuse all sends this tick. Returns ErrRegistryUnavailable. The
//     Run loop re-enqueues + retries on the next tick. A transient DB
//     hiccup is acceptable for one tick; silently sending from possibly-
//     deleted env-var mailboxes is not.
//   - registry wired + non-strict — fall through to config-only on a
//     nil allow-set (legacy behaviour for opt-in callers).
func (e *Engine) pickMailbox(recipient string) (config.MailboxConfig, error) {
	// Refresh the registry allow-set outside the engine mutex to avoid
	// holding it across a potentially slow DB call.
	allowed, allowedErr := e.resolveRegistryAllowed()
	if allowedErr != nil && e.registryStrict {
		slog.Error("sender refusing to send: registry unavailable and strict mode on",
			"op", "engine.pickMailbox/registryStrict",
			"error", allowedErr)
		return config.MailboxConfig{}, fmt.Errorf("%w: %v", ErrRegistryUnavailable, allowedErr)
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	// Self-send guard: never pick a mailbox whose own address is the recipient.
	// Without this, internal-test sends (mb=3 → a.mazher@email.cz where mb=3
	// IS a.mazher@email.cz) would still be accepted — relay delivers, IMAP
	// poller sees the same message in Sent and Inbox, and reply classification
	// runs against the sender's own outbound copy. Empty recipient (tests)
	// skips the check.
	normalisedRecipient := mailbox.NormaliseAddress(recipient)

	for i := 0; i < len(e.mailboxes); i++ {
		idx := (e.currentIdx + i) % len(e.mailboxes)
		mb := e.mailboxes[idx]

		if normalisedRecipient != "" && mailbox.NormaliseAddress(mb.Address) == normalisedRecipient {
			continue
		}

		// D2.3 registry gate: skip mailboxes that the outreach_mailboxes
		// registry does not mark as active. The registry is the source of
		// truth for operator overrides (pause, bounce_hold, retired), so
		// when it is configured we defer to it.
		//
		// INCIDENT 2026-05-13: when strict mode is on AND the registry is
		// wired (e.registry != nil), a nil allowed map (mailbox missing
		// from ActiveAddresses) is fatal — the env-var fallback in
		// LoadFromEnv would otherwise let a hard-deleted mailbox survive
		// across redeploys. Legacy fail-open is preserved only for opt-in
		// callers (WithStrictRegistryEnforcement(false)) and for engines
		// with no registry wired (unit-test friendly).
		if allowed != nil {
			if _, ok := allowed[mailbox.NormaliseAddress(mb.Address)]; !ok {
				slog.Warn("sender skipping mailbox: not in registry allow-set",
					"op", "engine.pickMailbox/registrySkip",
					"address", mb.Address,
					"strict", e.registryStrict)
				continue
			}
		} else if e.registry != nil && e.registryStrict {
			// Registry wired + strict + allow-set nil for a non-error
			// reason (cache miss is impossible here since resolveRegistryAllowed
			// returns either set+nil-err or nil+err). Defensive — never
			// fall through to config-only when strict.
			slog.Warn("sender skipping mailbox: strict registry mode with empty allow-set",
				"op", "engine.pickMailbox/registryStrictEmpty",
				"address", mb.Address)
			continue
		}

		// In-process cooldown after repeated dial/TLS/auth failures. This is
		// faster than the DB-backed registry auto-hold, which only trips on
		// daily bounce-rate thresholds and is useless for immediate dial
		// failures (bad credentials, SMTP outage).
		if cooldownUntil, ok := e.mailboxCooldownUntil[mb.Address]; ok {
			if time.Now().Before(cooldownUntil) {
				continue
			}
			delete(e.mailboxCooldownUntil, mb.Address)
			delete(e.mailboxConsecutiveFails, mb.Address)
		}

		// Check daily limit
		limit := mb.DailyLimit
		if mb.WarmupDay > 0 {
			limit = e.warmupLimit(mb.WarmupDay)
		}
		// DB-backed warmup overrides the static limit when a mailbox_warmup
		// row exists for this mailbox. Any DB error or missing row leaves the
		// static limit in place (fail-safe: never ramp *up* on error).
		if e.warmupLimiter != nil {
			if dbLimit, err := e.warmupLimiter.LimitForMailbox(mb.Address, limit); err == nil {
				limit = dbLimit
			}
		}

		if e.sentCounts[mb.Address] < limit {
			// D3.1: consult persistent daily-cap oracle before committing
			// to this mailbox. Oracle errors fail-open per contract.
			if e.dailyCap != nil {
				exhausted, err := e.dailyCap(mb.Address)
				if err != nil {
					slog.Warn("daily cap oracle error, fail-open", "op", "engine.pickMailbox/dailyCap", "address", mb.Address, "error", err)
				} else if exhausted {
					continue
				}
			}
			e.currentIdx = (idx + 1) % len(e.mailboxes)
			return mb, nil
		}
	}

	// INCIDENT 2026-05-13: when strict + no survivors, surface the
	// specific reason so caller logs / dashboards can distinguish "all
	// caps hit" from "env-var fallback blocked".
	if e.registry != nil && e.registryStrict && len(allowed) >= 0 {
		// allowed may be empty (registry says no active mailboxes) or
		// non-empty with every entry filtered by daily-cap. We can't
		// disambiguate here without an extra pass; return the more
		// informative wrapped sentinel so callers can errors.Is.
		return config.MailboxConfig{}, fmt.Errorf("%w (or all at daily limit)", ErrMailboxNotProvisioned)
	}
	return config.MailboxConfig{}, fmt.Errorf("all mailboxes at daily limit")
}

// resolveRegistryAllowed fetches the current active-address set from the
// mailbox registry, with a short TTL cache to keep the send loop fast.
//
// Return contract (INCIDENT 2026-05-13):
//   - no registry wired:   (nil, nil)
//   - cache hit:           (set, nil)
//   - registry ok:         (set, nil)  + cache refresh
//   - registry errored:    (nil, err)  — caller decides strict vs fall-open
//
// Callers in strict mode (registryStrict=true) MUST treat err != nil as
// fatal-for-this-tick instead of falling through to config-only behaviour.
//
// On a cache miss + registry-ok path, also opportunistically refreshes the
// engine's in-memory mailbox list (e.mailboxes) from the registry when the
// adapter implements mailbox.MailboxLister. This is the runtime self-heal
// for the 2026-05-13 incident, where a NULL Scan crash at boot left
// cfg.Mailboxes empty and the strict-mode engine refusing every send even
// after the DB was repaired. The registry is the strict-mode source of
// truth — when it advertises a mailbox we don't know about, we trust it.
func (e *Engine) resolveRegistryAllowed() (map[string]struct{}, error) {
	if e.registry == nil {
		return nil, nil
	}
	e.mu.Lock()
	cached, cachedAt, ttl := e.registryAllowed, e.registryAllowedAt, e.registryAllowedTTL
	e.mu.Unlock()
	if cached != nil && time.Since(cachedAt) < ttl {
		return cached, nil
	}
	set, err := e.registry.ActiveAddresses(context.Background())
	if err != nil {
		slog.Warn("mailbox registry ActiveAddresses failed",
			"op", "engine.activeRegistry",
			"strict", e.registryStrict,
			"error", err)
		return nil, err
	}
	e.mu.Lock()
	e.registryAllowed = set
	e.registryAllowedAt = time.Now()
	e.mu.Unlock()

	// Runtime self-heal: if the registry adapter implements MailboxLister,
	// pull the full mailbox configs and merge any unknown-yet-allowed
	// mailboxes into e.mailboxes. Only addresses that are CURRENTLY in the
	// registry allow-set are admitted — env-var fallback remains blocked
	// (PR #1342 contract).
	if lister, ok := e.registry.(mailbox.MailboxLister); ok {
		e.refreshMailboxesFromRegistry(lister, set)
	}
	return set, nil
}

// refreshMailboxesFromRegistry merges registry-reported mailboxes that are
// not present in e.mailboxes into the engine's in-memory mailbox list.
//
// Strict-mode contract preserved:
//   - Only mailboxes whose canonical address is in `allowed` are admitted.
//   - Existing e.mailboxes entries are kept (operator-tuned WarmupDay /
//     Persona overlays from cfg.yaml survive).
//   - New mailboxes are appended in stable order so round-robin behaviour
//     stays deterministic.
//   - On lister error we log and leave e.mailboxes alone — the next tick
//     retries.
func (e *Engine) refreshMailboxesFromRegistry(lister mailbox.MailboxLister, allowed map[string]struct{}) {
	mbs, err := lister.ActiveMailboxes(context.Background())
	if err != nil {
		slog.Warn("mailbox registry ActiveMailboxes failed (engine self-heal skipped)",
			"op", "engine.refreshMailboxes",
			"strict", e.registryStrict,
			"error", err)
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	known := make(map[string]struct{}, len(e.mailboxes))
	for _, mb := range e.mailboxes {
		known[mailbox.NormaliseAddress(mb.Address)] = struct{}{}
	}
	added := 0
	for _, mb := range mbs {
		canon := mailbox.NormaliseAddress(mb.Address)
		if canon == "" {
			continue
		}
		if _, isKnown := known[canon]; isKnown {
			continue
		}
		// Strict-mode safety: only admit if the registry's allow-set
		// currently includes this address. (Defense against a lister
		// that returns mailboxes the allow-set has since dropped.)
		if _, isAllowed := allowed[canon]; !isAllowed {
			continue
		}
		e.mailboxes = append(e.mailboxes, mb)
		known[canon] = struct{}{}
		added++
	}
	if added > 0 {
		slog.Info("mailbox registry self-heal: appended unknown mailboxes",
			"op", "engine.refreshMailboxes",
			"added", added,
			"total", len(e.mailboxes))
	}
}

func (e *Engine) warmupLimit(day int) int {
	schedule := map[int]int{
		1: 10, 2: 20, 3: 40, 4: 60, 5: 80,
		6: 100, 7: 120, 14: 150,
	}
	if e.sending.WarmupSchedule != nil {
		schedule = e.sending.WarmupSchedule
	}
	best := 10
	for d, limit := range schedule {
		if day >= d && limit > best {
			best = limit
		}
	}
	return best
}

func (e *Engine) allowDomain(domain string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	// Domain-level circuit breaker: if bounce rate for this domain exceeds
	// the global threshold, pause sends to that domain for 1 hour.
	if openedAt, open := e.domainCircuitOpen[domain]; open {
		if time.Since(openedAt) < time.Hour {
			return false
		}
		delete(e.domainCircuitOpen, domain)
		metrics.CircuitDomainOpen.Delete(domain)
		// Reset per-domain counters when the circuit recloses.
		e.domainSent[domain] = 0
		e.domainBounces[domain] = 0
	}
	// Greylisting deferral: if domain issued 4xx last time, honor the backoff.
	if until, deferred := e.domainDeferredUntil[domain]; deferred && time.Now().Before(until) {
		return false
	}
	return e.domainCounts[domain] < e.sending.MaxPerDomainHour
}

// recordSendResult is the classifier-aware replacement for recordSend.
// It inspects the SMTP error and updates per-domain state accordingly:
//   - warmup_cap_exceeded: skip quietly — this is a scheduling signal, NOT a
//     deliverability bounce. Mailbox-level counters are NOT incremented so
//     the in-memory cap stays accurate; do NOT trip the circuit breaker.
//   - warmup_cap_status_guard: mailbox is paused/auth_locked/retired; skip
//     quietly, log + Sentry, do NOT bounce, do NOT retry today.
//   - transient (4xx): schedule greylisting backoff, do not count as bounce
//   - permanent (5xx): count as bounce, may trip per-domain circuit
//   - success: clear any prior greylisting state for this domain
func (e *Engine) recordSendResult(mailbox, domain string, err error) {
	// Pre-send domain check skip: not an SMTP attempt. The Run loop
	// already `continue`s before reaching recordSendResult on this
	// path, but defend the invariant here too so a future caller can't
	// silently inflate daily caps / bounce counters by routing a
	// presend-skip result through this function.
	if IsPreSendDomainCheckSkip(err) {
		return
	}
	// AP1: warmup cap exceeded is a DB-side scheduling gate, not an SMTP error.
	// The mailbox already hit its daily cap; the trigger refused the INSERT.
	// Treat as a no-op for all counters so the cap is not double-counted and
	// the circuit breaker is not tripped on what is normal warmup behaviour.
	if IsWarmupCapError(err) {
		slog.Info("warmup cap reached, mailbox skipped for today",
			"op", "engine.recordSendResult/warmupCap",
			"mailbox", mailbox,
			"error", err)
		return
	}

	// AP1 (migration 079): status guard — mailbox is paused/auth_locked/retired.
	// The trigger rejected the INSERT because the mailbox is not active.
	// This is NOT a deliverability signal; skip without touching bounce counters
	// or the circuit breaker. Log a warning so the operator can investigate.
	if IsWarmupCapStatusGuardError(err) {
		slog.Warn("warmup cap status guard: mailbox inactive, skipping send",
			"op", "engine.recordSendResult/statusGuard",
			"mailbox", mailbox,
			"error", err)
		return
	}

	class := ClassifySMTPError(err)
	e.mu.Lock()
	defer e.mu.Unlock()

	// Rate-limit counter always increments on an attempt.
	e.sentCounts[mailbox]++
	e.domainCounts[domain]++
	e.totalSent++
	e.domainSent[domain]++

	metrics.SendTotal.Inc()
	metrics.DomainSendTotal.Inc(domain)

	switch class {
	case SMTPOK:
		// Clear any prior greylisting state — domain accepted us.
		delete(e.domainDeferredUntil, domain)
		delete(e.domainBackoffAttempt, domain)
		// Reset per-mailbox failure counters — a successful send proves the
		// mailbox is healthy and any prior transient issue has resolved.
		delete(e.mailboxConsecutiveFails, mailbox)
		delete(e.mailboxCooldownUntil, mailbox)
		metrics.SendSuccessTotal.Inc()
		// D2.3: Update mailbox registry counters.
		if e.registry != nil {
			goRegistryCall("RecordSuccess", mailbox, func() {
				e.registry.RecordSuccess(context.Background(), mailbox, time.Now())
			})
		}

	case SMTPTransient:
		metrics.SendGreylistedTotal.Inc()
		// Greylisting: do not count as bounce. Schedule retry backoff.
		attempt := e.domainBackoffAttempt[domain]
		if attempt >= maxGreylistingAttempts {
			// Escalate to permanent after too many transient failures —
			// this is a long-term policy rejection, not greylisting.
			e.domainBounces[domain]++
			e.bounceCount++
			metrics.SendBounceTotal.Inc()
			metrics.DomainBounceTotal.Inc(domain)
			slog.Error("greylisting budget exhausted, treating as permanent",
				"op", "engine.recordSendResult/transient", "domain", domain, "attempts", attempt)
		} else {
			backoff := greylistingBackoff(attempt)
			e.domainDeferredUntil[domain] = time.Now().Add(backoff)
			e.domainBackoffAttempt[domain] = attempt + 1
			slog.Info("greylisting deferral",
				"domain", domain, "attempt", attempt+1, "retry_in", backoff.String())
		}

	case SMTPPermanent:
		e.domainBounces[domain]++
		e.bounceCount++
		metrics.SendBounceTotal.Inc()
		metrics.DomainBounceTotal.Inc(domain)
		// D2.3: Update mailbox registry bounce counters and maybe auto-hold.
		if e.registry != nil {
			reason := "smtp_permanent"
			if err != nil {
				reason = err.Error()
			}
			goRegistryCall("RecordBounce", mailbox, func() {
				e.registry.RecordBounce(context.Background(), mailbox, reason)
			})
		}

	case SMTPUnknown:
		// Unclassified errors (TLS, auth, connection) — count as bounce for
		// conservative circuit-breaker tripping but do not apply backoff.
		e.domainBounces[domain]++
		e.bounceCount++
		metrics.SendBounceTotal.Inc()
		metrics.DomainBounceTotal.Inc(domain)
		// D2.3: Update mailbox registry bounce counters and maybe auto-hold.
		if e.registry != nil {
			reason := "smtp_unknown"
			if err != nil {
				reason = err.Error()
			}
			goRegistryCall("RecordBounce", mailbox, func() {
				e.registry.RecordBounce(context.Background(), mailbox, reason)
			})
		}
		// Per-mailbox cooldown: SMTPUnknown usually means the mailbox itself
		// is unreachable (bad creds, DNS flap, TLS handshake fail). After
		// `mailboxFailThreshold` consecutive failures, park the mailbox so
		// pickMailbox stops burning cycles on it until the cooldown elapses.
		e.mailboxConsecutiveFails[mailbox]++
		if e.mailboxConsecutiveFails[mailbox] >= mailboxFailThreshold {
			e.mailboxCooldownUntil[mailbox] = time.Now().Add(mailboxCooldown)
			slog.Warn("mailbox cooldown triggered",
				"op", "engine.recordSendResult/cooldown",
				"mailbox", mailbox,
				"consecutive_fails", e.mailboxConsecutiveFails[mailbox],
				"cooldown", mailboxCooldown.String())
		}
	}

	// Per-domain circuit breaker: after 10+ attempts to a domain, trip if
	// its bounce rate exceeds the global threshold.
	if ds := e.domainSent[domain]; ds > 10 {
		dRate := float64(e.domainBounces[domain]) / float64(ds)
		if dRate > e.safety.MaxBounceRate {
			if _, already := e.domainCircuitOpen[domain]; !already {
				e.domainCircuitOpen[domain] = time.Now()
				metrics.CircuitDomainOpen.Set(1, domain)
				slog.Error("domain circuit breaker open",
					"op", "engine.recordSendResult/domainCircuit",
					"domain", domain,
					"bounce_rate_pct", dRate*100,
					"max_bounce_rate_pct", e.safety.MaxBounceRate*100)
			}
		}
	}

	// Global circuit breaker (legacy — kept as last-resort safety net).
	if e.totalSent > 10 {
		bounceRate := float64(e.bounceCount) / float64(e.totalSent)
		metrics.BounceRate.Set(bounceRate)
		if bounceRate > e.safety.MaxBounceRate {
			e.circuitOpen = true
			metrics.CircuitGlobalOpen.Set(1)
			slog.Error("sender global circuit breaker open",
				"op", "engine.recordSendResult/globalCircuit",
				"bounce_rate_pct", bounceRate*100,
				"max_bounce_rate_pct", e.safety.MaxBounceRate*100)
		}
	}
}

// recordSend is kept for backwards compatibility with callers that treat
// any error as a bounce. New code should use recordSendResult.
//
// Deprecated: use recordSendResult for SMTP-code-aware accounting.
func (e *Engine) recordSend(mailbox, domain string, isBounce bool) {
	if isBounce {
		// Fabricate an SMTP-permanent error so the domain counters trip.
		e.recordSendResult(mailbox, domain, &simpleErr{msg: "bounce (unclassified)"})
		return
	}
	e.recordSendResult(mailbox, domain, nil)
}

type simpleErr struct{ msg string }

func (s *simpleErr) Error() string { return s.msg }

// goRegistryCall runs a fire-and-forget mailbox registry update with
// panic recovery. recordSendResult dispatches Record{Success,Bounce}
// asynchronously so the send loop is not blocked on a slow DB write —
// but a panic inside the registry layer (nil deref on a malformed
// mailbox row, etc.) would otherwise terminate the goroutine without
// surfacing in the engine's main loop, making the failure invisible
// until ops noticed bounce counters were stale.
func goRegistryCall(name, mailbox string, fn func()) {
	go func() {
		defer func() {
			if p := recover(); p != nil {
				slog.Error("registry call panic recovered",
					"op", "goRegistryCall/recover", "call", name, "mailbox", mailbox, "recover", p)
			}
		}()
		fn()
	}()
}

func (e *Engine) isCircuitOpen() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.circuitOpen
}

// ResetMailboxBreaker clears any per-mailbox cooldown and consecutive-failure
// count. Called by the watchdog daemon after a healing event ("AUTH probe
// passed", "proxy refreshed") so the engine can immediately re-attempt sends
// from this mailbox instead of waiting for the 30 min cooldown to elapse.
//
// BF-E2 — explicit half-open trigger. Without this, an operator who manually
// rotates a Seznam app password has to wait through the cooldown before the
// engine notices, even though the next send would succeed.
func (e *Engine) ResetMailboxBreaker(mailbox string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.mailboxCooldownUntil, mailbox)
	delete(e.mailboxConsecutiveFails, mailbox)
}

func (e *Engine) resetCountersIfNeeded() {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()

	// Hourly reset: domain-level rate-limit counters + per-domain circuit stats.
	// domainSent/domainBounces are reset together with domainCounts so the
	// circuit-breaker window is rolling-1h rather than lifetime (prevents the
	// map from growing without bound as new domains are contacted each hour).
	if now.Sub(e.lastReset) > time.Hour {
		e.domainCounts = make(map[string]int)
		e.domainSent = make(map[string]int)
		e.domainBounces = make(map[string]int)
		e.bounceCount = 0
		e.totalSent = 0
		// Global circuit reset: once the hourly bounce-rate window rolls
		// over, the engine must be eligible to send again. Without this
		// the global circuitOpen flag latched true forever — the Run loop
		// would sleep on isCircuitOpen() every minute with no path back to
		// false (only reset path was process restart, a real outage). If
		// the bounce conditions persist into the new window, the breaker
		// re-trips after the next 10 sends; otherwise the engine recovers
		// without operator intervention.
		if e.circuitOpen {
			slog.Info("sender global circuit breaker reset (hourly window rolled over)")
			e.circuitOpen = false
			metrics.CircuitGlobalOpen.Set(0)
		}
		e.lastReset = now
	}

	// Daily reset: per-mailbox sent counts. Evaluated against its OWN
	// timestamp (lastDailyReset), never the hourly one — otherwise the hourly
	// branch above, which sets e.lastReset = now, makes this check compare
	// now.Day() against now.Day() and silently skip the reset every day after
	// the first, pinning every mailbox at its cap until process restart.
	if now.Day() != e.lastDailyReset.Day() {
		e.sentCounts = make(map[string]int)
		e.lastDailyReset = now
	}

	// Prune expired ephemeral state to prevent unbounded map growth.
	// These entries are normally cleaned on success/timeout, but stale entries
	// accumulate for domains/mailboxes that never recover or are abandoned.
	for domain, until := range e.domainDeferredUntil {
		if now.After(until) {
			// Clear ONLY the expired deferral window. The per-domain attempt
			// counter MUST survive so the 15m→1h→4h→24h→permanent escalation
			// ladder keeps climbing across retries — the next retry reads it
			// (recordSendResult/SMTPTransient) to choose its backoff. Deleting
			// it here reset every domain to attempt 0 before each retry,
			// collapsing the ladder to a fixed 15-minute retry forever. The
			// counter is cleared only on a SUCCESSFUL send (SMTPOK above).
			delete(e.domainDeferredUntil, domain)
		}
	}
	for domain, openedAt := range e.domainCircuitOpen {
		if now.Sub(openedAt) >= time.Hour {
			delete(e.domainCircuitOpen, domain)
			metrics.CircuitDomainOpen.Delete(domain)
		}
	}
	for mb, until := range e.mailboxCooldownUntil {
		if now.After(until) {
			delete(e.mailboxCooldownUntil, mb)
			delete(e.mailboxConsecutiveFails, mb)
		}
	}
}

func buildMessage(from, to, subject, bodyPlain, bodyHTML string, headers map[string]string, messageID string) []byte {
	// Headers managed by humanize fingerprint are passed in the map.
	// We skip them when writing standard headers to avoid duplication.
	skip := map[string]bool{
		"Message-ID":                true,
		"Content-Type":              true,
		"Content-Transfer-Encoding": true,
		"MIME-Version":              true,
		"From":                      true,
		"To":                        true,
		"Subject":                   true,
		"Date":                      true,
	}

	// Strip CR/LF from every attacker-reachable header field. Without
	// this, a contact email or humanize fingerprint value containing
	// "\r\nBcc: ..." would smuggle extra headers through SMTP framing.
	// Applied to from/to/subject/messageID, the Date value, and every
	// custom header key+value.
	stripCRLF := strings.NewReplacer("\r", "", "\n", "").Replace

	subject = stripCRLF(subject)
	from = stripCRLF(from)
	to = stripCRLF(to)
	messageID = stripCRLF(messageID)

	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")

	// Use raw Message-ID if it already has angle brackets
	if strings.HasPrefix(messageID, "<") {
		b.WriteString("Message-ID: " + messageID + "\r\n")
	} else {
		b.WriteString("Message-ID: <" + messageID + ">\r\n")
	}

	// Date from headers (humanize fingerprint) or generate
	if d, ok := headers["Date"]; ok {
		b.WriteString("Date: " + stripCRLF(d) + "\r\n")
	}

	b.WriteString("MIME-Version: 1.0\r\n")

	// Custom headers (X-Mailer, List-Unsubscribe, etc.)
	// Key and value are both sanitized. A key is REJECTED outright (not
	// stripped) if it contains a CR/LF — otherwise a split key like
	// "B\r\ncc" would collapse to "Bcc" after stripping and forge a real
	// Bcc header. Values are stripped: CR/LF in a value can never
	// create a second header because the value ends at the first \r\n
	// written here.
	for k, v := range headers {
		if skip[k] {
			continue
		}
		// Reject keys containing any control character.
		if strings.ContainsAny(k, "\r\n") {
			continue
		}
		sk := k
		sv := stripCRLF(v)
		// A key that is empty, contains whitespace, or contains a
		// colon (which would turn the value into a second header) is
		// dropped — attacker-controlled garbage.
		if sk == "" || strings.ContainsAny(sk, ": \t") {
			continue
		}
		b.WriteString(sk + ": " + sv + "\r\n")
	}

	if bodyHTML != "" {
		// Multipart alternative: plain + HTML
		boundaryID := messageID
		if len(boundaryID) > 8 {
			boundaryID = boundaryID[:8]
		}
		boundary := "----=_Part_" + boundaryID
		b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
		b.WriteString("\r\n")

		// Plain text part
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
		b.WriteString("\r\n")
		b.WriteString(bodyPlain)
		b.WriteString("\r\n")

		// HTML part
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
		b.WriteString("\r\n")
		b.WriteString(bodyHTML)
		b.WriteString("\r\n")

		b.WriteString("--" + boundary + "--\r\n")
	} else {
		// Plain text only (no humanize)
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
		b.WriteString("\r\n")
		b.WriteString(bodyPlain)
	}

	return []byte(b.String())
}

// stripAngleBrackets normalizes a Message-ID for storage by removing the
// outer "<" / ">" the RFC 5322 header carries. Callers (inbound matcher,
// send_events.rfc_message_id INSERT) compare against this canonical form;
// keeping the brackets in DB would force every reader to TRIM them again.
func stripAngleBrackets(id string) string {
	id = strings.TrimSpace(id)
	id = strings.TrimPrefix(id, "<")
	id = strings.TrimSuffix(id, ">")
	return id
}

// generateMessageID builds an RFC 5322 Message-ID. Uses crypto/rand for
// unpredictability. On the theoretical kernel-failure path (crypto/rand
// unavailable), falls back to a timestamp-nanosecond-based ID — still unique
// per-send, just not unpredictable to external observers. Never panics;
// dropping a send because the kernel RNG hiccuped would be worse than losing
// a few bits of entropy for this one message.
func generateMessageID(fromAddr string) string {
	var buf [8]byte
	if _, err := randRead(buf[:]); err != nil {
		slog.Warn("crypto/rand unavailable, using nanosecond fallback for Message-ID", "op", "engine.generateMessageID", "error", err)
		now := time.Now().UnixNano()
		binary.BigEndian.PutUint64(buf[:], uint64(now))
	}
	domain := config.DomainFromEmail(fromAddr)
	return fmt.Sprintf("%x.%d@%s", buf[:], time.Now().UnixNano(), domain)
}

// randomDelay returns a cryptographically-random delay in [minSec, maxSec).
// On crypto/rand failure (theoretical), falls back to minSec — deterministic
// but safe. Panicking would take down the sender daemon; a predictable min
// delay is strictly better than process death.
func randomDelay(minSec, maxSec int) time.Duration {
	if maxSec <= minSec {
		return time.Duration(minSec) * time.Second
	}
	var buf [8]byte
	if _, err := randRead(buf[:]); err != nil {
		slog.Warn("crypto/rand unavailable, using minSec fallback for send delay", "op", "engine.randomDelay", "error", err, "min_sec", minSec)
		return time.Duration(minSec) * time.Second
	}
	n := binary.BigEndian.Uint64(buf[:])
	rangeSec := maxSec - minSec
	delay := minSec + int(n%uint64(rangeSec))
	return time.Duration(delay) * time.Second
}

// poissonDelay samples an inter-arrival time from the exponential distribution
// that underlies a Poisson process (inverse-CDF method: −mean·ln(U)).
// The result is clamped to [minSec, maxSec*3].
//
// When meanSec ≤ 0 the midpoint of [minSec, maxSec] is used as the mean so
// the function never panics or returns NaN.
func poissonDelay(meanSec float64, minSec, maxSec int) time.Duration {
	if meanSec <= 0 {
		meanSec = float64(minSec+maxSec) / 2.0
	}
	u := mrandFloat64()
	if u < 1e-9 {
		u = 1e-9 // prevent -Inf from math.Log(0)
	}
	delay := -meanSec * math.Log(u)
	if delay < float64(minSec) {
		delay = float64(minSec)
	}
	if delay > float64(maxSec)*3 {
		delay = float64(maxSec) * 3
	}
	return time.Duration(delay) * time.Second
}

// humanSendDelayConfig is the operator-tunable wrapper around
// humanSendDelay. Reads PoissonMeanSeconds / PoissonMinSeconds /
// PoissonMaxSeconds from the SendingConfig and falls back to the legacy
// MinDelaySeconds/MaxDelaySeconds when the new fields are unset (zero).
// The result is always >= the configured minimum and <= the configured
// maximum (no x3 expansion as the legacy clamp; production hard-cap
// matches operator intent).
func humanSendDelayConfig(s config.SendingConfig, now time.Time) time.Duration {
	min := s.PoissonMinSeconds
	if min <= 0 {
		min = s.MinDelaySeconds
	}
	max := s.PoissonMaxSeconds
	if max <= 0 {
		max = s.MaxDelaySeconds
	}
	mean := float64(s.PoissonMeanSeconds)
	if mean <= 0 {
		mean = float64(min+max) / 2.0
	}
	// Time-of-day factor still applies — humans reply faster in the
	// morning and slower at night. Keeps the legacy variance envelope
	// while moving the centre to the operator-configured mean.
	hour := now.Hour()
	var factor float64
	switch {
	case hour >= 8 && hour < 11:
		factor = 0.7
	case hour >= 13 && hour < 16:
		factor = 1.0
	case hour >= 11 && hour < 13:
		factor = 1.2
	default:
		factor = 1.4
	}
	return clampedPoisson(mean*factor, min, max)
}

// clampedPoisson samples an exponential delay (Poisson inter-arrival)
// and hard-clamps it to [minSec, maxSec]. Differs from poissonDelay
// (which expands the upper bound to maxSec*3 — heavy exponential tail).
// The hard-clamp variant matches operator expectation that
// POISSON_MAX_SECONDS is the absolute ceiling, never exceeded.
func clampedPoisson(meanSec float64, minSec, maxSec int) time.Duration {
	if meanSec <= 0 {
		meanSec = float64(minSec+maxSec) / 2.0
	}
	u := mrandFloat64()
	if u < 1e-9 {
		u = 1e-9
	}
	delay := -meanSec * math.Log(u)
	if delay < float64(minSec) {
		delay = float64(minSec)
	}
	if delay > float64(maxSec) {
		delay = float64(maxSec)
	}
	return time.Duration(delay) * time.Second
}

// humanSendDelay returns a delay that mimics human send patterns by sampling
// from an exponential (Poisson inter-arrival) distribution whose mean is
// scaled by a time-of-day factor.
//
// Time-of-day factors:
//   - 08:00–10:59 (morning peak)  → 0.7× — humans reply fastest
//   - 11:00–12:59 (pre-lunch)     → 1.2× — slightly slower
//   - 13:00–15:59 (afternoon)     → 1.0× — steady pace
//   - all other hours             → 1.8× — off-hours, much slower
//
// Result is drawn from poissonDelay which clamps to [minSec, maxSec*3].
func humanSendDelay(minSec, maxSec int, now time.Time) time.Duration {
	hour := now.Hour()
	var factor float64
	switch {
	case hour >= 8 && hour < 11:
		factor = 0.7 // morning peak — faster
	case hour >= 13 && hour < 16:
		factor = 1.0 // afternoon — normal
	case hour >= 11 && hour < 13:
		factor = 1.2 // pre-lunch — slightly slower
	default:
		factor = 1.8 // off-hours — much slower
	}
	mean := float64(minSec+maxSec) / 2.0 * factor
	return poissonDelay(mean, minSec, maxSec)
}
