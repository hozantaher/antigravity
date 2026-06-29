package metrics

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

// Registry holds all privacy-safe metrics.
// No per-submitter breakdown, no IPs, no content.
type Registry struct {
	submissionsReceived atomic.Int64
	bridgeDelivered     atomic.Int64
	bridgeFailed        atomic.Int64
	queueDepth          atomic.Int64
	// latency buckets for relay (ms): <100, <500, <1000, <5000, >=5000
	latencyBuckets [5]atomic.Int64
}

// Global is the default metrics registry.
var Global = &Registry{}

// IncSubmissionsReceived increments the total submissions received counter.
func (r *Registry) IncSubmissionsReceived() { r.submissionsReceived.Add(1) }

// IncBridgeDelivered increments the total successful bridge deliveries counter.
func (r *Registry) IncBridgeDelivered() { r.bridgeDelivered.Add(1) }

// IncBridgeFailed increments the total bridge delivery failures counter.
func (r *Registry) IncBridgeFailed() { r.bridgeFailed.Add(1) }

// SetQueueDepth sets the current relay queue depth gauge.
func (r *Registry) SetQueueDepth(n int64) { r.queueDepth.Store(n) }

// ObserveRelayLatency records a relay latency observation into the appropriate bucket.
func (r *Registry) ObserveRelayLatency(d time.Duration) {
	ms := d.Milliseconds()
	switch {
	case ms < 100:
		r.latencyBuckets[0].Add(1)
	case ms < 500:
		r.latencyBuckets[1].Add(1)
	case ms < 1000:
		r.latencyBuckets[2].Add(1)
	case ms < 5000:
		r.latencyBuckets[3].Add(1)
	default:
		r.latencyBuckets[4].Add(1)
	}
}

// TextFormat returns Prometheus text format output.
// All metrics are aggregate only — no per-submitter data, no IPs.
func (r *Registry) TextFormat() string {
	var b strings.Builder

	write := func(name, help, typ string, value int64) {
		fmt.Fprintf(&b, "# HELP %s %s\n", name, help)
		fmt.Fprintf(&b, "# TYPE %s %s\n", name, typ)
		fmt.Fprintf(&b, "%s %d\n", name, value)
	}

	write("atr_submissions_received_total", "Total submissions received", "counter", r.submissionsReceived.Load())
	write("atr_bridge_delivered_total", "Total envelopes successfully delivered via bridge", "counter", r.bridgeDelivered.Load())
	write("atr_bridge_failed_total", "Total bridge delivery failures", "counter", r.bridgeFailed.Load())
	write("atr_queue_depth", "Current relay queue depth", "gauge", r.queueDepth.Load())

	// Latency histogram: cumulative bucket counts per Prometheus convention.
	bounds := []string{"0.1", "0.5", "1.0", "5.0", "+Inf"}
	fmt.Fprintf(&b, "# HELP atr_relay_latency_seconds Relay latency histogram\n")
	fmt.Fprintf(&b, "# TYPE atr_relay_latency_seconds histogram\n")
	cumulative := int64(0)
	for i, bound := range bounds {
		cumulative += r.latencyBuckets[i].Load()
		fmt.Fprintf(&b, "atr_relay_latency_seconds_bucket{le=%q} %d\n", bound, cumulative)
	}
	fmt.Fprintf(&b, "atr_relay_latency_seconds_count %d\n", cumulative)

	return b.String()
}
