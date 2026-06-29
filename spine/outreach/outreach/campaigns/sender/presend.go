package sender

// Pre-send domain check gate — inline MX (with A-record fallback) probe
// run inside Engine.Run between mailbox selection and the antiTrace.Send
// call. Goal: refuse to spend a relay submit on a domain whose DNS shape
// guarantees a bounce (no MX and no A — RFC 5321 §5.1).
//
// Reference: RFC 5321 §5.1 "Locating the Target Host" — the SMTP sender
// MUST query MX records first; if NONE exist, it MAY fall back to an
// implicit MX (the domain's A/AAAA record) at distance 0. Returning an
// empty MX RRset is an explicit "do not deliver here" per RFC 7505
// (null MX), which we treat as a definitive skip.
//
// HARD-RULE traceability:
//   - feedback_engine_path_test (T0) — hook lives in Engine.Run before
//     antiTrace.Send; never bypasses the engine.
//   - feedback_no_speculation (T0) — RFC 5321 §5.1 + RFC 7505 cited.
//   - feedback_audit_log_on_mutations (T0) — Engine surfaces the skip
//     via SendResult{Error: ErrPreSendDomainCheck} so the orchestrator's
//     onSent callback can perform the audit log + contacts UPDATE inside
//     the same tx as the failed send_events INSERT.
//   - feedback_no_magic_thresholds (T0) — DNS timeout, cache TTL,
//     cache-cap are package-level named constants.
//   - feedback_external_io_backoff (T0) — DNS calls run under a
//     context.WithTimeout so a single slow resolver cannot wedge the
//     engine; negative results are cached so we never retry a dead
//     domain inside the cache window.
//
// Issue: reply-pipeline-recovery / campaign-457 cohort (31199
// unverified contacts, ~4.6% bounce rate; target <1% post-gate).

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"
)

// Pre-send domain check tunables. Encoded as named constants per the
// no-magic-numbers rule. Operator can override at boot via
// WithPreSendDomainCheck(opts) if a campaign needs different pacing
// (e.g. a slower upstream resolver in a sandbox region).
const (
	// preSendDNSTimeout caps a single MX (or A-fallback) lookup. The
	// engine hot loop is per-mailbox sequential; a stuck resolver here
	// would block the whole queue. 5s is generous for any reachable
	// recursive resolver (Cloudflare 1.1.1.1, Google 8.8.8.8 both p99
	// well under 200ms in EU).
	preSendDNSTimeout = 5 * time.Second

	// preSendRCPTTimeout caps the optional level-2 RCPT TO probe. The
	// probe is gated behind opts.RCPTCheck and currently NOT wired into
	// the engine (level 1 alone gives the 4.6% → <1% win). Tightened to
	// 8s per spec — enough for an SMTP banner + EHLO + RCPT round trip
	// over the SOCKS5 relay.
	preSendRCPTTimeout = 8 * time.Second

	// preSendCacheTTL is the in-memory TTL for an MX/A result. 24h is
	// long enough that a 100k-contact campaign sees ~one lookup per
	// distinct recipient domain, short enough that a re-resolved
	// honeypot domain re-enters the gate next day.
	preSendCacheTTL = 24 * time.Hour

	// preSendCacheCap is the maximum number of distinct domains held in
	// the cache. Past this point oldest entries are evicted on insert.
	// Sized to fit the campaign-457 cohort (~6k distinct domains in
	// 31199 contacts) plus generous headroom.
	preSendCacheCap = 50_000
)

// ErrPreSendDomainCheck signals that the inline domain check refused
// the recipient. The engine surfaces this via SendResult.Error so the
// onSent callback can:
//
//  1. INSERT a failed send_events row (existing failure-path code).
//  2. UPDATE contacts SET email_status='invalid',
//     email_verification='pre_send_fail_<reason>'.
//  3. audit.Log the skip.
//
// The reason is appended to SendResult.SMTPResponse with the
// "presend-skip:" prefix so the callback can extract it without
// re-parsing the error string.
//
// Use errors.Is to detect this in callbacks. Engine.recordSendResult
// short-circuits on this sentinel — pre-send skips are NOT SMTP
// attempts and must not affect daily caps, per-mailbox cooldowns, or
// the bounce-rate circuit breaker.
var ErrPreSendDomainCheck = errors.New("pre-send: recipient domain check failed")

// IsPreSendDomainCheckSkip reports whether err is the pre-send domain
// check sentinel. Exported so the orchestrator-side onSent callback
// can branch on the skip without coupling to errors.Is gymnastics at
// every call site.
func IsPreSendDomainCheckSkip(err error) bool {
	return errors.Is(err, ErrPreSendDomainCheck)
}

// MXResolver is the minimal DNS surface the gate needs. The standard
// library (net.DefaultResolver) satisfies it; tests inject a stub that
// returns canned results so the suite stays hermetic and race-free.
//
// LookupMX MUST follow net.LookupMX semantics: returns the MX RRset
// (possibly empty) plus an error. For RFC 7505 "null MX" the slice is
// empty AND error is nil.
//
// LookupHost MUST follow net.LookupHost semantics: returns A/AAAA
// addresses for the host.
type MXResolver interface {
	LookupMX(ctx context.Context, domain string) ([]*net.MX, error)
	LookupHost(ctx context.Context, host string) ([]string, error)
}

// RecipientProbe is the level-2 RCPT TO surface. Implementations forward
// to the anti-trace-relay's /v1/verify endpoint (see
// services/contacts/validation/smtp_probe.SMTPProbeValidator) so direct
// SMTP egress stays banned per R6.
//
// Sprint AE (2026-05-14): wired for high-risk recipient domains
// surfaced by the AD bounce forensics — e.g. tiscali.cz where the MX
// record is valid but most addresses are stale (user-unknown SMTP
// reject). Level-1 MX gate cannot catch this; level-2 RCPT can.
//
// Return contract:
//   - (ok=true,  reason="valid"|...)  — relay confirmed RCPT accepted
//   - (ok=false, reason="invalid"|...) — relay confirmed RCPT refused
//   - (ok=true,  reason="unknown"|"verify_disabled"|...) — fail-OPEN
//     because we don't want a flaky probe to halt legit sends.
//
// err is the transport-level failure; treat as fail-OPEN (return ok=true).
type RecipientProbe interface {
	Validate(ctx context.Context, email string) (ok bool, reason string, err error)
}

// stdMXResolver wraps net.DefaultResolver to satisfy MXResolver in
// production. Constructed in NewPreSendDomainChecker(nil).
type stdMXResolver struct{}

func (stdMXResolver) LookupMX(ctx context.Context, domain string) ([]*net.MX, error) {
	return net.DefaultResolver.LookupMX(ctx, domain)
}

func (stdMXResolver) LookupHost(ctx context.Context, host string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, host)
}

// PreSendDomainChecker is the gate's stateful core: an MX resolver and
// a 24h-TTL per-domain result cache. Concurrency-safe; the engine hot
// loop can call Check from multiple goroutines (current implementation
// is single-goroutine but future per-mailbox shards are safe).
//
// Sprint AE additions:
//   - probe — optional RecipientProbe wired via opts.Probe. nil ⇒
//     level-2 disabled (every domain passes after level-1 MX gate).
//   - highRiskDomains — lowercased domain set; when non-empty AND the
//     domain matches AND probe != nil, the gate fires the RCPT probe
//     after level-1 MX passes. Empty set ⇒ probe never fires.
//   - emailCache — per-email verdict cache (24h TTL, same cap as the
//     domain cache). Distinct keyspace because RCPT verdicts are per
//     mailbox; user1@tiscali.cz may be invalid while user2@tiscali.cz
//     is valid.
type PreSendDomainChecker struct {
	resolver MXResolver

	cacheMu  sync.Mutex
	cache    map[string]preSendCacheEntry
	cacheCap int

	probe           RecipientProbe
	highRiskDomains map[string]struct{}
	emailCacheMu    sync.Mutex
	emailCache      map[string]preSendCacheEntry
}

// preSendCacheEntry is one cached MX/A verdict.
type preSendCacheEntry struct {
	ok     bool
	reason string
	at     time.Time
}

// PreSendDomainCheckOptions carries optional knobs. Zero value falls
// through to safe production defaults (stdlib resolver, default cache
// cap). Sprint AE (2026-05-14) added Probe + HighRiskDomains for
// level-2 RCPT TO probe gated on a configured high-risk domain set —
// operator data (campaign 457 forensics) showed tiscali.cz with valid
// MX but high SMTP user-unknown reject rate that level-1 cannot catch.
type PreSendDomainCheckOptions struct {
	Resolver  MXResolver
	CacheCap  int
	RCPTCheck bool // legacy boolean; replaced by HighRiskDomains+Probe pair

	// Probe runs the RCPT TO verification against the anti-trace-relay's
	// /v1/verify endpoint. nil ⇒ level-2 disabled. Wire via boot config
	// reading ANTI_TRACE_RELAY_URL + token.
	Probe RecipientProbe

	// HighRiskDomains is the lowercased domain set that triggers the
	// level-2 probe after level-1 MX passes. Empty set ⇒ probe never
	// fires (no domain qualifies as high-risk). Source: operator_settings
	// `presend_smtp_probe_high_risk_domains` (comma-separated).
	HighRiskDomains []string
}

// NewPreSendDomainChecker builds a checker. Pass nil to accept all
// defaults. Tests usually pass a stub resolver.
func NewPreSendDomainChecker(opts *PreSendDomainCheckOptions) *PreSendDomainChecker {
	if opts == nil {
		opts = &PreSendDomainCheckOptions{}
	}
	r := opts.Resolver
	if r == nil {
		r = stdMXResolver{}
	}
	cap := opts.CacheCap
	if cap <= 0 {
		cap = preSendCacheCap
	}
	highRisk := make(map[string]struct{}, len(opts.HighRiskDomains))
	for _, d := range opts.HighRiskDomains {
		d = strings.ToLower(strings.TrimSpace(d))
		if d != "" {
			highRisk[d] = struct{}{}
		}
	}

	return &PreSendDomainChecker{
		resolver:        r,
		cache:           make(map[string]preSendCacheEntry),
		cacheCap:        cap,
		probe:           opts.Probe,
		highRiskDomains: highRisk,
		emailCache:      make(map[string]preSendCacheEntry),
	}
}

// CheckResult is the outcome of a single domain check.
type CheckResult struct {
	OK     bool
	Reason string // empty when OK; one of: no_domain, malformed_email, empty_mx, no_mx_no_a
	Cached bool   // true when served from the in-memory cache
}

// Check runs the gate for one recipient email. Returns (OK=true) when
// the domain has at least one MX record OR an A-record fallback (RFC
// 5321 §5.1); else (OK=false, Reason=<code>). On lookup error with no
// A fallback the gate fails closed (OK=false, Reason="no_mx_no_a") —
// the conservative choice: a domain whose DNS is unresolvable cannot
// receive mail anyway.
//
// The check is parameterised on a context so a stuck resolver cannot
// wedge the engine. The caller is expected to pass a context that
// honours the engine's own ctx.Done() — Run wires this directly.
func (p *PreSendDomainChecker) Check(ctx context.Context, recipientEmail string) CheckResult {
	domain, ok := extractDomain(recipientEmail)
	if !ok {
		return CheckResult{OK: false, Reason: "malformed_email"}
	}
	if domain == "" {
		return CheckResult{OK: false, Reason: "no_domain"}
	}

	// Cache hit short-circuits both happy + unhappy paths so a cohort
	// with thousands of @same-domain contacts pays one DNS lookup.
	if entry, hit := p.cacheLookup(domain); hit {
		return CheckResult{OK: entry.ok, Reason: entry.reason, Cached: true}
	}

	// Bound the DNS roundtrip. The engine's context bounds the upper
	// limit; this timeout bounds the lower so one resolver hiccup
	// doesn't blow the whole engine tick.
	lookupCtx, cancel := context.WithTimeout(ctx, preSendDNSTimeout)
	defer cancel()

	mxRecords, mxErr := p.resolver.LookupMX(lookupCtx, domain)
	if mxErr == nil && len(mxRecords) > 0 {
		// At least one MX → deliverable per RFC 5321 §5.1. Cache OK.
		p.cacheStore(domain, true, "")
		// Level-2 gate: high-risk domain + probe wired → RCPT TO probe
		// per recipient. Cached per email (24h TTL) so the same address
		// pays one probe even across multi-step sequences.
		if p.shouldProbe(domain) {
			return p.runRecipientProbe(ctx, recipientEmail)
		}
		return CheckResult{OK: true}
	}

	// Two ways to get here:
	//   (a) mxErr == nil && len(mxRecords) == 0 — explicit null MX
	//       (RFC 7505) or NXDOMAIN-with-NoError-shape. Try A-record.
	//   (b) mxErr != nil — typically DNSError with IsNotFound or
	//       network failure. Per §5.1, the sender MAY fall back to an
	//       implicit MX (A/AAAA at distance 0). Try A-record.
	hostAddrs, hostErr := p.resolver.LookupHost(lookupCtx, domain)
	if hostErr == nil && len(hostAddrs) > 0 {
		p.cacheStore(domain, true, "")
		return CheckResult{OK: true}
	}

	// No MX, no A. Pick the reason by the original MX shape so logs
	// distinguish "domain returned empty MX RRset" (a deliberate "do
	// not mail us") from "domain is completely unresolvable".
	reason := "no_mx_no_a"
	if mxErr == nil && len(mxRecords) == 0 {
		reason = "empty_mx"
	}
	p.cacheStore(domain, false, reason)
	return CheckResult{OK: false, Reason: reason}
}

// cacheLookup returns the cached entry if present and unexpired.
func (p *PreSendDomainChecker) cacheLookup(domain string) (preSendCacheEntry, bool) {
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	entry, ok := p.cache[domain]
	if !ok {
		return preSendCacheEntry{}, false
	}
	if time.Since(entry.at) > preSendCacheTTL {
		delete(p.cache, domain)
		return preSendCacheEntry{}, false
	}
	return entry, true
}

// cacheStore writes a verdict. Evicts the oldest entry when at cap
// (simple O(n) scan — at cap=50000 this runs ~once per 50k domains,
// negligible vs DNS roundtrip).
func (p *PreSendDomainChecker) cacheStore(domain string, ok bool, reason string) {
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	if len(p.cache) >= p.cacheCap {
		// Evict oldest. Single pass — cheap relative to one DNS round.
		var oldestKey string
		var oldestAt time.Time
		for k, v := range p.cache {
			if oldestKey == "" || v.at.Before(oldestAt) {
				oldestKey = k
				oldestAt = v.at
			}
		}
		if oldestKey != "" {
			delete(p.cache, oldestKey)
		}
	}
	p.cache[domain] = preSendCacheEntry{ok: ok, reason: reason, at: time.Now()}
}

// CacheSize returns the current number of cached domain verdicts.
// Exported for tests + future operator surface.
func (p *PreSendDomainChecker) CacheSize() int {
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	return len(p.cache)
}

// EmailCacheSize returns the current number of cached per-email RCPT
// probe verdicts. Exported for tests + operator visibility.
func (p *PreSendDomainChecker) EmailCacheSize() int {
	p.emailCacheMu.Lock()
	defer p.emailCacheMu.Unlock()
	return len(p.emailCache)
}

// shouldProbe reports whether the domain is in the high-risk set and
// a probe client is wired. Both conditions must hold for level-2 to
// fire. Domain comparison is case-insensitive (set already lowercased
// at construction).
func (p *PreSendDomainChecker) shouldProbe(domain string) bool {
	if p.probe == nil || len(p.highRiskDomains) == 0 {
		return false
	}
	_, ok := p.highRiskDomains[domain]
	return ok
}

// runRecipientProbe executes the level-2 RCPT TO probe via the wired
// RecipientProbe + caches the verdict per email. Fail-OPEN contract:
// transport-level errors return OK=true (we don't let a flaky probe
// block legit sends). Only an explicit "invalid" verdict from the
// relay flips OK=false.
//
// preSendRCPTTimeout caps the probe RTT (existing constant, 8s).
func (p *PreSendDomainChecker) runRecipientProbe(ctx context.Context, email string) CheckResult {
	// Email-cache lookup short-circuits a repeated probe of the same
	// recipient (multi-step sequence pays one probe across follow-ups).
	if entry, hit := p.emailCacheLookup(email); hit {
		return CheckResult{OK: entry.ok, Reason: entry.reason, Cached: true}
	}

	probeCtx, cancel := context.WithTimeout(ctx, preSendRCPTTimeout)
	defer cancel()

	ok, reason, err := p.probe.Validate(probeCtx, email)
	if err != nil {
		// Transport error — fail-OPEN. Cache nothing so a flaky relay
		// auto-retries on the next send; an unreachable relay is its
		// own incident category and surfaces through other channels.
		slog.Warn("pre-send RCPT probe transport error — fail-open",
			"op", "engine.Run/preSendDomainCheck/rcptProbe",
			"recipient", email,
			"error", err)
		return CheckResult{OK: true, Reason: "probe_transport_error"}
	}

	// Only an explicit invalid flips. Unknown / verify_disabled →
	// fail-OPEN (treat as if probe was never wired). The relay returns
	// "valid" for OK, "invalid" for refused, "unknown" for anything
	// else.
	if !ok && reason == "invalid" {
		p.emailCacheStore(email, false, "rcpt_invalid")
		return CheckResult{OK: false, Reason: "rcpt_invalid"}
	}
	p.emailCacheStore(email, true, reason)
	return CheckResult{OK: true, Reason: reason}
}

// emailCacheLookup mirrors cacheLookup but for per-email verdicts.
func (p *PreSendDomainChecker) emailCacheLookup(email string) (preSendCacheEntry, bool) {
	p.emailCacheMu.Lock()
	defer p.emailCacheMu.Unlock()
	entry, ok := p.emailCache[email]
	if !ok {
		return preSendCacheEntry{}, false
	}
	if time.Since(entry.at) > preSendCacheTTL {
		delete(p.emailCache, email)
		return preSendCacheEntry{}, false
	}
	return entry, true
}

// emailCacheStore mirrors cacheStore with the same oldest-evict semantic.
// Per-email cache shares the cap budget with the domain cache (each map
// is bounded independently — operator can pre-size both via opts.CacheCap).
func (p *PreSendDomainChecker) emailCacheStore(email string, ok bool, reason string) {
	p.emailCacheMu.Lock()
	defer p.emailCacheMu.Unlock()
	if len(p.emailCache) >= p.cacheCap {
		var oldestKey string
		var oldestAt time.Time
		for k, v := range p.emailCache {
			if oldestKey == "" || v.at.Before(oldestAt) {
				oldestKey = k
				oldestAt = v.at
			}
		}
		if oldestKey != "" {
			delete(p.emailCache, oldestKey)
		}
	}
	p.emailCache[email] = preSendCacheEntry{ok: ok, reason: reason, at: time.Now()}
}

// extractDomain returns the lowercased part after "@". Returns
// ok=false on a malformed email (missing @, multiple unquoted @,
// empty local-part, empty domain, whitespace anywhere). Per RFC 5321
// §4.1.2 the local-part is case-sensitive but the domain is not — we
// normalise to lower so cache lookups are domain-agnostic to recipient
// case.
//
// This is intentionally stricter than RFC 5321 ABNF (which permits
// quoted-string local-parts containing "@"): a quoted "@" inside the
// local-part of a B2B campaign target is so vanishingly rare that we
// treat anything with multiple "@" as garbage and skip the contact.
// Operators recover the rare edge case by manually cleansing the row.
func extractDomain(email string) (string, bool) {
	email = strings.TrimSpace(email)
	if email == "" {
		return "", false
	}
	// Multiple "@" → reject as malformed. catches "a@b@c" garbage.
	if strings.Count(email, "@") != 1 {
		return "", false
	}
	at := strings.IndexByte(email, '@')
	if at <= 0 || at == len(email)-1 {
		return "", false
	}
	local := email[:at]
	if local == "" {
		return "", false
	}
	domain := strings.ToLower(email[at+1:])
	// Reject whitespace anywhere in the domain — catches garbage like
	// "user@ exa mple.com" or trailing-space copy-paste artefacts.
	if strings.ContainsAny(domain, " \t\n") {
		return "", false
	}
	return domain, true
}

// preSendSkipResult builds the SendResult for a gated send. Embeds the
// reason in SMTPResponse with the "presend-skip:" prefix the
// orchestrator callback parses for the contacts.email_verification
// column ("pre_send_fail_<reason>").
func preSendSkipResult(mailbox, reason string) SendResult {
	return SendResult{
		MailboxUsed:  mailbox,
		SMTPResponse: fmt.Sprintf("presend-skip: %s", reason),
		Error:        fmt.Errorf("%w: %s", ErrPreSendDomainCheck, reason),
		SentAt:       time.Now(),
	}
}

// logPreSendSkip emits the operator-visible structured log for one
// gated send. Slog op convention matches the rest of engine.go (see
// docs/playbooks/slog-conventions.md).
func logPreSendSkip(mailbox, recipient, reason string, cached bool) {
	slog.Info("pre-send domain check skip",
		"op", "engine.Run/preSendDomainCheck",
		"mailbox", mailbox,
		"recipient", recipient,
		"reason", reason,
		"cached", cached)
}
