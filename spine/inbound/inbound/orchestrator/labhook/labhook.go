// Package labhook is the orchestrator's pre-send abort hook for Mail Lab
// (ML5.1). When TRANSPORT_MODE=lab, every outbound send first asks the
// lab API "would this provider accept the message?" and skips delivery
// if the verdict is reject, greylist, or spam.
//
// Wiring:
//
//	hook := labhook.New(os.Getenv("TRANSPORT_MODE"), client)
//	skip, reason := hook.ShouldSkip(ctx, labhook.EvaluateInput{...})
//	if skip {
//	    // record verdict in send_events with status='skipped:<reason>'
//	    return
//	}
//	// proceed with antiTrace.Send(...)
//
// The hook is deliberately a thin wrapper so the orchestrator's send
// pipeline stays mostly unchanged. ML5.2 will wire this into
// services/campaigns/sender/engine.go between the existing PreSendHook
// and antiTrace.Send.
package labhook

import (
	"context"
	"fmt"
	"strings"

	"common/maillabclient"
)

// Evaluator decides whether the current send should be skipped. Returned
// skip=true with a non-empty reason aborts the send before SMTP submit.
// skip=false means "proceed normally"; the reason field can still carry
// a non-fatal note (e.g. lab API was unreachable so we defaulted open).
type Evaluator interface {
	ShouldSkip(ctx context.Context, in EvaluateInput) (skip bool, reason string)
}

// EvaluateInput carries the per-message signals the lab needs to render
// a verdict. Mirror of maillabclient.EvaluateRequest minus internal
// fields the caller doesn't have to know about.
type EvaluateInput struct {
	SenderMailbox string  // e.g. op@gmail.lab
	SenderIP      string  // outbound IP if known
	RecipientAddr string  // e.g. prospect@seznam.lab
	SizeBytes     int64
	HasDkim       bool
	LinkRatio     float64
}

// LabEvaluator runs against a real mail-lab-api over HTTP. Disabled
// (Mode != "lab") returns no-op skip=false on every call so production
// flows are untouched.
type LabEvaluator struct {
	Mode   string // "lab" enables; anything else disables
	Client *maillabclient.Client
}

// New constructs a LabEvaluator. mode comes from TRANSPORT_MODE env;
// client is the maillabclient.Client wired at boot time. Either may be
// zero-valued — both must be non-empty/non-nil to enable evaluation.
func New(mode string, client *maillabclient.Client) *LabEvaluator {
	return &LabEvaluator{Mode: mode, Client: client}
}

// ShouldSkip queries the lab's /evaluate endpoint and returns whether
// the send should be aborted.
//
// Fail-open semantics: if the lab API is unreachable or returns an error
// we DO NOT block the send — the orchestrator's normal flow proceeds.
// The reason carries the error so callers can log it. Rationale: the
// hook should never be a single-point-of-failure for real campaigns.
func (e *LabEvaluator) ShouldSkip(ctx context.Context, in EvaluateInput) (bool, string) {
	if e == nil || e.Mode != "lab" || e.Client == nil {
		return false, ""
	}
	if in.RecipientAddr == "" {
		return false, ""
	}
	domain := domainOf(in.RecipientAddr)
	if domain == "" {
		return false, ""
	}

	res, err := e.Client.Evaluate(ctx, domain, maillabclient.EvaluateRequest{
		SenderMailbox: in.SenderMailbox,
		SenderIP:      in.SenderIP,
		SenderAddr:    in.SenderMailbox,
		RecipientAddr: in.RecipientAddr,
		SizeBytes:     in.SizeBytes,
		HasDkim:       in.HasDkim,
		LinkRatio:     in.LinkRatio,
		RecordRate:    true, // advance rate counter on every attempt
	})
	if err != nil {
		// Fail-open: don't block real sends because the lab API is down.
		return false, fmt.Sprintf("lab evaluate error: %v (defaulting allow)", err)
	}
	if res.Decision == "accept" {
		return false, ""
	}
	return true, fmt.Sprintf("lab verdict: %s (%s, fired_by=%s)", res.Decision, res.Reason, res.FiredBy)
}

// Enabled reports whether the evaluator will actually call the lab.
// Useful for the orchestrator boot log so operators can see at a glance
// whether they're in lab mode.
func (e *LabEvaluator) Enabled() bool {
	return e != nil && e.Mode == "lab" && e.Client != nil
}

func domainOf(addr string) string {
	at := strings.LastIndex(addr, "@")
	if at < 0 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(addr[at+1:]))
}
