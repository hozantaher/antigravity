package web

import (
	"relay/internal/abuse"
	"relay/internal/audit"
	"relay/internal/boundary"
	"relay/internal/deaddrop"
	"relay/internal/delivery"
	"relay/internal/intake"
	"relay/internal/intake/admin"
	"relay/internal/intake/auth"
	"relay/internal/metrics"
	"relay/internal/model"
	"relay/internal/relay"
	"relay/internal/transport"
	"relay/internal/transport/wgpool"
	"relay/internal/vault"

	"common/envconfig"
	"context"
	"encoding/hex"
	"encoding/json"
	"log"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// AW4-2 — queue-depth backpressure gate.
//
// Default cap mirrors the AW4 audit recommendation
// (docs/audits/2026-05-09-performance-audit-aw4.md): "cap /v1/submit at 100
// concurrent envelopes in queue, return 429 + Retry-After if exceeded".
//
// retryAfterSeconds is a conservative per-envelope drain-time hint: AW4 measured
// ~5s SMTP transaction latency per envelope, so 5s is the floor a polite
// submitter should wait before retrying.
const (
	defaultMaxQueueDepth = 100
	retryAfterSeconds    = 5
)

type contextKey string

const intakeChannelKey contextKey = "intake_channel"

// BridgeHealthChecker verifies connectivity to the downstream privacy-gateway.
type BridgeHealthChecker interface {
	HealthCheck(ctx context.Context) error
}

// Server wires HTTP endpoints to the anti-trace relay services.
type Server struct {
	auth           auth.Authenticator
	pipeline       *intake.Pipeline
	scheduler      *relay.Scheduler
	audit          *audit.Service
	vault          vault.Vault
	boundary       *boundary.ExitVerifier
	limiter        *abuse.Limiter
	deadDrop       *deaddrop.Store
	bridge         BridgeHealthChecker
	deliveryMode   string
	startedAt      time.Time
	maxBodyBytes   int64
	adminStats     *admin.Stats
	adminToken     string // empty = admin auth disabled
	proxyPool      ProxyPool
	proxyRefresher ProxyRefresher
	verifyEnabled  bool
	// fallbackProxyAddr is the SOCKS5 address probe handlers use when no
	// proxyPool is wired and the request body did not include `proxy_addr`.
	// Production wires this to the wireproxy localhost endpoint
	// (e.g. 127.0.0.1:1080) so /v1/probe and /v1/auth-check work in the
	// Mullvad-only egress configuration where the rotating pool is retired.
	fallbackProxyAddr string
	// wgPool is the multi-endpoint Mullvad rotation. When set,
	// /v1/proxy-pool returns its snapshot under mode="wg-pool".
	wgPool *wgpool.Pool
	// maxQueueDepth caps scheduler.PendingCount() before /v1/submit will accept
	// a new envelope. 0 disables the gate (unlimited). See AW4 audit
	// recommendation; the default (100) was lifted directly from that report.
	maxQueueDepth int
	// backpressureAudit toggles the slog.Info audit event emitted on every 429
	// backpressure rejection. Set via env BACKPRESSURE_AUDIT=1 (default off so
	// log volume stays bounded under sustained overload).
	backpressureAudit bool
}

// NewServer creates the HTTP server with all dependencies injected.
func NewServer(
	authenticator auth.Authenticator,
	pipeline *intake.Pipeline,
	scheduler *relay.Scheduler,
	auditSvc *audit.Service,
	vaultSvc vault.Vault,
	boundarySvc *boundary.ExitVerifier,
	limiter *abuse.Limiter,
) *Server {
	token := envconfig.GetOr("ADMIN_TOKEN", "")
	if token == "" {
		log.Println("[admin] WARNING: ADMIN_TOKEN not set — admin endpoints are open to anyone")
	}
	return &Server{
		auth:              authenticator,
		pipeline:          pipeline,
		scheduler:         scheduler,
		audit:             auditSvc,
		vault:             vaultSvc,
		boundary:          boundarySvc,
		limiter:           limiter,
		startedAt:         time.Now(),
		maxBodyBytes:      32 * 1024,
		adminStats:        admin.NewStats(),
		adminToken:        token,
		maxQueueDepth:     parseMaxQueueDepth(envconfig.GetOr("RELAY_MAX_QUEUE_DEPTH", "")),
		backpressureAudit: envconfig.BoolOr("BACKPRESSURE_AUDIT", false),
	}
}

// parseMaxQueueDepth resolves RELAY_MAX_QUEUE_DEPTH semantics:
//
//   - empty / unparseable / negative → defaultMaxQueueDepth (100)
//   - 0                              → unlimited (gate disabled)
//   - positive integer               → that cap
//
// Negative + unparseable both fall back to the default rather than 0/unlimited
// so a typo never silently disables backpressure.
func parseMaxQueueDepth(raw string) int {
	if raw == "" {
		return defaultMaxQueueDepth
	}
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return defaultMaxQueueDepth
	}
	if v < 0 {
		return defaultMaxQueueDepth
	}
	return v
}

// Handler returns an http.Handler with all routes registered.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/metrics", s.handleMetrics)
	mux.HandleFunc("/v1/submit", s.handleSubmit)
	mux.HandleFunc("/v1/status", s.handleStatus)
	mux.HandleFunc("/v1/health", s.handleHealth)
	mux.HandleFunc("/v1/audit-events", s.handleAuditEvents)
	mux.HandleFunc("/v1/exit-channels", s.handleExitChannels)
	mux.HandleFunc("/v1/identities", s.handleIdentities)
	mux.HandleFunc("/v1/drop/", s.handleDeadDrop)
	mux.HandleFunc("/admin/circuits", s.handleAdminCircuits)
	mux.HandleFunc("/admin/stats", s.handleAdminStats)
	mux.HandleFunc("/v1/admin/refresh-pool", s.handleAdminRefreshPool)

	// SMTP-EGRESS-LOCKDOWN R3 — probe + proxy-pool endpoints called by the BFF.
	mux.HandleFunc("/v1/auth-check", s.handleAuthCheck)
	mux.HandleFunc("/v1/probe", s.handleProbe)
	mux.HandleFunc("/v1/proxy-pool", s.handleProxyPool)
	mux.HandleFunc("/v1/egress-debug", s.handleEgressDebug)
	mux.HandleFunc("/api/health/proxy-sources", s.handleProxySourceHealth)
	mux.HandleFunc("/v1/verify", s.handleVerify)
	// Sprint AO1 — BFF IMAP-via-SOCKS5: relay resolves the wgpool SOCKS5 addr
	// for a given preferred_country so BFF can proxy IMAP through the same Mullvad
	// endpoint as SMTP. No auth required — returns 127.0.0.1:108X only.
	mux.HandleFunc("/v1/imap-socks-addr", s.handleImapSocksAddr)
	// 2026-05-12 — POST /v1/imap-fetch: HTTP wrapper around delivery.FetchInboxHeaders
	// so cross-Railway services (BFF, orchestrator) can poll inbound mailboxes
	// without needing their own SOCKS5 tunnel. Uses the relay's working wgpool
	// transport. Replaces the broken BFF-side dialIMAPViaSOCKS5 path which
	// hit ECONNREFUSED on wgsocks loopback (memory project_bff_imap_cross_service_broken).
	mux.HandleFunc("/v1/imap-fetch", s.handleImapFetch)
	// Sprint AP4 — Egress chaos detection: BFF drains the observation ring buffer
	// every 5 min and writes to mailbox_egress_observation for detect_mailbox_egress_chaos.
	// GET ?drain=1 clears the buffer after returning; GET alone peeks.
	mux.HandleFunc("/v1/egress-observations", s.handleEgressObservations)
	// Sprint H7 diagnostic — bypasses anti-trace pipeline for egress isolation.
	// Temporary: revert or gate behind EGRESS_DIAG_MODE=1 once H7 concludes.
	mux.HandleFunc("/v1/raw-smtp-test", s.handleRawSmtpTest)

	return mux
}

// WithVerifyEnabled controls whether /v1/verify performs real RCPT-TO probes.
// Off by default (R6 will flip this on once rate-limited verification lands).
func (s *Server) WithVerifyEnabled(enabled bool) *Server {
	s.verifyEnabled = enabled
	return s
}

// WithMaxQueueDepth overrides the queue-depth cap (AW4-2 backpressure gate).
// 0 disables the gate; negative is treated as 0 (unlimited) here because
// callers using this builder are explicit, unlike env-var typos.
func (s *Server) WithMaxQueueDepth(max int) *Server {
	if max < 0 {
		max = 0
	}
	s.maxQueueDepth = max
	return s
}

// WithBackpressureAudit toggles slog audit on every 429 queue-depth rejection.
func (s *Server) WithBackpressureAudit(enabled bool) *Server {
	s.backpressureAudit = enabled
	return s
}

// SecurityHeadersMiddleware adds security headers to all responses.
func SecurityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		w.Header().Set("Content-Security-Policy", "default-src 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")

		// Reject cross-origin requests
		if r.Header.Get("Origin") != "" {
			writeError(w, http.StatusForbidden, "cross-origin requests not allowed")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// WithIntakeChannel wraps a handler to inject intake channel into context.
// Used for the onion hidden service listener where we know the channel
// at the transport level, not from the spoofable Host header.
func WithIntakeChannel(next http.Handler, channel string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), intakeChannelKey, channel)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func getIntakeChannel(r *http.Request) string {
	if ch, ok := r.Context().Value(intakeChannelKey).(string); ok {
		return ch
	}
	return "api"
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSubmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// AW4-2 — queue-depth backpressure gate. Fail fast BEFORE actor auth, rate
	// limit, or body parse so an overloaded relay sheds load with the cheapest
	// possible response. Drain throughput is capped by Mullvad SMTP latency
	// (~12 envelopes/min, AW4 audit), so a deep queue means the submitter is
	// outpacing physical egress and must back off.
	if s.maxQueueDepth > 0 {
		if depth := s.scheduler.PendingCount(); depth >= s.maxQueueDepth {
			if s.backpressureAudit {
				slog.Info("relay_submit_backpressure",
					"op", "web.handleSubmit/backpressure",
					"queue_depth", depth,
					"max_queue_depth", s.maxQueueDepth,
					"retry_after_seconds", retryAfterSeconds,
				)
			}
			w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
			writeError(w, http.StatusTooManyRequests, "queue full")
			return
		}
	}

	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}

	var req model.IntakeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Recipient == "" || req.Body == "" {
		writeError(w, http.StatusBadRequest, "recipient and body are required")
		return
	}

	// Validate recipient format (prevent CRLF injection, empty domains)
	if err := delivery.ValidateRecipient(req.Recipient); err != nil {
		writeError(w, http.StatusBadRequest, "invalid recipient format")
		return
	}

	// Channel determined from transport-level context, not Host header
	channel := getIntakeChannel(r)

	result, err := s.pipeline.Process(r.Context(), actor, req, channel)
	if err != nil {
		if err == abuse.ErrRateLimited {
			writeError(w, http.StatusTooManyRequests, "rate limited")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if result.Status == model.StatusBlocked {
		writeError(w, http.StatusUnprocessableEntity, "content blocked by policy")
		return
	}

	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	_, ok := s.requireActor(w, r)
	if !ok {
		return
	}

	queueDepth := s.scheduler.PendingCount()
	oldestAge := s.scheduler.OldestPendingAge()

	// Express oldest age as seconds; -1 when queue is empty.
	var oldestAgeSeconds float64 = -1
	if oldestAge >= 0 {
		oldestAgeSeconds = oldestAge.Seconds()
	}

	status := map[string]any{
		"pending_envelopes":          queueDepth,
		"queue_depth":                queueDepth,
		"oldest_pending_age_seconds": oldestAgeSeconds,
		"delivery_mode":              s.deliveryMode,
		"uptime_seconds":             int(time.Since(s.startedAt).Seconds()),
	}

	if s.bridge != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if err := s.bridge.HealthCheck(ctx); err != nil {
			status["bridge_status"] = "unreachable"
		} else {
			status["bridge_status"] = "ok"
		}
	}

	writeJSON(w, http.StatusOK, status)
}

// handleHealth performs a liveness probe against the configured bridge target.
// GET /v1/health returns 200 {"status":"ok"} if the bridge is reachable,
// or 503 {"status":"unreachable"} if it is not or no bridge is configured.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.bridge == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unreachable"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if err := s.bridge.HealthCheck(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unreachable"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleAuditEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}

	eventType := r.URL.Query().Get("event_type")
	entries, err := s.audit.ListByTenantFiltered(r.Context(), actor.TenantID, eventType, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if entries == nil {
		entries = []model.AuditEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": entries})
}

func (s *Server) handleExitChannels(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}

	switch r.Method {
	case http.MethodGet:
		channels, err := s.boundary.ListChannels(r.Context(), actor.TenantID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if channels == nil {
			channels = []model.ExitChannel{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"channels": channels})

	case http.MethodPost:
		var ch model.ExitChannel
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024)).Decode(&ch); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		ch.TenantID = actor.TenantID
		if err := s.boundary.RegisterChannel(r.Context(), ch); err != nil {
			if err == boundary.ErrInvalidChannel {
				writeError(w, http.StatusBadRequest, "invalid channel configuration")
				return
			}
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"status": "registered"})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleIdentities(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}

	switch r.Method {
	case http.MethodGet:
		mappings, err := s.vault.ListByTenant(r.Context(), actor.TenantID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if mappings == nil {
			mappings = []model.AliasMapping{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"identities": mappings})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) requireActor(w http.ResponseWriter, r *http.Request) (model.Actor, bool) {
	actor, err := s.auth.Authenticate(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return model.Actor{}, false
	}
	return actor, true
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// WithDeadDrop adds dead drop store to the server.
func (s *Server) WithDeadDrop(store *deaddrop.Store) *Server {
	s.deadDrop = store
	return s
}

// WithBridge adds a bridge health checker and sets delivery mode.
func (s *Server) WithBridge(bridge BridgeHealthChecker, deliveryMode string) *Server {
	s.bridge = bridge
	s.deliveryMode = deliveryMode
	return s
}

// WithDeliveryMode sets the delivery mode for status reporting.
func (s *Server) WithDeliveryMode(mode string) *Server {
	s.deliveryMode = mode
	return s
}

// handleDeadDrop handles POST/GET /v1/drop/{slotID}
// Dead drops are intentionally unauthenticated -- anyone can post or poll.
// Slot IDs are opaque 32-byte hex. Without the shared secret used to derive
// the slot ID, an attacker cannot find active slots.
func (s *Server) handleDeadDrop(w http.ResponseWriter, r *http.Request) {
	if s.deadDrop == nil {
		writeError(w, http.StatusNotImplemented, "dead drop not configured")
		return
	}

	// Extract slot ID from path: /v1/drop/{slotID}
	path := strings.TrimPrefix(r.URL.Path, "/v1/drop/")
	if path == "" || len(path) != 64 { // 32 bytes = 64 hex chars
		writeError(w, http.StatusBadRequest, "invalid slot ID")
		return
	}

	slotBytes, err := hex.DecodeString(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid slot ID format")
		return
	}

	var slotID deaddrop.SlotID
	copy(slotID[:], slotBytes)

	switch r.Method {
	case http.MethodPost:
		var body struct {
			Data string `json:"data"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBodyBytes)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		payload, err := hex.DecodeString(body.Data)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid hex data")
			return
		}

		if err := s.deadDrop.Post(slotID, payload); err != nil {
			if err == deaddrop.ErrSlotFull {
				writeError(w, http.StatusConflict, "slot full")
			} else if err == deaddrop.ErrPayloadSize {
				writeError(w, http.StatusRequestEntityTooLarge, "payload too large")
			} else {
				writeError(w, http.StatusInternalServerError, "internal server error")
			}
			return
		}

		writeJSON(w, http.StatusAccepted, map[string]string{"status": "posted"})

	case http.MethodGet:
		messages, err := s.deadDrop.Poll(slotID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		// Encode messages as hex
		hexMsgs := make([]string, len(messages))
		for i, msg := range messages {
			hexMsgs[i] = hex.EncodeToString(msg)
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"messages": hexMsgs,
			"count":    len(hexMsgs),
		})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleMetrics serves Prometheus-compatible text format metrics on GET /metrics.
// No authentication required — standard for internal Prometheus scraping.
// All metrics are aggregate only: no per-submitter data, no IPs, no content.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(metrics.Global.TextFormat()))
}

// requireAdminToken checks the X-Admin-Token header against the configured
// ADMIN_TOKEN env var. If the token is empty (not set), admin auth is disabled
// and all requests are allowed through (with a warning already logged at startup).
// Returns false and writes 401 when the token check fails.
func (s *Server) requireAdminToken(w http.ResponseWriter, r *http.Request) bool {
	if s.adminToken == "" {
		// disabled — open to anyone
		return true
	}
	if r.Header.Get("X-Admin-Token") != s.adminToken {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

// circuitEntry is the JSON shape returned for one active relay session.
type circuitEntry struct {
	ID        string `json:"id"`
	CreatedAt string `json:"created_at"`
	Hops      int    `json:"hops"`
}

// handleAdminCircuits lists active obfuscation circuits (relay sessions).
// GET /admin/circuits
// In this service the equivalent of "circuits" is pending scheduled envelopes.
// Each pending envelope represents one store-and-forward relay session.
func (s *Server) handleAdminCircuits(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdminToken(w, r) {
		return
	}

	pending := s.scheduler.PendingEnvelopes()
	entries := make([]circuitEntry, len(pending))
	for i, env := range pending {
		entries[i] = circuitEntry{
			ID:        env.ID,
			CreatedAt: env.BucketedAt.UTC().Format(time.RFC3339),
			Hops:      3, // fixed multi-hop relay depth for this service
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"circuits": entries,
		"total":    len(entries),
	})
}

// handleAdminStats returns throughput and latency statistics.
// GET /admin/stats
func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdminToken(w, r) {
		return
	}

	writeJSON(w, http.StatusOK, s.adminStats.Snapshot())
}

// AdminStats returns the admin stats tracker so callers (e.g. middleware or
// the delivery engine) can record observations.
func (s *Server) AdminStats() *admin.Stats {
	return s.adminStats
}

// WithProxyRefresher wires the proxy-pool refresher so the admin
// POST /v1/admin/refresh-pool endpoint can trigger an immediate re-fetch.
func (s *Server) WithProxyRefresher(r ProxyRefresher) *Server {
	s.proxyRefresher = r
	return s
}

// handleAdminRefreshPool triggers an immediate proxy-pool re-fetch+probe cycle.
// POST /v1/admin/refresh-pool
// Called by the BFF watchdog when the working-proxy count drops below
// MIN_WORKING_PROXIES. Returns 202 immediately; the refresh runs asynchronously.
func (s *Server) handleAdminRefreshPool(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdminToken(w, r) {
		return
	}
	if s.proxyRefresher == nil {
		writeError(w, http.StatusServiceUnavailable, "proxy pool not configured")
		return
	}
	go s.proxyRefresher.ForceRefresh()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "refresh_triggered"})
}

// handleProxySourceHealth returns health monitoring data for all proxy sources.
// GET /api/health/proxy-sources
// Returns consecutive_zero, last_count, last_error, and degraded status for
// geonode, proxyscrape, and proxifly. Called by the BFF health endpoint.
func (s *Server) handleProxySourceHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if _, ok := s.requireActor(w, r); !ok {
		return
	}
	sourceHealth := transport.SourceHealthSnapshot()
	writeJSON(w, http.StatusOK, sourceHealth)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
