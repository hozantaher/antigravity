package sender

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"common/metrics"
)

// Sentinel errors for typed handling by callers (retry policy, metrics).
var (
	// ErrAntiTraceMarshal — request body could not be marshalled.
	// Practically unreachable for typed payloads; defensive.
	ErrAntiTraceMarshal = errors.New("anti-trace: marshal payload")

	// ErrAntiTraceRequest — http.NewRequestWithContext failed (bad URL, ctx).
	ErrAntiTraceRequest = errors.New("anti-trace: build request")

	// ErrAntiTraceTransport — http.Client.Do failed (network, DNS, timeout).
	ErrAntiTraceTransport = errors.New("anti-trace: transport")

	// ErrAntiTraceRateLimited — relay returned 429. Caller should back off.
	ErrAntiTraceRateLimited = errors.New("anti-trace: rate limited")

	// ErrAntiTraceHTTPStatus — relay returned a non-2xx, non-429 status.
	// Wraps the body for debugging (4096 byte limit).
	ErrAntiTraceHTTPStatus = errors.New("anti-trace: http status")

	// ErrAntiTraceEmptyEnvelope — relay returned 2xx with no envelope_id
	// (empty body, malformed JSON, or {} object). F3-3 fix: treat as a
	// transient failure so the caller can retry. Pre-fix the empty
	// envelope_id silently flowed into send_events.message_id="" and
	// broke later DSN-bounce dedupe (the bounce processor joins
	// inbound DSN's In-Reply-To against send_events.message_id; an
	// empty key never matches, so the bounce signal is lost).
	ErrAntiTraceEmptyEnvelope = errors.New("anti-trace: empty envelope_id in 2xx response")

	// ErrWarmupCapExceeded — the DB trigger (migration 071) rejected the
	// send_events INSERT because the mailbox has exhausted its warmup-phase
	// daily cap (Day0=5, Day3=10, Day7=25, Day14=50, Day30+=100).
	//
	// The relay propagates the PostgreSQL ERRCODE 23514 / message
	// "warmup_cap_exceeded: mailbox=... phase=... sent_today=... cap=..."
	// back as an application-level error. Engine.Run wraps DB errors matching
	// this pattern as ErrWarmupCapExceeded so runners can apply the correct
	// policy: skip this mailbox for today and retry after Prague midnight.
	//
	// The sentinel is also used by tests that stub the relay response and
	// verify that the runner skips the mailbox without tripping the bounce
	// circuit breaker (cap exhaustion is NOT a deliverability signal).
	ErrWarmupCapExceeded = errors.New("sender: warmup cap exceeded")

	// ErrWarmupCapStatusGuard — the DB trigger (migration 079) rejected the
	// send_events INSERT because the mailbox is in a non-sendable status
	// (paused, auth_locked, egress_chaos_detected, retired, etc.).
	//
	// The trigger raises:
	//   "warmup_cap_status_guard: mailbox=<addr> status=<status> (not active)"
	// with PostgreSQL ERRCODE 23514 (check_violation).
	//
	// This is NOT a cap exhaustion event. The mailbox should NOT be retried
	// for today (the status gate will remain until an operator unlocks the
	// mailbox). Do NOT increment bounce counters or trip the circuit breaker.
	ErrWarmupCapStatusGuard = errors.New("sender: warmup cap status guard")
)

// IsWarmupCapError reports whether err (or any error in its chain) signals
// that the DB trigger rejected a send_events INSERT because the mailbox's
// warmup-phase daily cap is exhausted.
//
// The trigger message format is:
//
//	"warmup_cap_exceeded: mailbox=<addr> phase=<phase> sent_today=<n> cap=<n>"
//
// with PostgreSQL ERRCODE 23514 (check_violation). The relay may also surface
// this as a 500/422 response body containing the same prefix.
//
// Callers should treat ErrWarmupCapExceeded as a schedule signal, NOT a
// deliverability bounce: skip the mailbox today, retry after Prague midnight.
// Do NOT increment bounce counters or trip the circuit breaker.
func IsWarmupCapError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrWarmupCapExceeded) {
		return true
	}
	return strings.Contains(err.Error(), "warmup_cap_exceeded")
}

// IsWarmupCapStatusGuardError reports whether err (or any error in its chain)
// signals that the DB trigger (migration 079) rejected a send_events INSERT
// because the mailbox is in a non-sendable status (paused, auth_locked,
// egress_chaos_detected, retired, etc.).
//
// The trigger message format is:
//
//	"warmup_cap_status_guard: mailbox=<addr> status=<status> (not active)"
//
// with PostgreSQL ERRCODE 23514 (check_violation).
//
// Callers should: skip this mailbox, log + emit Sentry, do NOT bounce, do NOT
// retry today. The status gate persists until an operator unlocks the mailbox.
func IsWarmupCapStatusGuardError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrWarmupCapStatusGuard) {
		return true
	}
	return strings.Contains(err.Error(), "warmup_cap_status_guard")
}

// AntiTraceClient routes outbound emails through the anti-trace-relay service
// instead of direct SMTP. The relay adds header sanitization, metadata
// padding, and optional Tor/VPN transport.
type AntiTraceClient struct {
	url          string
	token        string
	smtpHost     string
	smtpPort     int
	smtpUsername string
	smtpPassword string
	http         *http.Client
}

type antiTraceRequest struct {
	Recipient    string            `json:"recipient"`
	Subject      string            `json:"subject"`
	Body         string            `json:"body"`
	BodyHTML     string            `json:"body_html,omitempty"`
	Headers      map[string]string `json:"headers,omitempty"`
	FromAddress  string            `json:"from_address,omitempty"`
	SMTPHost     string            `json:"smtp_host,omitempty"`
	SMTPPort     int               `json:"smtp_port,omitempty"`
	SMTPUsername string            `json:"smtp_username,omitempty"`
	SMTPPassword string            `json:"smtp_password,omitempty"`
	// AW7-9 — IMAP coordinates of the sender mailbox. The relay drain
	// uses these to perform a post-send APPEND to the mailbox's "Sent"
	// folder inside the relay container (where wgsocks lives).
	// Username/Password are reused from the SMTP fields.
	IMAPHost string `json:"imap_host,omitempty"`
	IMAPPort int    `json:"imap_port,omitempty"`
	// PreferredCountry pins egress to a specific ISO 3166-1 alpha-2 country.
	// Passed through from SendRequest.PreferredCountry.
	PreferredCountry string `json:"preferred_country,omitempty"`
}

type antiTraceResponse struct {
	EnvelopeID string `json:"envelope_id"`
	Status     string `json:"status"`
}

// NewAntiTraceClient creates a client for the anti-trace-relay HTTP API.
func NewAntiTraceClient(url, token string) *AntiTraceClient {
	return &AntiTraceClient{
		url:      url,
		token:    token,
		
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Send submits an email to the anti-trace-relay for sanitized delivery.
// The relay strips identifying headers, pads to size class, and delivers
// through the configured transport (direct / Tor / VPN).
//
// SMTP credential resolution order: req fields take precedence over client
// fields, so the engine can inject per-mailbox creds via SendRequest without
// mutating the shared client on every send.
func (c *AntiTraceClient) Send(ctx context.Context, req SendRequest) SendResult {
	smtpHost := c.smtpHost
	if req.SMTPHost != "" {
		smtpHost = req.SMTPHost
	}
	smtpPort := c.smtpPort
	if req.SMTPPort != 0 {
		smtpPort = req.SMTPPort
	}
	smtpUsername := c.smtpUsername
	if req.SMTPUsername != "" {
		smtpUsername = req.SMTPUsername
	}
	smtpPassword := c.smtpPassword
	if req.SMTPPassword != "" {
		smtpPassword = req.SMTPPassword
	}
	if smtpUsername == "" {
		return SendResult{
			Error:  fmt.Errorf("antitrace: missing SMTPUsername — engine rotation must inject per-mailbox creds"),
			SentAt: time.Now(),
		}
	}
	fromAddr := smtpUsername

	payload := antiTraceRequest{
		Recipient:        req.ToAddress,
		Subject:          req.Subject,
		Body:             req.BodyPlain,
		BodyHTML:         req.BodyHTML,
		Headers:          req.Headers,
		FromAddress:      fromAddr,
		SMTPHost:         smtpHost,
		SMTPPort:         smtpPort,
		SMTPUsername:     smtpUsername,
		SMTPPassword:     smtpPassword,
		// AW7-9 — relay drain uses these to perform post-send IMAP
		// APPEND to the sender mailbox's "Sent" folder. SMTPUsername/
		// SMTPPassword are reused as the IMAP credentials (true for
		// Seznam + every major provider we target).
		IMAPHost:         req.IMAPHost,
		IMAPPort:         req.IMAPPort,
		PreferredCountry: req.PreferredCountry,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return SendResult{Error: fmt.Errorf("%w: %v", ErrAntiTraceMarshal, err), SentAt: time.Now()}
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/v1/submit", bytes.NewReader(body))
	if err != nil {
		return SendResult{Error: fmt.Errorf("%w: %v", ErrAntiTraceRequest, err), SentAt: time.Now()}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.token)

	// AT3.2 telemetry: count every relay submission attempt. Under LAB_ONLY=1
	// the LabAbortEvaluator gate (engine.go G8) must prevent execution from
	// ever reaching this line — so SMTPSocketOpenTotal must stay 0 in airtight
	// lab runs. The integration test at services/campaigns/integration/
	// airtight_lab_send_test.go asserts this invariant.
	metrics.SMTPSocketOpenTotal.Inc()

	resp, err := c.http.Do(httpReq)
	if err != nil {
		// slog.Warn (not Error) — transport failures are expected under load and
		// the engine will retry / circuit-break. Error log floods Sentry.
		slog.Warn("anti-trace transport error",
			"op", "antitrace.Submit/transport",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"step", req.Step,
			"recipient_domain", domainOf(req.ToAddress),
			"error", err)
		return SendResult{Error: fmt.Errorf("%w: %v", ErrAntiTraceTransport, err), SentAt: time.Now()}
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	if resp.StatusCode == http.StatusTooManyRequests {
		slog.Warn("anti-trace rate limited",
			"op", "antitrace.Submit/429",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"recipient_domain", domainOf(req.ToAddress))
		return SendResult{Error: ErrAntiTraceRateLimited, SentAt: time.Now()}
	}
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		// Body may include the relay's own error context. Truncated to 4096.
		// We do NOT log the full body at slog.Error to avoid Sentry noise from
		// repeated 5xx during relay deploy windows; the SendResult.Error has it.
		slog.Warn("anti-trace HTTP error status",
			"op", "antitrace.Submit/non2xx",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"status", resp.StatusCode,
			"recipient_domain", domainOf(req.ToAddress))
		return SendResult{
			Error:  fmt.Errorf("%w: %d: %s", ErrAntiTraceHTTPStatus, resp.StatusCode, string(respBody)),
			SentAt: time.Now(),
		}
	}

	var atr antiTraceResponse
	if err := json.Unmarshal(respBody, &atr); err != nil {
		// F3-3: 2xx with non-JSON body is contract drift — fail loudly
		// so the caller retries. Pre-fix this proceeded with empty
		// MessageID, breaking DSN-bounce dedupe weeks later.
		slog.Warn("anti-trace response unmarshal failed",
			"op", "antitrace.Submit/unmarshal",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"status", resp.StatusCode,
			"body_len", len(respBody),
			"error", err)
		return SendResult{
			Error:  fmt.Errorf("%w: unmarshal: %v", ErrAntiTraceEmptyEnvelope, err),
			SentAt: time.Now(),
		}
	}

	// F3-3: 2xx + parseable JSON but empty envelope_id is also contract
	// drift. The relay's contract is to return a unique envelope_id we
	// later use to match inbound DSN bounces. An empty value here means
	// either the relay didn't actually accept the envelope or it returned
	// the wrong shape — both are retry-worthy. Reject before committing
	// to send_events.
	if atr.EnvelopeID == "" {
		slog.Warn("anti-trace empty envelope_id in 2xx response",
			"op", "antitrace.Submit/empty_envelope",
			"campaign_id", req.CampaignID,
			"contact_id", req.ContactID,
			"status", resp.StatusCode,
			"relay_status", atr.Status,
			"body_len", len(respBody))
		return SendResult{
			Error:  fmt.Errorf("%w (relay_status=%q)", ErrAntiTraceEmptyEnvelope, atr.Status),
			SentAt: time.Now(),
		}
	}

	slog.Info("anti-trace submitted",
		"campaign_id", req.CampaignID,
		"contact_id", req.ContactID,
		"step", req.Step,
		"to", req.ToAddress,
		"envelope_id", atr.EnvelopeID,
		"status", atr.Status,
		"mailbox", fromAddr)

	return SendResult{
		MessageID:    atr.EnvelopeID,
		MailboxUsed:  fromAddr, // resolved (req.SMTPUsername || c.fromAddr) — not stale c.fromAddr
		SMTPResponse: atr.Status,
		SentAt:       time.Now(),
	}
}

// domainOf returns the part after '@' for log/metric tags, or "" if missing.
// Defensive helper — Sentry tags must not include full email addresses for
// privacy, but recipient domain is OK for aggregation.
func domainOf(email string) string {
	for i := len(email) - 1; i >= 0; i-- {
		if email[i] == '@' {
			return email[i+1:]
		}
	}
	return ""
}
