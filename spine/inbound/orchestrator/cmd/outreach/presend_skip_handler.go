// Pre-send domain check skip handler (companion to
// services/campaigns/sender/presend.go).
//
// When sender.Engine.Run gates a send via the inline MX/A domain check
// it surfaces SendResult.Error = sender.ErrPreSendDomainCheck (wrapped
// with the reason in SMTPResponse). This file owns the DB-side
// consequences:
//
//  1. INSERT a failed send_events row with status='presend_skip' and
//     smtp_response carrying the gate reason (the orchestrator's
//     existing failure-path UPDATE would silently no-op because no row
//     exists yet for this campaign/contact/step on the first attempt).
//  2. UPDATE contacts SET email_status='invalid',
//     email_verification='pre_send_fail_<reason>' so the cohort
//     telemetry surfaces the wasted-send avoidance.
//  3. RevertFailedStep so the runner-side `in_flight` reservation is
//     released. The campaign loop's status guard then refuses to
//     re-enqueue an `email_status='invalid'` contact, so the skip is
//     terminal for that contact (no infinite retry).
//  4. audit.Log the skip so the operator audit trail captures it.
//
// HARD RULE traceability:
//   - feedback_audit_log_on_mutations (T0) — every UPDATE/INSERT emits
//     an operator_audit_log row in the same SQL session.
//   - feedback_engine_path_test (T0) — the gate fired inside Engine.Run;
//     this handler only persists the consequence.

package main

import (
	"context"
	"database/sql"
	"log/slog"
	"strconv"
	"strings"

	"campaigns/campaign"
	"campaigns/sender"
	"common/audit"
)

// actionPreSendDomainSkip is the audit.Log action emitted when the
// inline MX/A gate skips a contact. Defined here rather than in
// common/audit to keep the gate's vocabulary co-located with its
// handler. Operators querying operator_audit_log can filter on this
// value to count gated sends per campaign.
const actionPreSendDomainSkip = "contact.presend_domain_skip"

// handlePreSendDomainCheckSkip persists the four DB consequences of a
// pre-send domain check skip. Idempotent at the contact level (the
// contacts UPDATE matches by id; a second skip for the same contact
// no-ops because email_status is already 'invalid'). Best-effort: each
// failure is slog-warned but never propagated — the engine hot loop
// must continue regardless.
//
// Returns true when the handler ran (i.e. the result was a pre-send
// skip and the caller should NOT execute the legacy failure path).
// Returns false on a normal SMTP error so the caller falls through to
// the existing UPDATE send_events + RevertFailedStep logic.
func handlePreSendDomainCheckSkip(
	ctx context.Context,
	db *sql.DB,
	scope string,
	req sender.SendRequest,
	result sender.SendResult,
) bool {
	if !sender.IsPreSendDomainCheckSkip(result.Error) {
		return false
	}

	reason := extractPreSendReason(result.SMTPResponse)
	verification := "pre_send_fail_" + reason

	slog.Info("pre-send domain check skip persisted",
		"op", scope+"/preSendDomainCheck",
		"contact_id", req.ContactID,
		"campaign_id", req.CampaignID,
		"step", req.Step,
		"reason", reason,
		"recipient_domain", presendDomainOf(req.ToAddress))

	// 1) Failed send_events row. ON CONFLICT keeps re-runs idempotent
	// (status_idx exists in PROD per migration 026 — campaign+contact+step).
	if _, err := db.ExecContext(ctx, `
		INSERT INTO send_events (campaign_id, contact_id, step, mailbox_used, status, smtp_response, sent_at)
		VALUES ($1, $2, $3, $4, 'presend_skip', $5, now())
		ON CONFLICT DO NOTHING`,
		req.CampaignID, req.ContactID, req.Step, result.MailboxUsed, result.SMTPResponse); err != nil {
		slog.Warn("presend-skip send_events insert failed",
			"op", scope+"/preSendDomainCheck",
			"contact_id", req.ContactID, "error", err)
	}

	// 2) Contact row — mark email_status invalid so the campaign loop
	// stops re-enqueueing this address. Best-effort UPDATE; missing
	// columns log-warn but don't block.
	if _, err := db.ExecContext(ctx, `
		UPDATE contacts
		   SET email_status = 'invalid',
		       email_verification = $1,
		       updated_at = now()
		 WHERE id = $2`, verification, req.ContactID); err != nil {
		slog.Warn("presend-skip contacts update failed",
			"op", scope+"/preSendDomainCheck",
			"contact_id", req.ContactID, "error", err)
	}

	// 3) Release the runner-side `in_flight` reservation.
	if _, err := campaign.RevertFailedStep(ctx, db, req); err != nil {
		slog.Warn("presend-skip RevertFailedStep failed",
			"op", scope+"/preSendDomainCheck",
			"contact_id", req.ContactID, "error", err)
	}

	// 4) Audit log so operators see the skip in the canonical timeline.
	// Signature: ctx, db, action, actor, entityType, entityID, details.
	audit.Log(ctx, db,
		actionPreSendDomainSkip,
		"engine.preSendDomainCheck",
		"contact",
		strconv.FormatInt(req.ContactID, 10),
		map[string]any{
			"campaign_id": req.CampaignID,
			"step":        req.Step,
			"reason":      reason,
			"mailbox":     result.MailboxUsed,
		})

	return true
}

// extractPreSendReason pulls the bare reason out of an SMTPResponse of
// shape "presend-skip: <reason>". Falls back to "unknown" if the
// shape is unexpected — the audit row still lands, the operator just
// loses the structured suffix.
func extractPreSendReason(smtpResponse string) string {
	const prefix = "presend-skip: "
	if strings.HasPrefix(smtpResponse, prefix) {
		return strings.TrimSpace(smtpResponse[len(prefix):])
	}
	return "unknown"
}

// presendDomainOf is a defensive split for log-only use. Engine path
// already validates the address; this is just so the log line carries
// a useful label when the recipient is malformed.
func presendDomainOf(email string) string {
	at := strings.LastIndex(email, "@")
	if at < 0 || at == len(email)-1 {
		return ""
	}
	return strings.ToLower(email[at+1:])
}
