package validation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// SMTPProbeValidator forwards email verification to anti-trace-relay's
// /v1/verify endpoint. Direct SMTP egress from this package is forbidden
// per R6 (SMTP-EGRESS-LOCKDOWN); the relay owns MX lookup + RCPT-TO probing
// over the SOCKS5 proxy pool.
//
// When RelayURL is empty the probe returns (false, "verify_disabled", nil).
type SMTPProbeValidator struct {
	Timeout    time.Duration
	FromDomain string // retained for callsite compat; unused (relay owns HELO)
	RelayURL   string
	RelayToken string
	HTTPClient *http.Client // optional; defaults to http.Client{Timeout}
	// LookupMX is retained for test compat but is no longer consulted —
	// relay owns MX resolution. Kept to avoid breaking existing test harnesses.
	LookupMX func(host string) ([]*net.MX, error)
}

type verifyRequest struct {
	Email  string `json:"email"`
	Domain string `json:"domain,omitempty"`
}

type verifyResponse struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

func (v *SMTPProbeValidator) Name() string { return "smtp_probe" }

// ProbeOutcome is the tri-state result of a relay /v1/verify call. It keeps a
// definitive "invalid" (hard 5xx reject) distinct from an "unknown" outcome
// (greylist / 4xx temp-fail / timeout / proxy-exhausted / relay disabled) so a
// deliverable mailbox sitting behind greylisting is never permanently labelled
// invalid. The zero value is ProbeUnknown — the safe default for any error or
// disabled path.
type ProbeOutcome int

const (
	ProbeUnknown ProbeOutcome = iota // inconclusive — caller should retry later
	ProbeValid                       // relay confirmed the mailbox accepts (250)
	ProbeInvalid                     // relay definitively rejected (550)
)

// Validate implements the Validator interface. It collapses the tri-state to a
// bool (only ProbeValid counts as "passed"); callers that must distinguish a
// temp-fail from a hard reject use Probe instead.
func (v *SMTPProbeValidator) Validate(ctx context.Context, email string) (bool, string, error) {
	outcome, reason, err := v.Probe(ctx, email)
	return outcome == ProbeValid, reason, err
}

// Probe performs the relay verify call and returns the tri-state outcome plus a
// human-readable reason. Every non-definitive path (no domain, relay disabled,
// transport error, non-200, decode failure, relay "unknown") maps to
// ProbeUnknown; only a relay "invalid" maps to ProbeInvalid.
func (v *SMTPProbeValidator) Probe(ctx context.Context, email string) (ProbeOutcome, string, error) {
	domain := domainFromEmail(email)
	if domain == "" {
		return ProbeUnknown, "no domain", nil
	}

	if strings.TrimSpace(v.RelayURL) == "" {
		return ProbeUnknown, "verify_disabled", nil
	}

	timeout := v.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}

	body, err := json.Marshal(verifyRequest{Email: email, Domain: domain})
	if err != nil {
		return ProbeUnknown, "marshal failed", nil
	}

	url := strings.TrimRight(v.RelayURL, "/") + "/v1/verify"
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return ProbeUnknown, "request failed", nil
	}
	req.Header.Set("Content-Type", "application/json")
	if v.RelayToken != "" {
		req.Header.Set("Authorization", "Bearer "+v.RelayToken)
	}

	client := v.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}

	resp, err := client.Do(req)
	if err != nil {
		return ProbeUnknown, "relay error: " + err.Error(), nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ProbeUnknown, fmt.Sprintf("relay http %d", resp.StatusCode), nil
	}

	var out verifyResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ProbeUnknown, "decode failed", nil
	}

	reason := out.Reason
	if reason == "" {
		reason = out.Status
	}
	switch out.Status {
	case "valid":
		return ProbeValid, reason, nil
	case "invalid":
		return ProbeInvalid, reason, nil
	case "unknown":
		return ProbeUnknown, reason, nil
	default:
		return ProbeUnknown, "unknown status: " + out.Status, nil
	}
}

// CatchAllValidator detects catch-all domains by asking the relay to verify
// a clearly non-existent address. If the relay says it's valid, the domain
// accepts everything (catch-all).
type CatchAllValidator struct {
	Timeout    time.Duration
	FromDomain string // retained for callsite compat; unused
	RelayURL   string
	RelayToken string
	HTTPClient *http.Client
}

func (v *CatchAllValidator) Name() string { return "catchall" }

func (v *CatchAllValidator) Validate(ctx context.Context, email string) (bool, string, error) {
	domain := domainFromEmail(email)
	if domain == "" {
		return true, "no domain", nil
	}

	fakeEmail := "xq7zk9m3p2w@" + domain
	probe := &SMTPProbeValidator{
		Timeout:    v.Timeout,
		FromDomain: v.FromDomain,
		RelayURL:   v.RelayURL,
		RelayToken: v.RelayToken,
		HTTPClient: v.HTTPClient,
	}

	accepted, _, err := probe.Validate(ctx, fakeEmail)
	if err != nil {
		return true, "probe error, assuming not catch-all", nil
	}
	if accepted {
		return false, "catch-all domain detected", nil
	}
	return true, "not catch-all", nil
}
