package relay

import (
	"context"
	"errors"
	"net"
	"strconv"
	"strings"

	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
)

// FailureDiagnosis holds the structured classification of a relay failure.
type FailureDiagnosis struct {
	Class       string // timeout, canceled, tls_required, config, auth_config, auth_failed, tls_failed, dns_failed, rejected, deferred, transport_failed, delivery_failed
	Disposition string // retryable, terminal
	Reason      string // original error message
}

// ClassifyError analyzes a relay error and returns a structured diagnosis.
func ClassifyError(err error) FailureDiagnosis {
	class, disposition := classifyFailure(err)
	return FailureDiagnosis{
		Class:       class,
		Disposition: disposition,
		Reason:      err.Error(),
	}
}

// RelayWithDiagnostics attempts to relay a message and automatically records
// a failure diagnosis if the relay fails. Returns the attempt (success or failure),
// the message record (on success), and the original error (if any).
func (s *Service) RelayWithDiagnostics(ctx context.Context, submissionID string, msg model.SanitizedMessage) (model.RelayAttempt, model.MessageRecord, error) {
	attempt, record, err := s.Relay(ctx, submissionID, msg)
	if err == nil {
		return attempt, record, nil
	}

	diag := ClassifyError(err)
	failedAttempt, recordErr := s.RecordFailure(ctx, submissionID, msg, diag.Class, diag.Disposition, diag.Reason)
	if recordErr != nil {
		return model.RelayAttempt{}, model.MessageRecord{}, recordErr
	}
	return failedAttempt, model.MessageRecord{}, err
}

// classifyFailure determines the failure class and disposition from an error.
func classifyFailure(err error) (string, string) {
	// Sentinel errors first (exact match)
	var netErr net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout", "retryable"
	case errors.Is(err, context.Canceled):
		return "canceled", "terminal"
	case errors.Is(err, mail.ErrSMTPSTARTTLSRequired):
		return "tls_required", "terminal"
	case errors.Is(err, mail.ErrSMTPHostRequired):
		return "config", "terminal"
	case errors.Is(err, mail.ErrSMTPCredentialsIncomplete):
		return "auth_config", "terminal"
	case errors.As(err, &netErr) && netErr.Timeout():
		return "timeout", "retryable"
	}

	// String-based classification for wrapped or unknown errors.
	// Run before numeric SMTP code extraction so semantic keywords (auth, tls, dns)
	// take priority over raw numeric code ranges.
	msg := strings.ToLower(strings.TrimSpace(err.Error()))

	if strings.Contains(msg, "starttls") && strings.Contains(msg, "required") {
		return "tls_required", "terminal"
	}

	switch {
	case strings.Contains(msg, "auth"):
		if strings.Contains(msg, "config") || strings.Contains(msg, "incomplete") {
			return "auth_config", "terminal"
		}
		return "auth_failed", "terminal"
	case strings.Contains(msg, "tls"):
		return "tls_failed", "terminal"

	// DNS failures
	case strings.Contains(msg, "no such host"),
		strings.Contains(msg, "nxdomain"),
		strings.Contains(msg, "no mx"),
		strings.Contains(msg, "dns lookup"),
		strings.Contains(msg, "server misbehaving"):
		return "dns_failed", "terminal"

	case strings.Contains(msg, "refused"),
		strings.Contains(msg, "reset"),
		strings.Contains(msg, "unreachable"),
		strings.Contains(msg, "dial tcp"),
		strings.Contains(msg, "temporary"),
		strings.Contains(msg, "timeout"):
		return "transport_failed", "retryable"

	case strings.Contains(msg, "host") && strings.Contains(msg, "required"):
		return "config", "terminal"
	}

	// Attempt proper SMTP numeric code extraction for bare numeric responses
	// that did not match any semantic keyword above.
	if smtpCode := extractSMTPCode(err); smtpCode != 0 {
		switch {
		case smtpCode >= 500 && smtpCode < 600:
			return "rejected", "terminal"
		case smtpCode >= 400 && smtpCode < 500:
			return "deferred", "retryable"
		}
	}

	return "delivery_failed", "terminal"
}

// extractSMTPCode extracts the leading 3-digit SMTP response code from an error
// message, returning 0 if the error does not begin with a valid numeric code.
func extractSMTPCode(err error) int {
	s := err.Error()
	if len(s) >= 3 {
		if code, parseErr := strconv.Atoi(s[:3]); parseErr == nil {
			return code
		}
	}
	return 0
}
