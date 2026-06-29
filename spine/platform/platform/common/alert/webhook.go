// Package alert sends operational notifications to a Slack-compatible webhook.
// Configure via ALERT_WEBHOOK_URL. If the variable is unset the client is a no-op.
// Optionally set ALERT_WEBHOOK_SECRET to sign outbound payloads with HMAC-SHA256
// (header: X-Hub-Signature-256: sha256=<hex>).
package alert

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"common/envconfig"
	"time"
)

// Client sends alert messages to a webhook URL.
type Client struct {
	webhookURL string
	secret     []byte // optional HMAC-SHA256 signing key
	http       *http.Client
}

// New creates an alert client. Reads ALERT_WEBHOOK_URL and ALERT_WEBHOOK_SECRET
// from the environment.
func New() *Client {
	return &Client{
		webhookURL: envconfig.GetOr("ALERT_WEBHOOK_URL", ""),
		secret:     []byte(envconfig.GetOr("ALERT_WEBHOOK_SECRET", "")),
		http:       &http.Client{Timeout: 5 * time.Second},
	}
}

// Enabled returns true when a webhook URL is configured.
func (c *Client) Enabled() bool {
	return c.webhookURL != ""
}

// Send posts a plain-text message to the webhook.
// If a secret is configured the request is signed with HMAC-SHA256 and the
// signature is sent as X-Hub-Signature-256: sha256=<hex>.
func (c *Client) Send(ctx context.Context, text string) {
	if !c.Enabled() {
		return
	}
	payload, _ := json.Marshal(map[string]string{"text": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.webhookURL, bytes.NewReader(payload))
	if err != nil {
		slog.Warn("alert webhook build request failed", "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if len(c.secret) > 0 {
		mac := hmac.New(sha256.New, c.secret)
		mac.Write(payload)
		req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		slog.Warn("alert webhook send failed", "error", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		slog.Warn("alert webhook non-OK response", "status", resp.StatusCode)
	}
}

// DomainsFlagged fires when the intelligence loop flags unhealthy domains.
func (c *Client) DomainsFlagged(ctx context.Context, count int) {
	c.Send(ctx, fmt.Sprintf("⚠️ *Domain health*: %d domain(s) flagged as unhealthy — check dashboard › Domains", count))
}

// AutoSuppressed fires when contacts/domains are auto-suppressed.
func (c *Client) AutoSuppressed(ctx context.Context, count int) {
	c.Send(ctx, fmt.Sprintf("🚫 *Auto-suppress*: %d contact(s)/domain(s) suppressed from bounce/complaint events", count))
}

// InterestedReply fires when an inbound reply is classified as interested.
func (c *Client) InterestedReply(ctx context.Context, from string, threadID int64) {
	c.Send(ctx, fmt.Sprintf("📩 *Interested reply*: %s (thread #%d) — check dashboard › Inbox", from, threadID))
}

// DaemonError fires when a daemon encounters a fatal error.
func (c *Client) DaemonError(ctx context.Context, daemon, errMsg string) {
	c.Send(ctx, fmt.Sprintf("❌ *Daemon error* [%s]: %s", daemon, errMsg))
}

// BounceRateHigh fires when a domain exceeds the bounce rate threshold.
func (c *Client) BounceRateHigh(ctx context.Context, domain string, rate float64) {
	c.Send(ctx, fmt.Sprintf("🔴 *High bounce rate*: %s → %.1f%% — sending paused for this domain", domain, rate*100))
}

// DaemonPanic fires when a daemon goroutine panics and is recovered.
// The daemon continues running on the next tick, but the panic is surfaced here.
func (c *Client) DaemonPanic(ctx context.Context, daemon, panicMsg string) {
	c.Send(ctx, fmt.Sprintf("🔥 *Daemon panic recovered* [%s]: %s — daemon is still running", daemon, panicMsg))
}
