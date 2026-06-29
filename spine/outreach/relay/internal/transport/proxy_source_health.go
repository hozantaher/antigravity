package transport

import (
	"log/slog"
	"sync"
	"time"
)

// sourceHealth tracks the health metrics of a single proxy source.
type sourceHealth struct {
	mu              sync.Mutex
	consecutiveZero int32
	lastCount       int
	lastFetchAt     time.Time
	lastError       string
}

// sourceHealthRegistry manages health tracking for all proxy sources.
type sourceHealthRegistry struct {
	mu      sync.RWMutex
	sources map[string]*sourceHealth
}

// globalSourceHealth is the singleton health registry for all proxy sources.
var globalSourceHealth = &sourceHealthRegistry{
	sources: map[string]*sourceHealth{
		"geonode":     {},
		"proxyscrape": {},
		"proxifly":    {},
	},
}

// sourceZeroAlertThreshold is the number of consecutive zero/error results
// before a source is flagged as degraded and a warning is logged.
const sourceZeroAlertThreshold = 3

// recordSourceResult updates the health tracking for a proxy source based on
// the outcome of a fetch operation.
//
// - If count > 0 and err == nil: successful fetch, resets consecutiveZero to 0
// - If count == 0 or err != nil: failed/empty fetch, increments consecutiveZero
// - When consecutiveZero >= sourceZeroAlertThreshold, a warning is logged
func recordSourceResult(name string, count int, err error) {
	globalSourceHealth.mu.RLock()
	h := globalSourceHealth.sources[name]
	globalSourceHealth.mu.RUnlock()
	if h == nil {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastFetchAt = time.Now()
	h.lastCount = count

	if err != nil {
		h.lastError = err.Error()
		h.consecutiveZero++
	} else if count == 0 {
		h.consecutiveZero++
		h.lastError = "returned 0 proxies"
	} else {
		h.consecutiveZero = 0
		h.lastError = ""
	}

	if h.consecutiveZero >= sourceZeroAlertThreshold {
		slog.Warn("proxy_pool: source degraded",
			"op", "transport.recordSourceResult/degraded",
			"source", name,
			"consecutive_zero", h.consecutiveZero,
			"last_error", h.lastError)
	}
}

// SourceHealthSnapshot returns a point-in-time view of the health status for
// all proxy sources. Each source maps to a dict with keys:
// - consecutive_zero: int32 count of consecutive zero/error results
// - last_count: int number of proxies from the last fetch
// - last_error: string error message (empty if last fetch succeeded)
// - degraded: bool true when consecutiveZero >= threshold
func SourceHealthSnapshot() map[string]map[string]interface{} {
	result := make(map[string]map[string]interface{})
	globalSourceHealth.mu.RLock()
	defer globalSourceHealth.mu.RUnlock()

	for name, h := range globalSourceHealth.sources {
		h.mu.Lock()
		result[name] = map[string]interface{}{
			"consecutive_zero": h.consecutiveZero,
			"last_count":       h.lastCount,
			"last_error":       h.lastError,
			"degraded":         h.consecutiveZero >= sourceZeroAlertThreshold,
		}
		h.mu.Unlock()
	}
	return result
}

// SelectAlternative returns the name of a healthy proxy source that is not
// currentSource and not present in exclude. Selection prefers sources with
// the lowest consecutiveZero count (least degraded first). Returns "" when
// no healthy alternative is available.
//
// Used by KT-A8.1 recovery loop in the contacts service: when a scraper
// detects a block on currentSource, it asks SelectAlternative for the next
// candidate, retries, and accumulates excluded names across attempts so the
// same failed source is not reused.
//
// "Healthy" means consecutiveZero < sourceZeroAlertThreshold. A source that
// has never been recorded (zero-value sourceHealth) is treated as healthy
// because the registry is seeded at boot before any fetches run.
func SelectAlternative(currentSource string, exclude []string) string {
	excluded := make(map[string]struct{}, len(exclude)+1)
	if currentSource != "" {
		excluded[currentSource] = struct{}{}
	}
	for _, e := range exclude {
		if e != "" {
			excluded[e] = struct{}{}
		}
	}

	type candidate struct {
		name             string
		consecutiveZero  int32
	}

	var candidates []candidate
	globalSourceHealth.mu.RLock()
	for name, h := range globalSourceHealth.sources {
		if _, skip := excluded[name]; skip {
			continue
		}
		h.mu.Lock()
		zero := h.consecutiveZero
		h.mu.Unlock()
		if zero >= sourceZeroAlertThreshold {
			continue
		}
		candidates = append(candidates, candidate{name: name, consecutiveZero: zero})
	}
	globalSourceHealth.mu.RUnlock()

	if len(candidates) == 0 {
		return ""
	}
	// Pick the candidate with the smallest consecutiveZero. On ties pick the
	// lexicographically smallest name so the choice is deterministic.
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.consecutiveZero < best.consecutiveZero ||
			(c.consecutiveZero == best.consecutiveZero && c.name < best.name) {
			best = c
		}
	}
	return best.name
}
