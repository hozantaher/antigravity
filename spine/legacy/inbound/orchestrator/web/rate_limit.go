package web

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"common/envconfig"
)

// State-changing-endpoint rate limiter (S1.2).
//
// SCOPE: Wraps POST/PUT/DELETE/PATCH handlers (campaigns, segments,
// replies, release-hold, recalc). Read paths (`/o`, `/c`,
// `/dashboard`, `/health`, `/healthz`, `/metrics`, GET API endpoints)
// remain on the existing sliding-window `ipLimiter` or stay
// unlimited — read paths do not mutate state and the open-pixel /
// click endpoints have their own per-IP sliding-window via
// `rateLimited(...)`.
//
// ALGORITHM: Token bucket — one bucket per remote IP. Each bucket
// refills at `rate` tokens/sec (default 10) and caps at `burst`
// tokens (default 30). A request consumes one token; if the bucket
// is empty the request is rejected with HTTP 429 and a
// `Retry-After: 1` header.
//
// References:
//   - RFC 6585 §4 (HTTP 429 Too Many Requests)
//   - RFC 7231 §7.1.3 (Retry-After header)
//   - Tanenbaum & Wetherall, *Computer Networks*, 5th ed., §5.3
//     (token-bucket vs leaky-bucket traffic shaping)
//
// MEMORY: Per-IP buckets are kept in a map capped at `maxIPs`
// entries (default 10000). When the cap is hit on insert the
// oldest bucket is evicted. Idle buckets are also dropped after
// `ttl` (default 1h) by a background ticker. Cap+TTL bound the
// worst-case memory at ~`maxIPs * sizeof(tokenBucket)`.

// tokenBucket holds the per-IP state for the token-bucket algorithm.
type tokenBucket struct {
	tokens   float64   // current token count (fractional accrual)
	lastSeen time.Time // wall clock at last refill — also drives LRU TTL
}

// stateLimiter is a per-IP token-bucket rate limiter for
// state-changing HTTP endpoints. It is safe for concurrent use.
type stateLimiter struct {
	rate    float64       // tokens added per second
	burst   float64       // max tokens in the bucket
	maxIPs  int           // hard cap on tracked unique IPs
	ttl     time.Duration // idle-bucket eviction window
	now     func() time.Time
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	stopCh  chan struct{}
}

// newStateLimiter builds a token-bucket limiter with the given
// sustained-rate (req/s), burst, max tracked IPs, and idle TTL.
func newStateLimiter(rate, burst float64, maxIPs int, ttl time.Duration) *stateLimiter {
	if rate <= 0 {
		rate = 10
	}
	if burst < 1 {
		burst = 30
	}
	if maxIPs <= 0 {
		maxIPs = 10000
	}
	if ttl <= 0 {
		ttl = time.Hour
	}
	l := &stateLimiter{
		rate:    rate,
		burst:   burst,
		maxIPs:  maxIPs,
		ttl:     ttl,
		now:     time.Now,
		buckets: make(map[string]*tokenBucket),
		stopCh:  make(chan struct{}),
	}
	go l.evictLoop()
	return l
}

// allow consumes one token for ip; returns true if the request is
// permitted. Returns false (caller should reply 429) when the
// bucket is empty.
func (l *stateLimiter) allow(ip string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[ip]
	if !ok {
		// Memory cap: evict the oldest bucket before inserting.
		if len(l.buckets) >= l.maxIPs {
			l.evictOldestLocked()
		}
		// New bucket starts full minus the one token consumed now.
		l.buckets[ip] = &tokenBucket{tokens: l.burst - 1, lastSeen: now}
		return true
	}

	// Refill since lastSeen.
	elapsed := now.Sub(b.lastSeen).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * l.rate
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
	}
	b.lastSeen = now

	if b.tokens >= 1 {
		b.tokens -= 1
		return true
	}
	return false
}

// evictOldestLocked drops the single oldest bucket. Must be called
// with l.mu held.
func (l *stateLimiter) evictOldestLocked() {
	var oldestKey string
	var oldestSeen time.Time
	first := true
	for ip, b := range l.buckets {
		if first || b.lastSeen.Before(oldestSeen) {
			oldestKey = ip
			oldestSeen = b.lastSeen
			first = false
		}
	}
	if !first {
		delete(l.buckets, oldestKey)
	}
}

// evictLoop periodically removes buckets idle longer than ttl.
func (l *stateLimiter) evictLoop() {
	tick := time.NewTicker(l.ttl / 4)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			l.evictIdle()
		case <-l.stopCh:
			return
		}
	}
}

// evictIdle drops buckets whose lastSeen is older than ttl.
func (l *stateLimiter) evictIdle() {
	cutoff := l.now().Add(-l.ttl)
	l.mu.Lock()
	defer l.mu.Unlock()
	for ip, b := range l.buckets {
		if b.lastSeen.Before(cutoff) {
			delete(l.buckets, ip)
		}
	}
}

// stop halts the background eviction goroutine. Tests use it via
// t.Cleanup so the goroutine doesn't leak.
func (l *stateLimiter) stop() {
	select {
	case <-l.stopCh:
		// already closed
	default:
		close(l.stopCh)
	}
}

// RateLimitState wraps next with a per-IP token-bucket gate using
// the supplied limiter. On rejection the response is HTTP 429 with
// `Retry-After: 1` and a JSON body `{"error":"rate_limited"}`.
//
// Mount this only on state-changing routes (POST/PUT/DELETE/PATCH).
// GET routes should remain unwrapped or use the existing
// sliding-window `rateLimited(...)` helper.
func RateLimitState(l *stateLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(remoteIP(r)) {
			w.Header().Set("Retry-After", "1")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"rate_limited"}`))
			return
		}
		next(w, r)
	}
}

// methodGuardedRateLimit applies RateLimitState only when the
// request method is state-changing (POST / PUT / DELETE / PATCH).
// GET / HEAD / OPTIONS bypass the limiter. This lets a single
// registered route (e.g. /api/campaigns) serve both reads and
// writes while only the write surface is rate-limited.
func methodGuardedRateLimit(l *stateLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
			RateLimitState(l, next)(w, r)
		default:
			next(w, r)
		}
	}
}

// stateLimiterFromEnv builds a stateLimiter using overridable env
// vars. Variables (all optional, with sensible defaults):
//
//	OUTREACH_STATE_RATE_PER_SEC   (default 10)
//	OUTREACH_STATE_BURST          (default 30)
//	OUTREACH_STATE_MAX_IPS        (default 10000)
//	OUTREACH_STATE_IDLE_TTL_SEC   (default 3600)
//
// envconfig.GetOr is used (NOT bare os.Getenv) per services/common
// envconfig consumption ratchet — see services/common/CLAUDE.md.
func stateLimiterFromEnv() *stateLimiter {
	rate := envFloat("OUTREACH_STATE_RATE_PER_SEC", 10)
	burst := envFloat("OUTREACH_STATE_BURST", 30)
	maxIPs := envInt("OUTREACH_STATE_MAX_IPS", 10000)
	ttlSec := envInt("OUTREACH_STATE_IDLE_TTL_SEC", 3600)
	return newStateLimiter(rate, burst, maxIPs, time.Duration(ttlSec)*time.Second)
}

func envFloat(key string, fallback float64) float64 {
	raw := envconfig.GetOr(key, "")
	if raw == "" {
		return fallback
	}
	if v, err := strconv.ParseFloat(raw, 64); err == nil && v > 0 {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw := envconfig.GetOr(key, "")
	if raw == "" {
		return fallback
	}
	if v, err := strconv.Atoi(raw); err == nil && v > 0 {
		return v
	}
	return fallback
}
