// Duplicate-send skip handler (companion to
// services/campaigns/sender/sendclaim.go, migration 171 send_claims).
//
// When the exactly-once send-claim gate in sender.Engine.Run decides a send is
// a duplicate it surfaces SendResult.Error = sender.ErrDuplicateAlreadySent or
// sender.ErrDuplicateInFlight. This file owns the DB-side consequence in the
// orchestrator onSent callback — it mirrors handlePreSendDomainCheckSkip.
//
//   - ErrDuplicateAlreadySent: a confirmed prior 'sent' claim exists. The
//     message was already delivered (a prior attempt, or the other send path),
//     so we FinalizeSentStep the contact — advancing its reservation exactly as
//     a real success would — WITHOUT inserting a duplicate send_events row.
//   - ErrDuplicateInFlight: another sender holds a fresh 'claiming' lease. We
//     neither finalize (the holder may still fail) nor revert (would fight the
//     holder); we leave the contact in_flight. The holder finalizes it, or the
//     stale-claim reaper recovers it. No duplicate either way.
//
// HARD RULE traceability:
//   - feedback_audit_log_on_mutations (T0) — a duplicate-prevented event is
//     rare and operator-relevant; we audit.Log it.

package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strconv"

	"campaigns/campaign"
	"campaigns/sender"
	"common/audit"
)

// actionDuplicateSendPrevented is the audit.Log action emitted when the
// exactly-once gate suppresses a send. Operators filter operator_audit_log on
// this value to count prevented duplicates per campaign.
const actionDuplicateSendPrevented = "contact.duplicate_send_prevented"

// handleDuplicateSendSkip persists the consequence of a send-claim skip.
// Returns true when the result was a duplicate skip (caller must NOT run the
// legacy success/failure path), false on a normal result so the caller falls
// through to the existing logic.
func handleDuplicateSendSkip(
	ctx context.Context,
	db *sql.DB,
	scope string,
	req sender.SendRequest,
	result sender.SendResult,
) bool {
	switch {
	case errors.Is(result.Error, sender.ErrDuplicateAlreadySent):
		slog.Info("duplicate send prevented — already sent, finalizing contact",
			"op", scope+"/dupSkipAlreadySent",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"step", req.Step)
		// The message WAS sent — advance the contact's reservation so it is
		// not left dangling in_flight. No send_events INSERT (would duplicate).
		if _, err := campaign.FinalizeSentStep(ctx, db, req); err != nil {
			slog.Warn("dup-skip FinalizeSentStep failed",
				"op", scope+"/dupSkipAlreadySent",
				"contact_id", req.ContactID, "error", err)
		}
		auditDuplicatePrevented(ctx, db, req, "already_sent")
		return true

	case errors.Is(result.Error, sender.ErrDuplicateInFlight):
		slog.Info("duplicate send skipped — in-flight elsewhere, leaving in_flight",
			"op", scope+"/dupSkipInFlight",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"step", req.Step)
		auditDuplicatePrevented(ctx, db, req, "in_flight_elsewhere")
		return true
	}
	return false
}

func auditDuplicatePrevented(ctx context.Context, db *sql.DB, req sender.SendRequest, reason string) {
	audit.Log(ctx, db,
		actionDuplicateSendPrevented,
		"engine.sendClaim",
		"contact",
		strconv.FormatInt(req.ContactID, 10),
		map[string]any{
			"campaign_id": req.CampaignID,
			"step":        req.Step,
			"reason":      reason,
		})
}
