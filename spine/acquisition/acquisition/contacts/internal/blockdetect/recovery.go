// KT-A8.1 — alt-source recovery loop + 30/50 circuit breaker.
//
// When a scraper observes a block on its current upstream source, the
// recovery layer is asked to swap to a healthy alternate (KT-A7
// SelectAlternative) and retry. A bounded retry budget (3 alternates) keeps
// the request hot-path predictable; circuit-breaker state per source keeps
// repeat offenders from being chosen until a 5-minute cooldown elapses.
//
// Design contract:
//
//   - Recover(ctx, current, fetch) returns RecoveryOutcome describing the
//     fallback chain. The caller stays in charge of the original fetch
//     attempt — Recover only orchestrates the fallback.
//   - The caller supplies a SourceSelector. Production wires this to
//     transport.SelectAlternative; tests wire a deterministic stub. This
//     decoupling avoids importing services/relay from services/contacts
//     (each Go module stays a leaf w.r.t. the other).
//   - The breaker tracks the last 50 attempts per source: when 30 of those
//     50 are blocks the breaker opens, excluding the source from
//     SelectAlternative output for the configured cooldown (5 min).
//
// Failure policy:
//   - DB writes happen via the optional Recorder hook (matches LogWriter
//     semantics). A failed update is logged and swallowed.
//   - All slog calls follow the project op-field convention; level matches
//     severity (Warn for breaker open / recovery exhausted, Info for
//     successful recoveries).
package blockdetect

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
)

// MaxRecoveryAttempts caps the number of alt-source retries Recover will
// perform before giving up. Bounded so the request hot path stays
// predictable under repeated upstream blocks.
const MaxRecoveryAttempts = 3

// BreakerWindowSize is the rolling window used by the per-source circuit
// breaker (last N attempts).
const BreakerWindowSize = 50

// BreakerOpenThreshold is the failure count within BreakerWindowSize that
// trips the breaker open.
const BreakerOpenThreshold = 30

// BreakerCooldown is how long a tripped breaker stays open before
// auto-resetting on the next attempt.
const BreakerCooldown = 5 * time.Minute

// SourceSelector returns the next healthy source name (excluding any names
// already attempted), or "" if no candidate is available. Wired to
// transport.SelectAlternative in production.
type SourceSelector func(currentSource string, exclude []string) string

// FetchFn performs one fetch attempt against the named source. Returns the
// detected BlockType (or BlockTypeNone for success) plus the underlying
// fetch error, if any. Implementations are expected to be free of side
// effects beyond the network round trip — Recover orchestrates retries.
type FetchFn func(ctx context.Context, source string) (BlockType, error)

// RecoveryOutcome summarises a Recover() invocation for callers and audit
// rows. RecoveredVia is empty when no alternate succeeded.
type RecoveryOutcome struct {
	// Recovered is true when at least one alternate returned BlockTypeNone.
	Recovered bool
	// RecoveredVia is the source name that produced the successful result.
	RecoveredVia string
	// Attempts is the ordered list of alternate source names tried.
	Attempts []string
	// LastErr is the error from the final attempt (nil on recovery).
	LastErr error
}

// Recoverer runs the alt-source recovery loop and owns the per-source
// circuit-breaker state. Construct one per process; the breaker map is
// shared across goroutines via mu.
type Recoverer struct {
	selector SourceSelector
	now      func() time.Time

	mu       sync.Mutex
	breakers map[string]*breakerState
}

// breakerState is the per-source rolling window + open/closed snapshot.
type breakerState struct {
	// window is a fixed-size circular buffer of attempt outcomes (true =
	// failure / block).
	window [BreakerWindowSize]bool
	// idx is the next slot to overwrite in the window.
	idx int
	// filled is the count of slots populated so far (caps at WindowSize).
	filled int
	// failCount is the number of failure entries currently in the window.
	failCount int
	// open is true when the breaker has tripped and the cooldown has not
	// yet elapsed.
	open bool
	// openedAt is the timestamp of the last open transition (zero when
	// closed).
	openedAt time.Time
}

// NewRecoverer wires a recovery loop. selector must be non-nil; production
// passes transport.SelectAlternative. nowFn is optional (defaults to
// time.Now) and exists so tests can drive cooldown elapsing without sleep.
func NewRecoverer(selector SourceSelector, nowFn func() time.Time) *Recoverer {
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Recoverer{
		selector: selector,
		now:      nowFn,
		breakers: make(map[string]*breakerState),
	}
}

// Recover walks up to MaxRecoveryAttempts alternate sources, returning the
// first successful fetch. Each attempt is recorded into the per-source
// breaker (success or block). Sentry breadcrumbs are emitted per attempt
// when a hub is initialised; tests run without sentry.Init and the
// breadcrumb call is a no-op.
//
// currentSource is the source that just observed a block (already counted
// as a failure on its breaker). It is excluded from the candidate pool.
func (r *Recoverer) Recover(ctx context.Context, currentSource string, fetch FetchFn) RecoveryOutcome {
	if r == nil || r.selector == nil || fetch == nil {
		return RecoveryOutcome{LastErr: fmt.Errorf("blockdetect.Recover: nil recoverer / selector / fetch")}
	}

	tried := make([]string, 0, MaxRecoveryAttempts)
	exclude := make([]string, 0, MaxRecoveryAttempts+1)

	for attempt := 1; attempt <= MaxRecoveryAttempts; attempt++ {
		alt := r.selector(currentSource, exclude)
		if alt == "" {
			r.emitBreadcrumb(currentSource, "", attempt, "no_alternate", nil)
			slog.Warn("blockdetect: žádný zdravý alternativní zdroj k dispozici",
				"op", "blockdetect.Recover/no_alt",
				"current_source", currentSource,
				"attempt", attempt,
				"tried", tried,
			)
			return RecoveryOutcome{
				Recovered: false,
				Attempts:  tried,
				LastErr:   fmt.Errorf("blockdetect.Recover: no healthy alternate after %d attempts", attempt-1),
			}
		}

		// Skip a candidate whose breaker is open. SelectAlternative also
		// hides degraded sources via consecutiveZero, but breaker state is
		// orthogonal (block-rate vs zero-result rate) so we re-check here.
		if r.IsOpen(alt) {
			r.emitBreadcrumb(currentSource, alt, attempt, "breaker_open", nil)
			tried = append(tried, alt)
			exclude = append(exclude, alt)
			continue
		}

		bt, err := fetch(ctx, alt)
		blocked := bt != BlockTypeNone || err != nil
		r.recordAttempt(alt, blocked)
		tried = append(tried, alt)
		exclude = append(exclude, alt)

		if !blocked {
			r.emitBreadcrumb(currentSource, alt, attempt, "recovered", nil)
			slog.Info("blockdetect: zotaveno přes alternativní zdroj",
				"op", "blockdetect.Recover/success",
				"current_source", currentSource,
				"recovered_via", alt,
				"attempt", attempt,
			)
			return RecoveryOutcome{
				Recovered:    true,
				RecoveredVia: alt,
				Attempts:     tried,
			}
		}

		r.emitBreadcrumb(currentSource, alt, attempt, "alt_blocked", err)
		slog.Warn("blockdetect: alternativní zdroj selhal",
			"op", "blockdetect.Recover/alt_blocked",
			"current_source", currentSource,
			"alternate", alt,
			"attempt", attempt,
			"block_type", bt.String(),
			"error", err,
		)
	}

	slog.Warn("blockdetect: recovery vyčerpáno bez úspěchu",
		"op", "blockdetect.Recover/exhausted",
		"current_source", currentSource,
		"tried", tried,
	)
	return RecoveryOutcome{
		Recovered: false,
		Attempts:  tried,
		LastErr:   fmt.Errorf("blockdetect.Recover: exhausted %d alternates", len(tried)),
	}
}

// recordAttempt updates the rolling window for the named source. If the
// failure count crosses BreakerOpenThreshold the breaker opens and a
// structured Warn is logged.
func (r *Recoverer) recordAttempt(source string, failed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	b := r.breakers[source]
	if b == nil {
		b = &breakerState{}
		r.breakers[source] = b
	}

	// Auto-close breaker once the cooldown elapses. Done lazily here (vs a
	// ticker) so the package has no background goroutines.
	if b.open && !b.openedAt.IsZero() && r.now().Sub(b.openedAt) >= BreakerCooldown {
		b.open = false
		b.openedAt = time.Time{}
		// Reset window so we don't immediately re-open from stale data.
		b.window = [BreakerWindowSize]bool{}
		b.idx = 0
		b.filled = 0
		b.failCount = 0
	}

	// Subtract the slot we are about to overwrite.
	if b.filled == BreakerWindowSize && b.window[b.idx] {
		b.failCount--
	}
	b.window[b.idx] = failed
	if failed {
		b.failCount++
	}
	b.idx = (b.idx + 1) % BreakerWindowSize
	if b.filled < BreakerWindowSize {
		b.filled++
	}

	if !b.open && b.failCount >= BreakerOpenThreshold {
		b.open = true
		b.openedAt = r.now()
		slog.Warn("blockdetect: breaker otevřen",
			"op", "blockdetect.Recover/breaker_open",
			"source", source,
			"fail_count", b.failCount,
			"window_size", BreakerWindowSize,
			"threshold", BreakerOpenThreshold,
		)
	}
}

// IsOpen reports whether the named source's breaker is currently open.
// Auto-closes the breaker if the cooldown has elapsed (lazy reset).
func (r *Recoverer) IsOpen(source string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	b := r.breakers[source]
	if b == nil || !b.open {
		return false
	}
	if !b.openedAt.IsZero() && r.now().Sub(b.openedAt) >= BreakerCooldown {
		b.open = false
		b.openedAt = time.Time{}
		b.window = [BreakerWindowSize]bool{}
		b.idx = 0
		b.filled = 0
		b.failCount = 0
		return false
	}
	return true
}

// BreakerSnapshot is a JSON-friendly view of breaker state for the BFF
// `/api/scraper/healing` endpoint.
type BreakerSnapshot struct {
	Open      bool      `json:"open"`
	OpenedAt  time.Time `json:"opened_at"`
	FailCount int       `json:"fail_count"`
	Window    int       `json:"window"`
}

// SnapshotBreakers returns a {source: snapshot} map. Safe for concurrent
// callers; takes the recoverer mutex once.
func (r *Recoverer) SnapshotBreakers() map[string]BreakerSnapshot {
	out := make(map[string]BreakerSnapshot)
	if r == nil {
		return out
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for name, b := range r.breakers {
		out[name] = BreakerSnapshot{
			Open:      b.open,
			OpenedAt:  b.openedAt,
			FailCount: b.failCount,
			Window:    b.filled,
		}
	}
	return out
}

// emitBreadcrumb pushes a Sentry breadcrumb describing one recovery
// attempt. Safe to call when sentry.Init was never invoked (the SDK uses a
// singleton no-op hub). The breadcrumb level is Warning for failures and
// Info for the success / "no_alternate" terminator.
func (r *Recoverer) emitBreadcrumb(currentSource, alt string, attempt int, status string, err error) {
	hub := sentry.CurrentHub()
	if hub == nil {
		return
	}
	level := sentry.LevelInfo
	if status == "alt_blocked" || status == "breaker_open" || status == "no_alternate" {
		level = sentry.LevelWarning
	}
	data := map[string]interface{}{
		"current_source": currentSource,
		"alternate":      alt,
		"attempt":        attempt,
		"status":         status,
	}
	if err != nil {
		data["error"] = err.Error()
	}
	hub.AddBreadcrumb(&sentry.Breadcrumb{
		Category:  "blockdetect-recover",
		Message:   fmt.Sprintf("recover-%s attempt=%d status=%s", currentSource, attempt, status),
		Level:     level,
		Timestamp: r.now(),
		Data:      data,
	}, nil)
}
