// Package wgpool provides per-envelope rotation across a pool of Mullvad
// WireGuard endpoints. Each endpoint is a userspace WG-SOCKS bridge
// instance (wgsocks, falling back to wireproxy via EGRESS_TRANSPORT)
// running on a distinct localhost SOCKS5 port (127.0.0.1:108x).
//
// Why this exists: a single-endpoint relay leaks "all 36 envelopes from
// 178.249.209.170" — a recipient running rate-limit / volumetric anomaly
// detection on source IP can flag the entire campaign as a single
// abusive sender. Rotating per-envelope across N CZ/EU Mullvad exits
// preserves the Mullvad egress architecture while presenting recipients
// a more diverse source-IP fingerprint.
//
// Mullvad architecturally allows ONE WG account-level private key to
// peer with ANY of their ~563 public servers. The pool exploits that:
// each entrypoint.sh instance writes a bridge config that reuses the
// same Interface (private key + assigned 10.x.x.x/32) and only varies
// the [Peer] block (public key + Endpoint host:port). Each instance
// binds its own SOCKS5 port.
//
// This package is the ONLY place that should construct SOCKS5Transport
// against a 127.0.0.1:108x address. The audit ratchet
// `wgpool_audit_test.go` (in this package) holds that invariant.
package wgpool

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
)

// Endpoint is one Mullvad WG exit reachable via a local userspace SOCKS5.
type Endpoint struct {
	Label      string `json:"label"`
	SocksAddr  string `json:"socks_addr"`
	Country    string `json:"country,omitempty"`
	City       string `json:"city,omitempty"`
	PeerPubKey string `json:"peer_pubkey,omitempty"`
	PeerHost   string `json:"peer_host,omitempty"`
}

// Health holds runtime state for one endpoint. Mutated under Pool.mu.
type Health struct {
	Endpoint        Endpoint  `json:"endpoint"`
	LastOK          time.Time `json:"last_ok,omitempty"`
	LastFail        time.Time `json:"last_fail,omitempty"`
	ConsecutiveFail int       `json:"consecutive_fail"`
	Quarantined     bool      `json:"quarantined"`
	QuarantineUntil time.Time `json:"quarantine_until,omitempty"`
	OKCount         uint64    `json:"ok_count"`
	FailCount       uint64    `json:"fail_count"`
}

// Config tunes Pool behavior. Zero values use safe defaults.
type Config struct {
	QuarantineThreshold int
	QuarantineDuration  time.Duration
	AffinityWindow      int
	AffinityEnabled     bool
	Now                 func() time.Time
}

// EgressObservation is a single egress event buffered by the pool for
// relay-side collection. The BFF drains this buffer and writes to DB.
type EgressObservation struct {
	MailboxID     string    `json:"mailbox_id"`
	Country       string    `json:"country"`
	EndpointLabel string    `json:"endpoint_label"`
	OpType        string    `json:"op_type"`
	ObservedAt    time.Time `json:"observed_at"`
}

const egressObsRingCap = 2000 // cap ring buffer — ~16h at 2 probes/mailbox/30min

// Pool holds a static list of endpoints + per-endpoint health state.
// Safe for concurrent Pick / RecordSuccess / RecordFailure.
type Pool struct {
	mu        sync.Mutex
	endpoints []Endpoint
	health    map[string]*Health
	cfg       Config
	rrCounter uint64
	affinity  map[string]*affinityEntry

	// pinReader / pinWriter are optional; wired after construction via
	// WithPinReader / WithPinWriter (see pin.go).
	pinReader PinReader
	pinWriter PinWriter

	// egressObs is an in-memory ring buffer of egress observations.
	// Drained by the BFF via GET /v1/egress-observations?drain=1.
	egressObs []EgressObservation

	// egressObsHighWater is the maximum len(egressObs) observed since startup.
	// Monotonically increasing — never reset — so operators can see the peak
	// without waiting for the next full cycle.
	egressObsHighWater int

	// egressObsEvictCount is the total number of oldest-entry evictions since
	// startup. Non-zero means data loss occurred — BFF cron fell behind.
	egressObsEvictCount int64
}

type affinityEntry struct {
	label string
	uses  int
}

// New constructs a Pool from a slice of endpoints.
func New(endpoints []Endpoint, cfg Config) (*Pool, error) {
	if len(endpoints) == 0 {
		return nil, errors.New("wgpool: pool must have at least one endpoint")
	}
	if cfg.QuarantineThreshold == 0 {
		cfg.QuarantineThreshold = 3
	}
	if cfg.QuarantineDuration == 0 {
		cfg.QuarantineDuration = 5 * time.Minute
	}
	if cfg.AffinityWindow == 0 {
		cfg.AffinityWindow = 5
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}

	seen := make(map[string]struct{}, len(endpoints))
	health := make(map[string]*Health, len(endpoints))
	for _, ep := range endpoints {
		if ep.Label == "" {
			return nil, errors.New("wgpool: endpoint missing label")
		}
		if ep.SocksAddr == "" {
			return nil, fmt.Errorf("wgpool: endpoint %q missing socks_addr", ep.Label)
		}
		if _, dup := seen[ep.Label]; dup {
			return nil, fmt.Errorf("wgpool: duplicate endpoint label %q", ep.Label)
		}
		seen[ep.Label] = struct{}{}
		health[ep.Label] = &Health{Endpoint: ep}
	}

	cp := make([]Endpoint, len(endpoints))
	copy(cp, endpoints)

	return &Pool{
		endpoints: cp,
		health:    health,
		cfg:       cfg,
		affinity:  make(map[string]*affinityEntry),
	}, nil
}

// Size returns the number of endpoints in the pool.
func (p *Pool) Size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.endpoints)
}

// Pick selects the endpoint that should carry the next outbound for
// (envelopeID, mailboxID) with an optional preferredCountry pin.
//
// Algorithm:
//  0. If the pool has a PinReader and the mailbox has a persisted
//     pinned_endpoint_label:
//     - Return that endpoint when it is active. No fallback.
//     - Return ErrPinnedEndpointQuarantined when quarantined.
//     - Return ErrPinnedEndpointMissing when the label is gone from pool.
//  0a. (AS2) When mailboxID is non-empty AND both PinReader and PinWriter are
//     wired, delegate to pickAllocate to enforce strict 1:1 exclusivity. The
//     hash-rotate fallback is retained for non-mailbox drain paths (mailboxID
//     empty) for backward compatibility.
//  1. Reap quarantine: any endpoint whose QuarantineUntil <= now is
//     restored to active.
//  2. If no endpoints are active, return ErrAllQuarantined.
//  3. If AffinityEnabled and we have a sticky binding for mailboxID
//     that is still within AffinityWindow, the bound endpoint is active,
//     and it satisfies preferredCountry (or no country is set), return it.
//     If the sticky endpoint violates the country constraint, evict it.
//  4. If preferredCountry != "" filter active endpoints to that country.
//     If the filtered set is empty, fall back to the full active pool
//     (country-quarantine fallback — all in-country endpoints are unhealthy).
//  5. Pick by stable hash(envelopeID + mailboxID) modulo the candidate set,
//     falling back to round-robin when both inputs are empty.
//  6. Bind the picked endpoint to mailboxID for affinity tracking.
func (p *Pool) Pick(envelopeID, mailboxID string, preferredCountry ...string) (Endpoint, error) {
	p.mu.Lock()

	// Step 0: enforce per-mailbox egress pin (AP2).
	// pickPinned drops and reacquires p.mu around the DB read so the
	// explicit unlock below remains consistent.
	if pinnedEP, pinSet, pinErr := p.pickPinned(mailboxID); pinSet {
		p.mu.Unlock()
		if pinErr != nil {
			return Endpoint{}, pinErr
		}
		return pinnedEP, nil
	}

	// Step 0a (AS2): strict 1:1 exclusive allocation when both reader and
	// writer are wired and mailboxID is present. Release lock before the
	// DB-touching pickAllocate to avoid holding mu across network I/O.
	//
	// P1.13: detect partial wiring (one side set, other nil) — silently
	// falling back to hash routing in that case masks a configuration bug.
	pinReaderSet := p.pinReader != nil
	pinWriterSet := p.pinWriter != nil
	hasPinIO := mailboxID != "" && pinReaderSet && pinWriterSet
	// Capture partial-wiring flag before releasing the lock; slog.Error is
	// emitted after Unlock to avoid holding p.mu across I/O.
	partialWiring := mailboxID != "" && (pinReaderSet != pinWriterSet)
	p.mu.Unlock()

	// P1.13: emit outside the critical section.
	if partialWiring {
		slog.Error("partial pin IO wiring; exclusive allocation falling back to hash routing",
			"op", "wgpool.Pick/partial-wiring",
			"pin_reader_set", pinReaderSet,
			"pin_writer_set", pinWriterSet,
			"mailbox_id", mailboxID,
		)
	}

	if hasPinIO {
		country := ""
		if len(preferredCountry) > 0 {
			country = preferredCountry[0]
		}
		return p.pickAllocate(mailboxID, country)
	}

	// Backward-compat path: hash-rotate (drain paths with empty mailboxID,
	// or pools without DB writer wired).
	p.mu.Lock()
	defer p.mu.Unlock()

	country := ""
	if len(preferredCountry) > 0 {
		country = preferredCountry[0]
	}

	now := p.cfg.Now()
	p.reapQuarantineLocked(now)

	active := p.activeLocked()
	if len(active) == 0 {
		return Endpoint{}, ErrAllQuarantined
	}

	// Affinity: reuse sticky endpoint if it satisfies the country constraint.
	if p.cfg.AffinityEnabled && mailboxID != "" {
		if ent, ok := p.affinity[mailboxID]; ok && ent.uses < p.cfg.AffinityWindow {
			if h, ok := p.health[ent.label]; ok && !h.Quarantined {
				if country == "" || strings.EqualFold(h.Endpoint.Country, country) {
					ent.uses++
					return h.Endpoint, nil
				}
				// Sticky endpoint violates country pin — evict and repick.
				delete(p.affinity, mailboxID)
			}
		}
	}

	// Country filter: restrict candidates to preferredCountry when specified.
	candidates := active
	if country != "" {
		if filtered := filterByCountry(active, country); len(filtered) > 0 {
			candidates = filtered
		}
		// else: all in-country endpoints quarantined — fall back to full active pool.
	}

	picked := pickByHash(candidates, envelopeID, mailboxID, &p.rrCounter)

	if p.cfg.AffinityEnabled && mailboxID != "" {
		p.affinity[mailboxID] = &affinityEntry{label: picked.Label, uses: 1}
	}

	return picked, nil
}

// activeEndpointsForCountry returns active (non-quarantined) endpoints that
// match country (case-insensitive). When country is "", all active endpoints
// are returned. Must be called with p.mu held.
func (p *Pool) activeEndpointsForCountry(country string) []Endpoint {
	all := p.activeLocked()
	if country == "" {
		return all
	}
	return filterByCountry(all, country)
}

// pickAllocate selects the first free endpoint for mailboxID in country,
// persisting the allocation atomically via the DB UNIQUE constraint.
//
// Algorithm:
//  1. If mailboxID already has a persisted pin, return it (or an error if
//     quarantined / missing).
//  2. Collect all endpoints active for country (or full pool when country "").
//     Return ErrPoolExhausted when the candidate set is empty.
//  3. Fetch all currently-pinned labels from DB.
//  4. Iterate candidates in deterministic config order; pick the first one
//     whose label is not in the pinned set.
//  5. Attempt SetMailboxPin. On DB UNIQUE violation, recursively retry
//     pickAllocate (another goroutine raced us; their write wins).
//  6. Return ErrPoolExhausted when all candidates are taken.
//
// Must be called WITHOUT p.mu held — it calls pickPinned which temporarily
// releases and reacquires the lock for DB I/O.
func (p *Pool) pickAllocate(mailboxID, country string) (Endpoint, error) {
	return p.pickAllocateWithDepth(mailboxID, country, 0)
}

// pickAllocateWithDepth is the internal recursive implementation with depth tracking.
// Q4.10: depth prevents infinite loops on concurrent race conditions.
func (p *Pool) pickAllocateWithDepth(mailboxID, country string, depth int) (Endpoint, error) {
	if depth > 10 {
		return Endpoint{}, fmt.Errorf("pickAllocate retry exceeded depth 10: possible infinite loop on UNIQUE violations")
	}

	if p.pinReader == nil {
		return Endpoint{}, fmt.Errorf("dbReader required for exclusive allocation")
	}

	// Step 1: already pinned?
	p.mu.Lock()
	ep, pinSet, pinErr := p.pickPinned(mailboxID)
	p.mu.Unlock()
	if pinSet {
		if pinErr != nil {
			return Endpoint{}, pinErr
		}
		return ep, nil
	}

	// Step 2: build candidate set (active + country filter).
	p.mu.Lock()
	now := p.cfg.Now()
	p.reapQuarantineLocked(now)
	candidates := p.activeEndpointsForCountry(country)
	p.mu.Unlock()

	if len(candidates) == 0 {
		if country != "" {
			return Endpoint{}, fmt.Errorf("no active endpoints for country %q: %w", country, ErrPoolExhausted)
		}
		return Endpoint{}, ErrPoolExhausted
	}

	// Step 3: fetch all taken labels.
	pinnedLabels, err := p.pinReader.GetAllPinnedLabels()
	if err != nil {
		return Endpoint{}, fmt.Errorf("pickAllocate: fetch pinned labels: %w", err)
	}

	pinnedSet := make(map[string]struct{}, len(pinnedLabels))
	for _, l := range pinnedLabels {
		pinnedSet[l] = struct{}{}
	}

	// Step 4: find first free endpoint (deterministic by config order).
	for _, candidate := range candidates {
		if _, taken := pinnedSet[candidate.Label]; taken {
			continue
		}
		// Step 5: attempt atomic pin via DB UNIQUE constraint.
		if p.pinWriter == nil {
			return Endpoint{}, fmt.Errorf("dbWriter required for exclusive allocation")
		}
		setErr := p.pinWriter.SetMailboxPin(mailboxID, candidate.Label, "wgpool_first_send")
		if setErr != nil {
			if isUniqueViolation(setErr) {
				// Race: another goroutine pinned this endpoint. Retry from top.
				// Q4.10: recursion with depth check to prevent infinite loops.
				return p.pickAllocateWithDepth(mailboxID, country, depth+1)
			}
			return Endpoint{}, fmt.Errorf("pickAllocate: set pin: %w", setErr)
		}
		return candidate, nil
	}

	// Step 6: all candidates taken.
	return Endpoint{}, ErrPoolExhausted
}

// isUniqueViolation returns true when the error originates from a PostgreSQL
// UNIQUE constraint violation (SQLSTATE 23505).
//
// P1 hardening: relay is stdlib-only (zero third-party deps required by
// services/relay/CLAUDE.md), so we cannot use *pq.Error.Code. We match
// on error message substrings instead. The SQLSTATE "23505" string is
// always present in lib/pq, pgx/v5, and database/sql error strings so it
// is the most reliable signal; the aliases below guard against drivers that
// omit the numeric code.
//
// Ordering: 23505 (most specific) checked first so a driver format change
// that drops the human-readable suffix does not produce a false-negative.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	// Primary: SQLSTATE code — present in all known PostgreSQL drivers.
	if strings.Contains(msg, "23505") {
		return true
	}
	// Fallbacks: human-readable aliases emitted by lib/pq and pgx.
	return strings.Contains(msg, "unique_violation") ||
		strings.Contains(msg, "duplicate key") ||
		strings.Contains(msg, "unique constraint")
}

// filterByCountry returns the subset of endpoints whose Country field matches
// the given ISO code (case-insensitive). Returns nil when no match.
func filterByCountry(eps []Endpoint, country string) []Endpoint {
	var out []Endpoint
	for _, ep := range eps {
		if strings.EqualFold(ep.Country, country) {
			out = append(out, ep)
		}
	}
	return out
}

func pickByHash(active []Endpoint, envelopeID, mailboxID string, rr *uint64) Endpoint {
	if len(active) == 1 {
		return active[0]
	}
	if envelopeID == "" && mailboxID == "" {
		idx := *rr % uint64(len(active))
		*rr++
		return active[idx]
	}
	h := sha256.New()
	h.Write([]byte(envelopeID))
	h.Write([]byte{0x00})
	h.Write([]byte(mailboxID))
	sum := h.Sum(nil)
	idx := binary.BigEndian.Uint64(sum[:8]) % uint64(len(active))
	return active[idx]
}

func (p *Pool) activeLocked() []Endpoint {
	out := make([]Endpoint, 0, len(p.endpoints))
	for _, ep := range p.endpoints {
		h := p.health[ep.Label]
		if h.Quarantined {
			continue
		}
		out = append(out, ep)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

func (p *Pool) reapQuarantineLocked(now time.Time) {
	for _, h := range p.health {
		if h.Quarantined && !h.QuarantineUntil.IsZero() && !now.Before(h.QuarantineUntil) {
			h.Quarantined = false
			h.QuarantineUntil = time.Time{}
			h.ConsecutiveFail = 0
		}
	}
}

// RecordSuccess clears the failure streak on an endpoint.
func (p *Pool) RecordSuccess(label string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	h, ok := p.health[label]
	if !ok {
		return
	}
	h.LastOK = p.cfg.Now()
	h.OKCount++
	h.ConsecutiveFail = 0
}

// RecordFailure increments the failure streak. When the streak reaches
// QuarantineThreshold, the endpoint is quarantined for QuarantineDuration.
func (p *Pool) RecordFailure(label string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	h, ok := p.health[label]
	if !ok {
		return
	}
	now := p.cfg.Now()
	h.LastFail = now
	h.FailCount++
	h.ConsecutiveFail++
	if h.ConsecutiveFail >= p.cfg.QuarantineThreshold {
		h.Quarantined = true
		h.QuarantineUntil = now.Add(p.cfg.QuarantineDuration)
		for mb, ent := range p.affinity {
			if ent.label == label {
				delete(p.affinity, mb)
			}
		}
	}
}

// Snapshot returns a point-in-time copy of every endpoint's health.
func (p *Pool) Snapshot() []Health {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.cfg.Now()
	p.reapQuarantineLocked(now)
	out := make([]Health, 0, len(p.health))
	for _, h := range p.health {
		out = append(out, *h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Endpoint.Label < out[j].Endpoint.Label })
	return out
}

// Endpoints returns the static endpoint list (defensive copy).
func (p *Pool) Endpoints() []Endpoint {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Endpoint, len(p.endpoints))
	copy(out, p.endpoints)
	return out
}

// ErrAllQuarantined is returned by Pick when every endpoint is currently
// quarantined.
var ErrAllQuarantined = errors.New("wgpool: all endpoints quarantined")

// ErrPoolExhausted is returned by pickAllocate when every active endpoint
// in the requested country (or the full pool when no country is set) is
// already pinned to a different mailbox.
var ErrPoolExhausted = errors.New("wgpool: pool exhausted: no free endpoint")

// ParseConfig parses the WIREPROXY_POOL_CONFIG env var.
func ParseConfig(raw string) ([]Endpoint, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var out []Endpoint
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("wgpool: parse WIREPROXY_POOL_CONFIG: %w", err)
	}
	return out, nil
}

// RecordEgressObservation appends an egress observation to the in-memory ring
// buffer. Non-blocking; drops oldest entry when at capacity. The BFF drains
// this buffer via GET /v1/egress-observations and writes to the DB.
//
// mailboxID must be a decimal integer string matching outreach_mailboxes.id.
// country is ISO 3166-1 alpha-2 (e.g. "CZ", "DE"). endpointLabel is the
// wgpool endpoint label (e.g. "cz5"). opType is one of: send, probe,
// imap_poll, imap_inbox.
func (p *Pool) RecordEgressObservation(mailboxID, country, endpointLabel, opType string) {
	if mailboxID == "" || country == "" {
		return
	}

	obs := EgressObservation{
		MailboxID:     mailboxID,
		Country:       country,
		EndpointLabel: endpointLabel,
		OpType:        opType,
		ObservedAt:    time.Now().UTC(),
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.egressObs) >= egressObsRingCap {
		// Drop oldest (index 0) — ring buffer eviction.
		copy(p.egressObs, p.egressObs[1:])
		p.egressObs = p.egressObs[:len(p.egressObs)-1]
		p.egressObsEvictCount++
	}
	p.egressObs = append(p.egressObs, obs)
	if len(p.egressObs) > p.egressObsHighWater {
		p.egressObsHighWater = len(p.egressObs)
	}
}

// EgressObsStats holds ring buffer occupancy metrics for the /v1/egress-debug
// endpoint. All fields are snapshot-at-call; no synchronisation needed beyond
// the caller holding mu.
type EgressObsStats struct {
	// RingBufferSize is the current number of buffered observations.
	RingBufferSize int `json:"ring_buffer_size"`
	// RingBufferCap is the maximum capacity before eviction begins.
	RingBufferCap int `json:"ring_buffer_cap"`
	// RingBufferHighWater is the peak size seen since process start.
	RingBufferHighWater int `json:"ring_buffer_high_water"`
	// RingBufferFillPct is RingBufferSize/RingBufferCap as a 0–100 integer.
	RingBufferFillPct int `json:"ring_buffer_fill_pct"`
	// EvictCount is the cumulative number of oldest-entry evictions since start.
	// Non-zero means the BFF drain cron is falling behind relative to ingest rate.
	EvictCount int64 `json:"evict_count"`
}

// EgressObsStatsSnapshot returns a point-in-time snapshot of ring buffer metrics.
// Thread-safe; acquires and releases the pool mutex.
func (p *Pool) EgressObsStatsSnapshot() EgressObsStats {
	p.mu.Lock()
	size := len(p.egressObs)
	hw := p.egressObsHighWater
	evict := p.egressObsEvictCount
	p.mu.Unlock()

	fillPct := 0
	if egressObsRingCap > 0 {
		fillPct = (size * 100) / egressObsRingCap
	}
	return EgressObsStats{
		RingBufferSize:      size,
		RingBufferCap:       egressObsRingCap,
		RingBufferHighWater: hw,
		RingBufferFillPct:   fillPct,
		EvictCount:          evict,
	}
}

// DrainEgressObservations returns all buffered egress observations and clears
// the buffer. Called by the relay HTTP handler for the BFF to collect.
func (p *Pool) DrainEgressObservations() []EgressObservation {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.egressObs) == 0 {
		return nil
	}
	out := make([]EgressObservation, len(p.egressObs))
	copy(out, p.egressObs)
	p.egressObs = p.egressObs[:0]
	return out
}

// DrainEgressObservationsN atomically drains exactly the first n observations
// from the ring buffer. Returns an error if n > current buffer size so the
// caller (BFF) can detect a mismatch between peek count and ack count caused
// by concurrent writers. Use this in the peek→INSERT→ack handshake to prevent
// data loss on BFF crash: peek without draining, INSERT to DB, then ack=N to
// confirm exactly N rows were processed.
func (p *Pool) DrainEgressObservationsN(n int) ([]EgressObservation, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n > len(p.egressObs) {
		return nil, fmt.Errorf("ack=%d exceeds buffer size=%d: BFF peeked %d rows but buffer has only %d", n, len(p.egressObs), n, len(p.egressObs))
	}
	if n == 0 {
		return []EgressObservation{}, nil
	}
	out := make([]EgressObservation, n)
	copy(out, p.egressObs[:n])
	// Shift remaining observations to front of slice.
	p.egressObs = p.egressObs[n:]
	return out, nil
}

// PeekEgressObservations returns a snapshot without clearing the buffer.
// Useful for tests.
func (p *Pool) PeekEgressObservations() []EgressObservation {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]EgressObservation, len(p.egressObs))
	copy(out, p.egressObs)
	return out
}

// RingBufferAlertThreshold is the fill percentage above which StartHealthMonitor
// fires a Sentry alert. Matches egressObsHighWaterWarnPct in web/egress_debug.go.
const RingBufferAlertThreshold = 80

// EgressAlertFn is the function signature for emitting ring buffer pressure alerts.
// Production code wires telemetry.CaptureAlert; tests inject a stub.
type EgressAlertFn func(evictCount int64, fillPct, size, cap, highWater int)

// StartHealthMonitor launches a background goroutine that periodically checks
// ring buffer occupancy and fires alertFn when pressure thresholds are exceeded.
// This replaces the handler-coupled alert logic in web/egress_debug.go so that
// alerts fire on a wall-clock schedule regardless of whether the BFF cron calls
// the /v1/egress-debug endpoint.
//
// alertFn is called when:
//   - evict_count > 0 (data loss: BFF drain cron is behind), or
//   - ring_buffer_fill_pct >= RingBufferAlertThreshold (high water warning).
//
// The goroutine runs until ctx is cancelled. interval is the check cadence
// (production: 60s). alertFn must be non-nil.
func (p *Pool) StartHealthMonitor(ctx context.Context, interval time.Duration, alertFn EgressAlertFn) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				stats := p.EgressObsStatsSnapshot()
				if stats.EvictCount > 0 || stats.RingBufferFillPct >= RingBufferAlertThreshold {
					alertFn(stats.EvictCount, stats.RingBufferFillPct, stats.RingBufferSize, stats.RingBufferCap, stats.RingBufferHighWater)
				}
			}
		}
	}()
}
