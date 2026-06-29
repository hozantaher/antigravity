package profile

import (
	"strings"
	"sync"
	"time"
)

// Tracker is a per-mailbox sliding-window send counter. Used to drive
// rate-limit verdicts: a profile with rate_limit_per_hour=100 plus a
// tracker that says "this mailbox sent 99 in the last hour" yields the
// Allow decision; the 101st call flips to deny.
//
// Implementation: append-only timestamp slice per mailbox, pruned on
// each read. Suitable for the lab's tiny traffic (a few hundred sends
// per scenario run); production-grade replacements would use Redis or
// a token bucket.
type Tracker struct {
	mu     sync.Mutex
	window time.Duration
	now    func() time.Time
	stamps map[string][]time.Time
}

// NewTracker returns a tracker with the given window (default 1h when
// zero or negative). The clock is fixed to time.Now; tests can swap via
// SetClock.
func NewTracker(window time.Duration) *Tracker {
	if window <= 0 {
		window = time.Hour
	}
	return &Tracker{
		window: window,
		now:    time.Now,
		stamps: map[string][]time.Time{},
	}
}

// SetClock replaces the time source. Test-only entry point.
func (t *Tracker) SetClock(fn func() time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.now = fn
}

// Record adds a send event for the mailbox at the current clock time and
// returns the post-record count within the window.
func (t *Tracker) Record(mailbox string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	key := strings.ToLower(strings.TrimSpace(mailbox))
	cutoff := t.now().Add(-t.window)
	t.stamps[key] = append(prune(t.stamps[key], cutoff), t.now())
	return len(t.stamps[key])
}

// Count returns the number of events within the window for the mailbox.
// Pruning happens on read so stale entries don't accumulate forever.
func (t *Tracker) Count(mailbox string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	key := strings.ToLower(strings.TrimSpace(mailbox))
	cutoff := t.now().Add(-t.window)
	t.stamps[key] = prune(t.stamps[key], cutoff)
	return len(t.stamps[key])
}

// Allow tells whether one more event for mailbox would fit under the
// profile's rate_limit_per_hour. Profiles with limit <= 0 are
// considered unlimited (Allow always true).
func (t *Tracker) Allow(mailbox string, p *Profile) bool {
	if p == nil || p.RateLimitPerHour <= 0 {
		return true
	}
	return t.Count(mailbox) < p.RateLimitPerHour
}

// Reset drops all tracking state. Used between chaos scenarios.
func (t *Tracker) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.stamps = map[string][]time.Time{}
}

// ── Registry-bound rate methods ────────────────────────────────────────

// RateRecord adds a send event for mailbox under the registry's tracker
// and returns the post-record count plus the per-domain limit. Unknown
// domain → ErrUnknownDomain.
func (r *Registry) RateRecord(domain, mailbox string) (int, int, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return 0, 0, ErrUnknownDomain
	}
	count := r.tracker.Record(mailbox)
	return count, p.RateLimitPerHour, nil
}

// RateCount returns the current count + limit for mailbox under domain.
func (r *Registry) RateCount(domain, mailbox string) (int, int, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return 0, 0, ErrUnknownDomain
	}
	return r.tracker.Count(mailbox), p.RateLimitPerHour, nil
}

// RateAllow returns whether one more send for mailbox would fit under
// the profile's rate_limit_per_hour.
func (r *Registry) RateAllow(domain, mailbox string) (bool, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return false, ErrUnknownDomain
	}
	return r.tracker.Allow(mailbox, p), nil
}

// RateReset clears all tracked send events. Used between scenarios.
func (r *Registry) RateReset() {
	r.tracker.Reset()
}

// SetClock swaps the tracker's time source — test injection point.
func (r *Registry) SetClock(fn func() time.Time) {
	r.tracker.SetClock(fn)
}

// prune drops entries older than cutoff. Returns a new slice; never
// mutates the caller's reference unless the slice header is identical.
func prune(stamps []time.Time, cutoff time.Time) []time.Time {
	// Find the first index whose timestamp is >= cutoff. Stamps append
	// in chronological order so a binary search would work; linear is
	// fine for the lab's traffic size.
	keep := 0
	for ; keep < len(stamps); keep++ {
		if !stamps[keep].Before(cutoff) {
			break
		}
	}
	if keep == 0 {
		return stamps
	}
	out := make([]time.Time, len(stamps)-keep)
	copy(out, stamps[keep:])
	return out
}
