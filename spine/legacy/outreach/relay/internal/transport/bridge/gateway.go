package bridge

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// AuditRecorder records delivery outcome events for bridge operations.
// Only the outcome-aware method is required; this keeps the interface minimal.
type AuditRecorder interface {
	RecordWithOutcome(ctx context.Context, tenantID, eventType, envelopeID, outcome string, httpStatus int) error
}

// PrivacyGatewayBridge connects anti-trace-relay to the privacy-gateway service.
//
// Flow:
//
//	Submitter -> anti-trace-relay (intake, sanitize, seal, relay)
//	          -> PrivacyGatewayBridge
//	          -> privacy-gateway (alias, submission, SMTP delivery)
//
// This allows anti-trace-relay to handle the privacy-hardened intake/relay pipeline
// while privacy-gateway handles the actual mail delivery with its established
// alias system, policy engine, and SMTP integration.
type PrivacyGatewayBridge struct {
	gatewayURL string
	token      string
	client     *http.Client
	log        *minlog.Logger
	audit      AuditRecorder
}

// BridgeConfig configures the privacy-gateway bridge.
type BridgeConfig struct {
	GatewayURL string // e.g. "http://127.0.0.1:8080"
	Token      string // Bearer token for privacy-gateway auth
}

// NewPrivacyGatewayBridge creates a bridge to privacy-gateway.
func NewPrivacyGatewayBridge(cfg BridgeConfig, log *minlog.Logger) *PrivacyGatewayBridge {
	return &PrivacyGatewayBridge{
		gatewayURL: cfg.GatewayURL,
		token:      cfg.Token,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		log: log,
	}
}

// WithAudit attaches an audit recorder to capture delivery outcomes.
// Returns the bridge for chaining.
func (b *PrivacyGatewayBridge) WithAudit(recorder AuditRecorder) *PrivacyGatewayBridge {
	b.audit = recorder
	return b
}

// ForwardSubmission sends a relayed envelope to privacy-gateway as a submission.
// The envelope content is already sanitized and sealed by anti-trace-relay.
// Transient failures (5xx, connection errors, 429) are retried with exponential
// backoff up to maxRetries times. Permanent failures (4xx except 429) are not
// retried and are recorded as dead-letter events in the audit log.
func (b *PrivacyGatewayBridge) ForwardSubmission(ctx context.Context, env model.Envelope, recipient, subject, body string) (*ForwardResult, error) {
	// Use the intake/submissions endpoint with CreateSubmissionInput format
	payload := map[string]any{
		"channel_id": "anti-trace-relay",
		"to":         []string{recipient},
		"subject":    subject,
		"text_body":  body,
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal submission: %w", err)
	}

	endpoint := b.gatewayURL + "/v1/intake/submissions"

	var (
		lastRespBody []byte
		lastResult   ForwardResult
	)

	retryResult := WithRetry(ctx, func() (int, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
		if err != nil {
			return 0, fmt.Errorf("create request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+b.token)
		req.Header.Set("Content-Type", "application/json")

		resp, err := b.client.Do(req)
		if err != nil {
			return 0, err
		}
		defer resp.Body.Close()

		lastRespBody, _ = io.ReadAll(io.LimitReader(resp.Body, 4096))

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if jsonErr := json.Unmarshal(lastRespBody, &lastResult); jsonErr != nil {
				lastResult.Raw = string(lastRespBody)
			}
			lastResult.StatusCode = resp.StatusCode
			lastResult.EnvelopeID = env.ID
		}

		return resp.StatusCode, nil
	})

	if retryResult.Success {
		b.log.Info("bridge_forwarded",
			minlog.F("envelope_id", env.ID),
			minlog.F("attempts", fmt.Sprintf("%d", retryResult.Attempts)),
		)
		b.recordOutcome(ctx, env, model.EventBridgeDelivered, model.OutcomeSuccess, retryResult.LastStatus)
		return &lastResult, nil
	}

	// Delivery failed — classify the dead-letter outcome for audit visibility.
	var outcome string
	switch retryResult.Kind {
	case FailurePermanent:
		outcome = "permanent_failure"
		b.log.Error("bridge_gateway_rejected",
			minlog.F("envelope_id", env.ID),
			minlog.F("status_code", fmt.Sprintf("%d", retryResult.LastStatus)),
		)
	default:
		outcome = "transient_failure_max_retries"
		b.log.Error("bridge_forward_failed",
			minlog.F("envelope_id", env.ID),
			minlog.F("attempts", fmt.Sprintf("%d", retryResult.Attempts)),
		)
	}

	b.recordOutcome(ctx, env, model.EventBridgeFailed, outcome, retryResult.LastStatus)
	return nil, fmt.Errorf("forward to gateway failed (status=%d, kind=%v, attempts=%d): %s",
		retryResult.LastStatus, retryResult.Kind, retryResult.Attempts, string(lastRespBody))
}

// recordOutcome fires an audit event with delivery outcome if an AuditRecorder is configured.
func (b *PrivacyGatewayBridge) recordOutcome(ctx context.Context, env model.Envelope, eventType, outcome string, httpStatus int) {
	if b.audit == nil {
		return
	}
	// Best-effort: ignore audit errors to avoid masking the primary delivery error.
	_ = b.audit.RecordWithOutcome(ctx, env.TenantID, eventType, env.ID, outcome, httpStatus)
}

// CreateAlias creates an alias in privacy-gateway for a given label.
func (b *PrivacyGatewayBridge) CreateAlias(ctx context.Context, label string) (*AliasResult, error) {
	payload := map[string]string{"label": label}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	url := b.gatewayURL + "/v1/aliases"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+b.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := b.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result AliasResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	result.StatusCode = resp.StatusCode
	return &result, nil
}

// HealthCheck verifies privacy-gateway is reachable.
func (b *PrivacyGatewayBridge) HealthCheck(ctx context.Context) error {
	url := b.gatewayURL + "/healthz"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return fmt.Errorf("gateway unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway health check failed: %d", resp.StatusCode)
	}
	return nil
}

// ForwardResult holds the response from privacy-gateway after forwarding.
type ForwardResult struct {
	StatusCode int    `json:"status_code"`
	EnvelopeID string `json:"envelope_id"`
	MessageID  string `json:"id,omitempty"`
	Raw        string `json:"raw,omitempty"`
}

// AliasResult holds the response from alias creation.
type AliasResult struct {
	StatusCode int    `json:"status_code"`
	ID         string `json:"id"`
	Email      string `json:"email"`
	Label      string `json:"label"`
}
