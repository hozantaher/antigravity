package web

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// ipLimiter is a sliding-window rate limiter keyed by remote IP.
// It is safe for concurrent use.
type ipLimiter struct {
	mu       sync.Mutex
	requests map[string][]time.Time
	window   time.Duration
	max      int
}

func newIPLimiter(max int, window time.Duration) *ipLimiter {
	l := &ipLimiter{
		requests: make(map[string][]time.Time),
		window:   window,
		max:      max,
	}
	go l.evict()
	return l
}

// allow returns true if the request should be permitted.
func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-l.window)

	prev := l.requests[ip]
	var recent []time.Time
	for _, t := range prev {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}

	if len(recent) >= l.max {
		l.requests[ip] = recent
		return false
	}

	l.requests[ip] = append(recent, now)
	return true
}

// evict removes stale IP entries every window to prevent unbounded growth.
func (l *ipLimiter) evict() {
	ticker := time.NewTicker(l.window)
	defer ticker.Stop()
	for range ticker.C {
		l.mu.Lock()
		cutoff := time.Now().Add(-l.window)
		for ip, times := range l.requests {
			var keep []time.Time
			for _, t := range times {
				if t.After(cutoff) {
					keep = append(keep, t)
				}
			}
			if len(keep) == 0 {
				delete(l.requests, ip)
			} else {
				l.requests[ip] = keep
			}
		}
		l.mu.Unlock()
	}
}

// remoteIP extracts the real client IP, respecting X-Forwarded-For when
// the connection comes through a trusted proxy (Railway).
func remoteIP(r *http.Request) string {
	// X-Forwarded-For is set by Railway's load balancer
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		// Take only the first entry to avoid spoofing by appending IPs
		host, _, err := net.SplitHostPort(fwd)
		if err != nil {
			return fwd
		}
		return host
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimited wraps a handler and applies a per-IP rate limit.
// Exceeding the limit returns 429 Too Many Requests.
func rateLimited(l *ipLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(remoteIP(r)) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next(w, r)
	}
}
