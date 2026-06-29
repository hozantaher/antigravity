package health

import (
	"sync"
	"time"
)

// DaemonStatus holds the last-known state of a background daemon or subsystem.
type DaemonStatus struct {
	Name    string    `json:"name"`
	OK      bool      `json:"ok"`
	LastRun time.Time `json:"last_run,omitempty"`
	Error   string    `json:"error,omitempty"`
}

// Registry is a thread-safe store of daemon/subsystem health statuses.
type Registry struct {
	mu     sync.RWMutex
	states map[string]*DaemonStatus
	start  time.Time
}

// New creates a new health registry.
func New() *Registry {
	return &Registry{
		states: make(map[string]*DaemonStatus),
		start:  time.Now(),
	}
}

// Report records the outcome of a daemon tick. errMsg may be "" for success.
func (r *Registry) Report(name string, ok bool, errMsg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states[name] = &DaemonStatus{
		Name:    name,
		OK:      ok,
		LastRun: time.Now(),
		Error:   errMsg,
	}
}

// Snapshot returns a copy of all statuses, safe to marshal to JSON.
func (r *Registry) Snapshot() []*DaemonStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*DaemonStatus, 0, len(r.states))
	for _, s := range r.states {
		cp := *s
		out = append(out, &cp)
	}
	return out
}

// AllOK returns true only if every reported daemon is OK.
func (r *Registry) AllOK() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, s := range r.states {
		if !s.OK {
			return false
		}
	}
	return true
}

// UptimeSeconds is seconds since registry creation.
func (r *Registry) UptimeSeconds() float64 {
	return time.Since(r.start).Seconds()
}

// Stale returns names of daemons that have not reported within maxAge.
// Use to surface "dead daemon" situations where the goroutine exited without
// reporting a failure (e.g. silent panic before recovery was added).
func (r *Registry) Stale(maxAge time.Duration) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	now := time.Now()
	var stale []string
	for _, s := range r.states {
		if !s.LastRun.IsZero() && now.Sub(s.LastRun) > maxAge {
			stale = append(stale, s.Name)
		}
	}
	return stale
}
