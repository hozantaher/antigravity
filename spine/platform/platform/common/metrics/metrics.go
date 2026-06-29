// Package metrics implements a minimal Prometheus exposition format using
// only the Go standard library. We avoid the heavyweight
// github.com/prometheus/client_golang dependency because our metric surface
// is small (counters, gauges, labeled variants) and a few hundred lines of
// stdlib code keep the binary lean and auditable.
//
// Exposition format reference:
//   https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format
//
// Usage:
//
//	metrics.SendTotal.Inc()
//	metrics.BounceRate.Set(0.03)
//	metrics.DomainCircuit.With("domain", "example.test").Set(1)
//	http.Handle("/metrics", metrics.Handler())
package metrics

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Counter is a monotonically increasing 64-bit counter. Safe for concurrent use.
type Counter struct {
	name string
	help string
	v    atomic.Int64
}

// Gauge is a 64-bit integer (or float via IEEE 754 bit reinterpretation) that
// can be set to arbitrary values. We use int64 bits to avoid pulling
// sync/atomic/atomicfloat shenanigans.
type Gauge struct {
	name string
	help string
	mu   sync.RWMutex
	v    float64
}

// LabeledGauge stores per-label-set gauge values (e.g. per-domain circuit state).
// Label names are fixed at construction; label values are dynamic.
type LabeledGauge struct {
	name       string
	help       string
	labelNames []string
	mu         sync.RWMutex
	values     map[string]float64 // key = joined label values
}

// LabeledCounter stores per-label-set counters.
type LabeledCounter struct {
	name       string
	help       string
	labelNames []string
	mu         sync.RWMutex
	values     map[string]int64
}

var (
	regMu      sync.RWMutex
	counters   = make([]*Counter, 0, 32)
	gauges     = make([]*Gauge, 0, 32)
	labCounts  = make([]*LabeledCounter, 0, 32)
	labGauges  = make([]*LabeledGauge, 0, 32)
)

// NewCounter registers and returns a new counter.
func NewCounter(name, help string) *Counter {
	c := &Counter{name: name, help: help}
	regMu.Lock()
	counters = append(counters, c)
	regMu.Unlock()
	return c
}

// NewGauge registers and returns a new gauge.
func NewGauge(name, help string) *Gauge {
	g := &Gauge{name: name, help: help}
	regMu.Lock()
	gauges = append(gauges, g)
	regMu.Unlock()
	return g
}

// NewLabeledCounter registers and returns a new labeled counter.
func NewLabeledCounter(name, help string, labels ...string) *LabeledCounter {
	lc := &LabeledCounter{
		name:       name,
		help:       help,
		labelNames: append([]string(nil), labels...),
		values:     make(map[string]int64),
	}
	regMu.Lock()
	labCounts = append(labCounts, lc)
	regMu.Unlock()
	return lc
}

// NewLabeledGauge registers and returns a new labeled gauge.
func NewLabeledGauge(name, help string, labels ...string) *LabeledGauge {
	lg := &LabeledGauge{
		name:       name,
		help:       help,
		labelNames: append([]string(nil), labels...),
		values:     make(map[string]float64),
	}
	regMu.Lock()
	labGauges = append(labGauges, lg)
	regMu.Unlock()
	return lg
}

// Inc increments the counter by 1.
func (c *Counter) Inc() { c.v.Add(1) }

// Add adds n to the counter. Negative values are ignored.
func (c *Counter) Add(n int64) {
	if n <= 0 {
		return
	}
	c.v.Add(n)
}

// Value returns the current counter value.
func (c *Counter) Value() int64 { return c.v.Load() }

// Set sets the gauge to v.
func (g *Gauge) Set(v float64) {
	g.mu.Lock()
	g.v = v
	g.mu.Unlock()
}

// Value returns the current gauge value.
func (g *Gauge) Value() float64 {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.v
}

// Inc increments a labeled counter for the given label values.
// labelValues must be in the same order as labelNames.
func (lc *LabeledCounter) Inc(labelValues ...string) {
	lc.Add(1, labelValues...)
}

// Add adds n to the labeled counter for the given label values.
func (lc *LabeledCounter) Add(n int64, labelValues ...string) {
	if n <= 0 || len(labelValues) != len(lc.labelNames) {
		return
	}
	key := strings.Join(labelValues, "\x00")
	lc.mu.Lock()
	lc.values[key] += n
	lc.mu.Unlock()
}

// Set sets the labeled gauge to v for the given label values.
func (lg *LabeledGauge) Set(v float64, labelValues ...string) {
	if len(labelValues) != len(lg.labelNames) {
		return
	}
	key := strings.Join(labelValues, "\x00")
	lg.mu.Lock()
	lg.values[key] = v
	lg.mu.Unlock()
}

// Delete removes a label-set from the labeled gauge. Useful for removing
// stale per-domain state after a circuit recloses.
func (lg *LabeledGauge) Delete(labelValues ...string) {
	if len(labelValues) != len(lg.labelNames) {
		return
	}
	key := strings.Join(labelValues, "\x00")
	lg.mu.Lock()
	delete(lg.values, key)
	lg.mu.Unlock()
}

// Handler returns an http.Handler that emits Prometheus text-format metrics.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		write(w)
	})
}

func write(w io.Writer) {
	regMu.RLock()
	defer regMu.RUnlock()

	for _, c := range counters {
		fmt.Fprintf(w, "# HELP %s %s\n", c.name, escapeHelp(c.help))
		fmt.Fprintf(w, "# TYPE %s counter\n", c.name)
		fmt.Fprintf(w, "%s %d\n", c.name, c.v.Load())
	}
	for _, g := range gauges {
		fmt.Fprintf(w, "# HELP %s %s\n", g.name, escapeHelp(g.help))
		fmt.Fprintf(w, "# TYPE %s gauge\n", g.name)
		g.mu.RLock()
		fmt.Fprintf(w, "%s %s\n", g.name, formatFloat(g.v))
		g.mu.RUnlock()
	}
	for _, lc := range labCounts {
		fmt.Fprintf(w, "# HELP %s %s\n", lc.name, escapeHelp(lc.help))
		fmt.Fprintf(w, "# TYPE %s counter\n", lc.name)
		lc.mu.RLock()
		keys := sortedKeys(lc.values)
		for _, k := range keys {
			fmt.Fprintf(w, "%s{%s} %d\n", lc.name, formatLabels(lc.labelNames, k), lc.values[k])
		}
		lc.mu.RUnlock()
	}
	for _, lg := range labGauges {
		fmt.Fprintf(w, "# HELP %s %s\n", lg.name, escapeHelp(lg.help))
		fmt.Fprintf(w, "# TYPE %s gauge\n", lg.name)
		lg.mu.RLock()
		keys := sortedKeysF(lg.values)
		for _, k := range keys {
			fmt.Fprintf(w, "%s{%s} %s\n", lg.name, formatLabels(lg.labelNames, k), formatFloat(lg.values[k]))
		}
		lg.mu.RUnlock()
	}
}

func sortedKeys(m map[string]int64) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func sortedKeysF(m map[string]float64) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func formatLabels(names []string, key string) string {
	vals := strings.Split(key, "\x00")
	parts := make([]string, 0, len(names))
	for i, n := range names {
		v := ""
		if i < len(vals) {
			v = vals[i]
		}
		parts = append(parts, fmt.Sprintf("%s=%q", n, escapeLabelValue(v)))
	}
	return strings.Join(parts, ",")
}

func escapeHelp(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

func escapeLabelValue(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

func formatFloat(v float64) string {
	// Prometheus accepts plain decimal; avoid scientific notation for small
	// values because scrapers sometimes parse more permissively than the spec.
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.6f", v), "0"), ".")
}

// Reset clears all registered metrics. Tests only.
func Reset() {
	regMu.Lock()
	defer regMu.Unlock()
	counters = counters[:0]
	gauges = gauges[:0]
	labCounts = labCounts[:0]
	labGauges = labGauges[:0]
}
