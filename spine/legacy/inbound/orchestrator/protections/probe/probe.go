// Package probe implements the protection verification framework:
// every declared protection layer is checked periodically at multiple
// levels (L1=exists, L2=alive, L3=correct) and each run is persisted
// to protection_probes for the dashboard OchranyPanel.
//
// Scheduler runs Probers on independent tickers so a slow L3 probe
// cannot starve the fast L2 heartbeat loop. All writes are fire-and-forget
// from the probe's perspective — the Recorder handles persistence errors.
package probe

import (
	"context"
	"sync"
	"time"
)

// Level encodes the depth of the probe.
//
//	L1 = exists   — compile / unit-test presence (not written here, CI-only)
//	L2 = alive    — healthz / TCP / DB ping (30s cadence)
//	L3 = correct  — synthetic canary with observable side-effect (5–15m)
type Level int

const (
	LevelAlive   Level = 2
	LevelCorrect Level = 3
)

// Status is the outcome of a single probe run.
type Status string

const (
	StatusOK   Status = "ok"
	StatusWarn Status = "warn"
	StatusErr  Status = "err"
	StatusSkip Status = "skip" // intentionally not run (dependency down)
)

// Result is one row destined for protection_probes.
type Result struct {
	Layer    string
	Level    Level
	Status   Status
	Detail   string
	Latency  time.Duration
	Expected map[string]any // compared against Actual in UI
	Actual   map[string]any
}

// Prober is one probe for one (layer, level) pair. Implementations must
// be safe for concurrent Run (the scheduler may reuse the same Prober
// across ticks without waiting for a slow run to finish).
type Prober interface {
	Layer() string
	Level() Level
	Interval() time.Duration
	Run(ctx context.Context) Result
}

// Sink persists Results. The scheduler calls Sink.Write synchronously
// inside the tick goroutine — implementations should not block for
// more than a few ms.
type Sink interface {
	Write(ctx context.Context, r Result) error
}

// Scheduler runs a set of Probers on independent tickers. One instance
// per deployment; Run blocks until ctx is cancelled.
type Scheduler struct {
	probers []Prober
	sink    Sink
	onError func(p Prober, err error) // nil-safe; called when sink.Write fails

	mu      sync.RWMutex
	lastRun map[key]time.Time // layer|level → last tick start
}

type key struct {
	layer string
	level Level
}

// NewScheduler constructs a scheduler. Probers can be added later via
// Add(); all are started when Run is called.
func NewScheduler(sink Sink, probers ...Prober) *Scheduler {
	return &Scheduler{
		probers: probers,
		sink:    sink,
		lastRun: make(map[key]time.Time),
	}
}

// Add registers a prober. Must be called before Run.
func (s *Scheduler) Add(p Prober) {
	s.probers = append(s.probers, p)
}

// OnError sets an optional callback invoked when a sink write fails.
// Useful for metrics/alerting — the scheduler itself never panics.
func (s *Scheduler) OnError(fn func(Prober, error)) {
	s.onError = fn
}

// LastRun returns the most recent tick start for (layer, level), or
// the zero time if that probe hasn't run yet.
func (s *Scheduler) LastRun(layer string, level Level) time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastRun[key{layer, level}]
}

// Run starts one goroutine per prober. Each goroutine runs its prober
// immediately, then at Interval() cadence until ctx is cancelled.
// Sink writes use a detached 5-second context so a cancellation of
// the outer ctx does not abort an already-started persistence call.
func (s *Scheduler) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, p := range s.probers {
		wg.Add(1)
		go func(p Prober) {
			defer wg.Done()
			s.runOne(ctx, p)
		}(p)
	}
	wg.Wait()
}

func (s *Scheduler) runOne(ctx context.Context, p Prober) {
	interval := p.Interval()
	if interval <= 0 {
		interval = 30 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()

	s.tickOnce(ctx, p)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tickOnce(ctx, p)
		}
	}
}

func (s *Scheduler) tickOnce(ctx context.Context, p Prober) {
	k := key{p.Layer(), p.Level()}
	s.mu.Lock()
	s.lastRun[k] = time.Now()
	s.mu.Unlock()

	start := time.Now()
	res := p.Run(ctx)
	if res.Latency == 0 {
		if l := time.Since(start); l > 0 {
			res.Latency = l
		} else {
			res.Latency = time.Nanosecond
		}
	}
	if res.Layer == "" {
		res.Layer = p.Layer()
	}
	if res.Level == 0 {
		res.Level = p.Level()
	}

	// Detached so an outer cancellation still flushes the last probe.
	writeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.sink.Write(writeCtx, res); err != nil && s.onError != nil {
		s.onError(p, err)
	}
}
