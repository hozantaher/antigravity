// Package admin provides operator-visibility primitives for the relay service.
// All counters are aggregate-only: no per-submitter data, no IPs, no content.
package admin

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const ringSize = 1000

// Stats tracks throughput and latency for admin visibility.
type Stats struct {
	requestsTotal  atomic.Int64
	bytesForwarded atomic.Int64
	startedAt      time.Time

	mu      sync.Mutex
	samples [ringSize]int64 // milliseconds, ring buffer
	head    int             // next write position
	count   int             // total samples recorded (capped at ringSize for percentile use)
}

// NewStats creates a new Stats with the start time set to now.
func NewStats() *Stats {
	return &Stats{startedAt: time.Now()}
}

// IncRequests increments the total request counter by 1.
func (s *Stats) IncRequests() {
	s.requestsTotal.Add(1)
}

// AddBytes adds n to the bytes-forwarded counter.
func (s *Stats) AddBytes(n int64) {
	s.bytesForwarded.Add(n)
}

// ObserveLatency records one latency sample (duration is converted to milliseconds).
func (s *Stats) ObserveLatency(d time.Duration) {
	ms := d.Milliseconds()
	s.mu.Lock()
	s.samples[s.head] = ms
	s.head = (s.head + 1) % ringSize
	if s.count < ringSize {
		s.count++
	}
	s.mu.Unlock()
}

// Snapshot returns a point-in-time view of all counters and percentiles.
func (s *Stats) Snapshot() StatsSnapshot {
	s.mu.Lock()
	n := s.count
	buf := make([]int64, n)
	// copy live samples in order (oldest first is fine for sorting)
	if n > 0 {
		start := s.head - n
		if start < 0 {
			start += ringSize
		}
		for i := 0; i < n; i++ {
			buf[i] = s.samples[(start+i)%ringSize]
		}
	}
	s.mu.Unlock()

	return StatsSnapshot{
		RequestsTotal:  s.requestsTotal.Load(),
		BytesForwarded: s.bytesForwarded.Load(),
		LatencyP50Ms:   percentile(buf, 50),
		LatencyP95Ms:   percentile(buf, 95),
		LatencyP99Ms:   percentile(buf, 99),
		UptimeSeconds:  int64(time.Since(s.startedAt).Seconds()),
	}
}

// StatsSnapshot is the JSON-serialisable view returned by GET /admin/stats.
type StatsSnapshot struct {
	RequestsTotal  int64 `json:"requests_total"`
	BytesForwarded int64 `json:"bytes_forwarded"`
	LatencyP50Ms   int64 `json:"latency_p50_ms"`
	LatencyP95Ms   int64 `json:"latency_p95_ms"`
	LatencyP99Ms   int64 `json:"latency_p99_ms"`
	UptimeSeconds  int64 `json:"uptime_seconds"`
}

// percentile returns the p-th percentile (0–100) of the sorted sample set.
// Returns 0 when the slice is empty.
func percentile(samples []int64, p int) int64 {
	n := len(samples)
	if n == 0 {
		return 0
	}
	sorted := make([]int64, n)
	copy(sorted, samples)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	// Nearest-rank method: rank = ceil(p/100 * n)
	rank := (p*n + 99) / 100 // integer ceiling without float
	if rank < 1 {
		rank = 1
	}
	if rank > n {
		rank = n
	}
	return sorted[rank-1]
}
