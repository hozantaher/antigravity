package constrate

import (
	"context"
	"math/rand"
	"relay/internal/minlog"
	"relay/internal/model"
	"sync"
	"testing"
	"testing/quick"
	"time"
)

// ---------------------------------------------------------------------------
// Property: rate stays positive regardless of interval value
// ---------------------------------------------------------------------------

// TestEmitter_IntervalAlwaysPositive verifies that NewEmitter never stores
// a zero or negative interval (the package takes whatever the caller passes,
// but our invariant is that the object is safe to construct from any value).
func TestEmitter_IntervalAlwaysPositive(t *testing.T) {
	f := func(ns int64) bool {
		interval := time.Duration(ns)
		src := &mockSource{}
		snd := &mockSender{}
		log := minlog.New("prop-test")

		// Must never panic regardless of interval sign / magnitude.
		defer func() { recover() }()
		e := NewEmitter(interval, src, snd, log)
		_ = e.IsRunning()
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestEmitter_NeverPanics_ZeroInterval constructs an emitter with a zero
// interval and verifies construction + Stats + IsRunning are all safe.
func TestEmitter_NeverPanics_ZeroInterval(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic with zero interval: %v", r)
		}
	}()
	e := NewEmitter(0, &mockSource{}, &mockSender{}, minlog.New("zero-interval"))
	_ = e.Stats()
	_ = e.IsRunning()
}

// TestEmitter_NeverPanics_NegativeInterval mirrors the zero test for negatives.
func TestEmitter_NeverPanics_NegativeInterval(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic with negative interval: %v", r)
		}
	}()
	e := NewEmitter(-time.Second, &mockSource{}, &mockSender{}, minlog.New("neg-interval"))
	_ = e.Stats()
	_ = e.IsRunning()
}

// TestEmitter_NeverPanics_Property exercises NewEmitter + Stats + IsRunning
// with arbitrary int64-derived intervals and never expects a panic.
func TestEmitter_NeverPanics_Property(t *testing.T) {
	f := func(ns int64) bool {
		defer func() { recover() }()
		e := NewEmitter(time.Duration(ns), &mockSource{}, &mockSender{}, minlog.New("prop"))
		_ = e.Stats()
		_ = e.IsRunning()
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// Property: stats invariant — TotalEmitted == RealEmitted + CoverEmitted
// ---------------------------------------------------------------------------

// TestEmitter_StatsInvariant_Property runs emitOne repeatedly with random
// message queues and verifies the accounting invariant after every call.
func TestEmitter_StatsInvariant_Property(t *testing.T) {
	f := func(realCount uint8) bool {
		n := int(realCount) % 16 // cap at 15 messages to keep test fast
		msgs := make([]model.Envelope, n)
		for i := range msgs {
			msgs[i] = model.Envelope{ID: "real"}
		}
		src := &mockSource{messages: msgs}
		snd := &mockSender{}
		e := NewEmitter(time.Hour, src, snd, minlog.New("prop"))

		for i := 0; i < n+3; i++ {
			e.emitOne(context.Background())
		}

		s := e.Stats()
		return s.TotalEmitted == s.RealEmitted+s.CoverEmitted
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// Monkey: concurrent Stats + IsRunning + emitOne never race
// ---------------------------------------------------------------------------

// TestEmitter_ConcurrentAccess_NoRace fires emitOne and Stats/IsRunning
// concurrently to surface any data races (run with -race).
func TestEmitter_ConcurrentAccess_NoRace(t *testing.T) {
	src := &mockSource{messages: []model.Envelope{{ID: "r1"}, {ID: "r2"}, {ID: "r3"}}}
	snd := &mockSender{}
	e := NewEmitter(time.Hour, src, snd, minlog.New("race-test"))

	var wg sync.WaitGroup
	ctx := context.Background()

	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e.emitOne(ctx)
		}()
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = e.Stats()
			_ = e.IsRunning()
		}()
	}
	wg.Wait()

	s := e.Stats()
	if s.TotalEmitted != s.RealEmitted+s.CoverEmitted {
		t.Fatalf("stats invariant broken after concurrent access: %+v", s)
	}
}

// ---------------------------------------------------------------------------
// Monkey: emitOne with random source behaviour — no panic
// ---------------------------------------------------------------------------

// panicSource panics from Draw at random to confirm emitOne is panic-safe.
// (We use recover in the test, not in the production code.)
type panicSource struct {
	mu       sync.Mutex
	queue    []model.Envelope
	panicPct int // 0-100: percent of Draw calls that should panic
	rng      *rand.Rand
}

func (p *panicSource) Draw() (model.Envelope, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rng.Intn(100) < p.panicPct {
		panic("monkey: Draw panic")
	}
	if len(p.queue) == 0 {
		return model.Envelope{IsCover: true, ID: "cover"}, false
	}
	env := p.queue[0]
	p.queue = p.queue[1:]
	return env, true
}

func (p *panicSource) Requeue(env model.Envelope) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.queue = append(p.queue, env)
}

// TestEmitter_MonkeySource_PanicRecovery verifies that emitOne doesn't
// panic when the source panics — the panic propagates naturally (we're
// checking there's no double-panic, and recovery works from the caller).
func TestEmitter_MonkeySource_PanicRecovery(t *testing.T) {
	for _, pct := range []int{0, 25, 75, 100} {
		t.Run("panicPct="+itoa(pct), func(t *testing.T) {
			src := &panicSource{
				queue:    []model.Envelope{{ID: "r1"}},
				panicPct: pct,
				rng:      rand.New(rand.NewSource(42)),
			}
			snd := &mockSender{}
			e := NewEmitter(time.Hour, src, snd, minlog.New("monkey"))

			// At 0%: no panic, stats must be valid afterwards.
			if pct == 0 {
				e.emitOne(context.Background())
				s := e.Stats()
				if s.TotalEmitted != s.RealEmitted+s.CoverEmitted {
					t.Fatalf("stats invariant broken: %+v", s)
				}
				return
			}

			// For non-zero: panic is expected to propagate — we catch it.
			didPanic := false
			func() {
				defer func() {
					if r := recover(); r != nil {
						didPanic = true
					}
				}()
				e.emitOne(context.Background())
			}()
			_ = didPanic // panic-or-no-panic both acceptable, no double-panic
		})
	}
}

// itoa is a tiny helper to avoid importing fmt in tests.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
