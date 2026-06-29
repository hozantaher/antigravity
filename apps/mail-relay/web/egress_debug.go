package web

// Egress debug endpoint — exposes the relay's actual outbound network
// state so operators (and the BFF /api/anti-trace/health aggregator)
// can detect config drift before launching a campaign.
//
// Background: 2026-05-01 anonymity smoke run sealed 36 envelopes via
// relay but 0/18 reached Seznam IMAP. Manual debugging traced the
// egress to a Chinese Mullvad exit (120.239.37.236) — config drift
// in WIREPROXY_CONFIG that nothing surfaced operator-visibly. This
// endpoint closes that gap by probing the actual egress IP through
// the relay's local SOCKS5 (wireproxy) and returning it alongside
// the configured transport mode and Mullvad peer endpoint parsed
// from the live WIREPROXY_CONFIG env.
//
// CAD-M2 / issue #557. See docs/subsystem-maps/anti-trace.md (Layer 5
// step D7-D8) for the canonical egress topology.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"common/envconfig"
	"relay/internal/transport"
)

// egressDebugCacheTTL is the freshness budget for the probe result.
// 60s mirrors the BFF's read-through cache window over /v1/proxy-pool
// and prevents a hot loop of api.ipify.org calls if the dashboard
// page is open in multiple tabs.
const egressDebugCacheTTL = 60 * time.Second

// egressProbeTimeout is the wall-clock budget for a single
// SOCKS5+HTTP round-trip to api.ipify.org. Generous for the
// wireproxy → Mullvad → public-internet hop chain.
const egressProbeTimeout = 10 * time.Second

// egressDebugCache holds the last probe result plus its capture
// timestamp. Single-instance because the relay process is single-
// instance per Railway service.
type egressDebugCache struct {
	mu        sync.Mutex
	cachedAt  time.Time
	payload   *EgressDebugResponse
	probeErr  error
}

var debugCache = &egressDebugCache{}

// EgressDebugResponse is the public JSON shape returned by
// GET /v1/egress-debug. Field names locked — BFF + pnpm report parse
// them. Add new fields with omitempty; never rename.
type EgressDebugResponse struct {
	TransportMode       string   `json:"transport_mode"`
	WireproxyActive     bool     `json:"wireproxy_active"`
	CurrentEgressIP     string   `json:"current_egress_ip,omitempty"`
	MullvadPeerEndpoint string   `json:"mullvad_peer_endpoint,omitempty"`
	FallbackProxyAddr   string   `json:"fallback_proxy_addr,omitempty"`
	ProbedAt            string   `json:"probed_at"`
	ProbeError          string   `json:"probe_error,omitempty"`
	Notes               []string `json:"notes,omitempty"`
	// WGPool fields populated when the multi-endpoint Mullvad pool is wired.
	PoolSize             int `json:"pool_size,omitempty"`
	ActiveEndpoints      int `json:"active_endpoints,omitempty"`
	QuarantinedEndpoints int `json:"quarantined_endpoints,omitempty"`

	// AP4 ring buffer occupancy — always present when wgPool is wired.
	// BFF cron and Sentry alert use ring_buffer_fill_pct to detect
	// drainage failures before data loss occurs (evict_count > 0 = data lost).
	RingBufferSize      int   `json:"ring_buffer_size,omitempty"`
	RingBufferCap       int   `json:"ring_buffer_cap,omitempty"`
	RingBufferHighWater int   `json:"ring_buffer_high_water,omitempty"`
	RingBufferFillPct   int   `json:"ring_buffer_fill_pct,omitempty"`
	EvictCount          int64 `json:"evict_count,omitempty"`
}

// handleEgressDebug returns the relay's runtime egress state. Auth-
// required (same Bearer-token gate as /v1/status). Result is cached
// for egressDebugCacheTTL to avoid a per-request external probe.
func (s *Server) handleEgressDebug(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if _, ok := s.requireActor(w, r); !ok {
		return
	}

	resp := s.getEgressDebug(r.Context())
	writeJSON(w, http.StatusOK, resp)
}

// getEgressDebug returns the cached probe payload if fresh, otherwise
// triggers a new probe. Exported (lowercase, package-private) for tests.
func (s *Server) getEgressDebug(ctx context.Context) *EgressDebugResponse {
	debugCache.mu.Lock()
	if debugCache.payload != nil && time.Since(debugCache.cachedAt) < egressDebugCacheTTL {
		out := *debugCache.payload
		debugCache.mu.Unlock()
		return &out
	}
	debugCache.mu.Unlock()

	// Probe outside the lock — external HTTP call is slow.
	payload := s.probeEgressDebug(ctx)

	debugCache.mu.Lock()
	debugCache.cachedAt = time.Now()
	debugCache.payload = payload
	debugCache.mu.Unlock()

	out := *payload
	return &out
}

// probeEgressDebug builds the response by combining static config
// (TRANSPORT_MODE env, WIREPROXY_CONFIG parse, Server.fallbackProxyAddr)
// with a live SOCKS5 probe to api.ipify.org for the actual egress IP.
func (s *Server) probeEgressDebug(ctx context.Context) *EgressDebugResponse {
	transportMode := strings.TrimSpace(envconfig.GetOr("TRANSPORT_MODE", ""))
	if transportMode == "" {
		transportMode = "(unset)"
	}
	wgConfig := envconfig.GetOr("WIREPROXY_CONFIG", "")
	wireproxyActive := wgConfig != ""
	peerEndpoint := parseMullvadPeerEndpoint(wgConfig)

	resp := &EgressDebugResponse{
		TransportMode:       transportMode,
		WireproxyActive:     wireproxyActive,
		MullvadPeerEndpoint: peerEndpoint,
		FallbackProxyAddr:   s.fallbackProxyAddr,
		ProbedAt:            time.Now().UTC().Format(time.RFC3339),
	}

	// Multi-endpoint Mullvad pool truth surface. When wired, take pool
	// stats over the single fallbackProxyAddr.
	if s.wgPool != nil {
		snap := s.wgPool.Snapshot()
		resp.PoolSize = s.wgPool.Size()
		for _, h := range snap {
			if h.Quarantined {
				resp.QuarantinedEndpoints++
			} else {
				resp.ActiveEndpoints++
			}
		}

		// AP4 ring buffer occupancy — always populated when pool is wired.
		// Sentry alerts are fired by wgPool.StartHealthMonitor (time-driven,
		// wired in cmd/relay/main.go) — NOT here. Handler is read-only: returns
		// stats, never triggers side effects.
		stats := s.wgPool.EgressObsStatsSnapshot()
		resp.RingBufferSize = stats.RingBufferSize
		resp.RingBufferCap = stats.RingBufferCap
		resp.RingBufferHighWater = stats.RingBufferHighWater
		resp.RingBufferFillPct = stats.RingBufferFillPct
		resp.EvictCount = stats.EvictCount
	}

	// Note any config oddities operators should see at a glance.
	if !wireproxyActive {
		resp.Notes = append(resp.Notes,
			"WIREPROXY_CONFIG unset — egress flows direct from Railway IP")
	}
	if transportMode == "direct" {
		resp.Notes = append(resp.Notes,
			"TRANSPORT_MODE=direct is forbidden — chain.go:97 ErrDirectTransportForbidden should have failed boot")
	}
	if transportMode == "proxy" {
		resp.Notes = append(resp.Notes,
			"TRANSPORT_MODE=proxy is forbidden — chain.go:100 ErrFreePoolForbidden should have failed boot")
	}

	// Live probe — only if we have a SOCKS5 endpoint to dial through.
	if s.fallbackProxyAddr == "" {
		resp.ProbeError = "no fallback SOCKS5 address configured; cannot probe live egress IP"
		return resp
	}

	probeCtx, cancel := context.WithTimeout(ctx, egressProbeTimeout)
	defer cancel()

	ip, err := probeEgressIP(probeCtx, s.fallbackProxyAddr)
	if err != nil {
		resp.ProbeError = err.Error()
		return resp
	}
	resp.CurrentEgressIP = ip
	return resp
}

// probeEgressIP dials api.ipify.org via the given SOCKS5 endpoint and
// returns the public IP the egress hop reports. Uses a custom http.Client
// whose Transport.DialContext routes through SOCKS5.
func probeEgressIP(ctx context.Context, socksAddr string) (string, error) {
	socks := transport.NewSOCKS5Transport(socksAddr, egressProbeTimeout)
	httpTransport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return socks.DialContext(ctx, network, addr)
		},
		// Do not honour HTTP_PROXY env — the egress is forced through
		// the SOCKS5 dialer above.
		Proxy:                 nil,
		ResponseHeaderTimeout: egressProbeTimeout,
		IdleConnTimeout:       egressProbeTimeout,
	}
	client := &http.Client{
		Transport: httpTransport,
		Timeout:   egressProbeTimeout,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.ipify.org/?format=text", nil)
	if err != nil {
		return "", fmt.Errorf("build probe request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("probe transport: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("probe non-200 status: %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return "", fmt.Errorf("probe body: %w", err)
	}
	ip := strings.TrimSpace(string(body))
	if net.ParseIP(ip) == nil {
		return "", fmt.Errorf("probe returned non-IP body: %q", ip)
	}
	return ip, nil
}

// parseMullvadPeerEndpoint extracts the `Endpoint = ...` line from a
// WIREPROXY_CONFIG ini value. Returns the bare host:port string or
// "" if not found. Used so operators can see at a glance which
// Mullvad server the relay is configured to tunnel through.
//
// Multi-line ini matching is line-anchored. Whitespace tolerated.
func parseMullvadPeerEndpoint(wgConfig string) string {
	if wgConfig == "" {
		return ""
	}
	re := regexp.MustCompile(`(?im)^\s*Endpoint\s*=\s*(.+?)\s*$`)
	m := re.FindStringSubmatch(wgConfig)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}

// resetEgressDebugCacheForTest is the test-only escape hatch to clear
// the package-level cache between cases. Lowercase to keep it package-
// private.
func resetEgressDebugCacheForTest() {
	debugCache.mu.Lock()
	debugCache.cachedAt = time.Time{}
	debugCache.payload = nil
	debugCache.probeErr = nil
	debugCache.mu.Unlock()
}

// errEgressNoSocks is exported (lowercase) so tests can assert exact
// failure mode when fallbackProxyAddr is empty without string-matching.
var errEgressNoSocks = errors.New("no fallback SOCKS5 address configured")
