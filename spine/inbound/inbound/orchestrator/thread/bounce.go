package thread

import (
	"regexp"
	"strings"
)

// BounceKind classifies the severity of a detected delivery failure.
type BounceKind string

const (
	// BounceNone means the message is not a bounce — the inbound flow
	// should fall through to regular reply classification.
	BounceNone BounceKind = ""

	// BounceHard is a permanent failure (5.x.x DSN code). The contact
	// should be suppressed: the mailbox does not exist, the domain has
	// no MX record, or the sender is blocked.
	BounceHard BounceKind = "hard"

	// BounceSoft is a transient failure (4.x.x DSN code). The sender
	// would normally retry. For consent-score purposes we still record
	// the event, but we don't flip the contact to permanently bounced.
	BounceSoft BounceKind = "soft"
)

// BounceInfo is the structured verdict produced by DetectBounce.
type BounceInfo struct {
	Kind         BounceKind
	DSNCode      string // RFC 3463 enhanced status code, e.g. "5.1.1"
	Diagnostic   string // First line of Diagnostic-Code, trimmed
	FailedRecipient string // From Final-Recipient / X-Failed-Recipients
}

// IsBounce returns true for hard or soft bounces.
func (b BounceInfo) IsBounce() bool {
	return b.Kind == BounceHard || b.Kind == BounceSoft
}

var (
	// mailerDaemonFrom matches the canonical RFC 3464 sender names.
	// Both "MAILER-DAEMON@host" and the historic "Mail Delivery Subsystem"
	// wording cover Postfix, Sendmail, Exim, Microsoft Exchange NDR,
	// Google Groups bounces, and Amazon SES DSNs.
	mailerDaemonFrom = regexp.MustCompile(`(?i)mailer-daemon|mail\s*delivery\s*(subsystem|system|service)|postmaster`)

	// bounceSubjectHint matches the most common subject lines in real
	// bounce messages. Kept aligned with inbound.go's
	// unmatchedBounceSubjectHint so the matched-thread gate (this file) and
	// the unmatched-thread classifier accept the same NDR subjects — most
	// notably Microsoft's "Undeliverable:" (NOT a substring of "undelivered")
	// and Seznam/Centrum's Czech "nedoručitelná". The body parse remains the
	// authoritative signal once the gate passes.
	bounceSubjectHint = regexp.MustCompile(`(?i)undeliverable|undelivered|nedoručitelná|returned\s+to\s+sender|delivery\s+(status|failure|notification|problem)|failure\s+notice|mail\s+delivery\s+(system|fail)|could\s+not\s+be\s+delivered|rejected:`)

	// dsnStatusLine captures an RFC 3464 "Status: X.Y.Z" line anywhere
	// in the body. We accept either numeric class (4.x.x transient,
	// 5.x.x permanent) and require exactly three dot-separated groups
	// so we don't trip on version numbers in signatures etc.
	dsnStatusLine = regexp.MustCompile(`(?mi)^\s*Status\s*:\s*([245]\.\d{1,3}\.\d{1,3})\s*$`)

	// diagnosticLine captures the Diagnostic-Code field for display.
	diagnosticLine = regexp.MustCompile(`(?mi)^\s*Diagnostic-Code\s*:\s*(?:smtp;\s*)?(.+)$`)

	// finalRecipientLine captures the recipient whose delivery failed.
	finalRecipientLine = regexp.MustCompile(`(?mi)^\s*Final-Recipient\s*:\s*(?:rfc822;\s*)?(.+?)\s*$`)

	// actionLine — "failed" means definitive failure, "delayed" is transient.
	actionLine = regexp.MustCompile(`(?mi)^\s*Action\s*:\s*(failed|delayed)\s*$`)
)

// DetectBounce inspects a raw inbound message and decides whether it
// represents a DSN bounce. The function is intentionally defensive:
// many MTAs produce near-valid DSNs, and a single heuristic signal is
// not enough to flip the contact status. We require at least:
//
//  1. A bouncer-looking From header (MAILER-DAEMON etc.), OR a bounce
//     subject line, OR an "X-Failed-Recipients" header — AND
//  2. A parseable "Status: X.Y.Z" line in the body.
//
// If both signals agree, the first digit of the DSN code decides
// hard vs soft.
func DetectBounce(raw RawInbound) BounceInfo {
	// Fast-path gate: the sender / subject must look bouncy.
	if !looksLikeBounceEnvelope(raw) {
		return BounceInfo{}
	}

	// Scan BodyPlain first, then fall back to the full RFC822 RawBytes. A
	// real multipart/report DSN keeps the Status:/Action:/Final-Recipient:
	// lines in a message/delivery-status part that mime.Parse files as an
	// attachment, and inbound.go overwrites BodyPlain with the human-readable
	// part before DetectBounce runs on the unmatched path — so the structured
	// fields are absent from BodyPlain even though the message is a genuine
	// DSN. RawBytes always carries the delivery-status part verbatim (it is
	// us-ascii / 7bit), so the regexes still match there. We pick a single
	// scan corpus so DSNCode, Diagnostic, FailedRecipient and Action are all
	// read from the same source. DSNs whose BodyPlain already contains the
	// Status line (plain-text NDRs, or a DSN with no human part) match on the
	// first pass and never touch RawBytes — no regression.
	scan := raw.BodyPlain
	status := dsnStatusLine.FindStringSubmatch(scan)
	if len(status) < 2 && len(raw.RawBytes) > 0 {
		scan = string(raw.RawBytes)
		status = dsnStatusLine.FindStringSubmatch(scan)
	}
	if len(status) < 2 {
		// No structured DSN body — some MTAs send plain-text NDR.
		// Fall back to class detection from the subject or body.
		return fallbackDetect(raw)
	}
	code := status[1]

	info := BounceInfo{
		DSNCode:         code,
		Diagnostic:      firstCapture(diagnosticLine, scan),
		FailedRecipient: firstCapture(finalRecipientLine, scan),
	}

	switch code[:1] {
	case "5":
		info.Kind = BounceHard
	case "4":
		info.Kind = BounceSoft
	}

	// Action: delayed downgrades a 5.x.x to soft (some MTAs report
	// 5.x.x during initial queuing), matching Postfix behaviour.
	if action := firstCapture(actionLine, scan); strings.EqualFold(action, "delayed") && info.Kind == BounceHard {
		info.Kind = BounceSoft
	}
	return info
}

// looksLikeBounceEnvelope is the gating heuristic — cheap enough to
// run on every inbound and specific enough to let regular replies fall
// through to the reply classifier.
func looksLikeBounceEnvelope(raw RawInbound) bool {
	if mailerDaemonFrom.MatchString(raw.From) {
		return true
	}
	if bounceSubjectHint.MatchString(raw.Subject) {
		return true
	}
	// RFC 3464 allows a top-level X-Failed-Recipients header even when
	// the From field is rewritten; we treat it as a strong hint.
	if strings.Contains(strings.ToLower(raw.BodyPlain), "x-failed-recipients") {
		return true
	}
	return false
}

// fallbackDetect handles NDR messages that lack a structured
// Status: field. We guess hard vs soft from subject-line phrasing.
// Best-effort — if nothing matches we return BounceNone.
//
// The hard-bounce keyword set is kept aligned with the unmatched-side
// classifier (inbound.go unmatchedBounceSubjectHint): "undeliverable"
// (Microsoft Outlook/Exchange NDR) and "nedoručitelná" (Seznam/Centrum)
// are first-class subjects, not just "undelivered".
func fallbackDetect(raw RawInbound) BounceInfo {
	subj := strings.ToLower(raw.Subject)
	body := strings.ToLower(raw.BodyPlain)
	switch {
	case strings.Contains(subj, "delayed") ||
		strings.Contains(body, "will retry") ||
		strings.Contains(body, "temporary failure"):
		return BounceInfo{Kind: BounceSoft, Diagnostic: strings.TrimSpace(raw.Subject)}
	case strings.Contains(subj, "undeliverable") ||
		strings.Contains(subj, "undelivered") ||
		strings.Contains(subj, "nedoručitelná") ||
		strings.Contains(subj, "returned to sender") ||
		strings.Contains(body, "user unknown") ||
		strings.Contains(body, "no such user") ||
		strings.Contains(body, "mailbox unavailable"):
		return BounceInfo{Kind: BounceHard, Diagnostic: strings.TrimSpace(raw.Subject)}
	}
	// A MAILER-DAEMON / postmaster envelope that reached fallbackDetect has
	// already cleared looksLikeBounceEnvelope but carries neither a parseable
	// Status: line nor a recognized phrase. It is still a delivery failure —
	// treat it as at least a soft bounce so the reply classifier is skipped
	// and the event is recorded, without permanently suppressing the contact
	// on a thin signal (a hard flip needs the DSN code or an explicit phrase).
	if mailerDaemonFrom.MatchString(raw.From) {
		return BounceInfo{Kind: BounceSoft, Diagnostic: strings.TrimSpace(raw.Subject)}
	}
	return BounceInfo{}
}

// firstCapture returns the first regex group captured on the first
// match, trimmed of surrounding whitespace. Returns "" on no match.
func firstCapture(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}
