// Package maillabclient is a strongly-typed Go client for the Mail Lab
// admin API (services/mail-lab-api). Used by harness drivers + future
// orchestrator integrations so callers don't reimplement HTTP shapes.
//
// Construction:
//
//	c := maillabclient.New("http://localhost:8090", "dev-only")
//	if err := c.Health(ctx); err != nil { … }
//	mb, err := c.CreateMailbox(ctx, "op@seznam.lab", "secret")
//
// Auth: every call sets X-Lab-Api-Key from the constructor; if you pass
// an empty key the header is omitted (for unauthenticated test fixtures).
//
// All methods accept a context.Context for cancellation and timeout.
// Return errors are wrapped with the endpoint that failed so callers
// can errors.Is-style match (ErrUnknownDomain etc.).
package maillabclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrUnknownDomain is returned when the mail-lab-api responds 404 for a
// domain-scoped operation. Callers use errors.Is to map the API's
// per-endpoint 404 onto a uniform sentinel.
var ErrUnknownDomain = errors.New("maillabclient: unknown domain")

// ErrUnauthorized is returned when the API rejects the X-Lab-Api-Key
// (HTTP 401). Construction-time misconfig.
var ErrUnauthorized = errors.New("maillabclient: unauthorized (bad X-Lab-Api-Key)")

// ErrBadRequest is returned for HTTP 400 — payload validation failed
// upstream. Inspect err.Error() for the API's reason.
var ErrBadRequest = errors.New("maillabclient: bad request")

// Client wraps the HTTP API. Zero-value is invalid; use New().
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// New constructs a Client. Pass an empty apiKey to disable the auth
// header (for tests against an unauthenticated lab instance). The
// internal http.Client uses a 10s timeout — override via WithHTTP.
func New(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

// WithHTTP swaps the http.Client (test injection point + custom timeout).
func (c *Client) WithHTTP(h *http.Client) *Client {
	c.http = h
	return c
}

// ── Health ─────────────────────────────────────────────────────────────

// HealthResponse mirrors the /healthz body.
type HealthResponse struct {
	Status        string `json:"status"`
	UptimeSeconds int64  `json:"uptime_seconds"`
}

// Health queries /healthz. Returns the response or wraps the HTTP error.
func (c *Client) Health(ctx context.Context) (*HealthResponse, error) {
	var out HealthResponse
	if err := c.do(ctx, http.MethodGet, "/healthz", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Mailbox ────────────────────────────────────────────────────────────

// MailboxResponse mirrors POST /v1/mailbox / GET /v1/mailbox/:address.
type MailboxResponse struct {
	Address string `json:"address"`
	Domain  string `json:"domain"`
	Created bool   `json:"created,omitempty"`
}

// CreateMailbox provisions a new account.
func (c *Client) CreateMailbox(ctx context.Context, address, password string) (*MailboxResponse, error) {
	body := map[string]string{"address": address, "password": password}
	var out MailboxResponse
	if err := c.do(ctx, http.MethodPost, "/v1/mailbox", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetMailbox fetches metadata for an existing mailbox.
func (c *Client) GetMailbox(ctx context.Context, address string) (*MailboxResponse, error) {
	var out MailboxResponse
	if err := c.do(ctx, http.MethodGet, "/v1/mailbox/"+url.PathEscape(address), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteMailbox removes an account.
func (c *Client) DeleteMailbox(ctx context.Context, address string) error {
	return c.do(ctx, http.MethodDelete, "/v1/mailbox/"+url.PathEscape(address), nil, nil)
}

// ── Profile ────────────────────────────────────────────────────────────

// Profile mirrors profile.Profile in mail-lab-api. Field tags match the
// API JSON (snake_case).
type Profile struct {
	Domain                string   `json:"domain"`
	MaxMessageSizeBytes   int64    `json:"max_message_size_bytes"`
	MailboxQuotaBytes     int64    `json:"mailbox_quota_bytes"`
	RateLimitPerHour      int      `json:"rate_limit_per_hour"`
	RejectNonCzOrigin     bool     `json:"reject_non_cz_origin"`
	GreylistUnknownSender bool     `json:"greylist_unknown_sender"`
	SpamClassifyLinkRatio float64  `json:"spam_classify_link_ratio"`
	RejectProxyIpsCidr    []string `json:"reject_proxy_ips_cidr"`
	BounceKindOnReject    string   `json:"bounce_kind_on_reject"`
	DkimStrictness        string   `json:"dkim_strictness"`
	AutoReplyEnabled      bool     `json:"auto_reply_enabled"`
}

// ListProfiles returns every registered profile.
func (c *Client) ListProfiles(ctx context.Context) ([]Profile, error) {
	var out struct {
		Profiles []Profile `json:"profiles"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/profile", nil, &out); err != nil {
		return nil, err
	}
	return out.Profiles, nil
}

// GetProfile fetches a single profile by domain.
func (c *Client) GetProfile(ctx context.Context, domain string) (*Profile, error) {
	var out Profile
	if err := c.do(ctx, http.MethodGet, "/v1/profile/"+url.PathEscape(domain), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ApplyOverride merges runtime overrides into the profile. Only keys
// present in the map are touched; everything else stays at baseline.
func (c *Client) ApplyOverride(ctx context.Context, domain string, overrides map[string]interface{}) (*Profile, error) {
	var out Profile
	if err := c.do(ctx, http.MethodPost, "/v1/profile/"+url.PathEscape(domain)+"/override", overrides, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Verdict / DSN / Evaluate ───────────────────────────────────────────

// MessageContext mirrors profile.MessageContext (verdict signals).
type MessageContext struct {
	SizeBytes           int64   `json:"size_bytes,omitempty"`
	SenderIP            string  `json:"sender_ip,omitempty"`
	SenderOriginCountry string  `json:"sender_origin_country,omitempty"`
	LinkRatio           float64 `json:"link_ratio,omitempty"`
	HasDkim             bool    `json:"has_dkim,omitempty"`
	KnownSender         bool    `json:"known_sender,omitempty"`
}

// CheckResponse mirrors POST /v1/profile/{domain}/check.
type CheckResponse struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}

// Check runs the static verdict pure function.
func (c *Client) Check(ctx context.Context, domain string, msg MessageContext) (*CheckResponse, error) {
	var out CheckResponse
	if err := c.do(ctx, http.MethodPost, "/v1/profile/"+url.PathEscape(domain)+"/check", msg, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DSNEnvelope mirrors profile.DSNEnvelope.
type DSNEnvelope struct {
	OriginalFrom string    `json:"original_from,omitempty"`
	OriginalTo   string    `json:"original_to"`
	MessageID    string    `json:"message_id,omitempty"`
	ArrivalTime  time.Time `json:"arrival_time,omitempty"`
}

// DSN mirrors profile.DSN.
type DSN struct {
	From           string `json:"from"`
	To             string `json:"to"`
	Subject        string `json:"subject"`
	StatusCode     string `json:"status_code"`
	DiagnosticCode string `json:"diagnostic_code"`
	Action         string `json:"action"`
	ReportingMTA   string `json:"reporting_mta"`
	Body           string `json:"body"`
}

// PreviewDSNResponse mirrors POST /v1/profile/{domain}/dsn.
type PreviewDSNResponse struct {
	Decision string `json:"decision"`
	DSN      *DSN   `json:"dsn"`
}

// PreviewDSN returns the DSN that would be rendered for the given
// envelope + context.
func (c *Client) PreviewDSN(ctx context.Context, domain string, env DSNEnvelope, msg MessageContext) (*PreviewDSNResponse, error) {
	body := map[string]interface{}{"envelope": env, "context": msg}
	var out PreviewDSNResponse
	if err := c.do(ctx, http.MethodPost, "/v1/profile/"+url.PathEscape(domain)+"/dsn", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// EvaluateRequest mirrors profile.EvaluateRequest.
type EvaluateRequest struct {
	SenderMailbox       string  `json:"sender_mailbox,omitempty"`
	SenderIP            string  `json:"sender_ip,omitempty"`
	SenderAddr          string  `json:"sender_addr,omitempty"`
	RecipientAddr       string  `json:"recipient_addr,omitempty"`
	SizeBytes           int64   `json:"size_bytes,omitempty"`
	SenderOriginCountry string  `json:"sender_origin_country,omitempty"`
	LinkRatio           float64 `json:"link_ratio,omitempty"`
	HasDkim             bool    `json:"has_dkim,omitempty"`
	RecordRate          bool    `json:"record_rate,omitempty"`
}

// EvaluateResponse mirrors profile.EvaluateResult.
type EvaluateResponse struct {
	Decision  string `json:"decision"`
	Reason    string `json:"reason,omitempty"`
	FiredBy   string `json:"fired_by"`
	RateCount int    `json:"rate_count,omitempty"`
	RateLimit int    `json:"rate_limit,omitempty"`
}

// Evaluate runs the full pipeline (greylist → rate → static).
func (c *Client) Evaluate(ctx context.Context, domain string, req EvaluateRequest) (*EvaluateResponse, error) {
	var out EvaluateResponse
	if err := c.do(ctx, http.MethodPost, "/v1/profile/"+url.PathEscape(domain)+"/evaluate", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Rate / Quota / Greylist trackers ───────────────────────────────────

// RateResponse mirrors GET/POST /v1/profile/{domain}/rate/{mailbox}…
type RateResponse struct {
	Mailbox   string `json:"mailbox"`
	Domain    string `json:"domain"`
	Count     int    `json:"count"`
	Limit     int    `json:"limit"`
	Remaining int    `json:"remaining"`
}

// RateGet returns the current send count + limit for a mailbox.
func (c *Client) RateGet(ctx context.Context, domain, mailbox string) (*RateResponse, error) {
	var out RateResponse
	path := "/v1/profile/" + url.PathEscape(domain) + "/rate/" + url.PathEscape(mailbox)
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RateRecord increments the counter for a mailbox.
func (c *Client) RateRecord(ctx context.Context, domain, mailbox string) (*RateResponse, error) {
	var out RateResponse
	path := "/v1/profile/" + url.PathEscape(domain) + "/rate/" + url.PathEscape(mailbox) + "/record"
	if err := c.do(ctx, http.MethodPost, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// QuotaResponse mirrors GET/POST /v1/profile/{domain}/quota/{mailbox}…
type QuotaResponse struct {
	Mailbox string `json:"mailbox"`
	Domain  string `json:"domain"`
	Used    int64  `json:"used_bytes"`
	Cap     int64  `json:"cap_bytes"`
}

// QuotaGet returns current bytes used + profile cap.
func (c *Client) QuotaGet(ctx context.Context, domain, mailbox string) (*QuotaResponse, error) {
	var out QuotaResponse
	path := "/v1/profile/" + url.PathEscape(domain) + "/quota/" + url.PathEscape(mailbox)
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// QuotaAdd increments the byte counter (e.g. on inbound delivery).
func (c *Client) QuotaAdd(ctx context.Context, domain, mailbox string, bytes int64) (*QuotaResponse, error) {
	if bytes <= 0 {
		return nil, fmt.Errorf("maillabclient.QuotaAdd: bytes must be > 0, got %d", bytes)
	}
	body := map[string]int64{"bytes": bytes}
	var out QuotaResponse
	path := "/v1/profile/" + url.PathEscape(domain) + "/quota/" + url.PathEscape(mailbox) + "/add"
	if err := c.do(ctx, http.MethodPost, path, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GreylistRequest mirrors POST /v1/profile/{domain}/greylist/check.
type GreylistRequest struct {
	SenderIP      string `json:"sender_ip"`
	SenderAddr    string `json:"sender_addr"`
	RecipientAddr string `json:"recipient_addr"`
}

// GreylistResponse mirrors the same endpoint's response.
type GreylistResponse struct {
	Allow  bool   `json:"allow"`
	Reason string `json:"reason"`
}

// Greylist runs the triplet state machine. Returns allow=true once the
// triplet has graduated past the defer phase.
func (c *Client) Greylist(ctx context.Context, domain string, req GreylistRequest) (*GreylistResponse, error) {
	if strings.TrimSpace(req.RecipientAddr) == "" {
		return nil, fmt.Errorf("maillabclient.Greylist: recipient_addr required")
	}
	var out GreylistResponse
	path := "/v1/profile/" + url.PathEscape(domain) + "/greylist/check"
	if err := c.do(ctx, http.MethodPost, path, req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Operator reset + bounce delivery ───────────────────────────────────

// ResetAll clears every runtime tracker + reloads profiles. source can
// be "embedded" (default) or a filesystem path.
func (c *Client) ResetAll(ctx context.Context, source string) error {
	body := map[string]string{"source": source}
	return c.do(ctx, http.MethodPost, "/v1/profile/reset", body, nil)
}

// BounceRequest mirrors POST /v1/scenario/bounce.
type BounceRequest struct {
	RecipientDomain string                 `json:"recipient_domain"`
	OriginalTo      string                 `json:"original_to"`
	OriginalFrom    string                 `json:"original_from"`
	MessageID       string                 `json:"message_id,omitempty"`
	Context         map[string]interface{} `json:"context,omitempty"`
}

// BounceResponse mirrors the same endpoint's response.
type BounceResponse struct {
	Decision  string `json:"decision"`
	Reason    string `json:"reason,omitempty"`
	Delivered bool   `json:"delivered"`
	DSNBody   string `json:"dsn_body,omitempty"`
	Container string `json:"container,omitempty"`
}

// DeliverBounce synthesizes a DSN per the recipient's profile + verdict
// and delivers it to the sender's mailbox via docker exec sendmail.
func (c *Client) DeliverBounce(ctx context.Context, req BounceRequest) (*BounceResponse, error) {
	var out BounceResponse
	if err := c.do(ctx, http.MethodPost, "/v1/scenario/bounce", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── transport ──────────────────────────────────────────────────────────

// do is the shared HTTP plumbing. Marshals reqBody (if non-nil), sets
// auth header, parses status code into a typed error, decodes resp
// into respBody (if non-nil).
func (c *Client) do(ctx context.Context, method, path string, reqBody, respBody interface{}) error {
	var body io.Reader
	if reqBody != nil {
		buf, err := json.Marshal(reqBody)
		if err != nil {
			return fmt.Errorf("%s %s: marshal request: %w", method, path, err)
		}
		body = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return fmt.Errorf("%s %s: build request: %w", method, path, err)
	}
	if c.apiKey != "" {
		req.Header.Set("X-Lab-Api-Key", c.apiKey)
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return mapHTTPError(method, path, resp)
	}
	if resp.StatusCode == http.StatusNoContent || respBody == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(respBody); err != nil {
		return fmt.Errorf("%s %s: decode response: %w", method, path, err)
	}
	// Drain trailing bytes so HTTP keep-alive can reuse the connection
	// (#258 self-review HIGH).
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// errBodyMaxBytes caps how much of an error response body we include in
// the wrapped error message. Prevents leaking large stack traces / DB
// errors / credentials that a misconfigured server might return on 5xx.
const errBodyMaxBytes = 256

// truncate returns s shortened to maxBytes with an ellipsis suffix if
// it overflowed. Used to bound error-string size (#258 self-review HIGH).
func truncate(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	return s[:maxBytes] + "…(truncated)"
}

func mapHTTPError(method, path string, resp *http.Response) error {
	// Read full body up to a safe cap so JSON decode succeeds, but bound
	// the surface — server returning a giant stack trace shouldn't dump
	// into our logs / Sentry breadcrumbs.
	const readCap = 16 * 1024
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, readCap))
	_, _ = io.Copy(io.Discard, resp.Body) // drain any extra so keep-alive survives
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	// If JSON decode didn't yield an error field, fall back to the raw
	// body text (server might return non-JSON 5xx).
	msg := body.Error
	if msg == "" && len(raw) > 0 {
		msg = string(raw)
	}
	msg = truncate(msg, errBodyMaxBytes)
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return fmt.Errorf("%s %s: %w (%s)", method, path, ErrUnauthorized, msg)
	case http.StatusBadRequest:
		return fmt.Errorf("%s %s: %w (%s)", method, path, ErrBadRequest, msg)
	case http.StatusNotFound:
		return fmt.Errorf("%s %s: %w (%s)", method, path, ErrUnknownDomain, msg)
	default:
		return fmt.Errorf("%s %s: HTTP %d (%s)", method, path, resp.StatusCode, msg)
	}
}
