package profile

import (
	"strings"
	"sync"
	"time"
)

// GreylistTracker keeps the (sender_ip, sender_addr, recipient_addr)
// triplet state real Postfix postgrey/sqlgrey use:
//
//   1. First time a triplet is seen — defer (Allow=false). Real MTAs
//      respond 451 4.7.1 "greylisted, try again later".
//   2. If the same sender retries before the delay window passes —
//      defer again.
//   3. After delay elapses, accept + remember as "known" so subsequent
//      messages skip the defer.
//   4. After ttl elapses without traffic, the triplet ages out (we
//      forget it; next message starts the dance over).
//
// Defaults match common postgrey: delay=5min, ttl=35d. Tests can
// override both via SetClock + custom values in NewGreylistTracker.
type GreylistTracker struct {
	mu      sync.Mutex
	delay   time.Duration
	ttl     time.Duration
	now     func() time.Time
	entries map[string]*greyEntry
}

type greyEntry struct {
	firstSeen time.Time
	accepted  bool // true once delay has elapsed and a retry came through
	lastSeen  time.Time
}

// NewGreylistTracker returns a tracker. Zero/negative delay → 5min.
// Zero/negative ttl → 35 days.
func NewGreylistTracker(delay, ttl time.Duration) *GreylistTracker {
	if delay <= 0 {
		delay = 5 * time.Minute
	}
	if ttl <= 0 {
		ttl = 35 * 24 * time.Hour
	}
	return &GreylistTracker{
		delay:   delay,
		ttl:     ttl,
		now:     time.Now,
		entries: map[string]*greyEntry{},
	}
}

// SetClock replaces the time source. Test-only.
func (g *GreylistTracker) SetClock(fn func() time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.now = fn
}

// Allow runs the greylist state machine for the triplet and returns
// (allowed, reason). The reason describes why the decision was made —
// useful for chaos-test logs.
func (g *GreylistTracker) Allow(senderIP, senderAddr, recipientAddr string) (bool, string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	key := tripletKey(senderIP, senderAddr, recipientAddr)
	now := g.now()
	g.gcLocked(now)

	e, seen := g.entries[key]
	if !seen {
		g.entries[key] = &greyEntry{firstSeen: now, lastSeen: now}
		return false, "first contact, deferred"
	}
	e.lastSeen = now
	if e.accepted {
		return true, "known sender"
	}
	if now.Sub(e.firstSeen) >= g.delay {
		e.accepted = true
		return true, "delay elapsed, accepted"
	}
	return false, "delay not yet elapsed"
}

// Known reports whether the triplet has graduated past the defer phase
// without recording a new event. Useful when the verdict needs the
// KnownSender flag without performing the state transition.
func (g *GreylistTracker) Known(senderIP, senderAddr, recipientAddr string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.gcLocked(g.now())
	e, ok := g.entries[tripletKey(senderIP, senderAddr, recipientAddr)]
	return ok && e.accepted
}

// Reset drops all triplet state.
func (g *GreylistTracker) Reset() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.entries = map[string]*greyEntry{}
}

// gcLocked drops entries whose lastSeen is older than ttl. Called from
// Allow/Known so stale entries don't accumulate forever.
func (g *GreylistTracker) gcLocked(now time.Time) {
	cutoff := now.Add(-g.ttl)
	for k, e := range g.entries {
		if e.lastSeen.Before(cutoff) {
			delete(g.entries, k)
		}
	}
}

// ── Registry-bound greylist methods ────────────────────────────────────

// GreylistAllow runs the greylist state machine for the triplet under
// the named domain. Profile must have greylist_unknown_sender=true,
// otherwise the call short-circuits to allow=true.
func (r *Registry) GreylistAllow(domain, senderIP, senderAddr, recipientAddr string) (bool, string, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return false, "", ErrUnknownDomain
	}
	if !p.GreylistUnknownSender {
		return true, "greylist disabled by profile", nil
	}
	allow, reason := r.greylist.Allow(senderIP, senderAddr, recipientAddr)
	return allow, reason, nil
}

// GreylistKnown queries graduate status without recording an event.
func (r *Registry) GreylistKnown(domain, senderIP, senderAddr, recipientAddr string) (bool, error) {
	r.mu.RLock()
	_, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return false, ErrUnknownDomain
	}
	return r.greylist.Known(senderIP, senderAddr, recipientAddr), nil
}

// GreylistReset clears greylist tracker state.
func (r *Registry) GreylistReset() {
	r.greylist.Reset()
}

// SetGreylistClock swaps the greylist tracker's clock — test injection.
func (r *Registry) SetGreylistClock(fn func() time.Time) {
	r.greylist.SetClock(fn)
}

func tripletKey(ip, sender, recipient string) string {
	return strings.ToLower(strings.TrimSpace(ip)) + "|" +
		strings.ToLower(strings.TrimSpace(sender)) + "|" +
		strings.ToLower(strings.TrimSpace(recipient))
}
