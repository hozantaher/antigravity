// Package handler exposes the Mail Lab admin REST surface.
//
// Endpoints (all require X-Lab-Api-Key header except /healthz):
//
//	GET    /healthz                         — liveness
//	POST   /v1/mailbox                      — create account
//	GET    /v1/mailbox/:address             — read account metadata
//	DELETE /v1/mailbox/:address             — delete account
//
// All admin endpoints shell out to `docker exec <container> setup email ...`
// against docker-mailserver. The container name is configurable
// (default: mail-lab-seznam) so ML2 can drive multi-provider with one
// API server.
package handler

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"sync"
	"time"

	"mail-lab-api/internal/exec"
)

// ProfileRegistry is the minimal contract handlers need from the
// per-provider profile store (ML2.2). Defined here so tests can drop in
// a fake without pulling the full profile package.
//
// Check (ML2.3) returns the verdict the registry would render for a
// message given the provided context map (decoded JSON body).
type ProfileRegistry interface {
	Get(domain string) (interface{}, error)
	List() []interface{}
	Apply(domain string, override map[string]interface{}) (interface{}, error)
	Check(domain string, ctx map[string]interface{}) (decision string, reason string, err error)
	PreviewDSN(domain string, env map[string]interface{}, ctx map[string]interface{}) (dsn interface{}, decision string, err error)
	RateRecord(domain, mailbox string) (count int, limit int, err error)
	RateCount(domain, mailbox string) (count int, limit int, err error)
	GreylistAllow(domain, senderIP, senderAddr, recipientAddr string) (allow bool, reason string, err error)
	EvaluateFromMap(domain string, raw map[string]interface{}) (result interface{}, err error)
	QuotaAdd(domain, mailbox string, bytes int64) (used int64, cap int64, err error)
	QuotaUsage(domain, mailbox string) (used int64, cap int64, err error)
	ResetAll(source string) error
}

// Server holds dependencies shared across handlers.
type Server struct {
	APIKey       string         // required header value (X-Lab-Api-Key); empty disables auth (DEV ONLY)
	ContainerFor func(domain string) string // maps "seznam.lab" → "mail-lab-seznam"
	Runner       exec.Runner
	Logger       *slog.Logger
	StartedAt    time.Time
	Profiles     ProfileRegistry // ML2.2 — nil disables /v1/profile endpoints

	// Address-level mutex map prevents two concurrent POST/DELETE for the
	// same account from racing in docker-mailserver's account file. Maps
	// are coarse but the lab traffic volume is tiny so this is fine.
	mu      sync.Mutex
	addrLock map[string]*sync.Mutex
}

func NewServer(apiKey string, runner exec.Runner, logger *slog.Logger) *Server {
	return &Server{
		APIKey:       apiKey,
		Runner:       runner,
		Logger:       logger,
		StartedAt:    time.Now(),
		ContainerFor: defaultContainerFor,
		addrLock:     map[string]*sync.Mutex{},
	}
}

// WithProfiles attaches a ProfileRegistry — when set, /v1/profile
// endpoints become available. Test injection point.
func (s *Server) WithProfiles(p ProfileRegistry) *Server {
	s.Profiles = p
	return s
}

// defaultContainerFor returns the docker container name for a given domain.
// ML1: only seznam.lab supported. ML2 will extend.
func defaultContainerFor(domain string) string {
	switch domain {
	case "seznam.lab":
		return "mail-lab-seznam"
	case "gmail.lab":
		return "mail-lab-gmail"
	case "outlook.lab":
		return "mail-lab-outlook"
	default:
		return ""
	}
}

// lockFor returns the per-address mutex, creating it on first access.
func (s *Server) lockFor(addr string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if l, ok := s.addrLock[addr]; ok {
		return l
	}
	l := &sync.Mutex{}
	s.addrLock[addr] = l
	return l
}

// Routes registers the HTTP routes onto a fresh ServeMux.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.Handle("POST /v1/mailbox", s.requireAuth(http.HandlerFunc(s.handleCreate)))
	mux.Handle("GET /v1/mailbox/{address}", s.requireAuth(http.HandlerFunc(s.handleRead)))
	mux.Handle("GET /v1/mailbox/{address}/messages", s.requireAuth(http.HandlerFunc(s.handleMessages)))
	mux.Handle("DELETE /v1/mailbox/{address}", s.requireAuth(http.HandlerFunc(s.handleDelete)))
	// ML2.2 — profile endpoints. Available only when WithProfiles() ran.
	if s.Profiles != nil {
		mux.Handle("GET /v1/profile", s.requireAuth(http.HandlerFunc(s.handleProfileList)))
		mux.Handle("GET /v1/profile/{domain}", s.requireAuth(http.HandlerFunc(s.handleProfileGet)))
		mux.Handle("POST /v1/profile/{domain}/override", s.requireAuth(http.HandlerFunc(s.handleProfileOverride)))
		// ML2.3 — verdict endpoint
		mux.Handle("POST /v1/profile/{domain}/check", s.requireAuth(http.HandlerFunc(s.handleProfileCheck)))
		// ML2.4 — DSN preview endpoint
		mux.Handle("POST /v1/profile/{domain}/dsn", s.requireAuth(http.HandlerFunc(s.handleProfileDSN)))
		// ML2.5 — per-mailbox rate-limit tracker
		mux.Handle("GET /v1/profile/{domain}/rate/{mailbox}", s.requireAuth(http.HandlerFunc(s.handleRateGet)))
		mux.Handle("POST /v1/profile/{domain}/rate/{mailbox}/record", s.requireAuth(http.HandlerFunc(s.handleRateRecord)))
		// ML3.2 — greylist tracker
		mux.Handle("POST /v1/profile/{domain}/greylist/check", s.requireAuth(http.HandlerFunc(s.handleGreylistCheck)))
		// ML3.3 — combined evaluate (greylist → rate → static)
		mux.Handle("POST /v1/profile/{domain}/evaluate", s.requireAuth(http.HandlerFunc(s.handleEvaluate)))
		// ML2.6 — quota tracker
		mux.Handle("GET /v1/profile/{domain}/quota/{mailbox}", s.requireAuth(http.HandlerFunc(s.handleQuotaGet)))
		mux.Handle("POST /v1/profile/{domain}/quota/{mailbox}/add", s.requireAuth(http.HandlerFunc(s.handleQuotaAdd)))
		// ML2.7 — operator reset (clears all trackers + reloads profiles)
		mux.Handle("POST /v1/profile/reset", s.requireAuth(http.HandlerFunc(s.handleResetAll)))
		// ML3.1 — bounce delivery: synth DSN + docker exec sendmail
		mux.Handle("POST /v1/scenario/bounce", s.requireAuth(http.HandlerFunc(s.handleBounceDeliver)))
	}
	return mux
}

// ── Profile endpoints (ML2.2) ──────────────────────────────────────────

func (s *Server) handleProfileList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"profiles": s.Profiles.List()})
}

func (s *Server) handleProfileGet(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	if domain == "" {
		writeError(w, http.StatusBadRequest, "domain path param required")
		return
	}
	p, err := s.Profiles.Get(domain)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleProfileOverride(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	if domain == "" {
		writeError(w, http.StatusBadRequest, "domain path param required")
		return
	}
	var override map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&override); err != nil {
		writeError(w, http.StatusBadRequest, "malformed JSON body")
		return
	}
	if len(override) == 0 {
		writeError(w, http.StatusBadRequest, "override body must contain at least one field")
		return
	}
	updated, err := s.Profiles.Apply(domain, override)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	s.Logger.Info("profile override applied",
		"op", "mail-lab-api.handleProfileOverride",
		"domain", domain,
		"keys", overrideKeys(override))
	writeJSON(w, http.StatusOK, updated)
}

// ── Verdict endpoint (ML2.3) ───────────────────────────────────────────

type checkResponse struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}

func (s *Server) handleProfileCheck(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	if domain == "" {
		writeError(w, http.StatusBadRequest, "domain path param required")
		return
	}
	var ctx map[string]interface{}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&ctx); err != nil {
			writeError(w, http.StatusBadRequest, "malformed JSON body")
			return
		}
	}
	decision, reason, err := s.Profiles.Check(domain, ctx)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, checkResponse{Decision: decision, Reason: reason})
}

// ── DSN preview endpoint (ML2.4) ───────────────────────────────────────

type dsnRequest struct {
	Envelope map[string]interface{} `json:"envelope"`
	Context  map[string]interface{} `json:"context"`
}

type dsnResponse struct {
	Decision string      `json:"decision"`
	DSN      interface{} `json:"dsn"`
}

func (s *Server) handleProfileDSN(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	if domain == "" {
		writeError(w, http.StatusBadRequest, "domain path param required")
		return
	}
	var req dsnRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "malformed JSON body")
			return
		}
	}
	dsn, decision, err := s.Profiles.PreviewDSN(domain, req.Envelope, req.Context)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, dsnResponse{Decision: decision, DSN: dsn})
}

// ── Rate-limit endpoints (ML2.5) ───────────────────────────────────────

type rateResponse struct {
	Mailbox   string `json:"mailbox"`
	Domain    string `json:"domain"`
	Count     int    `json:"count"`
	Limit     int    `json:"limit"`
	Remaining int    `json:"remaining"`
}

func (s *Server) handleRateGet(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	mailbox := strings.TrimSpace(r.PathValue("mailbox"))
	if domain == "" || mailbox == "" {
		writeError(w, http.StatusBadRequest, "domain and mailbox required")
		return
	}
	count, limit, err := s.Profiles.RateCount(domain, mailbox)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, rateResponse{
		Mailbox: mailbox, Domain: domain,
		Count: count, Limit: limit, Remaining: remainingOf(count, limit),
	})
}

func (s *Server) handleRateRecord(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	mailbox := strings.TrimSpace(r.PathValue("mailbox"))
	if domain == "" || mailbox == "" {
		writeError(w, http.StatusBadRequest, "domain and mailbox required")
		return
	}
	count, limit, err := s.Profiles.RateRecord(domain, mailbox)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, rateResponse{
		Mailbox: mailbox, Domain: domain,
		Count: count, Limit: limit, Remaining: remainingOf(count, limit),
	})
}

// ── Greylist endpoint (ML3.2) ──────────────────────────────────────────

type greylistRequest struct {
	SenderIP      string `json:"sender_ip"`
	SenderAddr    string `json:"sender_addr"`
	RecipientAddr string `json:"recipient_addr"`
}

type greylistResponse struct {
	Allow  bool   `json:"allow"`
	Reason string `json:"reason"`
}

func (s *Server) handleGreylistCheck(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	if domain == "" {
		writeError(w, http.StatusBadRequest, "domain path param required")
		return
	}
	var req greylistRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed JSON body")
		return
	}
	if req.RecipientAddr == "" {
		writeError(w, http.StatusBadRequest, "recipient_addr required")
		return
	}
	allow, reason, err := s.Profiles.GreylistAllow(domain, req.SenderIP, req.SenderAddr, req.RecipientAddr)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, greylistResponse{Allow: allow, Reason: reason})
}

// ── Evaluate endpoint (ML3.3) ──────────────────────────────────────────

func (s *Server) handleEvaluate(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	if domain == "" {
		writeError(w, http.StatusBadRequest, "domain path param required")
		return
	}
	var raw map[string]interface{}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			writeError(w, http.StatusBadRequest, "malformed JSON body")
			return
		}
	}
	res, err := s.Profiles.EvaluateFromMap(domain, raw)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ── Quota endpoints (ML2.6) ────────────────────────────────────────────

type quotaResponse struct {
	Mailbox string `json:"mailbox"`
	Domain  string `json:"domain"`
	Used    int64  `json:"used_bytes"`
	Cap     int64  `json:"cap_bytes"`
}

type quotaAddRequest struct {
	Bytes int64 `json:"bytes"`
}

func (s *Server) handleQuotaGet(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	mailbox := strings.TrimSpace(r.PathValue("mailbox"))
	if domain == "" || mailbox == "" {
		writeError(w, http.StatusBadRequest, "domain and mailbox required")
		return
	}
	used, cap, err := s.Profiles.QuotaUsage(domain, mailbox)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, quotaResponse{
		Mailbox: mailbox, Domain: domain, Used: used, Cap: cap,
	})
}

func (s *Server) handleQuotaAdd(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.PathValue("domain"))
	mailbox := strings.TrimSpace(r.PathValue("mailbox"))
	if domain == "" || mailbox == "" {
		writeError(w, http.StatusBadRequest, "domain and mailbox required")
		return
	}
	var req quotaAddRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed JSON body")
		return
	}
	if req.Bytes <= 0 {
		writeError(w, http.StatusBadRequest, "bytes must be > 0")
		return
	}
	used, cap, err := s.Profiles.QuotaAdd(domain, mailbox, req.Bytes)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown domain "+domain)
		return
	}
	writeJSON(w, http.StatusOK, quotaResponse{
		Mailbox: mailbox, Domain: domain, Used: used, Cap: cap,
	})
}

// ── Operator reset endpoint (ML2.7) ────────────────────────────────────

type resetRequest struct {
	Source string `json:"source"` // "embedded" | path; default empty → embedded
}

type resetResponse struct {
	Status string `json:"status"`
	Source string `json:"source"`
}

func (s *Server) handleResetAll(w http.ResponseWriter, r *http.Request) {
	var req resetRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "malformed JSON body")
			return
		}
	}
	source := strings.TrimSpace(req.Source)
	if source == "" {
		source = "embedded"
	}
	if err := s.Profiles.ResetAll(source); err != nil {
		s.Logger.Error("profile reset failed",
			"op", "mail-lab-api.handleResetAll",
			"source", source, "error", err)
		writeError(w, http.StatusInternalServerError, "reset failed: "+err.Error())
		return
	}
	s.Logger.Info("profile registry reset",
		"op", "mail-lab-api.handleResetAll",
		"source", source)
	writeJSON(w, http.StatusOK, resetResponse{Status: "ok", Source: source})
}

func remainingOf(count, limit int) int {
	if limit <= 0 {
		return -1 // unlimited sentinel
	}
	if count >= limit {
		return 0
	}
	return limit - count
}

func overrideKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// requireAuth gates handlers behind X-Lab-Api-Key. Constant-time compare
// to avoid timing oracle (mirrors privacy-gateway's static auth pattern).
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.APIKey == "" {
			next.ServeHTTP(w, r)
			return
		}
		got := r.Header.Get("X-Lab-Api-Key")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.APIKey)) != 1 {
			writeError(w, http.StatusUnauthorized, "missing or invalid X-Lab-Api-Key")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── Health ──────────────────────────────────────────────────────────────

type healthResponse struct {
	Status         string `json:"status"`
	UptimeSeconds  int64  `json:"uptime_seconds"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{
		Status:        "ok",
		UptimeSeconds: int64(time.Since(s.StartedAt).Seconds()),
	})
}

// ── Create mailbox ─────────────────────────────────────────────────────

type createRequest struct {
	Address  string `json:"address"`
	Password string `json:"password"`
}

type mailboxResponse struct {
	Address string `json:"address"`
	Domain  string `json:"domain"`
	Created bool   `json:"created,omitempty"`
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed JSON")
		return
	}
	addr := strings.TrimSpace(req.Address)
	pwd := req.Password
	if addr == "" || pwd == "" {
		writeError(w, http.StatusBadRequest, "address and password are required")
		return
	}
	if _, err := mail.ParseAddress(addr); err != nil {
		writeError(w, http.StatusBadRequest, "invalid email address")
		return
	}
	domain := domainOf(addr)
	container := s.ContainerFor(domain)
	if container == "" {
		writeError(w, http.StatusBadRequest, "unsupported domain "+domain)
		return
	}

	// Per-address serialize so two concurrent POSTs for the same account
	// don't both try to add and end up with `setup email add` racing.
	l := s.lockFor(addr)
	l.Lock()
	defer l.Unlock()

	// Detect "already exists" by listing first — `setup email add` exits
	// non-zero on duplicate but with non-deterministic stderr, so we
	// pre-check explicitly.
	if exists, err := s.mailboxExists(r.Context(), container, addr); err != nil {
		s.Logger.Error("mailbox exists check failed",
			"op", "mail-lab-api.handleCreate/existsCheck",
			"address", addr, "error", err)
		writeError(w, http.StatusInternalServerError, "exists check failed: "+err.Error())
		return
	} else if exists {
		writeError(w, http.StatusConflict, "mailbox already exists")
		return
	}

	out, err := s.Runner.Run(r.Context(), "docker", "exec", container, "setup", "email", "add", addr, pwd)
	if err != nil {
		s.Logger.Error("mailbox create failed",
			"op", "mail-lab-api.handleCreate/exec",
			"address", addr, "container", container, "error", err)
		writeError(w, http.StatusInternalServerError, "create failed: "+err.Error())
		return
	}
	s.Logger.Info("mailbox created",
		"op", "mail-lab-api.handleCreate",
		"address", addr, "container", container, "stdout", strings.TrimSpace(out))

	w.Header().Set("Location", "/v1/mailbox/"+addr)
	writeJSON(w, http.StatusCreated, mailboxResponse{Address: addr, Domain: domain, Created: true})
}

// ── Read mailbox ───────────────────────────────────────────────────────

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	addr := r.PathValue("address")
	if addr == "" {
		writeError(w, http.StatusBadRequest, "address path param required")
		return
	}
	if _, err := mail.ParseAddress(addr); err != nil {
		writeError(w, http.StatusBadRequest, "invalid email address")
		return
	}
	domain := domainOf(addr)
	container := s.ContainerFor(domain)
	if container == "" {
		writeError(w, http.StatusBadRequest, "unsupported domain "+domain)
		return
	}

	exists, err := s.mailboxExists(r.Context(), container, addr)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "exists check failed: "+err.Error())
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "mailbox not found")
		return
	}
	writeJSON(w, http.StatusOK, mailboxResponse{Address: addr, Domain: domain})
}

// ── List messages ──────────────────────────────────────────────────────

// messageEntry represents a brief summary of a stored message, returned by
// GET /v1/mailbox/:address/messages. Fields are derived from what
// `doveadm mailbox list` + `doveadm fetch` expose; ML1 returns the count
// obtained from `setup email list` and stubs richer fields for ML2.
type messageEntry struct {
	UID         string `json:"uid"`
	From        string `json:"from"`
	Subject     string `json:"subject"`
	ReceivedAt  string `json:"received_at"`
	SizeBytes   int64  `json:"size_bytes"`
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	addr := r.PathValue("address")
	if addr == "" {
		writeError(w, http.StatusBadRequest, "address path param required")
		return
	}
	if _, err := mail.ParseAddress(addr); err != nil {
		writeError(w, http.StatusBadRequest, "invalid email address")
		return
	}
	domain := domainOf(addr)
	container := s.ContainerFor(domain)
	if container == "" {
		writeError(w, http.StatusBadRequest, "unsupported domain "+domain)
		return
	}

	exists, err := s.mailboxExists(r.Context(), container, addr)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "exists check failed: "+err.Error())
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "mailbox not found")
		return
	}

	// ML1: use doveadm fetch to list messages. doveadm is available inside
	// docker-mailserver. When the mailbox is empty it returns exit 0 with no
	// output; the response MUST be [] not null (issue #217 assertion 6).
	out, err := s.Runner.Run(r.Context(), "docker", "exec", container,
		"doveadm", "fetch", "-u", addr, "uid from subject date size", "ALL")
	if err != nil {
		// doveadm returns exit 75 when the mailbox has no messages on some
		// configurations — treat as empty rather than an error.
		s.Logger.Info("doveadm fetch empty or err",
			"op", "mail-lab-api.handleMessages/fetch",
			"address", addr, "output", strings.TrimSpace(out))
		writeJSON(w, http.StatusOK, []messageEntry{})
		return
	}

	msgs := parseDoveadmFetch(out)
	s.Logger.Info("messages listed",
		"op", "mail-lab-api.handleMessages",
		"address", addr,
		"count", len(msgs))
	writeJSON(w, http.StatusOK, msgs)
}

// parseDoveadmFetch parses `doveadm fetch uid from subject date size ALL`
// output into a slice of messageEntry. Output format (one record per line,
// fields separated by newlines within a record, records separated by blank
// line):
//
//	uid: 1
//	from: Alice <alice@example.com>
//	subject: Hello
//	date: 2026-05-01 10:00:00 +0000
//	size: 1234
//	(blank line)
//
// ML1 implementation parses best-effort; malformed lines are skipped.
func parseDoveadmFetch(raw string) []messageEntry {
	var msgs []messageEntry
	var cur messageEntry
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			// record separator
			if cur.UID != "" {
				msgs = append(msgs, cur)
			}
			cur = messageEntry{}
			continue
		}
		k, v, ok := strings.Cut(line, ": ")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "uid":
			cur.UID = strings.TrimSpace(v)
		case "from":
			cur.From = strings.TrimSpace(v)
		case "subject":
			cur.Subject = strings.TrimSpace(v)
		case "date":
			cur.ReceivedAt = strings.TrimSpace(v)
		case "size":
			var n int64
			for _, ch := range strings.TrimSpace(v) {
				if ch >= '0' && ch <= '9' {
					n = n*10 + int64(ch-'0')
				}
			}
			cur.SizeBytes = n
		}
	}
	// flush last record if output doesn't end with blank line
	if cur.UID != "" {
		msgs = append(msgs, cur)
	}
	if msgs == nil {
		msgs = []messageEntry{} // guarantee [] not null in JSON
	}
	return msgs
}

// ── Delete mailbox ─────────────────────────────────────────────────────

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	addr := r.PathValue("address")
	if addr == "" {
		writeError(w, http.StatusBadRequest, "address path param required")
		return
	}
	if _, err := mail.ParseAddress(addr); err != nil {
		writeError(w, http.StatusBadRequest, "invalid email address")
		return
	}
	domain := domainOf(addr)
	container := s.ContainerFor(domain)
	if container == "" {
		writeError(w, http.StatusBadRequest, "unsupported domain "+domain)
		return
	}

	l := s.lockFor(addr)
	l.Lock()
	defer l.Unlock()

	if exists, err := s.mailboxExists(r.Context(), container, addr); err != nil {
		writeError(w, http.StatusInternalServerError, "exists check failed: "+err.Error())
		return
	} else if !exists {
		writeError(w, http.StatusNotFound, "mailbox not found")
		return
	}

	// `setup email del -y` skips the interactive confirmation prompt.
	out, err := s.Runner.Run(r.Context(), "docker", "exec", container, "setup", "email", "del", "-y", addr)
	if err != nil {
		s.Logger.Error("mailbox delete failed",
			"op", "mail-lab-api.handleDelete/exec",
			"address", addr, "error", err)
		writeError(w, http.StatusInternalServerError, "delete failed: "+err.Error())
		return
	}
	s.Logger.Info("mailbox deleted",
		"op", "mail-lab-api.handleDelete",
		"address", addr, "stdout", strings.TrimSpace(out))
	w.WriteHeader(http.StatusNoContent)
}

// ── helpers ────────────────────────────────────────────────────────────

func (s *Server) mailboxExists(ctx context.Context, container, addr string) (bool, error) {
	out, err := s.Runner.Run(ctx, "docker", "exec", container, "setup", "email", "list")
	if err != nil {
		return false, err
	}
	// `setup email list` outputs lines like "* postmaster@seznam.lab ( 0 / ~ ) [...]"
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, addr) {
			return true, nil
		}
	}
	return false, nil
}

func domainOf(addr string) string {
	at := strings.LastIndex(addr, "@")
	if at < 0 {
		return ""
	}
	return addr[at+1:]
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type errorResponse struct {
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}

// ErrNotImplemented signals a stub endpoint not yet wired (e.g. listing
// messages, planned in ML2). Reserved for future expansion.
var ErrNotImplemented = errors.New("not implemented")
