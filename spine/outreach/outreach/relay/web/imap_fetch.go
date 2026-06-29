package web

// imap_fetch.go — POST /v1/imap-fetch handler.
//
// Wraps delivery.FetchInboxHeaders behind an HTTP endpoint so cross-Railway
// services (BFF, orchestrator) can poll inbound mailboxes without owning
// their own SOCKS5 tunnel. The relay container already has working wgsocks
// instances (proven by /v1/submit + Sent APPEND on every campaign send);
// this handler reuses the same transport.
//
// Why this is the right architectural fix:
//   - wgsocks listeners bind 127.0.0.1:108x INSIDE relay. Cross-service
//     dial fails ECONNREFUSED (memory project_bff_imap_cross_service_broken).
//   - BFF wireproxy sidecar attempt failed (wireproxy v1.1.2 connForward
//     bug + Railway netstack quirks).
//   - HTTP wrapper is the documented architectural fix per memory.
//
// Compliance:
//   - feedback_no_pii_in_commands: from/to/subject in response body only
//     (caller already has them); slog labels use mailbox address (operator
//     already knows that PII) and never echo recipient details.
//   - feedback_extreme_testing: companion imap_fetch_test.go.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"relay/internal/delivery"
	"relay/internal/transport"
)

// imapFetchRequest is the JSON body of POST /v1/imap-fetch.
type imapFetchRequest struct {
	MailboxAddress string `json:"mailbox_address"`
	IMAPHost       string `json:"imap_host"`
	IMAPPort       int    `json:"imap_port"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	Folder         string `json:"folder,omitempty"`
	SinceUID       uint32 `json:"since_uid,omitempty"`
	Limit          int    `json:"limit,omitempty"`
	// PreferredCountry pins the wgpool egress country. Defaults to "CZ"
	// when the mailbox is on Seznam — Seznam rejects foreign-IP IMAP
	// LOGIN attempts under their fraud-prevention rules. Caller passes
	// empty string to disable pinning.
	PreferredCountry string `json:"preferred_country,omitempty"`
	// IncludeBody asks for the full raw RFC 5322 stream per message so
	// caller (BFF → orchestrator) can MIME-parse + extract attachments.
	// When true, server-side limit caps at 30; raw bytes are base64'd
	// over JSON by the standard encoder.
	IncludeBody bool `json:"include_body,omitempty"`
}

// imapFetchResponse mirrors delivery.FetchResult with a wrapping ok flag
// so transient errors don't require the caller to parse stderr.
type imapFetchResponse struct {
	OK          bool                       `json:"ok"`
	Error       string                     `json:"error,omitempty"`
	UIDValidity uint32                     `json:"uid_validity,omitempty"`
	UnseenTotal int                        `json:"unseen_total"`
	Messages    []delivery.FetchedMessage  `json:"messages,omitempty"`
	EgressLabel string                     `json:"egress_label,omitempty"`
}

// handleImapFetch is the HTTP handler. POST, JSON in/out, requires a
// valid actor bearer token (same auth path as /v1/submit). Cross-tenant
// IMAP access would be a credential-theft vector; auth gating is
// non-negotiable.
func (s *Server) handleImapFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if _, ok := s.requireActor(w, r); !ok {
		return
	}

	var req imapFetchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.IMAPHost == "" || req.IMAPPort == 0 || req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "imap_host, imap_port, username, password required")
		return
	}

	// Resolve SOCKS5 addr: prefer wgpool with country pin, fall back to
	// fallbackProxyAddr (single-endpoint Mullvad). Mirrors handleProbe
	// behaviour so the relay's egress story stays consistent across
	// SMTP, IMAP APPEND, and IMAP FETCH.
	proxyAddr, egressLabel := s.resolveProxyForFetch(req.PreferredCountry)
	if proxyAddr == "" {
		writeJSON(w, http.StatusServiceUnavailable, imapFetchResponse{
			OK:    false,
			Error: "no wgpool endpoint available + no fallbackProxyAddr",
		})
		return
	}

	// 90s ceiling — UID FETCH on a 200-message batch can be ~60s; add
	// 30s headroom for handshake + LOGIN + SELECT.
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	tr := transport.NewSOCKS5Transport(proxyAddr, 15*time.Second)

	result, err := delivery.FetchInboxHeaders(ctx, tr, delivery.FetchParams{
		MailboxAddress: req.MailboxAddress,
		IMAPHost:       req.IMAPHost,
		IMAPPort:       req.IMAPPort,
		Username:       req.Username,
		Password:       req.Password,
		Folder:         req.Folder,
		SinceUID:       req.SinceUID,
		Limit:          req.Limit,
		IncludeBody:    req.IncludeBody,
	})
	if err != nil {
		// Map ErrFetchNoIMAPCreds to 400 (caller bug) vs all other
		// errors to 502 (relay-side problem upstream of caller).
		if err == delivery.ErrFetchNoIMAPCreds {
			writeError(w, http.StatusBadRequest, "missing imap credentials")
			return
		}
		writeJSON(w, http.StatusBadGateway, imapFetchResponse{
			OK:          false,
			Error:       err.Error(),
			UIDValidity: result.UIDValidity, // partial state if SELECT succeeded
			UnseenTotal: result.UnseenTotal,
			EgressLabel: egressLabel,
		})
		return
	}

	writeJSON(w, http.StatusOK, imapFetchResponse{
		OK:          true,
		UIDValidity: result.UIDValidity,
		UnseenTotal: result.UnseenTotal,
		Messages:    result.Messages,
		EgressLabel: egressLabel,
	})
}

// resolveProxyForFetch picks the SOCKS5 endpoint for the IMAP dial.
// Order: wgpool with country pin → wgpool any → fallbackProxyAddr →
// empty (caller returns 503).
func (s *Server) resolveProxyForFetch(preferredCountry string) (addr, label string) {
	if s.wgPool != nil {
		// Pick is deterministic per (envelope_id, mailbox_id) but we
		// have neither in this context — pass empty strings to get
		// round-robin within the country.
		if ep, err := s.wgPool.Pick("", "", strings.ToUpper(preferredCountry)); err == nil {
			return ep.SocksAddr, ep.Label
		}
		// Country pin failed → try any active endpoint.
		if preferredCountry != "" {
			if ep, err := s.wgPool.Pick("", "", ""); err == nil {
				return ep.SocksAddr, ep.Label
			}
		}
	}
	if s.fallbackProxyAddr != "" {
		return s.fallbackProxyAddr, "single"
	}
	return "", ""
}
