package sender

import (
	"errors"
	"net/textproto"
	"strings"
	"time"
)

// SMTPClass categorizes an SMTP error returned by the server.
type SMTPClass int

const (
	SMTPOK SMTPClass = iota
	// SMTPTransient — temporary failure; worth retrying later. Includes
	// greylisting (450/451), mailbox temporarily unavailable (452), and
	// server-too-busy (421). Standard RFC 5321 §4.2.1 semantics.
	SMTPTransient
	// SMTPPermanent — hard bounce (5xx). Do not retry; mark contact dead.
	SMTPPermanent
	// SMTPUnknown — error we cannot classify (connection error, auth failure,
	// client-side issue). Treated as retry-on-next-tick at most.
	SMTPUnknown
)

// ClassifySMTPError examines an error returned from the net/smtp package
// and maps it to its SMTP response class. When the server returns a proper
// reply code, the code is used directly. Otherwise heuristic string matching
// identifies common greylisting phrases from Czech/foreign MTAs.
//
// Anti-trace-relay typed errors are classified first (errors.Is on the
// sentinels in antitrace.go). The relay sits between us and the actual MTA,
// so its 429/network/HTTP errors should not be blamed on the recipient
// domain — they are relay-side conditions and should retry.
func ClassifySMTPError(err error) SMTPClass {
	if err == nil {
		return SMTPOK
	}
	// Anti-trace relay typed errors — handle before generic SMTP parsing
	// because these never produce textproto codes (HTTP layer).
	switch {
	case errors.Is(err, ErrAntiTraceRateLimited):
		// 429 from our relay — caller must back off; recipient is innocent.
		return SMTPTransient
	case errors.Is(err, ErrAntiTraceTransport):
		// Network/DNS/timeout reaching the relay — transient infra blip.
		return SMTPTransient
	case errors.Is(err, ErrAntiTraceHTTPStatus):
		// Non-2xx, non-429 from the relay. Could be 4xx (bad payload —
		// our bug) or 5xx (relay-side outage). Be conservative: treat as
		// transient so the send is retried after relay recovery, rather
		// than burning the contact as a permanent bounce. The relay code
		// owns the responsibility to surface persistent 4xx via Sentry.
		return SMTPTransient
	case errors.Is(err, ErrAntiTraceMarshal), errors.Is(err, ErrAntiTraceRequest):
		// Programmer error in request construction. Don't penalize the
		// recipient domain or the mailbox — surface as SMTPUnknown so
		// the cockpit captures it without bounce/greylist accounting.
		return SMTPUnknown
	}
	var te *textproto.Error
	if errors.As(err, &te) {
		if te.Code >= 400 && te.Code < 500 {
			return SMTPTransient
		}
		if te.Code >= 500 && te.Code < 600 {
			return SMTPPermanent
		}
		return SMTPUnknown
	}
	s := strings.ToLower(err.Error())
	// Seznam.cz and other Czech MTAs: "451 greylisting", "try again later",
	// "temporary failure". Check these before the generic 5xx substring.
	transientHints := []string{
		"greylist",
		"try again",
		"try later",
		"deferred",
		"temporarily",
		"temporary failure",
		"resources temporarily",
		"421 ",
		"450 ",
		"451 ",
		"452 ",
	}
	for _, hint := range transientHints {
		if strings.Contains(s, hint) {
			return SMTPTransient
		}
	}
	permanentHints := []string{
		"550 ",
		"551 ",
		"552 ",
		"553 ",
		"554 ",
		"mailbox unavailable",
		"user unknown",
		"no such user",
		"does not exist",
		"relay denied",
	}
	for _, hint := range permanentHints {
		if strings.Contains(s, hint) {
			return SMTPPermanent
		}
	}
	return SMTPUnknown
}

// greylistingBackoff returns the delay before the n-th retry attempt.
// Schedule: 15m, 1h, 4h, 24h. After 4 attempts we stop retrying — the
// domain is presumed to be rejecting via long-term policy, not greylist.
// This schedule is calibrated for Seznam.cz which often greylists first-time
// senders for 5-15 minutes but releases after a single successful retry.
func greylistingBackoff(attempt int) time.Duration {
	switch {
	case attempt <= 0:
		return 15 * time.Minute
	case attempt == 1:
		return 1 * time.Hour
	case attempt == 2:
		return 4 * time.Hour
	default:
		return 24 * time.Hour
	}
}

// maxGreylistingAttempts caps the number of retries before we treat a
// domain as permanently refusing. Calibrated for Czech greylisting policies
// that typically release within 15–60 minutes.
const maxGreylistingAttempts = 4
