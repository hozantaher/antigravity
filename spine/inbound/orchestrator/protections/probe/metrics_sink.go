package probe

import (
	"context"
	"fmt"
	"common/metrics"
)

// MetricsSink wraps any Sink and increments Prometheus-style counters
// after each probe write. It never blocks or fails: metric errors are
// silently discarded so a metrics bug cannot interrupt probe delivery.
type MetricsSink struct {
	Inner Sink
}

func (m *MetricsSink) Write(ctx context.Context, r Result) error {
	err := m.Inner.Write(ctx, r)
	// Always record the run, even on sink error — the counter is about
	// the probe outcome, not the persistence outcome.
	levelStr := fmt.Sprintf("%d", int(r.Level))
	metrics.ProbeRunTotal.Inc(r.Layer, levelStr, string(r.Status))
	metrics.ProbeLatencyMs.Set(float64(r.Latency.Milliseconds()), r.Layer, levelStr)
	return err
}
