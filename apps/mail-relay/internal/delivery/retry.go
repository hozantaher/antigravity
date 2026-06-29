package delivery

import (
	"errors"
	"fmt"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// SMTP reply-code classification (RFC 5321 §4.2).
//
//	2xx — positive completion (success).
//	4xx — transient negative completion (client may retry later).
//	5xx — permanent negative completion (do not retry without operator change).
//
// We retry only on 4xx codes that match the transient catalog below. 2xx
// is success and never reaches the classifier; 5xx is always non-retryable.
//
// Source: RFC 5321 §4.2.1 (theory of reply codes) + §4.5.5 (specific transient
// codes used in practice). The list below intentionally enumerates the exact
// 4xx codes Czech B2B mail servers emit on greylisting / rate-limit; an
// uncatalogued 4xx code falls back to "transient = false" so we do not
// over-retry on it (defensive default). A codeless error (no SMTP reply at all
// — connect/TLS/timeout/pool failure) is handled separately in
// IsTransientSMTPError and defaults to transient.
var transientSMTPCodes = map[int]struct{}{
	421: {}, // <domain> Service not available, closing transmission channel
	450: {}, // Requested mail action not taken: mailbox unavailable (greylist)
	451: {}, // Requested action aborted: local error in processing
	452: {}, // Requested action not taken: insufficient system storage
	454: {}, // Temporary authentication failure (RFC 4954 §6)
	458: {}, // Unable to queue messages for node (extended)
}

// IsTransientSMTPError reports whether err warrants a retry. Returns
// (transient, code) where code is the RFC 5321 reply code (0 when the error
// carries no SMTP reply, e.g. a pure transport failure).
//
// Classification:
//   - code == 0 (no SMTP reply): transient. At the relay's connect/egress
//     layer the dominant failures carry no SMTP code — dial "connection
//     refused" / "i/o timeout" to the wgsocks bridge, TLS handshake failure,
//     "context deadline exceeded", and wgpool quarantine/exhaustion
//     (ErrAllQuarantined / ErrPoolExhausted / ErrPinnedEndpointQuarantined).
//     The message was never handed to the recipient MTA, so retrying cannot
//     duplicate it; MaxAttempts bounds the loop. (A message accepted at
//     end-of-DATA whose QUIT then errors is converted to success in smtp.go,
//     so no post-acceptance error reaches this classifier.)
//   - 5xx: permanent, never retry.
//   - 4xx: retry only when the code is in the explicit transient catalog;
//     an uncatalogued 4xx falls back to (false, code) (no over-retry).
//   - anything else (e.g. 3xx): (false, code).
//
// The reply code is read from its authoritative source via smtpReplyCode (the
// *textproto.Error carried by net/smtp), not by scanning the wrapped message
// text — so an interpolated recipient address can never be misread as the code.
func IsTransientSMTPError(err error) (bool, int) {
	if err == nil {
		return false, 0
	}
	code := smtpReplyCode(err)
	if code == 0 {
		// No SMTP reply present: a transport-layer (connect/TLS/timeout/pool)
		// failure that is transient by nature. Default to retryable.
		return true, 0
	}
	if code >= 500 {
		return false, code
	}
	if code >= 400 {
		_, ok := transientSMTPCodes[code]
		return ok, code
	}
	return false, code
}

// smtpReplyCode returns the SMTP reply code carried by err, or 0 when none can
// be determined.
//
// net/smtp surfaces a protocol reply as *textproto.Error (exported Code field);
// we read that code directly via errors.As so an interpolated recipient address
// in an outer wrap (e.g. "rcpt to nakup@stavebniny365.cz: ...") can never be
// misread as the reply code. Only when no structured reply is present (a pure
// transport error, or a test double built with fmt.Errorf) do we fall back to a
// best-effort scan for the leading 3-digit code in the message text.
func smtpReplyCode(err error) int {
	var te *textproto.Error
	if errors.As(err, &te) {
		return te.Code
	}
	return extractSMTPCode(err.Error())
}

// extractSMTPCode finds the first 3-digit number that looks like an SMTP
// reply code in the message. Returns 0 if none found.
//
// Tolerant of common wrapping: leading text ("delivery failed: rcpt to: 421
// ..."), surrounding punctuation, and multi-line replies. Skips numbers that
// are not exactly 3 digits or are not in the SMTP code range (200..599).
func extractSMTPCode(msg string) int {
	for i := 0; i+3 <= len(msg); i++ {
		// Must be at the start of the string, or preceded by a non-digit
		// (so we don't grab the tail of a longer number like "12345").
		if i > 0 {
			prev := rune(msg[i-1])
			if unicode.IsDigit(prev) {
				continue
			}
		}
		if !isAllDigits(msg[i : i+3]) {
			continue
		}
		// Must be followed by a non-digit (so we don't read part of a
		// longer integer; SMTP codes are exactly 3 digits).
		if i+3 < len(msg) && unicode.IsDigit(rune(msg[i+3])) {
			continue
		}
		n, err := strconv.Atoi(msg[i : i+3])
		if err != nil {
			continue
		}
		if n >= 200 && n <= 599 {
			return n
		}
	}
	return 0
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return s != ""
}

// RetryConfig governs auto-retry behavior for transient SMTP failures.
//
// Defaults match the AW7-5 sprint design: 3 attempts max, exponential
// backoff 5m / 15m / 60m. Operator can override via env:
//
//	RELAY_GREYLIST_RETRY_ENABLED  (default 1)  — feature flag
//	RELAY_GREYLIST_RETRY_MAX      (default 3)  — total attempts (incl. first)
//	RELAY_GREYLIST_RETRY_BACKOFF  (default "5m,15m,60m") — delay before
//	                                                       attempt N+1
//
// MaxAttempts is the total attempt budget per envelope (first attempt + retries).
// Backoff[i] is the wait *before* attempt i+1 (so Backoff[0] is the wait
// between attempt 1's failure and attempt 2). Backoff length must equal
// MaxAttempts-1 or longer; extra entries beyond MaxAttempts-1 are ignored.
type RetryConfig struct {
	Enabled     bool
	MaxAttempts int
	Backoff     []time.Duration
}

// DefaultRetryConfig returns the sprint AW7-5 defaults.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		Enabled:     true,
		MaxAttempts: 3,
		Backoff:     []time.Duration{5 * time.Minute, 15 * time.Minute, 60 * time.Minute},
	}
}

// LoadRetryConfigFromEnv reads RELAY_GREYLIST_RETRY_* env vars and overlays
// them on the defaults. Invalid values fall back to defaults silently — this
// is a hot-path configuration that must never block startup; misconfiguration
// is logged by the caller via cfg.Validate.
func LoadRetryConfigFromEnv() RetryConfig {
	cfg := DefaultRetryConfig()
	// envconfig-allowed: bootstrap-time configuration loading (called from cmd/relay/main.go).
	if v := strings.TrimSpace(os.Getenv("RELAY_GREYLIST_RETRY_ENABLED")); v != "" {
		cfg.Enabled = !(v == "0" || strings.EqualFold(v, "false") || strings.EqualFold(v, "no"))
	}
	// envconfig-allowed: bootstrap-time configuration loading.
	if v := strings.TrimSpace(os.Getenv("RELAY_GREYLIST_RETRY_MAX")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 20 {
			cfg.MaxAttempts = n
		}
	}
	// envconfig-allowed: bootstrap-time configuration loading.
	if v := strings.TrimSpace(os.Getenv("RELAY_GREYLIST_RETRY_BACKOFF")); v != "" {
		if parsed, err := ParseBackoffSpec(v); err == nil && len(parsed) > 0 {
			cfg.Backoff = parsed
		}
	}
	return cfg
}

// ParseBackoffSpec parses a comma-separated list of Go durations (e.g.
// "5m,15m,60m") into a slice of time.Duration. Returns an error on the
// first malformed token; partial results are not returned.
func ParseBackoffSpec(spec string) ([]time.Duration, error) {
	parts := strings.Split(spec, ",")
	out := make([]time.Duration, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		d, err := time.ParseDuration(p)
		if err != nil {
			return nil, fmt.Errorf("backoff token %q: %w", p, err)
		}
		if d <= 0 {
			return nil, fmt.Errorf("backoff token %q: must be positive", p)
		}
		out = append(out, d)
	}
	if len(out) == 0 {
		return nil, errors.New("empty backoff spec")
	}
	return out, nil
}

// BackoffFor returns the wait duration before retry attempt n+1 (1-indexed
// caller-side: pass attempts=1 to get the wait after the first failed
// attempt). When n exceeds the configured slice, the last entry is reused
// (capped exponential backoff).
//
// Returns 0 when the config is disabled or n is out of range (n < 1).
func (c RetryConfig) BackoffFor(attempts int) time.Duration {
	if !c.Enabled || attempts < 1 {
		return 0
	}
	if len(c.Backoff) == 0 {
		return 0
	}
	idx := attempts - 1
	if idx >= len(c.Backoff) {
		idx = len(c.Backoff) - 1
	}
	return c.Backoff[idx]
}

// ShouldRetry returns true when the (attempts, err) pair indicates a
// retryable transient failure under the current configuration.
//
//   - Disabled flag → never retry.
//   - attempts >= MaxAttempts → max budget reached, fail permanently.
//   - err must classify as transient via IsTransientSMTPError.
//
// attempts is the attempt count *that just failed* (1 = first attempt
// failed, so we may retry once more). The boolean ok is true exactly
// when the caller should re-queue with delay = BackoffFor(attempts).
func (c RetryConfig) ShouldRetry(attempts int, err error) (ok bool, code int) {
	if !c.Enabled {
		return false, 0
	}
	if attempts < 1 || attempts >= c.MaxAttempts {
		// attempts==MaxAttempts means we just failed our last allowed
		// retry; do not re-queue.
		transient, c2 := IsTransientSMTPError(err)
		_ = transient
		return false, c2
	}
	transient, code := IsTransientSMTPError(err)
	if !transient {
		return false, code
	}
	return true, code
}
