package web

// Mailbox-probe and proxy-pool endpoints used by the BFF (apps/outreach-dashboard).
// These replace direct SMTP/IMAP/SOCKS5 calls that previously lived in server.js,
// so the only process that talks to mail hosts is the relay (SMTP-EGRESS-LOCKDOWN R3).

import (
	"relay/internal/delivery"
	"common/envconfig"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/smtp"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"relay/internal/transport"
	"relay/internal/transport/wgpool"
)

// ProxyPool is the subset of *transport.RotatingProxyTransport used by the probe
// handlers. Declared here so tests can pass a minimal fake.
type ProxyPool interface {
	Snapshot() transport.PoolSnapshot
}

// pickFreshProxy returns the best proxy address from a snapshot.
// Selection: highest ProxyScore() first, latency tiebreaker. Skips entries
// scoring below 0.2 unless ALL are below (then falls back to lowest-latency).
//
// This avoids the previous `Working[0]` pattern which always picked the same
// (often-stale) entry and ignored the per-proxy success-rate stats already
// tracked by transport.RecordProxyResult.
func pickFreshProxy(working []transport.PoolEntry) string {
	if len(working) == 0 {
		return ""
	}
	type scored struct {
		addr  string
		score float64
		ms    int64
	}
	all := make([]scored, 0, len(working))
	for _, e := range working {
		all = append(all, scored{addr: e.Addr, score: transport.ProxyScore(e.Addr), ms: e.LatencyMs})
	}
	// Prefer score >= 0.2; tiebreak by lower latency.
	viable := all[:0]
	for _, s := range all {
		if s.score >= 0.2 {
			viable = append(viable, s)
		}
	}
	pool := viable
	if len(pool) == 0 {
		pool = all // fallback — degraded routing beats blackout
	}
	best := pool[0]
	for _, s := range pool[1:] {
		if s.score > best.score || (s.score == best.score && s.ms > 0 && (best.ms == 0 || s.ms < best.ms)) {
			best = s
		}
	}
	return best.addr
}

// ProxyRefresher is implemented by *transport.RotatingProxyTransport. Declared
// separately so the admin handler can accept a minimal fake in tests.
type ProxyRefresher interface {
	ForceRefresh()
}

// WithProxyPool wires the shared proxy pool into the server so probe handlers
// can read pool state and dial through it.
func (s *Server) WithProxyPool(p ProxyPool) *Server {
	s.proxyPool = p
	return s
}

// WithFallbackProxyAddr sets the SOCKS5 address probe handlers use when the
// rotating pool is unavailable and the request did not specify `proxy_addr`.
// In Mullvad-only deployments this is the wireproxy localhost endpoint
// (e.g. "127.0.0.1:1080"). Empty disables the fallback.
func (s *Server) WithFallbackProxyAddr(addr string) *Server {
	s.fallbackProxyAddr = addr
	return s
}

// WithWGPool wires the multi-endpoint Mullvad pool into the server so
// /v1/proxy-pool can return its real per-endpoint health.
func (s *Server) WithWGPool(p *wgpool.Pool) *Server {
	s.wgPool = p
	return s
}

// probeSubcheck is the shape for one of the subchecks in a /v1/probe response.
// Mirrors the `checks.smtp|imap|proxy` object used by the BFF full-check cache.
type probeSubcheck struct {
	OK     bool            `json:"ok"`
	Ms     int64           `json:"ms"`
	Steps  []probeStep     `json:"steps,omitempty"`
	Error  string          `json:"error,omitempty"`
	Extra  map[string]any  `json:"extra,omitempty"`
	// PoolExhausted is true when wgPool.Pick returned ErrPoolExhausted.
	// handleProbe uses this to emit a typed HTTP 503 instead of an opaque 200.
	// Not included in JSON output (internal routing signal only).
	PoolExhausted bool `json:"-"`
}

type probeStep struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
	Ms   int64  `json:"ms"`
	Msg  string `json:"msg,omitempty"`
}

// ─── POST /v1/auth-check ───────────────────────────────────────────
// Input:  {smtp_host, smtp_port, smtp_username, password, proxy_addr?}
// Output: probeSubcheck
// Either proxy_addr is given (probe that specific SOCKS5), or we pick from pool.

type authCheckRequest struct {
	SMTPHost         string `json:"smtp_host"`
	SMTPPort         int    `json:"smtp_port"`
	SMTPUsername     string `json:"smtp_username"`
	Password         string `json:"password"`
	ProxyAddr        string `json:"proxy_addr,omitempty"`         // host:port SOCKS5; blank = dial through pool
	MailboxID        string `json:"mailbox_id,omitempty"`         // when set: route via wgPool (same path as drain)
	PreferredCountry string `json:"preferred_country,omitempty"` // ISO-3166-1 alpha-2; requires MailboxID
}

func (s *Server) handleAuthCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if _, ok := s.requireActor(w, r); !ok {
		return
	}

	var req authCheckRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.SMTPHost == "" || req.SMTPPort == 0 || req.SMTPUsername == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "smtp_host, smtp_port, smtp_username, password required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	// Resolve which proxy address will be used so we can pin after success.
	proxyAddr := resolveProxyAddr(s, req.ProxyAddr)

	result := s.smtpAuthProbe(ctx, req)

	// AP2: pin the mailbox to the endpoint used on first successful probe.
	if result.OK && s.wgPool != nil && req.SMTPUsername != "" && proxyAddr != "" {
		if label := s.wgPool.LabelBySocksAddr(proxyAddr); label != "" {
			_ = s.wgPool.SetPin(req.SMTPUsername, label, "probe_first")
		}
	}

	writeJSON(w, http.StatusOK, result)
}

// resolveProxyAddr returns the proxy address that smtpAuthProbe will use for
// a given request, without actually dialling. Used by AP2 pin-after-probe.
func resolveProxyAddr(s *Server, requestAddr string) string {
	if requestAddr != "" {
		return requestAddr
	}
	if s.proxyPool != nil {
		snap := s.proxyPool.Snapshot()
		if len(snap.Working) > 0 {
			return pickFreshProxy(snap.Working)
		}
	}
	return s.fallbackProxyAddr
}

// smtpAuthProbe connects to the target SMTP via a SOCKS5 proxy, does EHLO,
// STARTTLS (or implicit TLS on port 465), AUTH LOGIN, QUIT. Returns a
// probeSubcheck describing each step.
func (s *Server) smtpAuthProbe(ctx context.Context, req authCheckRequest) probeSubcheck {
	start := time.Now()
	subcheck := probeSubcheck{}
	appendStep := func(name string, ok bool, from time.Time, msg string) {
		subcheck.Steps = append(subcheck.Steps, probeStep{
			Name: name, OK: ok,
			Ms:  time.Since(from).Milliseconds(),
			Msg: msg,
		})
	}

	// AP4: track which endpoint was picked via wgPool for egress observation.
	var pickedCountry, pickedLabel string

	proxyAddr := req.ProxyAddr
	if proxyAddr == "" {
		switch {
		case s.wgPool != nil && req.MailboxID != "":
			// Same path as drain: country-pinned wgpool endpoint.
			// When mailbox_id is present we MUST use wgPool and MUST NOT
			// silently fall back to the free rotating pool — that would
			// produce the multi-country signal we are trying to eliminate.
			endpoint, err := s.wgPool.Pick("", req.MailboxID, req.PreferredCountry)
			if err != nil {
				subcheck.OK = false
				subcheck.Error = fmt.Sprintf("wgpool pick: %v", err)
				subcheck.Ms = time.Since(start).Milliseconds()
				// P1 Fix 6: propagate ErrPoolExhausted as a typed signal so the
				// HTTP handler can emit 503 {error: "pool_exhausted"} instead of
				// 200 with an opaque error string.
				if errors.Is(err, wgpool.ErrPoolExhausted) {
					subcheck.PoolExhausted = true
				}
				slog.Warn("probe_wgpool_pick_failed",
					"op", "probe.smtpAuthProbe/wgpool",
					"mailbox_id", req.MailboxID,
					"preferred_country", req.PreferredCountry,
					"error", err.Error(),
				)
				return subcheck
			}
			proxyAddr = endpoint.SocksAddr
			pickedCountry = endpoint.Country
			pickedLabel = endpoint.Label
			slog.Info("probe_via_wgpool",
				"op", "probe.smtpAuthProbe/wgpool",
				"mailbox_id", req.MailboxID,
				"country", req.PreferredCountry,
				"endpoint", endpoint.Label,
				"socks_addr", endpoint.SocksAddr,
			)
		case s.proxyPool != nil:
			// Backward compat: no mailbox_id → free rotating pool.
			if req.MailboxID != "" {
				// wgPool not configured but mailbox_id given — this is the fraud-lock
				// pattern: wgPool is required for per-mailbox routing and MUST NOT fall
				// back to the free rotating (multi-country) pool. Return a hard error.
				subcheck.OK = false
				subcheck.Error = "wgpool_required: wgPool not configured but mailbox_id set — refusing free-pool fallback"
				subcheck.Ms = time.Since(start).Milliseconds()
				slog.Error("probe.fail/wgpool_required",
					"op", "probe.smtpAuthProbe/wgpool_required",
					"mailbox_id", req.MailboxID,
					"error", "wgPool nil but mailbox_id set — ErrWgPoolUnavailableForMailbox",
				)
				return subcheck
			}
			snap := s.proxyPool.Snapshot()
			if len(snap.Working) == 0 {
				subcheck.OK = false
				subcheck.Error = "proxy pool empty"
				subcheck.Ms = time.Since(start).Milliseconds()
				return subcheck
			}
			proxyAddr = pickFreshProxy(snap.Working)
		case s.fallbackProxyAddr != "":
			proxyAddr = s.fallbackProxyAddr
		default:
			subcheck.OK = false
			subcheck.Error = "no proxy pool configured and no proxy_addr provided"
			subcheck.Ms = time.Since(start).Milliseconds()
			return subcheck
		}
	}

	target := fmt.Sprintf("%s:%d", req.SMTPHost, req.SMTPPort)

	dialStart := time.Now()
	socks := transport.NewSOCKS5Transport(proxyAddr, 10*time.Second)
	conn, err := socks.DialContext(ctx, "tcp", target)
	if err != nil {
		appendStep("socks_dial", false, dialStart, err.Error())
		subcheck.Error = err.Error()
		subcheck.Ms = time.Since(start).Milliseconds()
		return subcheck
	}
	appendStep("socks_dial", true, dialStart, "")
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline) // error is non-fatal: deadline best-effort on already-connected sock
	}

	var smtpConn net.Conn = conn
	if req.SMTPPort == 465 {
		tlsStart := time.Now()
		tlsCfg := transport.SMTPParrotTLS(req.SMTPHost)
		tlsConn := tls.Client(conn, tlsCfg)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			appendStep("tls_handshake", false, tlsStart, err.Error())
			subcheck.Error = err.Error()
			subcheck.Ms = time.Since(start).Milliseconds()
			return subcheck
		}
		appendStep("tls_handshake", true, tlsStart, "")
		smtpConn = tlsConn
	}

	clientStart := time.Now()
	client, err := smtp.NewClient(smtpConn, req.SMTPHost)
	if err != nil {
		appendStep("smtp_client", false, clientStart, err.Error())
		subcheck.Error = err.Error()
		subcheck.Ms = time.Since(start).Milliseconds()
		return subcheck
	}
	appendStep("smtp_client", true, clientStart, "")
	defer client.Close()

	if req.SMTPPort == 587 {
		sttStart := time.Now()
		tlsCfg := transport.SMTPParrotTLS(req.SMTPHost)
		if err := client.StartTLS(tlsCfg); err != nil {
			appendStep("starttls", false, sttStart, err.Error())
			subcheck.Error = err.Error()
			subcheck.Ms = time.Since(start).Milliseconds()
			return subcheck
		}
		appendStep("starttls", true, sttStart, "")
	}

	// Try AUTH LOGIN first (required by seznam.cz and Czech providers);
	// fall back to AUTH PLAIN if LOGIN is not advertised.
	authStart := time.Now()
	_, exts := client.Extension("AUTH")
	var auth smtp.Auth
	if strings.Contains(exts, "LOGIN") {
		auth = delivery.LoginAuth(req.SMTPUsername, req.Password)
	} else {
		auth = smtp.PlainAuth("", req.SMTPUsername, req.Password, req.SMTPHost)
	}
	if err := client.Auth(auth); err != nil {
		appendStep("smtp_auth", false, authStart, err.Error())
		subcheck.Error = err.Error()
		subcheck.Ms = time.Since(start).Milliseconds()
		return subcheck
	}
	appendStep("smtp_auth", true, authStart, "")

	_ = client.Quit()
	subcheck.OK = true
	subcheck.Ms = time.Since(start).Milliseconds()
	// AP4 — record egress observation on successful probe via wgPool.
	if s.wgPool != nil && req.MailboxID != "" && pickedCountry != "" {
		s.wgPool.RecordEgressObservation(req.MailboxID, pickedCountry, pickedLabel, "probe")
	}
	return subcheck
}

// ─── POST /v1/probe ────────────────────────────────────────────────
// Input: {smtp_host, smtp_port, smtp_username, password, imap_host?, imap_port?, imap_username?, proxy_url?}
// Output: {checks: {smtp, imap, proxy}}
//
// The BFF /api/mailboxes/:id/full-check includes additional DB-sourced subchecks
// (config, warmup, bounce, send_rate, pipeline). Those remain BFF-owned. This
// endpoint covers only the network-probe subset.

type probeRequest struct {
	SMTPHost         string `json:"smtp_host"`
	SMTPPort         int    `json:"smtp_port"`
	SMTPUsername     string `json:"smtp_username"`
	Password         string `json:"password"`
	IMAPHost         string `json:"imap_host,omitempty"`
	IMAPPort         int    `json:"imap_port,omitempty"`
	IMAPUsername     string `json:"imap_username,omitempty"`
	ProxyURL         string `json:"proxy_url,omitempty"`         // socks5://host:port
	MailboxID        string `json:"mailbox_id,omitempty"`        // when set: route via wgPool (same path as drain)
	PreferredCountry string `json:"preferred_country,omitempty"` // ISO-3166-1 alpha-2; requires MailboxID
}

type probeResponse struct {
	Checks struct {
		SMTP  probeSubcheck  `json:"smtp"`
		IMAP  *probeSubcheck `json:"imap,omitempty"`
		Proxy *probeSubcheck `json:"proxy,omitempty"`
	} `json:"checks"`
	CheckedAt string `json:"checked_at"`
}

func (s *Server) handleProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if _, ok := s.requireActor(w, r); !ok {
		return
	}

	var req probeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.SMTPHost == "" || req.SMTPPort == 0 || req.SMTPUsername == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "smtp_host, smtp_port, smtp_username, password required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	resp := probeResponse{CheckedAt: time.Now().UTC().Format(time.RFC3339)}

	proxyAddr := ""
	if req.ProxyURL != "" {
		proxyAddr = strings.TrimPrefix(req.ProxyURL, "socks5://")
	}

	resp.Checks.SMTP = s.smtpAuthProbe(ctx, authCheckRequest{
		SMTPHost: req.SMTPHost, SMTPPort: req.SMTPPort,
		SMTPUsername: req.SMTPUsername, Password: req.Password,
		ProxyAddr:        proxyAddr,
		MailboxID:        req.MailboxID,
		PreferredCountry: req.PreferredCountry,
	})

	// P1 Fix 6: ErrPoolExhausted → typed HTTP 503 so callers can distinguish
	// "probe ran but failed auth" (200/ok=false) from "no endpoint available" (503).
	if resp.Checks.SMTP.PoolExhausted {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error":  "pool_exhausted",
			"detail": resp.Checks.SMTP.Error,
		})
		return
	}

	if req.IMAPHost != "" && req.IMAPPort != 0 {
		imap := s.imapAuthProbe(ctx, req, proxyAddr)
		// P1 Fix 6: propagate pool exhaustion from IMAP probe too.
		if imap.PoolExhausted {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{
				"error":  "pool_exhausted",
				"detail": imap.Error,
			})
			return
		}
		resp.Checks.IMAP = &imap
	}

	if proxyAddr != "" {
		proxy := s.proxyLivenessProbe(ctx, proxyAddr, req.SMTPHost, req.SMTPPort)
		proxy.Extra = map[string]any{"proxy_url": req.ProxyURL}
		resp.Checks.Proxy = &proxy
	}

	writeJSON(w, http.StatusOK, resp)
}

// imapAuthProbe does a minimal IMAP LOGIN dance through the proxy.
// Protocol: read greeting, send "a1 LOGIN user pass", read status, "a2 LOGOUT".
func (s *Server) imapAuthProbe(ctx context.Context, req probeRequest, proxyAddr string) probeSubcheck {
	start := time.Now()
	sc := probeSubcheck{}
	appendStep := func(name string, ok bool, from time.Time, msg string) {
		sc.Steps = append(sc.Steps, probeStep{Name: name, OK: ok, Ms: time.Since(from).Milliseconds(), Msg: msg})
	}

	// AP4: track which endpoint was picked via wgPool for egress observation.
	var imapPickedCountry, imapPickedLabel string

	if proxyAddr == "" {
		switch {
		case s.wgPool != nil && req.MailboxID != "":
			// Same path as drain: country-pinned wgpool endpoint.
			// When mailbox_id is present we MUST use wgPool and MUST NOT
			// silently fall back to the free rotating pool.
			endpoint, err := s.wgPool.Pick("", req.MailboxID, req.PreferredCountry)
			if err != nil {
				sc.Error = fmt.Sprintf("wgpool pick: %v", err)
				sc.Ms = time.Since(start).Milliseconds()
				// P1 Fix 6: propagate ErrPoolExhausted as typed signal.
				if errors.Is(err, wgpool.ErrPoolExhausted) {
					sc.PoolExhausted = true
				}
				slog.Warn("probe_wgpool_pick_failed",
					"op", "probe.imapAuthProbe/wgpool",
					"mailbox_id", req.MailboxID,
					"preferred_country", req.PreferredCountry,
					"error", err.Error(),
				)
				return sc
			}
			proxyAddr = endpoint.SocksAddr
			imapPickedCountry = endpoint.Country
			imapPickedLabel = endpoint.Label
			slog.Info("probe_via_wgpool",
				"op", "probe.imapAuthProbe/wgpool",
				"mailbox_id", req.MailboxID,
				"country", req.PreferredCountry,
				"endpoint", endpoint.Label,
				"socks_addr", endpoint.SocksAddr,
			)
		case s.proxyPool != nil:
			// Backward compat: no mailbox_id → free rotating pool.
			if req.MailboxID != "" {
				// wgPool not configured but mailbox_id given — same fraud-lock risk as
				// smtpAuthProbe: refuse fallback to free multi-country pool.
				sc.OK = false
				sc.Error = "wgpool_required: wgPool not configured but mailbox_id set — refusing free-pool fallback"
				sc.Ms = time.Since(start).Milliseconds()
				slog.Error("probe.fail/wgpool_required",
					"op", "probe.imapAuthProbe/wgpool_required",
					"mailbox_id", req.MailboxID,
					"error", "wgPool nil but mailbox_id set — ErrWgPoolUnavailableForMailbox",
				)
				return sc
			}
			snap := s.proxyPool.Snapshot()
			if len(snap.Working) == 0 {
				sc.Error = "proxy pool empty"
				sc.Ms = time.Since(start).Milliseconds()
				return sc
			}
			proxyAddr = pickFreshProxy(snap.Working)
		case s.fallbackProxyAddr != "":
			proxyAddr = s.fallbackProxyAddr
		default:
			sc.Error = "no proxy pool"
			sc.Ms = time.Since(start).Milliseconds()
			return sc
		}
	}

	target := fmt.Sprintf("%s:%d", req.IMAPHost, req.IMAPPort)
	dialStart := time.Now()
	socks := transport.NewSOCKS5Transport(proxyAddr, 10*time.Second)
	conn, err := socks.DialContext(ctx, "tcp", target)
	if err != nil {
		appendStep("socks_dial", false, dialStart, err.Error())
		sc.Error = err.Error()
		sc.Ms = time.Since(start).Milliseconds()
		return sc
	}
	appendStep("socks_dial", true, dialStart, "")
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline) // error is non-fatal: deadline best-effort on already-connected sock
	}

	var imapConn net.Conn = conn
	if req.IMAPPort == 993 {
		tlsStart := time.Now()
		tlsConn := tls.Client(conn, transport.SMTPParrotTLS(req.IMAPHost))
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			appendStep("tls_handshake", false, tlsStart, err.Error())
			sc.Error = err.Error()
			sc.Ms = time.Since(start).Milliseconds()
			return sc
		}
		appendStep("tls_handshake", true, tlsStart, "")
		imapConn = tlsConn
	}

	user := req.IMAPUsername
	if user == "" {
		user = req.SMTPUsername
	}

	buf := make([]byte, 4096)
	if _, err := imapConn.Read(buf); err != nil {
		appendStep("imap_greeting", false, start, err.Error())
		sc.Error = err.Error()
		sc.Ms = time.Since(start).Milliseconds()
		return sc
	}
	appendStep("imap_greeting", true, start, "")

	loginStart := time.Now()
	login := fmt.Sprintf("a1 LOGIN %q %q\r\n", user, req.Password)
	if _, err := imapConn.Write([]byte(login)); err != nil {
		appendStep("imap_login_write", false, loginStart, err.Error())
		sc.Error = err.Error()
		sc.Ms = time.Since(start).Milliseconds()
		return sc
	}
	n, err := imapConn.Read(buf)
	if err != nil {
		appendStep("imap_login_read", false, loginStart, err.Error())
		sc.Error = err.Error()
		sc.Ms = time.Since(start).Milliseconds()
		return sc
	}
	resp := string(buf[:n])
	if !strings.Contains(resp, "a1 OK") {
		appendStep("imap_login", false, loginStart, strings.TrimSpace(resp))
		sc.Error = "login failed"
		sc.Ms = time.Since(start).Milliseconds()
		return sc
	}
	appendStep("imap_login", true, loginStart, "")

	_, _ = imapConn.Write([]byte("a2 LOGOUT\r\n"))
	sc.OK = true
	sc.Ms = time.Since(start).Milliseconds()
	// AP4 — record egress observation on successful IMAP probe via wgPool.
	if s.wgPool != nil && req.MailboxID != "" && imapPickedCountry != "" {
		s.wgPool.RecordEgressObservation(req.MailboxID, imapPickedCountry, imapPickedLabel, "probe")
	}
	return sc
}

// proxyLivenessProbe confirms the SOCKS5 can reach the SMTP target without auth.
// Reports latency only — useful when BFF wants to show "proxy online" separately
// from "SMTP auth succeeded".
func (s *Server) proxyLivenessProbe(ctx context.Context, proxyAddr, smtpHost string, smtpPort int) probeSubcheck {
	start := time.Now()
	sc := probeSubcheck{}

	socks := transport.NewSOCKS5Transport(proxyAddr, 8*time.Second)
	target := fmt.Sprintf("%s:%d", smtpHost, smtpPort)
	conn, err := socks.DialContext(ctx, "tcp", target)
	if err != nil {
		sc.Error = err.Error()
		sc.Ms = time.Since(start).Milliseconds()
		return sc
	}
	conn.Close()
	sc.OK = true
	sc.Ms = time.Since(start).Milliseconds()
	return sc
}

// ─── GET /v1/proxy-pool ────────────────────────────────────────────
// Output: {mode, working: [...], count, ...}

type proxyPoolResponse struct {
	// Mode indicates the egress architecture:
	//   "wg-pool"       — multi-endpoint Mullvad rotation (wgpool.Pool)
	//   "rotating-pool" — RotatingProxyTransport drives Working[]
	//   "mullvad"       — single SOCKS5 hop via fallbackProxyAddr;
	//                     Working is empty by design
	//   "none"          — neither pool nor fallback configured
	Mode                     string             `json:"mode"`
	Working                  []proxyPoolEntry   `json:"working"`
	Count                    int                `json:"count"`
	LastRefresh              string             `json:"last_refresh,omitempty"`
	ConsecutiveZeroRefreshes int32              `json:"consecutive_zero_refreshes"`
	EmptyPoolCritical        bool               `json:"empty_pool_critical"`
	// WGPool fields populated when Mode=="wg-pool".
	PoolSize             int                  `json:"pool_size,omitempty"`
	ActiveEndpoints      int                  `json:"active_endpoints,omitempty"`
	QuarantinedEndpoints int                  `json:"quarantined_endpoints,omitempty"`
	Endpoints            []wgPoolEndpointStat `json:"endpoints,omitempty"`
}

type proxyPoolEntry struct {
	Addr      string `json:"addr"`
	LatencyMs int64  `json:"latency_ms"`
	Country   string `json:"country,omitempty"`
	Source    string `json:"source,omitempty"`
}

// wgPoolEndpointStat is the per-endpoint truth surface that replaces the
// synthetic data the BFF was previously fabricating.
type wgPoolEndpointStat struct {
	Label           string `json:"label"`
	SocksAddr       string `json:"socks_addr"`
	Country         string `json:"country,omitempty"`
	City            string `json:"city,omitempty"`
	PeerHost        string `json:"peer_host,omitempty"`
	LastOK          string `json:"last_ok,omitempty"`
	LastFail        string `json:"last_fail,omitempty"`
	ConsecutiveFail int    `json:"consecutive_fail"`
	Quarantined     bool   `json:"quarantined"`
	QuarantineUntil string `json:"quarantine_until,omitempty"`
	OKCount         uint64 `json:"ok_count"`
	FailCount       uint64 `json:"fail_count"`
}

func (s *Server) handleProxyPool(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if _, ok := s.requireActor(w, r); !ok {
		return
	}

	// Multi-endpoint Mullvad pool wins when wired.
	if s.wgPool != nil {
		writeJSON(w, http.StatusOK, buildWGPoolResponse(s.wgPool))
		return
	}

	if s.proxyPool == nil {
		mode := "none"
		if s.fallbackProxyAddr != "" {
			mode = "mullvad"
		}
		writeJSON(w, http.StatusOK, proxyPoolResponse{
			Mode:    mode,
			Working: []proxyPoolEntry{},
			Count:   0,
		})
		return
	}

	snap := s.proxyPool.Snapshot()
	out := proxyPoolResponse{
		Mode:                     "rotating-pool",
		Working:                  make([]proxyPoolEntry, 0, len(snap.Working)),
		Count:                    len(snap.Working),
		ConsecutiveZeroRefreshes: snap.ConsecutiveZeroRefreshes,
		EmptyPoolCritical:        snap.EmptyPoolCritical,
	}
	for _, e := range snap.Working {
		out.Working = append(out.Working, proxyPoolEntry{
			Addr:      e.Addr,
			LatencyMs: e.Latency.Milliseconds(),
			Country:   e.Country,
			Source:    e.Source,
		})
	}
	if !snap.LastRefresh.IsZero() {
		out.LastRefresh = snap.LastRefresh.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, out)
}

// buildWGPoolResponse converts a wgpool.Pool snapshot into the public
// /v1/proxy-pool JSON shape. Pulled out so tests can construct it
// without spinning up an http.Server.
func buildWGPoolResponse(pool *wgpool.Pool) proxyPoolResponse {
	snap := pool.Snapshot()
	out := proxyPoolResponse{
		Mode:      "wg-pool",
		Working:   []proxyPoolEntry{},
		Count:     0,
		PoolSize:  pool.Size(),
		Endpoints: make([]wgPoolEndpointStat, 0, len(snap)),
	}
	for _, h := range snap {
		stat := wgPoolEndpointStat{
			Label:           h.Endpoint.Label,
			SocksAddr:       h.Endpoint.SocksAddr,
			Country:         h.Endpoint.Country,
			City:            h.Endpoint.City,
			PeerHost:        h.Endpoint.PeerHost,
			ConsecutiveFail: h.ConsecutiveFail,
			Quarantined:     h.Quarantined,
			OKCount:         h.OKCount,
			FailCount:       h.FailCount,
		}
		if !h.LastOK.IsZero() {
			stat.LastOK = h.LastOK.UTC().Format(time.RFC3339)
		}
		if !h.LastFail.IsZero() {
			stat.LastFail = h.LastFail.UTC().Format(time.RFC3339)
		}
		if !h.QuarantineUntil.IsZero() {
			stat.QuarantineUntil = h.QuarantineUntil.UTC().Format(time.RFC3339)
		}
		out.Endpoints = append(out.Endpoints, stat)
		if h.Quarantined {
			out.QuarantinedEndpoints++
		} else {
			out.ActiveEndpoints++
			out.Working = append(out.Working, proxyPoolEntry{
				Addr:    h.Endpoint.SocksAddr,
				Country: h.Endpoint.Country,
			})
		}
	}
	out.Count = out.ActiveEndpoints
	return out
}

// ─── Rate limiter for /v1/imap-socks-addr ────────────────────────────────────
// P2 FIX: simple per-source-IP rate limit (60 req/min).
var imapSocksAddrLimiter = newIPRateLimiter(60, 60*time.Second)

type ipRateLimiter struct {
	mu      sync.Mutex
	counts  map[string][]time.Time
	limit   int
	window  time.Duration
}

func newIPRateLimiter(limit int, window time.Duration) *ipRateLimiter {
	return &ipRateLimiter{
		counts: make(map[string][]time.Time),
		limit: limit,
		window: window,
	}
}

// Allow returns true if the IP has not exceeded the limit in the window.
// P2 FIX: 61st request within 60s returns false + 429.
func (l *ipRateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if _, ok := l.counts[ip]; !ok {
		l.counts[ip] = []time.Time{}
	}
	// Prune old entries outside the window
	filtered := make([]time.Time, 0, l.limit)
	for _, t := range l.counts[ip] {
		if now.Sub(t) < l.window {
			filtered = append(filtered, t)
		}
	}
	l.counts[ip] = filtered
	if len(filtered) >= l.limit {
		return false
	}
	l.counts[ip] = append(filtered, now)
	return true
}

// ─── GET /v1/imap-socks-addr ──────────────────────────────────────────────────
// Sprint AO1: BFF IMAP-via-SOCKS5.
//
// Returns the SOCKS5 address (127.0.0.1:108X) the BFF should use when dialling
// IMAP for a given mailbox. Query parameter:
//   - preferred_country (optional, ISO-2): pin the endpoint to a country.
//     Falls back to any active endpoint when unset or no in-country ep available.
//
// In wgpool mode the relay calls Pool.Pick to honour affinity + country pin.
// In socks5 (single endpoint) mode it returns the configured SOCKS_PROXY_ADDR.
// Returns 503 when no endpoint is available.
// P2 FIX: Rate limit 60 req/min per source IP; 429 on overflow.
//
// No bearer auth required — only returns loopback addresses (127.0.0.1:108X).
func (s *Server) handleImapSocksAddr(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// P2 FIX: rate limit per source IP
	sourceIP := strings.Split(r.RemoteAddr, ":")[0]
	if !imapSocksAddrLimiter.Allow(sourceIP) {
		writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
		return
	}

	preferredCountry := strings.TrimSpace(r.URL.Query().Get("preferred_country"))

	if s.wgPool != nil {
		ep, err := s.wgPool.Pick("", "", preferredCountry)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "no active wgpool endpoint: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"socks_addr": ep.SocksAddr,
			"country":    ep.Country,
			"label":      ep.Label,
		})
		return
	}

	// Single-endpoint (Mullvad socks5 / wireproxy) mode.
	addr := s.fallbackProxyAddr
	if addr == "" {
		writeError(w, http.StatusServiceUnavailable, "relay not configured (no wgPool, no fallback proxy)")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"socks_addr": addr,
		"country":    "",
		"label":      "single",
	})
}

// ─── POST /v1/verify ───────────────────────────────────────────────
// Email-address RCPT-TO probe via SMTP EHLO/MAIL FROM/RCPT TO/RSET/QUIT.
// Disabled unless VERIFY_EMAIL_ENABLED=true because RCPT probing is
// aggressive and can hurt sender reputation if abused.
//
// Rate limit: 5 s spacing per-MX host (enforced by verifyMXGate).
// Timeout: 15 s per probe (context deadline).
// Egress: through wgsocks SOCKS5 proxy (same path as campaign sends).
//
// Response status values:
//   "valid"     — RCPT TO accepted (250)
//   "invalid"   — RCPT TO hard-rejected (5xx) or domain has no MX
//   "catch_all" — domain accepts any address (random canary got 250)
//   "unknown"   — connection error, greylist (4xx), or feature disabled

type verifyRequest struct {
	Email  string `json:"email"`
	Domain string `json:"domain,omitempty"`
}

type verifyResponse struct {
	Status string `json:"status"`         // "valid" | "invalid" | "catch_all" | "unknown"
	Code   int    `json:"code,omitempty"` // SMTP response code, 0 when not reached
	Reason string `json:"reason,omitempty"`
}

// verifyMXGate enforces per-MX host rate limiting (5 s minimum spacing).
var verifyMXGate = newMXRateLimiter(5 * time.Second)

func newMXRateLimiter(spacing time.Duration) *mxRateLimiter {
	return &mxRateLimiter{
		last:    make(map[string]time.Time),
		spacing: spacing,
	}
}

type mxRateLimiter struct {
	mu      sync.Mutex
	last    map[string]time.Time
	spacing time.Duration
}

// Allow returns true if enough time has passed since the last probe for host.
// It always records the current time regardless.
func (m *mxRateLimiter) Allow(host string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if t, ok := m.last[host]; ok && now.Sub(t) < m.spacing {
		return false
	}
	m.last[host] = now
	return true
}

// verifyGetEnv reads an environment variable. Injectable in tests to avoid
// mutating os.Environ (tests swap this to a closed-over map).
// envconfig-allowed: test-injectable func var — closure wraps os.Getenv; callers use envconfig.GetOr via verifyFromAddr/verifyHeloDomain
var verifyGetEnv = func(key string) string { return os.Getenv(key) }

// verifyFromAddr returns the MAIL FROM address for RCPT-TO probing.
// Reads RELAY_VERIFY_FROM; defaults to "probe@email.cz".
func verifyFromAddr() string {
	if v := strings.TrimSpace(verifyGetEnv("RELAY_VERIFY_FROM")); v != "" {
		return v
	}
	return "probe@email.cz"
}

// verifyHeloDomain returns the EHLO domain for RCPT-TO probing.
// Reads RELAY_HELO_DOMAIN; defaults to "email.cz".
func verifyHeloDomain() string {
	if v := strings.TrimSpace(verifyGetEnv("RELAY_HELO_DOMAIN")); v != "" {
		return v
	}
	return "email.cz"
}

// verifySocksAddr picks the SOCKS5 proxy address for RCPT-TO probes.
// Prefers the server's fallbackProxyAddr (wgsocks on 127.0.0.1:1080).
func (s *Server) verifySocksAddr() string {
	if s.fallbackProxyAddr != "" {
		return s.fallbackProxyAddr
	}
	if s.proxyPool != nil {
		snap := s.proxyPool.Snapshot()
		if len(snap.Working) > 0 {
			return pickFreshProxy(snap.Working)
		}
	}
	return ""
}

// verifyDirectEgress reports whether the verify probe should use Railway native
// egress (direct TCP dial) instead of the SOCKS5/wgsocks pool.
// Defaults to true; set VERIFY_VIA_DIRECT_EGRESS=false to revert to SOCKS5 (legacy).
func verifyDirectEgress() bool {
	return envconfig.GetOr("VERIFY_VIA_DIRECT_EGRESS", "true") != "false"
}

// smtpRCPTProbe dials the MX host and performs the EHLO / MAIL FROM / RCPT TO /
// RSET / QUIT exchange.  When VERIFY_VIA_DIRECT_EGRESS != "false" (default) it
// uses Railway native egress (plain net.Dialer) so that CZ SMTP servers (Seznam
// etc.) are not blocked by the Mullvad VPN range and Mullvad IP reputation is
// preserved for actual sending.  When VERIFY_VIA_DIRECT_EGRESS=false it falls
// back to the legacy SOCKS5 path (socksAddr must be non-empty).
// Returns the SMTP numeric code and a human-readable reason.
// A code of 0 means the probe did not reach the RCPT TO stage.
var smtpRCPTProbe = func(ctx context.Context, socksAddr, mxHost, recipient string) (code int, reason string) {
	target := net.JoinHostPort(mxHost, "25")
	var conn net.Conn
	var err error
	if verifyDirectEgress() {
		// Direct dial — Railway native egress; no SOCKS5 involved.
		conn, err = (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", target)
	} else {
		// Legacy: SOCKS5 via wgsocks (deprecated for probing).
		socks := transport.NewSOCKS5Transport(socksAddr, 10*time.Second)
		conn, err = socks.DialContext(ctx, "tcp", target)
	}
	if err != nil {
		return 0, fmt.Sprintf("connection failed: %v", err)
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	client, err := smtp.NewClient(conn, mxHost)
	if err != nil {
		return 0, fmt.Sprintf("smtp client: %v", err)
	}
	defer client.Close()

	helo := verifyHeloDomain()
	if err := client.Hello(helo); err != nil {
		return 0, fmt.Sprintf("EHLO failed: %v", err)
	}

	from := verifyFromAddr()
	if err := client.Mail(from); err != nil {
		return 0, fmt.Sprintf("MAIL FROM failed: %v", err)
	}

	// RCPT TO — this is the probe that tells us whether the mailbox exists.
	err = client.Rcpt(recipient)
	if err == nil {
		_ = client.Reset()
		_ = client.Quit()
		return 250, "accepted"
	}

	// Extract SMTP numeric code from the error string.
	code = extractSMTPCode(err.Error())
	_ = client.Reset()
	_ = client.Quit()
	return code, err.Error()
}

// extractSMTPCode parses the leading 3-digit SMTP status code from an error
// string of the form "550 5.1.1 ..." or "452 ...". Returns 0 if not found.
func extractSMTPCode(msg string) int {
	if len(msg) < 3 {
		return 0
	}
	code := 0
	for i := 0; i < 3; i++ {
		c := msg[i]
		if c < '0' || c > '9' {
			return 0
		}
		code = code*10 + int(c-'0')
	}
	// Validate: 100-599 range
	if code < 100 || code > 599 {
		return 0
	}
	return code
}

// lookupMXHosts returns the MX hosts for a domain sorted by priority (lowest = highest priority).
// Uses net.LookupMX (injectable for tests via verifyLookupMX).
var verifyLookupMX = func(ctx context.Context, domain string) ([]*net.MX, error) {
	return net.DefaultResolver.LookupMX(ctx, domain)
}

func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if _, ok := s.requireActor(w, r); !ok {
		return
	}

	var req verifyRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Email == "" {
		writeError(w, http.StatusBadRequest, "email required")
		return
	}

	if !s.verifyEnabled {
		writeJSON(w, http.StatusOK, verifyResponse{Status: "unknown", Reason: "verify disabled (VERIFY_EMAIL_ENABLED=false)"})
		return
	}

	resp := s.runVerify(r.Context(), req.Email)
	writeJSON(w, http.StatusOK, resp)
}

// runVerify performs the full MX lookup + SMTP RCPT-TO probe.
func (s *Server) runVerify(ctx context.Context, email string) verifyResponse {
	// Basic syntax check: must have exactly one @ with non-empty local and domain.
	at := strings.LastIndex(email, "@")
	if at < 1 || at >= len(email)-1 {
		return verifyResponse{Status: "invalid", Reason: "invalid email syntax"}
	}
	domain := strings.ToLower(email[at+1:])
	if strings.ContainsAny(domain, " \t\r\n") || !strings.Contains(domain, ".") {
		return verifyResponse{Status: "invalid", Reason: "invalid domain"}
	}

	// MX lookup (15 s cap, shared with total probe budget).
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	mxRecords, err := verifyLookupMX(probeCtx, domain)
	if err != nil || len(mxRecords) == 0 {
		return verifyResponse{Status: "invalid", Reason: "no MX records for domain"}
	}

	// Sort by priority ascending (net.LookupMX does not guarantee order).
	sortedMX := make([]*net.MX, len(mxRecords))
	copy(sortedMX, mxRecords)
	for i := 1; i < len(sortedMX); i++ {
		for j := i; j > 0 && sortedMX[j].Pref < sortedMX[j-1].Pref; j-- {
			sortedMX[j], sortedMX[j-1] = sortedMX[j-1], sortedMX[j]
		}
	}

	topMX := strings.TrimSuffix(sortedMX[0].Host, ".")

	// Per-MX rate gate (5 s spacing).
	if !verifyMXGate.Allow(topMX) {
		return verifyResponse{Status: "unknown", Reason: "rate limited — too many probes to this MX"}
	}

	// Pick egress path.
	// When direct egress is enabled (default) socksAddr is intentionally empty —
	// smtpRCPTProbe will use a plain net.Dialer.  When VERIFY_VIA_DIRECT_EGRESS=false
	// we still require a SOCKS5 proxy for the legacy code path.
	var socksAddr string
	if !verifyDirectEgress() {
		socksAddr = s.verifySocksAddr()
		if socksAddr == "" {
			return verifyResponse{Status: "unknown", Reason: "no SOCKS5 proxy available for probe"}
		}
	}

	// Catch-all detection: probe a random canary address first.
	// If the MX accepts it, the domain is catch-all and individual verification is impossible.
	canary := fmt.Sprintf("verify-canary-noreply-xz9q7@%s", domain)
	canaryCode, _ := smtpRCPTProbe(probeCtx, socksAddr, topMX, canary)
	if canaryCode == 250 {
		return verifyResponse{Status: "catch_all", Code: 250, Reason: "domain accepts all addresses (catch-all)"}
	}

	// Real probe.
	code, reason := smtpRCPTProbe(probeCtx, socksAddr, topMX, email)
	switch {
	case code == 250:
		return verifyResponse{Status: "valid", Code: code, Reason: "mailbox accepted"}
	case code >= 500 && code <= 599:
		return verifyResponse{Status: "invalid", Code: code, Reason: reason}
	case code >= 400 && code <= 499:
		return verifyResponse{Status: "unknown", Code: code, Reason: "greylisted or temporary failure"}
	default:
		return verifyResponse{Status: "unknown", Code: code, Reason: reason}
	}
}
