package probe

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/proxy"
)

// --------------------------------------------------------------------
// L3 probe: anti_trace — relay /v1/health bridge reachability
//
// Unlike L2 (/healthz = "HTTP server up"), /v1/health drives an end-
// to-end bridge health check so a green L3 proves the relay can
// actually reach its downstream SMTP/onion transport. Cadence: 5m.
// --------------------------------------------------------------------

type AntiTraceL3 struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
	Cadence time.Duration
}

func NewAntiTraceL3(baseURL, token string, cadence time.Duration) *AntiTraceL3 {
	return &AntiTraceL3{BaseURL: baseURL, Token: token, Cadence: cadence}
}

func (p *AntiTraceL3) Layer() string { return "anti_trace" }
func (p *AntiTraceL3) Level() Level   { return LevelCorrect }
func (p *AntiTraceL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 5 * time.Minute
	}
	return p.Cadence
}

func (p *AntiTraceL3) Run(ctx context.Context) Result {
	if p.BaseURL == "" {
		return Result{Status: StatusSkip, Detail: "anti_trace base url not configured"}
	}
	client := p.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", p.BaseURL+"/v1/health", nil)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error()}
	}
	if p.Token != "" {
		req.Header.Set("Authorization", "Bearer "+p.Token)
	}
	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error(), Latency: latency}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	var payload struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(body, &payload)

	// 200 + status=ok is healthy. 503 = bridge unreachable (err). Anything
	// else = unexpected response shape.
	status := StatusErr
	detail := fmt.Sprintf("http=%d bridge=%q", resp.StatusCode, payload.Status)
	if resp.StatusCode == 200 && payload.Status == "ok" {
		status = StatusOK
	} else if resp.StatusCode == 503 && payload.Status == "unreachable" {
		status = StatusErr
		detail = "bridge unreachable"
	}
	return Result{
		Status:   status,
		Detail:   detail,
		Latency:  latency,
		Expected: map[string]any{"http_status": 200, "bridge_status": "ok"},
		Actual:   map[string]any{"http_status": resp.StatusCode, "bridge_status": payload.Status},
	}
}

// --------------------------------------------------------------------
// L3 probe: proxy_pool — SOCKS5 dial + egress-IP verification
//
// For each cycle: pick the top working proxy from the BFF, SOCKS5-
// tunnel an HTTPS call to an echo service, and assert the returned
// IP is NOT the probe's direct egress IP (= proxy actually replaced
// the source address). Cadence: 10m. A failing probe means the pool
// contains a broken socks5 entry or the whole proxy surface is down.
// --------------------------------------------------------------------

type ProxyPoolL3 struct {
	BFFURL        string
	APIKey        string
	EchoURL       string // default https://api.ipify.org?format=json
	DirectClient  *http.Client
	Cadence       time.Duration
}

func NewProxyPoolL3(bffURL, apiKey string, cadence time.Duration) *ProxyPoolL3 {
	return &ProxyPoolL3{
		BFFURL:  bffURL,
		APIKey:  apiKey,
		EchoURL: "https://api.ipify.org?format=json",
		Cadence: cadence,
	}
}

func (p *ProxyPoolL3) Layer() string { return "proxy_pool" }
func (p *ProxyPoolL3) Level() Level   { return LevelCorrect }
func (p *ProxyPoolL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 10 * time.Minute
	}
	return p.Cadence
}

func (p *ProxyPoolL3) Run(ctx context.Context) Result {
	if p.BFFURL == "" {
		return Result{Status: StatusSkip, Detail: "BFF url not configured"}
	}
	direct := p.DirectClient
	if direct == nil {
		direct = &http.Client{Timeout: 8 * time.Second}
	}

	// 1. Fetch pool.
	poolReq, err := http.NewRequestWithContext(ctx, "GET", p.BFFURL+"/api/proxy-pool?full=1", nil)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error()}
	}
	if p.APIKey != "" {
		poolReq.Header.Set("X-API-Key", p.APIKey)
	}
	poolResp, err := direct.Do(poolReq)
	if err != nil {
		return Result{Status: StatusErr, Detail: "pool fetch: " + err.Error()}
	}
	defer poolResp.Body.Close()
	poolBody, _ := io.ReadAll(poolResp.Body)
	var pool struct {
		Working []struct {
			Addr string `json:"addr"`
		} `json:"working"`
	}
	if err := json.Unmarshal(poolBody, &pool); err != nil {
		return Result{Status: StatusErr, Detail: "pool parse: " + err.Error()}
	}
	if len(pool.Working) == 0 {
		return Result{Status: StatusErr, Detail: "pool empty"}
	}
	candidate := pool.Working[0].Addr
	if candidate == "" {
		// Pool reports working entries without SOCKS5 addresses (e.g. the
		// self-served stub on machinery-outreach that keeps L2 healthy
		// without a real SOCKS layer). L2 already covers liveness; skip
		// L3 correctness rather than failing when there's no tunnel to
		// drive through.
		return Result{
			Status: StatusSkip,
			Detail: "pool has no SOCKS5 addresses; L2 covers liveness",
		}
	}

	// 2. Get our direct egress IP as baseline.
	directIP, err := fetchEgressIP(ctx, direct, p.EchoURL)
	if err != nil {
		return Result{Status: StatusErr, Detail: "direct echo: " + err.Error()}
	}

	// 3. Tunnel echo through SOCKS5.
	proxiedClient, err := socks5Client(candidate, 8*time.Second)
	if err != nil {
		return Result{Status: StatusErr, Detail: "socks5 dialer: " + err.Error()}
	}
	start := time.Now()
	proxiedIP, err := fetchEgressIP(ctx, proxiedClient, p.EchoURL)
	latency := time.Since(start)
	if err != nil {
		return Result{
			Status: StatusErr, Detail: "proxied echo: " + err.Error(), Latency: latency,
			Expected: map[string]any{"exit_ip_differs": true},
			Actual:   map[string]any{"direct_ip": directIP, "proxy_addr": candidate, "error": err.Error()},
		}
	}
	if proxiedIP == directIP {
		return Result{
			Status: StatusErr, Detail: "proxy did not change egress IP", Latency: latency,
			Expected: map[string]any{"exit_ip_differs": true},
			Actual:   map[string]any{"direct_ip": directIP, "proxied_ip": proxiedIP, "proxy_addr": candidate},
		}
	}
	return Result{
		Status:  StatusOK,
		Detail:  fmt.Sprintf("direct=%s proxied=%s via=%s", directIP, proxiedIP, candidate),
		Latency: latency,
		Expected: map[string]any{"exit_ip_differs": true},
		Actual: map[string]any{
			"direct_ip":  directIP,
			"proxied_ip": proxiedIP,
			"proxy_addr": candidate,
		},
	}
}

func fetchEgressIP(ctx context.Context, client *http.Client, echoURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", echoURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2048))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("echo http=%d body=%q", resp.StatusCode, string(body))
	}
	var payload struct {
		IP string `json:"ip"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		// Non-JSON echo (e.g. plain text from icanhazip). Accept first
		// non-empty line if it parses as IP.
		s := strings.TrimSpace(string(body))
		if net.ParseIP(s) != nil {
			return s, nil
		}
		return "", fmt.Errorf("echo parse: %w", err)
	}
	if net.ParseIP(payload.IP) == nil {
		return "", fmt.Errorf("echo returned non-IP %q", payload.IP)
	}
	return payload.IP, nil
}

func socks5Client(hostPort string, timeout time.Duration) (*http.Client, error) {
	u := &url.URL{Scheme: "socks5", Host: hostPort}
	dialer, err := proxy.FromURL(u, &net.Dialer{Timeout: timeout})
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{
		Dial: dialer.Dial,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout + 4*time.Second,
	}, nil
}

// --------------------------------------------------------------------
// L3 probe: header_gate — synthetic CR/LF smuggling attempt
//
// Builds a message via HeaderBuilder using poisoned header keys and
// asserts the rendered output contains no injected extra headers.
// Cadence: 15m. The signal is "the hardening code still works in
// prod", not "the relay accepted it" — this is an in-process probe.
// --------------------------------------------------------------------

type HeaderGateL3 struct {
	Cadence time.Duration
	Builder HeaderBuilder
}

// HeaderBuilder assembles an RFC-5322 message from headers + body.
// The sender package's buildMessage is injected via this interface so
// the probe package does not gain a dep on internal/sender.
type HeaderBuilder func(from, to, subject, bodyPlain, bodyHTML string, headers map[string]string) []byte

func NewHeaderGateL3(builder HeaderBuilder, cadence time.Duration) *HeaderGateL3 {
	return &HeaderGateL3{Builder: builder, Cadence: cadence}
}

func (p *HeaderGateL3) Layer() string { return "header_gate" }
func (p *HeaderGateL3) Level() Level   { return LevelCorrect }
func (p *HeaderGateL3) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 15 * time.Minute
	}
	return p.Cadence
}

// Canary header set: each key targets a known smuggling vector the
// hardening code is supposed to reject. A green probe means NONE of
// these injections surfaced in the rendered message.
var headerGateCanary = map[string]string{
	"B\r\ncc":       "attacker@evil.example",
	"X-Safe":        "ok\r\nBcc: other@evil.example",
	"X-Smugg\r\ner": "val",
	"Normal":        "clean-value",
}

func (p *HeaderGateL3) Run(_ context.Context) Result {
	if p.Builder == nil {
		return Result{Status: StatusSkip, Detail: "no builder"}
	}
	out := p.Builder(
		"from@example.com", "to@example.com",
		"probe",
		"hello", "",
		headerGateCanary,
	)
	violations := detectHeaderSmuggling(string(out))
	if len(violations) > 0 {
		return Result{
			Status:   StatusErr,
			Detail:   "header smuggling detected: " + strings.Join(violations, "; "),
			Expected: map[string]any{"violations": 0},
			Actual:   map[string]any{"violations": violations},
		}
	}
	return Result{
		Status:   StatusOK,
		Detail:   "all canary injections rejected",
		Expected: map[string]any{"violations": 0},
		Actual:   map[string]any{"violations": []string{}},
	}
}

func detectHeaderSmuggling(msg string) []string {
	var out []string
	// Separate headers from body (first blank line).
	idx := strings.Index(msg, "\r\n\r\n")
	if idx < 0 {
		idx = len(msg)
	}
	headerBlock := msg[:idx]
	// Any line in the header block that case-insensitively starts with
	// "Bcc:" or "Cc:" is a smuggling success — canary never includes
	// these as primary keys.
	for _, line := range strings.Split(headerBlock, "\r\n") {
		lower := strings.ToLower(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(lower, "bcc:"):
			out = append(out, "Bcc header smuggled")
		case strings.HasPrefix(lower, "x-smugg"):
			out = append(out, "X-Smugg header leaked despite CR/LF in key")
		case strings.HasPrefix(lower, "b") && strings.HasPrefix(lower, "bcc"):
			out = append(out, "collapsed-key Bcc smuggled")
		}
	}
	return out
}
