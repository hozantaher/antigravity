// AW7-4 — engine panic atomic rollback (sister sprint to AW7 PR #1186 +
// AW6-2 PR #1194).
//
// Problem statement:
//
//	The runner reserves contacts with status='in_flight' before enqueueing
//	to the sender engine. The engine's onSent callback finalizes
//	(in_flight -> in_sequence/completed) on success or reverts
//	(in_flight -> pending) on failure. AW6-2 cycle-2 identified the gap:
//	if the callback panics mid-call (nil deref in audit, malformed
//	template, panic in PreSendHook, surprise in recordOutboundToThread)
//	the panic propagates to the engine.Run goroutine. The outer
//	defer recover() at main.go catches it, but the callback never
//	reaches FinalizeSentStep / RevertFailedStep. The contact stays
//	`in_flight` indefinitely — until either an operator manually flips
//	it back, or the AW7-3 watchdog reaper finally lands.
//
// Solution:
//
//	wrapSendCallbackWithRecover wraps the user-supplied onSent callback
//	with an inner defer recover(). When the inner callback panics, the
//	wrapper:
//	  1. Logs the recovered value with op="<scope>/callbackPanic".
//	  2. Calls campaign.RevertFailedStep so the contact escapes
//	     `in_flight` regardless of which path (success or error) the
//	     panic interrupted. RevertFailedStep is idempotent so even if
//	     the panic happened AFTER FinalizeSentStep already ran (unlikely
//	     given panic ordering, but defensive), the second call is a
//	     no-op (rows=0, no error).
//	  3. Writes an `engine.panic_recovered` row into operator_audit_log
//	     so the operator can see a panic-recovery happened without
//	     scraping logs.
//
//	The wrapper deliberately does NOT re-raise the panic. Re-raising
//	would propagate to the outer defer recover() in main.go, which
//	already trips the BulkRevertInFlight escape valve — those two
//	would double-revert. Swallowing the panic here matches the existing
//	"goroutine continues" semantics of safeCall in sender_daemon.go.

package main

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"

	"campaigns/campaign"
	"campaigns/sender"
	"common/audit"
)

// wrapSendCallbackWithRecover wraps onSent with panic-safe rollback.
//
// scope is the slog `op` prefix ("outreach.main/server" or
// "outreach.main/campaign-run") so callers don't see a generic op tag and
// the existing slog_op_audit_test.go convention is preserved.
//
// db may be nil during tests — RevertFailedStep + audit.Log both no-op on
// nil DB, so the wrapper stays safe. campaign.DB satisfies audit.Execer
// directly because both interfaces declare the same ExecContext signature
// (sql.Result, error), so no adapter is needed.
func wrapSendCallbackWithRecover(
	ctx context.Context,
	db campaign.DB,
	scope string,
	onSent func(req sender.SendRequest, result sender.SendResult),
) func(req sender.SendRequest, result sender.SendResult) {
	return func(req sender.SendRequest, result sender.SendResult) {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			panicMsg := fmt.Sprintf("%v", r)
			slog.Error("send callback panic recovered",
				"op", scope+"/callbackPanic",
				"campaign_id", req.CampaignID,
				"contact_id", req.ContactID,
				"step", req.Step,
				"recover", panicMsg)

			// Best-effort revert: even if the panic happened on the
			// success branch, RevertFailedStep's CAS predicate
			// (status='in_flight' AND current_step=Step+1) means the
			// call is idempotent — already-finalized rows won't be
			// stomped. We do NOT inspect result.Error here because the
			// panic could have happened before we ever reached either
			// branch, leaving the contact in `in_flight` regardless.
			if db == nil {
				return
			}
			if _, err := campaign.RevertFailedStep(ctx, db, req); err != nil {
				slog.Warn("RevertFailedStep after callback panic failed",
					"op", scope+"/callbackPanic-revert",
					"campaign_id", req.CampaignID,
					"contact_id", req.ContactID,
					"error", err)
			}
			// campaign.DB satisfies audit.Execer (same ExecContext sig).
			audit.Log(ctx, db,
				audit.ActionEnginePanicRecovered, "engine.callback", "campaign", strconv.FormatInt(req.CampaignID, 10),
				map[string]any{
					"scope":      scope,
					"contact_id": req.ContactID,
					"step":       req.Step,
					"recover":    panicMsg,
				})
		}()
		onSent(req, result)
	}
}
