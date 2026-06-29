package abuse

import (
	"errors"
	"sync"
	"time"
)

var ErrRateLimited = errors.New("rate limited")

// Limiter provides per-actor rate limiting and volume anomaly detection.
type Limiter struct {
	mu        sync.Mutex
	windows   map[string]*window
	maxPerMin int
	now       func() time.Time
}

type window struct {
	counts []time.Time
}

// NewLimiter creates a rate limiter with the given per-minute maximum.
func NewLimiter(maxPerMinute int) *Limiter {
	return &Limiter{
		windows:   make(map[string]*window),
		maxPerMin: maxPerMinute,
		now:       time.Now,
	}
}

// Check returns nil if the actor is within rate limits, ErrRateLimited otherwise.
func (l *Limiter) Check(actorID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	cutoff := now.Add(-time.Minute)

	w, ok := l.windows[actorID]
	if !ok {
		w = &window{}
		l.windows[actorID] = w
	}

	// Prune old entries
	fresh := w.counts[:0]
	for _, t := range w.counts {
		if t.After(cutoff) {
			fresh = append(fresh, t)
		}
	}
	w.counts = fresh

	if len(w.counts) >= l.maxPerMin {
		return ErrRateLimited
	}

	w.counts = append(w.counts, now)
	return nil
}

// Cleanup removes stale actor windows. Call periodically.
func (l *Limiter) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := l.now().Add(-5 * time.Minute)
	for actor, w := range l.windows {
		if len(w.counts) == 0 {
			delete(l.windows, actor)
			continue
		}
		latest := w.counts[len(w.counts)-1]
		if latest.Before(cutoff) {
			delete(l.windows, actor)
		}
	}
}
