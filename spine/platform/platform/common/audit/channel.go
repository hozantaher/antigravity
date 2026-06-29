package audit

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/mail"
	"strings"
)

// Channel direction constants. Phase 1 covers email; whatsapp / portal_event
// reservations live in the migration 019 schema for Phase 2.
const (
	ChannelEmail        = "email"
	DirectionOutbound   = "outbound"
	DirectionInbound    = "inbound"
)

// LogChannel records one channel event in `channel_audit_log` (migration 019).
// Best-effort: failures are slog-warned, never returned. Callers MUST NOT
// gate the send/receive path on this write — the contract per the audit
// consolidation review (#4) is that audit writes never abort hot paths.
//
// Inputs:
//   - channel       — free-form ("email" today; whatsapp/portal_event Phase 2).
//   - direction     — "outbound" or "inbound".
//   - subjectEmail  — data subject's email; passed through normaliseEmail
//                     (lower-cased, address-only). Empty string → NULL row.
//   - messageID     — RFC 5322 Message-ID; empty stored as NULL.
//   - details       — extra JSON metadata (campaign_id, mailbox, etc.).
//
// db may be nil — returns silently. This mirrors audit.Log's contract so
// read-only Runner variants and dry-run paths can call LogChannel without
// branching at every site.
func LogChannel(
	ctx context.Context,
	db Execer,
	channel, direction, subjectEmail, messageID string,
	details map[string]any,
) {
	if db == nil {
		return
	}

	detailsJSON := json.RawMessage("{}")
	if len(details) > 0 {
		if data, err := json.Marshal(details); err == nil {
			detailsJSON = data
		}
	}

	// Normalise subject_email so the schema's partial index
	// `WHERE subject_email IS NOT NULL` and the DSR cascade UNION reads
	// match deterministically on lower-cased addresses.
	normalised := normaliseEmail(subjectEmail)
	var subjectArg any
	if normalised == "" {
		subjectArg = nil
	} else {
		subjectArg = normalised
	}

	var msgArg any
	if strings.TrimSpace(messageID) == "" {
		msgArg = nil
	} else {
		msgArg = messageID
	}

	_, err := db.ExecContext(ctx, `
		INSERT INTO channel_audit_log
		    (channel, direction, subject_email, message_id, details)
		VALUES ($1, $2, $3, $4, $5)
	`, channel, direction, subjectArg, msgArg, string(detailsJSON))
	if err != nil {
		slog.Warn("channel audit log write failed",
			"op", "audit.LogChannel/exec",
			"channel", channel,
			"direction", direction,
			"error", err)
	}
}

// normaliseEmail extracts the address-only form from a possibly-decorated
// header value (e.g. `"Jan Novák" <jan@example.com>`) and lower-cases it.
// Returns "" when the input has no usable address — the caller stores NULL
// in that case. Per memory feedback_no_speculation: net/mail.ParseAddress
// is the RFC 5322 reference; we don't roll our own parser.
func normaliseEmail(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if addr, err := mail.ParseAddress(s); err == nil && addr.Address != "" {
		return strings.ToLower(addr.Address)
	}
	// Fallback: the input may already be a bare address that ParseAddress
	// fails on (rare — only when angle brackets are unbalanced). If it
	// looks like one (single @, no spaces, no <>), accept lower-cased.
	if !strings.ContainsAny(s, " <>\"") && strings.Count(s, "@") == 1 {
		return strings.ToLower(s)
	}
	return ""
}
