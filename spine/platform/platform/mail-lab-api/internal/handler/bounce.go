package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// BounceRunner is the minimal contract bounce delivery needs from
// exec.Runner — only RunWithStdin (the DSN body is piped to sendmail).
// Defined here so tests can stub without pulling exec/docker.
type BounceRunner interface {
	RunWithStdin(ctx context.Context, stdin []byte, name string, args ...string) (string, error)
}

// ── Bounce delivery (ML3.1) ────────────────────────────────────────────

type bounceRequest struct {
	RecipientDomain string                 `json:"recipient_domain"` // domain that's rejecting
	OriginalTo      string                 `json:"original_to"`      // who was rejected
	OriginalFrom    string                 `json:"original_from"`    // who gets the bounce
	MessageID       string                 `json:"message_id,omitempty"`
	Context         map[string]interface{} `json:"context,omitempty"`
}

type bounceResponse struct {
	Decision  string `json:"decision"`
	Reason    string `json:"reason,omitempty"`
	Delivered bool   `json:"delivered"`
	DSNBody   string `json:"dsn_body,omitempty"`
	Container string `json:"container,omitempty"`
}

// containerForSenderDomain maps a sender's domain to the docker container
// that hosts their mailbox. Mirrors handler.defaultContainerFor but kept
// separate so future operators can override per-test.
func containerForSenderDomain(domain string) string {
	switch strings.ToLower(strings.TrimSpace(domain)) {
	case "seznam.lab":
		return "mail-lab-seznam"
	case "gmail.lab":
		return "mail-lab-gmail"
	case "outlook.lab":
		return "mail-lab-outlook"
	default:
		return ""
	}
}

func (s *Server) handleBounceDeliver(w http.ResponseWriter, r *http.Request) {
	var req bounceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed JSON body")
		return
	}
	if strings.TrimSpace(req.RecipientDomain) == "" || strings.TrimSpace(req.OriginalTo) == "" || strings.TrimSpace(req.OriginalFrom) == "" {
		writeError(w, http.StatusBadRequest, "recipient_domain, original_to, original_from required")
		return
	}

	// Stage 1 — evaluate verdict via the registry (greylist → rate → static).
	res, err := s.Profiles.EvaluateFromMap(req.RecipientDomain, withEnvelope(req.Context, req.OriginalFrom, req.OriginalTo))
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown recipient_domain "+req.RecipientDomain)
		return
	}
	decision, reason := extractDecisionReason(res)

	// Accept verdicts skip delivery — there's no bounce to deliver.
	if decision == "accept" {
		writeJSON(w, http.StatusOK, bounceResponse{Decision: decision, Reason: reason, Delivered: false})
		return
	}

	// Stage 2 — render DSN. PreviewDSN re-runs Verdict internally (cheap;
	// keeps the rendering logic in one place).
	dsnAny, _, err := s.Profiles.PreviewDSN(
		req.RecipientDomain,
		map[string]interface{}{
			"original_to":   req.OriginalTo,
			"original_from": req.OriginalFrom,
			"message_id":    req.MessageID,
		},
		req.Context,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "preview-dsn failed: "+err.Error())
		return
	}
	body := extractDSNBody(dsnAny)
	if body == "" {
		// Verdict wasn't accept but DSN body is empty — defensive: BuildDSN
		// returns zero DSN when OriginalTo is missing. Surface the inconsistency.
		writeError(w, http.StatusInternalServerError, "internal: empty DSN body for non-accept verdict")
		return
	}

	// Stage 3 — deliver. The DSN goes FROM postmaster@<recipient_domain>
	// TO original_from, so it lands in the SENDER's mailbox via the
	// SENDER's provider container.
	senderDomain := domainOf(req.OriginalFrom)
	container := containerForSenderDomain(senderDomain)
	if container == "" {
		writeError(w, http.StatusBadRequest, "unsupported sender domain "+senderDomain)
		return
	}

	bounceRunner, ok := s.Runner.(BounceRunner)
	if !ok {
		writeError(w, http.StatusInternalServerError, "runner does not support stdin")
		return
	}
	out, err := bounceRunner.RunWithStdin(r.Context(), []byte(body),
		"docker", "exec", "-i", container, "sendmail", "-i", "-f", "postmaster@"+req.RecipientDomain, req.OriginalFrom)
	if err != nil {
		s.Logger.Error("bounce delivery failed",
			"op", "mail-lab-api.handleBounceDeliver/exec",
			"sender", req.OriginalFrom, "container", container, "error", err)
		writeError(w, http.StatusInternalServerError, "delivery failed: "+err.Error())
		return
	}
	s.Logger.Info("bounce delivered",
		"op", "mail-lab-api.handleBounceDeliver",
		"sender", req.OriginalFrom,
		"recipient_domain", req.RecipientDomain,
		"container", container,
		"decision", decision,
		"dsn_size", len(body),
		"stdout", strings.TrimSpace(out))

	writeJSON(w, http.StatusOK, bounceResponse{
		Decision:  decision,
		Reason:    reason,
		Delivered: true,
		DSNBody:   body,
		Container: container,
	})
}

// withEnvelope folds the original sender + recipient into the context map
// so EvaluateFromMap has them available. The context map originates from
// the bounce request body (verdict signals like size, dkim, etc.).
func withEnvelope(ctx map[string]interface{}, originalFrom, originalTo string) map[string]interface{} {
	out := map[string]interface{}{}
	for k, v := range ctx {
		out[k] = v
	}
	if _, ok := out["sender_addr"]; !ok && originalFrom != "" {
		out["sender_addr"] = originalFrom
	}
	if _, ok := out["sender_mailbox"]; !ok && originalFrom != "" {
		out["sender_mailbox"] = originalFrom
	}
	if _, ok := out["recipient_addr"]; !ok && originalTo != "" {
		out["recipient_addr"] = originalTo
	}
	return out
}

func extractDecisionReason(res interface{}) (string, string) {
	if res == nil {
		return "", ""
	}
	// res is *profile.EvaluateResult or compatible struct — use JSON
	// roundtrip so handler doesn't need to import the profile package.
	buf, err := json.Marshal(res)
	if err != nil {
		return "", ""
	}
	var view struct {
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
	}
	_ = json.Unmarshal(buf, &view)
	return view.Decision, view.Reason
}

func extractDSNBody(dsn interface{}) string {
	if dsn == nil {
		return ""
	}
	buf, err := json.Marshal(dsn)
	if err != nil {
		return ""
	}
	var view struct {
		Body string `json:"body"`
	}
	_ = json.Unmarshal(buf, &view)
	return view.Body
}

