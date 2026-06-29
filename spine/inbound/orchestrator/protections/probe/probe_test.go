package probe

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeProber records each Run call. Latency on the result is the
// zero duration; the scheduler fills it in.
type fakeProber struct {
	layer    string
	level    Level
	interval time.Duration
	calls    atomic.Int32
	status   Status
}

func (p *fakeProber) Layer() string           { return p.layer }
func (p *fakeProber) Level() Level             { return p.level }
func (p *fakeProber) Interval() time.Duration { return p.interval }
func (p *fakeProber) Run(_ context.Context) Result {
	p.calls.Add(1)
	return Result{Status: p.status}
}

// memorySink captures writes for assertions.
type memorySink struct {
	mu    sync.Mutex
	out   []Result
	fail  bool
	calls atomic.Int32
}

func (s *memorySink) Write(_ context.Context, r Result) error {
	s.calls.Add(1)
	if s.fail {
		return errors.New("sink boom")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.out = append(s.out, r)
	return nil
}

func (s *memorySink) snapshot() []Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]Result, len(s.out))
	copy(cp, s.out)
	return cp
}

func TestScheduler_RunsImmediatelyThenOnInterval(t *testing.T) {
	p := &fakeProber{layer: "anti_trace", level: LevelAlive, interval: 40 * time.Millisecond, status: StatusOK}
	sink := &memorySink{}
	s := NewScheduler(sink, p)

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	s.Run(ctx)

	// Immediate + roughly 2 interval-driven ticks within 120ms.
	if got := p.calls.Load(); got < 2 || got > 5 {
		t.Fatalf("expected 2..5 probe runs, got %d", got)
	}
	if got := sink.calls.Load(); got != p.calls.Load() {
		t.Fatalf("sink call count %d != prober call count %d", got, p.calls.Load())
	}
}

func TestScheduler_FillsLayerLevelLatency(t *testing.T) {
	p := &fakeProber{layer: "watchdog", level: LevelAlive, interval: 20 * time.Millisecond, status: StatusOK}
	sink := &memorySink{}
	s := NewScheduler(sink, p)

	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Millisecond)
	defer cancel()
	s.Run(ctx)

	rows := sink.snapshot()
	if len(rows) == 0 {
		t.Fatal("expected at least one row")
	}
	r := rows[0]
	if r.Layer != "watchdog" {
		t.Errorf("Layer not filled in: %q", r.Layer)
	}
	if r.Level != LevelAlive {
		t.Errorf("Level not filled in: %d", r.Level)
	}
	if r.Latency <= 0 {
		t.Errorf("Latency not filled in: %v", r.Latency)
	}
}

func TestScheduler_OnErrorInvokedOnSinkFailure(t *testing.T) {
	p := &fakeProber{layer: "proxy_pool", level: LevelAlive, interval: 20 * time.Millisecond, status: StatusOK}
	sink := &memorySink{fail: true}
	s := NewScheduler(sink, p)

	var gotErr atomic.Int32
	s.OnError(func(Prober, error) { gotErr.Add(1) })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	s.Run(ctx)

	if gotErr.Load() == 0 {
		t.Fatal("OnError never invoked despite failing sink")
	}
}

func TestScheduler_LastRunTracked(t *testing.T) {
	p := &fakeProber{layer: "db_pool", level: LevelAlive, interval: 15 * time.Millisecond, status: StatusOK}
	sink := &memorySink{}
	s := NewScheduler(sink, p)

	before := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	s.Run(ctx)

	lr := s.LastRun("db_pool", LevelAlive)
	if lr.Before(before) {
		t.Fatalf("LastRun not updated: got %v, before=%v", lr, before)
	}
	// Unknown key returns zero time.
	if !s.LastRun("nope", LevelAlive).IsZero() {
		t.Fatal("LastRun for unknown key should be zero time")
	}
}

func TestScheduler_ZeroIntervalDefaults(t *testing.T) {
	p := &fakeProber{layer: "any", level: LevelAlive, interval: 0, status: StatusOK}
	sink := &memorySink{}
	s := NewScheduler(sink, p)

	// With ctx <30s deadline we should still get exactly one immediate run.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	s.Run(ctx)

	if p.calls.Load() != 1 {
		t.Fatalf("expected exactly 1 call (immediate), got %d", p.calls.Load())
	}
}

func TestCountWorkingProxies(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want int
	}{
		{"empty body", "", 0},
		{"malformed", "{not json", 0},
		{"no working", `{"cz_working": 4}`, 0},
		{"empty working", `{"working": []}`, 0},
		{"one", `{"working": [{"addr": "a:1"}]}`, 1},
		{"three", `{"working": [{},{},{}]}`, 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := countWorkingProxies([]byte(tt.in)); got != tt.want {
				t.Errorf("countWorkingProxies(%q) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

func TestAntiTraceL2_SkipWhenNotConfigured(t *testing.T) {
	p := NewAntiTraceL2("", 30*time.Second)
	res := p.Run(context.Background())
	if res.Status != StatusSkip {
		t.Errorf("expected skip when URL empty, got %q", res.Status)
	}
}

func TestProxyPoolL2_SkipWhenNotConfigured(t *testing.T) {
	p := NewProxyPoolL2("", "", 30*time.Second)
	res := p.Run(context.Background())
	if res.Status != StatusSkip {
		t.Errorf("expected skip when BFF empty, got %q", res.Status)
	}
}

func TestWatchdogL2_SkipWhenNoDB(t *testing.T) {
	p := NewWatchdogL2(nil, 30*time.Second, 15*time.Minute)
	if p.Run(context.Background()).Status != StatusSkip {
		t.Error("expected skip when db nil")
	}
}

func TestDBPoolL2_SkipWhenNoDB(t *testing.T) {
	p := NewDBPoolL2(nil, 30*time.Second)
	if p.Run(context.Background()).Status != StatusSkip {
		t.Error("expected skip when db nil")
	}
}

func TestSenderEngineL2_SkipWhenNoDB(t *testing.T) {
	p := NewSenderEngineL2(nil, 30*time.Second, 30*time.Minute)
	if p.Run(context.Background()).Status != StatusSkip {
		t.Error("expected skip when db nil")
	}
}

func TestProberInterval_Defaults(t *testing.T) {
	type tc struct {
		name string
		p    Prober
		want time.Duration
	}
	cases := []tc{
		{"anti_trace", NewAntiTraceL2("http://x", 0), 30 * time.Second},
		{"proxy_pool", NewProxyPoolL2("http://x", "", 0), 30 * time.Second},
		{"watchdog", NewWatchdogL2(nil, 0, 0), 60 * time.Second},
		{"db_pool", NewDBPoolL2(nil, 0), 30 * time.Second},
		{"sender_engine", NewSenderEngineL2(nil, 0, 0), 60 * time.Second},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.p.Interval(); got != c.want {
				t.Errorf("%s default interval = %v, want %v", c.name, got, c.want)
			}
		})
	}
}
